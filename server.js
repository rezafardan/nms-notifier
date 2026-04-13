'use strict';

// ── Load .env manual (tanpa dotenv package) ───────────────────────────────────
try {
  require('fs').readFileSync('.env', 'utf8').split('\n').forEach(line => {
    const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  });
} catch {}

const express = require('express');
const { WebSocketServer } = require('ws');
const http    = require('http');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// ── Static files + JSON body ──────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '2mb' }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Konfigurasi ───────────────────────────────────────────────────────────────
const CFG = {
  grafanaUrl:   (process.env.GRAFANA_URL     || 'http://localhost:3000').replace(/\/$/, ''),
  apiKey:        process.env.GRAFANA_API_KEY  || '',
  user:          process.env.GRAFANA_USER     || 'admin',
  password:      process.env.GRAFANA_PASSWORD || 'admin',
  orgId:         process.env.GRAFANA_ORG_ID   || '1',
  pollInterval:  parseInt(process.env.POLL_INTERVAL   || '30000'),
  slideInterval: parseInt(process.env.SLIDE_INTERVAL  || '15000'),
  port:          parseInt(process.env.PORT            || '5000'),
  webhookToken:  process.env.WEBHOOK_TOKEN    || '',
};

// ── State ─────────────────────────────────────────────────────────────────────
let dashboards   = [];
let prevAlertMap = new Map();
let lastPollAt   = null;
let lastStatus   = 'pending';
const clients    = new Set();

// ── Auth headers untuk Grafana API ───────────────────────────────────────────
function authHeaders() {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (CFG.apiKey) {
    h['Authorization'] = `Bearer ${CFG.apiKey}`;
  } else {
    h['Authorization'] = 'Basic ' + Buffer.from(`${CFG.user}:${CFG.password}`).toString('base64');
  }
  return h;
}

// ── Fetch daftar dashboard ────────────────────────────────────────────────────
async function fetchDashboards() {
  try {
    const r = await fetch(
      `${CFG.grafanaUrl}/api/search?type=dash-db&limit=100`,
      { headers: authHeaders(), signal: AbortSignal.timeout(10000) }
    );
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    dashboards = data.map(d => ({
      uid:         d.uid,
      title:       d.title,
      slug:        (d.url || '').split('/').pop() || d.uid,
      url:         d.url   || '',
      folderTitle: d.folderTitle || '',
      tags:        d.tags  || [],
    }));
    console.log(`[Dashboard] ${dashboards.length} dashboard ditemukan`);
    broadcast({ type: 'dashboards', dashboards });
  } catch (err) {
    console.error('[Dashboard Error]', err.message);
  }
}

// ── Normalisasi alert dari polling ────────────────────────────────────────────
function normalizePolled(raw) {
  const lbl = raw.labels      || {};
  const ann = raw.annotations || {};
  return {
    fp:           raw.fingerprint,
    name:         lbl.alertname  || 'Unknown Alert',
    severity:     (lbl.severity  || lbl.level || 'warning').toLowerCase(),
    summary:      ann.summary    || ann.description || lbl.alertname || '',
    instance:     lbl.instance   || lbl.host || lbl.job || '',
    startsAt:     raw.startsAt   || new Date().toISOString(),
    dashboardURL: raw.dashboardURL || raw.panelURL || '',
    labels:       lbl,
    via:          'poll',
  };
}

// ── Normalisasi alert dari webhook ────────────────────────────────────────────
function normalizeWebhook(raw) {
  const lbl = raw.labels      || {};
  const ann = raw.annotations || {};
  return {
    fp:           raw.fingerprint
                  || `${lbl.alertname || 'alert'}-${lbl.instance || ''}-${lbl.job || ''}`,
    name:         lbl.alertname  || 'Unknown Alert',
    severity:     (lbl.severity  || lbl.level || 'warning').toLowerCase(),
    summary:      ann.summary    || ann.description || lbl.alertname || '',
    instance:     lbl.instance   || lbl.host || lbl.job || '',
    startsAt:     raw.startsAt   || new Date().toISOString(),
    dashboardURL: raw.dashboardURL || raw.panelURL || '',
    labels:       lbl,
    via:          'webhook',
  };
}

// ── Polling alert (backup) ────────────────────────────────────────────────────
async function fetchAlerts() {
  const h = authHeaders();
  try {
    const r = await fetch(
      `${CFG.grafanaUrl}/api/alertmanager/grafana/api/v2/alerts?active=true&silenced=false&inhibited=false`,
      { headers: h, signal: AbortSignal.timeout(10000) }
    );
    if (r.ok) return { source: 'unified', raw: await r.json() };
  } catch (_) {}

  const r2 = await fetch(
    `${CFG.grafanaUrl}/api/alerts?state=alerting&limit=200`,
    { headers: h, signal: AbortSignal.timeout(10000) }
  );
  if (!r2.ok) throw new Error(`HTTP ${r2.status}`);
  const data = await r2.json();
  return {
    source: 'legacy',
    raw: data.map(a => ({
      fingerprint:  String(a.id),
      startsAt:     a.newStateDate || new Date().toISOString(),
      labels:       { alertname: a.name, severity: 'warning' },
      annotations:  { summary: a.name },
      dashboardURL: `${CFG.grafanaUrl}${a.url || ''}`,
    }))
  };
}

async function pollAlerts() {
  lastPollAt = new Date().toISOString();
  try {
    const { source, raw } = await fetchAlerts();
    lastStatus = 'ok';

    const currMap   = new Map();
    const newAlerts = [];
    const resolved  = [];

    for (const item of raw) {
      const a = normalizePolled(item);
      currMap.set(a.fp, a);
      if (!prevAlertMap.has(a.fp)) newAlerts.push(a);
    }
    for (const [fp, a] of prevAlertMap) {
      if (a.via === 'poll' && !currMap.has(fp))
        resolved.push({ ...a, resolvedAt: new Date().toISOString() });
    }
    // Pertahankan alert yang masuk via webhook
    for (const [fp, a] of prevAlertMap) {
      if (a.via === 'webhook' && !currMap.has(fp)) currMap.set(fp, a);
    }
    prevAlertMap = currMap;

    broadcast({ type: 'alert_state', alerts: [...currMap.values()], pollAt: lastPollAt, source });
    newAlerts.forEach(a => broadcast({ type: 'new_alert', alert: a }));
    resolved.forEach(a  => broadcast({ type: 'resolved',  alert: a }));

    if (newAlerts.length || resolved.length)
      console.log(`[Poll-${source}] baru=${newAlerts.length} resolved=${resolved.length} total=${raw.length}`);
  } catch (err) {
    lastStatus = 'error';
    broadcast({ type: 'alert_error', message: err.message });
    console.error('[Poll Error]', err.message);
  }
}

// ── Broadcast ke semua WS client ──────────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of clients) if (ws.readyState === 1) ws.send(msg);
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', ws => {
  clients.add(ws);
  ws.send(JSON.stringify({
    type:          'init',
    grafanaUrl:    CFG.grafanaUrl,
    orgId:         CFG.orgId,
    slideInterval: CFG.slideInterval,
    dashboards,
    alerts:        [...prevAlertMap.values()],
    pollAt:        lastPollAt,
  }));
  ws.on('close',  () => clients.delete(ws));
  ws.on('error',  () => clients.delete(ws));
});

// ── Webhook dari Grafana Contact Point ────────────────────────────────────────
app.post('/webhook/grafana', (req, res) => {
  if (CFG.webhookToken) {
    const auth  = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
    if (token !== CFG.webhookToken) {
      console.warn('[Webhook] Unauthorized — token tidak cocok');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  // Balas 200 dulu agar Grafana tidak timeout
  res.status(200).json({ status: 'ok', ts: new Date().toISOString() });

  const payload = req.body;
  if (!payload || !Array.isArray(payload.alerts) || !payload.alerts.length) return;

  const groupStatus = payload.status || 'firing';
  console.log(`[Webhook] group=${groupStatus} alerts=${payload.alerts.length} receiver=${payload.receiver || '-'}`);

  for (const raw of payload.alerts) {
    const alertStatus = raw.status || groupStatus;
    const a = normalizeWebhook(raw);

    if (alertStatus === 'firing') {
      prevAlertMap.set(a.fp, a);
      broadcast({ type: 'new_alert', alert: a, via: 'webhook' });
      console.log(`  [↑ FIRING]   ${a.name} | sev=${a.severity} | ${a.instance || '-'}`);
    } else if (alertStatus === 'resolved') {
      prevAlertMap.delete(a.fp);
      broadcast({ type: 'resolved', alert: a, via: 'webhook' });
      console.log(`  [↓ RESOLVED] ${a.name} | ${a.instance || '-'}`);
    }
  }

  broadcast({ type: 'alert_state', alerts: [...prevAlertMap.values()], pollAt: new Date().toISOString() });
});

// ── REST endpoints ────────────────────────────────────────────────────────────
app.get('/api/dashboards', (_req, res) =>
  res.json({ dashboards, grafanaUrl: CFG.grafanaUrl, orgId: CFG.orgId }));

app.get('/api/status', (_req, res) =>
  res.json({ status: lastStatus, pollAt: lastPollAt,
             alerts: prevAlertMap.size, dashboards: dashboards.length }));

app.get('/webhook/test', (_req, res) =>
  res.json({ status: 'ok', message: 'Webhook endpoint aktif', url: '/webhook/grafana',
             ts: new Date().toISOString() }));

// ── Start ─────────────────────────────────────────────────────────────────────
fetchDashboards();
setInterval(fetchDashboards, 5 * 60 * 1000);
pollAlerts();
setInterval(pollAlerts, CFG.pollInterval);

server.listen(CFG.port, () => {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   Grafana TV Monitor v2  — siap!                 ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  Dashboard : http://localhost:${CFG.port}`);
  console.log(`  Grafana   : ${CFG.grafanaUrl}`);
  console.log(`  Webhook   : POST http://[IP-PC]:${CFG.port}/webhook/grafana`);
  console.log(`  Slide     : setiap ${CFG.slideInterval / 1000} detik`);
  console.log(`  Poll      : setiap ${CFG.pollInterval / 1000} detik (backup)\n`);
  console.log('  Sound files:');
  console.log('    public/sounds/firing.mp3');
  console.log('    public/sounds/resolved.mp3\n');
});