const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../database/db');
const { signToken, requireAuth } = require('./auth');
const pingPoller = require('../pollers/ping');
const snmpPoller = require('../pollers/snmp');
const tools = require('../tools/traceroute');

const router = express.Router();

function emitMap(mapId, change) {
  try {
    const io = require('../websocket/ws-server').getIO();
    if (io) io.emit('map:updated', Object.assign({ mapId: db.id(mapId) }, change));
  } catch (e) {}
}
async function fullNode(mapId, nodeId) {
  mapId = db.id(mapId);
  nodeId = db.id(nodeId);
  const n = await db.findOne('map_nodes', { map_id: mapId, id: nodeId });
  const enriched = Object.assign({}, n);
  if (n && n.device_id) {
    try {
      const d = await db.devById(n.device_id);
      enriched.device_name = d ? d.name : null;
      enriched.device_status = d ? d.status : null;
      enriched.ip_address = d ? d.ip_address : null;
      enriched.device_type = d ? d.device_type : null;
      enriched.mac_address = d ? d.mac_address : null;
      enriched.last_seen = d ? d.last_seen : null;
      const lm = await db.lastMetricsByDev(n.device_id);
      enriched.cpu = null; enriched.memory = null; enriched.disk = null; enriched.uptime = null;
      lm.forEach((r) => { if (r.metric_type === 'cpu') enriched.cpu = r.value; else if (r.metric_type === 'memory') enriched.memory = r.value; else if (r.metric_type === 'disk') enriched.disk = r.value; else if (r.metric_type === 'uptime') enriched.uptime = r.value; });
    } catch {}
  }
  return enriched;
}

// ── Auth ──
router.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
  const user = await db.findOne('users', { username });
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: signToken(user), user: { id: user.id, username: user.username, role: user.role } });
});

router.get('/auth/me', requireAuth, async (req, res) => {
  const u = await db.findOne('users', { id: db.id(req.user.id) }, { projection: { _id: 0, password_hash: 0 } });
  res.json(u);
});

// ── Devices ──
router.get('/devices', requireAuth, async (req, res) => {
  res.json(await db.allDevices());
});

router.get('/devices/:id', requireAuth, async (req, res) => {
  const d = await db.devById(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json(d);
});

router.post('/devices', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.ip_address) return res.status(400).json({ error: 'name and ip_address required' });
  try {
    const existing = await db.devByIp(b.ip_address);
    if (existing) return res.status(400).json({ error: 'A device with this IP already exists' });
    const id = await db.ins('devices', {
      name: b.name, ip_address: b.ip_address, mac_address: b.mac_address || null,
      device_type: b.device_type || 'generic', snmp_community: b.snmp_community || 'public',
      snmp_version: b.snmp_version || '2c', snmp_port: b.snmp_port || 161,
      snmp_user: b.snmp_user || null, snmp_auth_pass: b.snmp_auth_pass || null, snmp_priv_pass: b.snmp_priv_pass || null,
      snmp_auth_protocol: b.snmp_auth_protocol || null, snmp_priv_protocol: b.snmp_priv_protocol || null,
      api_type: b.api_type || null, http_url: b.http_url || null,
      latitude: b.latitude || null, longitude: b.longitude || null, status: 'unknown'
    });
    await db.addEvent(null, 'system', `Device added: ${b.name} (${b.ip_address})`, 'system', 'info');
    res.status(201).json({ id, message: 'Created' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/devices/:id', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.ip_address) return res.status(400).json({ error: 'name and ip_address required' });
  const id = db.id(req.params.id);
  try {
    await db.updateOne('devices', { id }, { $set: {
      name: b.name, ip_address: b.ip_address, device_type: b.device_type || 'generic',
      snmp_community: b.snmp_community || 'public', snmp_version: b.snmp_version || '2c',
      snmp_port: b.snmp_port || 161, snmp_user: b.snmp_user || null,
      snmp_auth_pass: b.snmp_auth_pass || null, snmp_priv_pass: b.snmp_priv_pass || null,
      snmp_auth_protocol: b.snmp_auth_protocol || null, snmp_priv_protocol: b.snmp_priv_protocol || null,
      api_type: b.api_type || null, http_url: b.http_url || null,
      latitude: b.latitude || null, longitude: b.longitude || null
    } });
    res.json({ message: 'Updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/devices/:id', requireAuth, async (req, res) => {
  const id = db.id(req.params.id);
  await db.deleteMany('map_nodes', { device_id: id });
  await db.deleteOne('devices', { id });
  res.json({ message: 'Deleted' });
});

router.get('/devices/:id/metrics', requireAuth, async (req, res) => {
  res.json(await db.metricHistory(req.params.id, {
    metric_type: req.query.metric_type || null,
    interface_name: req.query.interface_name || null,
    hours: req.query.hours ? parseInt(req.query.hours) : null,
    limit: parseInt(req.query.limit) || 500
  }));
});

router.get('/devices/:id/interfaces', requireAuth, async (req, res) => {
  res.json(await db.interfacesByDev(req.params.id));
});

router.get('/devices/:id/ping', requireAuth, async (req, res) => {
  const d = await db.devById(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json(await pingPoller.pingHost(d.ip_address));
});

router.get('/devices/:id/snmp', requireAuth, async (req, res) => {
  const d = await db.devById(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  try {
    res.json(await snmpPoller.pollDevice(d));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/devices/:id/refresh', requireAuth, async (req, res) => {
  const d = await db.devById(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  try {
    const pingResult = await pingPoller.pingHost(d.ip_address);
    const status = pingResult.reachable ? 'up' : 'down';
    await db.setDevStatus(d.id, status);
    let latency = null;
    if (pingResult.reachable && pingResult.latencyMs != null) {
      latency = Math.round(pingResult.latencyMs * 10) / 10;
      await db.addMetric(d.id, 'ping', pingResult.latencyMs);
      await db.upsertLastM(d.id, 'ping', pingResult.latencyMs);
    }
    try {
      // Manual refresh = full SNMP walk for this device (hourly otherwise).
      const pollerEngine = require('../pollers/poller-engine');
      await pollerEngine.fullPollDevice(d.id);
    } catch (e) {}
    const nodes = await db.find('map_nodes', { device_id: d.id }, { projection: { map_id: 1, id: 1 } });
    for (const row of nodes) {
      const fn = await fullNode(row.map_id, row.id);
      emitMap(row.map_id, { type: 'node-status', node: fn, latencyMs: latency });
    }
    res.json({ status: status, latencyMs: latency });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Maps ──
router.get('/maps', requireAuth, async (req, res) => {
  res.json(await db.find('maps', {}, { sort: { title: 1 } }));
});

router.post('/maps', requireAuth, async (req, res) => {
  if (!req.body.title) return res.status(400).json({ error: 'title required' });
  const id = await db.ins('maps', { title: req.body.title, background_image: req.body.background_image || null, parent_map_id: db.id(req.body.parent_map_id) });
  res.status(201).json({ id, message: 'Created' });
});

router.get('/maps/:id', requireAuth, async (req, res) => {
  const m = await db.mapById(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  const mapId = db.id(req.params.id);
  const nodes = await db.mapNodesByMap(mapId);
  const devIds = nodes.filter((n) => n.device_id).map((n) => n.device_id);
  let devById = {};
  if (devIds.length) {
    const devs = await db.find('devices', { id: { $in: devIds } });
    devs.forEach((d) => { devById[d.id] = d; });
  }
  nodes.forEach((n) => {
    const d = n.device_id ? devById[n.device_id] : null;
    n.device_name = d ? d.name : null;
    n.device_status = d ? d.status : null;
    n.ip_address = d ? d.ip_address : null;
    n.device_type = d ? d.device_type : null;
    n.mac_address = d ? d.mac_address : null;
    n.last_seen = d ? d.last_seen : null;
    n.cpu = null; n.memory = null; n.disk = null; n.uptime = null;
  });
  try {
    const lm = await db.allLastMetrics();
    const lmByDev = {};
    lm.forEach((r) => { (lmByDev[r.device_id] = lmByDev[r.device_id] || {})[r.metric_type] = r.value; });
    nodes.forEach((n) => {
      const s = n.device_id ? lmByDev[n.device_id] : null;
      n.cpu = s && s.cpu != null ? s.cpu : null;
      n.memory = s && s.memory != null ? s.memory : null;
      n.disk = s && s.disk != null ? s.disk : null;
      n.uptime = s && s.uptime != null ? s.uptime : null;
    });
  } catch {}
  const rawLinks = await db.mapLinksByMap(mapId);
  m.nodes = nodes;
  try {
    const linkStats = require('../pollers/link-stats');
    const nodeById = {};
    m.nodes.forEach((n) => { nodeById[n.id] = n; });
    m.links = await Promise.all(rawLinks.map((l) => linkStats.enrichLink(l, nodeById)));
  } catch { m.links = rawLinks; }
  res.json(m);
});

router.put('/maps/:id', requireAuth, async (req, res) => {
  const id = db.id(req.params.id);
  await db.updateOne('maps', { id }, { $set: { title: req.body.title, background_image: req.body.background_image || null, parent_map_id: db.id(req.body.parent_map_id) } });
  res.json({ message: 'Updated' });
});

router.delete('/maps/:id', requireAuth, async (req, res) => {
  const id = db.id(req.params.id);
  await db.deleteMany('map_nodes', { map_id: id });
  await db.deleteMany('map_links', { map_id: id });
  await db.deleteOne('maps', { id });
  res.json({ message: 'Deleted' });
});

router.post('/maps/:id/nodes', requireAuth, async (req, res) => {
  const b = req.body || {};
  const mapId = db.id(req.params.id);
  const id = await db.ins('map_nodes', {
    map_id: mapId, device_id: db.id(b.device_id), sub_map_id: db.id(b.sub_map_id),
    x_position: b.x_position || 100, y_position: b.y_position || 100,
    custom_label: b.custom_label || null, icon_name: b.icon_name || null
  });
  res.status(201).json({ id });
  const fn = await fullNode(mapId, id);
  emitMap(mapId, { type: 'node-added', node: fn });
});

router.put('/maps/:mapId/nodes/:nodeId', requireAuth, async (req, res) => {
  const b = req.body || {};
  const mapId = db.id(req.params.mapId);
  const nodeId = db.id(req.params.nodeId);
  const set = {};
  if (b.x_position !== undefined) set.x_position = b.x_position;
  if (b.y_position !== undefined) set.y_position = b.y_position;
  if (b.custom_label !== undefined) set.custom_label = b.custom_label;
  if (b.icon_name !== undefined) set.icon_name = b.icon_name;
  if (b.device_id !== undefined) set.device_id = db.id(b.device_id);
  if (!Object.keys(set).length) return res.status(400).json({ error: 'No fields to update' });
  await db.updateOne('map_nodes', { id: nodeId, map_id: mapId }, { $set: set });
  res.json({ message: 'Updated' });
  const fn = await fullNode(mapId, nodeId);
  emitMap(mapId, { type: 'node-moved', node: fn });
});

router.delete('/maps/:mapId/nodes/:nodeId', requireAuth, async (req, res) => {
  const mapId = db.id(req.params.mapId);
  const nodeId = db.id(req.params.nodeId);
  await db.deleteMany('map_links', { $or: [{ source_node_id: nodeId }, { target_node_id: nodeId }], map_id: mapId });
  await db.deleteOne('map_nodes', { id: nodeId, map_id: mapId });
  res.json({ message: 'Deleted' });
  emitMap(mapId, { type: 'node-deleted', id: nodeId });
});

router.post('/maps/:id/links', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.source_node_id || !b.target_node_id) return res.status(400).json({ error: 'source and target required' });
  const mapId = db.id(req.params.id);
  const id = await db.ins('map_links', {
    map_id: mapId, source_node_id: db.id(b.source_node_id), target_node_id: db.id(b.target_node_id),
    source_interface: b.source_interface || null, target_interface: b.target_interface || null,
    max_speed_bps: b.max_speed_bps || 1000000000
  });
  res.status(201).json({ id });
  try {
    const linkStats = require('../pollers/link-stats');
    const raw = await db.findOne('map_links', { id });
    const nodes = await db.mapNodesByMap(mapId);
    const nodeById = {};
    nodes.forEach((n) => { nodeById[n.id] = n; });
    emitMap(mapId, { type: 'link-added', link: await linkStats.enrichLink(raw, nodeById) });
  } catch (e) { emitMap(mapId, { type: 'link-added', link: await db.findOne('map_links', { id }) }); }
});

router.delete('/maps/:mapId/links/:linkId', requireAuth, async (req, res) => {
  const mapId = db.id(req.params.mapId);
  const linkId = db.id(req.params.linkId);
  await db.deleteOne('map_links', { id: linkId, map_id: mapId });
  res.json({ message: 'Deleted' });
  emitMap(mapId, { type: 'link-deleted', id: linkId });
});

router.put('/maps/:mapId/links/:linkId', requireAuth, async (req, res) => {
  const b = req.body || {};
  const mapId = db.id(req.params.mapId);
  const linkId = db.id(req.params.linkId);
  const cur = await db.findOne('map_links', { id: linkId, map_id: mapId });
  if (!cur) return res.status(404).json({ error: 'Link not found' });
  const set = {};
  if (b.source_interface !== undefined) set.source_interface = b.source_interface || null;
  if (b.target_interface !== undefined) set.target_interface = b.target_interface || null;
  if (b.max_speed_bps !== undefined) {
    if (b.max_speed_bps === null || b.max_speed_bps === 'auto') set.max_speed_bps = null;
    else set.max_speed_bps = (parseInt(b.max_speed_bps) > 0 ? parseInt(b.max_speed_bps) : 1000000000);
  }
  if (!Object.keys(set).length) return res.status(400).json({ error: 'Nothing to update' });
  await db.updateOne('map_links', { id: linkId, map_id: mapId }, { $set: set });
  res.json({ message: 'Updated' });
  try {
    const linkStats = require('../pollers/link-stats');
    const raw = await db.findOne('map_links', { id: linkId });
    const nodes = await db.mapNodesByMap(mapId);
    const nodeById = {};
    nodes.forEach((n) => { nodeById[n.id] = n; });
    emitMap(mapId, { type: 'link-updated', link: await linkStats.enrichLink(raw, nodeById) });
  } catch { emitMap(mapId, { type: 'link-updated', link: await db.findOne('map_links', { id: linkId }) }); }
});

// ── Alerts ──
router.get('/alerts', requireAuth, async (req, res) => {
  const q = req.query || {};
  let filter = {};
  if (q.status) filter.status = q.status;
  if (q.severity) filter.severity = q.severity;
  if (q.device_id) filter.device_id = db.id(q.device_id);
  const rows = await db.find('alerts', filter, { sort: { created_at: -1 }, limit: parseInt(q.limit) || 100 });
  const devIds = rows.filter((r) => r.device_id).map((r) => r.device_id);
  const devById = {};
  if (devIds.length) {
    const devs = await db.find('devices', { id: { $in: devIds } }, { projection: { name: 1, ip_address: 1 } });
    devs.forEach((d) => { devById[d.id] = d; });
  }
  rows.forEach((r) => {
    const d = r.device_id ? devById[r.device_id] : null;
    r.device_name = d ? d.name : null;
    r.ip_address = d ? d.ip_address : null;
  });
  res.json(rows);
});

router.post('/alerts/:id/acknowledge', requireAuth, async (req, res) => {
  await db.ackAlert(db.id(req.params.id), req.user.id);
  res.json({ message: 'Acknowledged' });
});

router.post('/alerts/:id/resolve', requireAuth, async (req, res) => {
  await db.resolveAlert(db.id(req.params.id));
  res.json({ message: 'Resolved' });
});

// ── Alert Rules ──
router.get('/alert-rules', requireAuth, async (req, res) => {
  res.json(await db.allRules(false));
});

router.post('/alert-rules', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.metric_type) return res.status(400).json({ error: 'name and metric_type required' });
  const id = await db.ins('alert_rules', {
    name: b.name, device_id: b.device_id || null, metric_type: b.metric_type,
    condition_op: b.condition_op || 'gt', threshold: b.threshold || 0,
    severity: b.severity || 'warning', cooldown_seconds: b.cooldown_seconds || 300,
    notify_webhook: b.notify_webhook ? 1 : 0, notify_email: b.notify_email ? 1 : 0,
    notify_telegram: b.notify_telegram ? 1 : 0, notify_browser: b.notify_browser !== false ? 1 : 0,
    enabled: b.enabled !== false ? 1 : 0
  });
  res.status(201).json({ id });
});

router.delete('/alert-rules/:id', requireAuth, async (req, res) => {
  await db.deleteOne('alert_rules', { id: db.id(req.params.id) });
  res.json({ message: 'Deleted' });
});

// ── SNMP Profiles ──
router.get('/snmp-profiles', requireAuth, async (req, res) => {
  res.json(await db.find('snmp_profiles', {}, { sort: { name: 1 } }));
});

router.post('/snmp-profiles', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name required' });
  try {
    const existing = await db.findOne('snmp_profiles', { name: b.name });
    if (existing) return res.status(400).json({ error: 'Profile name already exists' });
    const id = await db.ins('snmp_profiles', {
      name: b.name, snmp_version: b.snmp_version || '2c', snmp_community: b.snmp_community || null,
      snmp_port: b.snmp_port || 161, snmp_user: b.snmp_user || null,
      snmp_auth_protocol: b.snmp_auth_protocol || null, snmp_auth_pass: b.snmp_auth_pass || null,
      snmp_priv_protocol: b.snmp_priv_protocol || null, snmp_priv_pass: b.snmp_priv_pass || null
    });
    res.status(201).json({ id, message: 'Created' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/snmp-profiles/:id', requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name required' });
  try {
    await db.updateOne('snmp_profiles', { id: db.id(req.params.id) }, { $set: {
      name: b.name, snmp_version: b.snmp_version || '2c', snmp_community: b.snmp_community || null,
      snmp_port: b.snmp_port || 161, snmp_user: b.snmp_user || null,
      snmp_auth_protocol: b.snmp_auth_protocol || null, snmp_auth_pass: b.snmp_auth_pass || null,
      snmp_priv_protocol: b.snmp_priv_protocol || null, snmp_priv_pass: b.snmp_priv_pass || null
    } });
    res.json({ message: 'Updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/snmp-profiles/:id', requireAuth, async (req, res) => {
  await db.deleteOne('snmp_profiles', { id: db.id(req.params.id) });
  res.json({ message: 'Deleted' });
});

// ── Settings ──
router.get('/settings', requireAuth, async (req, res) => {
  const pollerEngine = require('../pollers/poller-engine');
  const notify = {};
  for (const k of ['webhook_url', 'telegram_token', 'telegram_chat_id', 'smtp_host', 'smtp_user', 'smtp_pass', 'alert_email_to']) {
    notify[k] = await db.getSettingRaw('notify_' + k, '');
  }
  res.json({ snmp_interval_ms: await pollerEngine.effSnmpMs(), ping_interval_ms: await pollerEngine.effPingMs(), notify });
});

router.put('/settings', requireAuth, async (req, res) => {
  const parseMs = (v) => { const n = parseInt(v); return (isNaN(n) || n < 1000 || n > 3600000) ? null : n; };
  const b = req.body || {};
  if (b.snmp_interval_ms !== undefined) {
    const v = parseMs(b.snmp_interval_ms);
    if (v === null) return res.status(400).json({ error: 'snmp_interval_ms must be 1000-3600000' });
    await db.setSetting('snmp_interval_ms', v);
  }
  if (b.ping_interval_ms !== undefined) {
    const v = parseMs(b.ping_interval_ms);
    if (v === null) return res.status(400).json({ error: 'ping_interval_ms must be 1000-3600000' });
    await db.setSetting('ping_interval_ms', v);
  }
  for (const k of ['webhook_url', 'telegram_token', 'telegram_chat_id', 'smtp_host', 'smtp_user', 'smtp_pass', 'alert_email_to']) {
    if (b[k] !== undefined) {
      const v = b[k] === null ? '' : String(b[k]).slice(0, 500);
      if (k === 'webhook_url' && v !== '' && !/^https?:\/\/.+\..+/.test(v)) return res.status(400).json({ error: 'webhook_url must be an http(s) URL' });
      await db.setSetting('notify_' + k, v);
    }
  }
  const pollerEngine = require('../pollers/poller-engine');
  await pollerEngine.applyIntervals();
  res.json({ message: 'Updated', settings: { snmp_interval_ms: await pollerEngine.effSnmpMs(), ping_interval_ms: await pollerEngine.effPingMs() } });
});

// ── Events ──
router.get('/events', requireAuth, async (req, res) => {
  const q = req.query || {};
  let filter = {};
  if (q.device_id) filter.device_id = db.id(q.device_id);
  if (q.event_type) filter.event_type = q.event_type;
  const rows = await db.find('event_log', filter, { sort: { created_at: -1 }, limit: parseInt(q.limit) || 200 });
  const devIds = rows.filter((r) => r.device_id).map((r) => r.device_id);
  const devById = {};
  if (devIds.length) {
    const devs = await db.find('devices', { id: { $in: devIds } }, { projection: { name: 1 } });
    devs.forEach((d) => { devById[d.id] = d; });
  }
  rows.forEach((r) => { r.device_name = r.device_id && devById[r.device_id] ? devById[r.device_id].name : null; });
  res.json(rows);
});

// ── Dashboard ──
router.get('/dashboard/stats', requireAuth, async (req, res) => {
  const [total, up, down, unknown, activeAlerts, criticalAlerts] = await Promise.all([
    db.col('devices').countDocuments({}),
    db.col('devices').countDocuments({ status: 'up' }),
    db.col('devices').countDocuments({ status: 'down' }),
    db.col('devices').countDocuments({ status: 'unknown' }),
    db.col('alerts').countDocuments({ status: 'active' }),
    db.col('alerts').countDocuments({ status: 'active', severity: 'critical' })
  ]);
  res.json({ total, up, down, unknown, activeAlerts, criticalAlerts });
});

// ── Tools ──
router.get('/tools/ping/:target', requireAuth, async (req, res) => {
  res.json(await pingPoller.pingHost(req.params.target));
});

router.get('/tools/traceroute/:target', requireAuth, async (req, res) => {
  try { res.json(await tools.traceroute(req.params.target, parseInt(req.query.hops) || 30)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/tools/mtr/:target', requireAuth, async (req, res) => {
  try { res.json(await tools.mtr(req.params.target, parseInt(req.query.cycles) || 4)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/tools/portscan/:target', requireAuth, async (req, res) => {
  const ports = req.query.ports ? req.query.ports.split(',').map(Number) : [21,22,23,25,53,80,110,143,443,993,995,3306,3389,5432,8080,8443];
  try { res.json(await tools.portScan(req.params.target, ports)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

const _targetOk = (t) => /^[a-zA-Z0-9._-]+$/.test(t || '');

// DNS lookup: A/AAAA/NS/MX/TXT for names, PTR for IPs.
router.get('/tools/dns/:target', requireAuth, async (req, res) => {
  const target = req.params.target;
  if (!_targetOk(target)) return res.status(400).json({ error: 'Invalid target' });
  const dns = require('dns/promises');
  const net = require('net');
  const out = { target, records: {} };
  const tryGet = async (k, fn) => { try { const v = await fn(); if (v && v.length) out.records[k] = v; } catch {} };
  try {
    if (net.isIP(target)) {
      await tryGet('PTR', () => dns.reverse(target));
    } else {
      await tryGet('A', () => dns.resolve4(target));
      await tryGet('AAAA', () => dns.resolve6(target));
      await tryGet('NS', () => dns.resolveNs(target));
      await tryGet('MX', () => dns.resolveMx(target).then((m) => m.map((x) => `${x.priority} ${x.exchange}`)));
      await tryGet('TXT', () => dns.resolveTxt(target).then((t) => t.map((x) => x.join(''))));
    }
  } catch (e) { out.error = String(e.message || e).slice(0, 200); }
  res.json(out);
});

// HTTP check: status, time, size for a URL (http/https only, 10s cap).
router.get('/tools/http', requireAuth, async (req, res) => {
  let u;
  try { u = new URL(String(req.query.url || '')); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return res.status(400).json({ error: 'Only http/https URLs' });
  const t0 = Date.now();
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 10000);
    const r = await fetch(u.toString(), { signal: ctl.signal, redirect: 'follow' });
    const buf = Buffer.from(await r.arrayBuffer());
    clearTimeout(to);
    res.json({ url: u.toString(), ok: r.ok, status: r.status, statusText: r.statusText, ms: Date.now() - t0, bytes: buf.length, contentType: r.headers.get('content-type') });
  } catch (e) { res.json({ url: u.toString(), ok: false, ms: Date.now() - t0, error: String(e.message || e).slice(0, 200) }); }
});

// SNMP walk against an arbitrary target (ad-hoc community/version, read-only).
router.get('/tools/snmpwalk', requireAuth, async (req, res) => {
  const target = req.query.target;
  if (!_targetOk(target)) return res.status(400).json({ error: 'Invalid target' });
  const version = String(req.query.version || '2c');
  if (!['1', '2c'].includes(version)) return res.status(400).json({ error: 'Only v1/v2c supported here' });
  const port = Math.min(Math.max(parseInt(req.query.port) || 161, 1), 65535);
  try {
    const r = await snmpPoller.pollDevice({ ip_address: target, snmp_community: req.query.community || 'public', snmp_version: version, snmp_port: port });
    if (!r || r.error) return res.json({ target, error: (r && (r.error || (r.errors && r.errors[0]))) || 'no response' });
    res.json({
      target, sysDescr: r.sysDescr, sysName: r.sysName,
      cpuLoad: r.cpuLoad, memoryPct: r.memoryPct, diskPct: r.diskPct,
      sysUpTime: r.sysUpTime, interfaceCount: (r.interfaces || []).length,
      interfaces: (r.interfaces || []).slice(0, 100).map((i) => ({ if_index: i.if_index, if_name: i.if_name, if_speed: i.if_speed, if_oper_status: i.if_oper_status, if_admin_status: i.if_admin_status }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Discovery ──
router.post('/discovery/scan', requireAuth, async (req, res) => {
  const subnet = req.body.subnet;
  if (!subnet) return res.status(400).json({ error: 'subnet required (CIDR)' });
  const discovery = require('../discovery/auto-discovery');
  const io = require('../websocket/ws-server').getIO();
  res.json({ message: 'Scan started', subnet });
  discovery.scanSubnet(subnet, io).catch(e => console.error('[Discovery]', e.message));
});

router.get('/discovery/jobs', requireAuth, async (req, res) => {
  res.json(await db.find('discovery_jobs', {}, { sort: { created_at: -1 }, limit: 50 }));
});

// ── Poll Trigger ──
router.post('/trigger-poll', requireAuth, async (req, res) => {
  const pollerEngine = require('../pollers/poller-engine');
  const results = await pollerEngine.fullPoll();
  res.json({ message: 'Poll completed', devices: results.length });
});

// ── Poller health: cycle runs/skips prove the overlap guards aren't starving a loop ──
router.get('/poller/stats', requireAuth, (req, res) => {
  const pollerEngine = require('../pollers/poller-engine');
  res.json({ cycles: pollerEngine.getCycleStats(), snmp_interval_ms: pollerEngine.effSnmpMs(), ping_interval_ms: pollerEngine.effPingMs() });
});

module.exports = router;
