'use strict';

const fs = require('fs');

// ── Load .env manual ─────────────────────────────────────────────────────────
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

app.use(express.static(path.join(__dirname, 'public')));


app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/api/sounds', (_req, res) => {
  const dir = path.join(__dirname, 'public', 'sounds');
  try {
    const files = fs.readdirSync(dir)
      .filter(f => /\.(mp3|wav|ogg|m4a|aac)$/i.test(f))
      .sort();
    res.json({ sounds: files });
  } catch {
    res.json({ sounds: [] });
  }
});


const CFG = {
  grafanaUrl:    (process.env.GRAFANA_URL     || 'http://localhost:3000').replace(/\/$/, ''),
  apiKey:         process.env.GRAFANA_API_KEY  || '',
  user:           process.env.GRAFANA_USER     || 'admin',
  password:       process.env.GRAFANA_PASSWORD || 'admin',
  orgId:          process.env.GRAFANA_ORG_ID   || '1',
  pollInterval:   parseInt(process.env.POLL_INTERVAL   || '15000'),
  slideInterval:  parseInt(process.env.SLIDE_INTERVAL  || '15000'),
  port:           parseInt(process.env.PORT            || '5000'),
};

let dashboards   = [];
let prevAlertMap = new Map();
let lastPollAt   = null;
let lastStatus   = 'pending';
const clients    = new Set();

function authHeaders() {
  const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (CFG.apiKey) {
    h['Authorization'] = `Bearer ${CFG.apiKey}`;
  } else {
    h['Authorization'] = 'Basic ' + Buffer.from(`${CFG.user}:${CFG.password}`).toString('base64');
  }
  return h;
}

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
      url:         d.url,
      folderTitle: d.folderTitle || '',
      tags:        d.tags || [],
    }));
    console.log(`[Dashboard] ${dashboards.length} dashboard ditemukan`);
    broadcast({ type: 'dashboards', dashboards });
  } catch (err) {
    console.error('[Dashboard Error]', err.message);
  }
}

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
      fingerprint: String(a.id),
      startsAt:    a.newStateDate || new Date().toISOString(),
      status:      { state: 'active' },
      labels:      { alertname: a.name, severity: 'warning' },
      annotations: { summary: a.name, description: `Dashboard: ${a.dashboardSlug || ''}` },
      dashboardURL: `${CFG.grafanaUrl}${a.url || ''}`,
    }))
  };
}

function normalize(raw) {
  const lbl = raw.labels      || {};
  const ann = raw.annotations || {};
  return {
    fp:          raw.fingerprint,
    name:        lbl.alertname  || 'Unknown Alert',
    severity:    (lbl.severity  || lbl.level || 'warning').toLowerCase(),
    summary:     ann.summary    || ann.description || lbl.alertname || '',
    instance:    lbl.instance   || lbl.host || lbl.job || '',
    startsAt:    raw.startsAt   || new Date().toISOString(),
    dashboardURL: raw.dashboardURL || '',
    labels:      lbl,
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
      const a = normalize(item);
      currMap.set(a.fp, a);
      if (!prevAlertMap.has(a.fp)) newAlerts.push(a);
    }
    for (const [fp, a] of prevAlertMap) {
      if (!currMap.has(fp)) resolved.push({ ...a, resolvedAt: new Date().toISOString() });
    }
    prevAlertMap = currMap;
    broadcast({ type: 'alert_state', alerts: [...currMap.values()], pollAt: lastPollAt });
    newAlerts.forEach(a => broadcast({ type: 'new_alert', alert: a }));
    resolved.forEach(a  => broadcast({ type: 'resolved',  alert: a }));
    if (newAlerts.length || resolved.length)
      console.log(`[Alert] (${source}) baru=${newAlerts.length} resolved=${resolved.length} total=${raw.length}`);
  } catch (err) {
    lastStatus = 'error';
    broadcast({ type: 'alert_error', message: err.message });
    console.error('[Alert Error]', err.message);
  }
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of clients) if (ws.readyState === 1) ws.send(msg);
}

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

app.get('/api/dashboards', (_req, res) => res.json({ dashboards, grafanaUrl: CFG.grafanaUrl }));
app.get('/api/status',     (_req, res) => res.json({ status: lastStatus, pollAt: lastPollAt,
                                                     alerts: prevAlertMap.size, dashboards: dashboards.length }));

fetchDashboards();
setInterval(fetchDashboards, 5 * 60 * 1000);
pollAlerts();
setInterval(pollAlerts, CFG.pollInterval);

server.listen(CFG.port, () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Grafana TV Monitor  — siap!            ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`  Dashboard : http://localhost:${CFG.port}`);
  console.log(`  Grafana   : ${CFG.grafanaUrl}`);
  console.log(`  Slide     : setiap ${CFG.slideInterval / 1000} detik`);
  console.log(`  Poll      : setiap ${CFG.pollInterval / 1000} detik\n`);
  console.log('  PENTING: Login ke Grafana di browser sebelum membuka halaman ini!\n');
});