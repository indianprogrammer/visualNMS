const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../database/db');
const { signToken, requireAuth } = require('./auth');
const pingPoller = require('../pollers/ping');
const snmpPoller = require('../pollers/snmp');
const tools = require('../tools/traceroute');

const router = express.Router();

// ── Auth ──
router.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: signToken(user), user: { id: user.id, username: user.username, role: user.role } });
});

router.get('/auth/me', requireAuth, (req, res) => {
  const u = db.prepare('SELECT id,username,role,created_at FROM users WHERE id=?').get(req.user.id);
  res.json(u);
});

// ── Devices ──
router.get('/devices', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM devices ORDER BY name').all());
});

router.get('/devices/:id', requireAuth, (req, res) => {
  const d = db.prepare('SELECT * FROM devices WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json(d);
});

router.post('/devices', requireAuth, (req, res) => {
  const b = req.body;
  if (!b.name || !b.ip_address) return res.status(400).json({ error: 'name and ip_address required' });
  try {
    const r = db.prepare(`INSERT INTO devices (name,ip_address,mac_address,device_type,snmp_community,snmp_version,snmp_port,snmp_user,snmp_auth_pass,snmp_priv_pass,snmp_auth_protocol,snmp_priv_protocol,api_type,http_url,latitude,longitude) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(b.name, b.ip_address, b.mac_address||null, b.device_type||'generic', b.snmp_community||'public', b.snmp_version||'2c', b.snmp_port||161, b.snmp_user||null, b.snmp_auth_pass||null, b.snmp_priv_pass||null, b.snmp_auth_protocol||null, b.snmp_priv_protocol||null, b.api_type||null, b.http_url||null, b.latitude||null, b.longitude||null);
    db.prepare(`INSERT INTO event_log (event_type,message,source,severity) VALUES (?,?,?,?)`).run('system', `Device added: ${b.name} (${b.ip_address})`, 'system', 'info');
    res.status(201).json({ id: r.lastInsertRowid, message: 'Created' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/devices/:id', requireAuth, (req, res) => {
  const b = req.body;
  try {
    db.prepare(`UPDATE devices SET name=?,ip_address=?,device_type=?,snmp_community=?,snmp_version=?,snmp_port=?,snmp_user=?,snmp_auth_pass=?,snmp_priv_pass=?,snmp_auth_protocol=?,snmp_priv_protocol=?,api_type=?,http_url=?,latitude=?,longitude=? WHERE id=?`).run(b.name, b.ip_address, b.device_type, b.snmp_community, b.snmp_version, b.snmp_port||161, b.snmp_user, b.snmp_auth_pass, b.snmp_priv_pass, b.snmp_auth_protocol, b.snmp_priv_protocol, b.api_type, b.http_url, b.latitude, b.longitude, req.params.id);
    res.json({ message: 'Updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/devices/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM devices WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

router.get('/devices/:id/metrics', requireAuth, (req, res) => {
  let sql = 'SELECT * FROM metric_history WHERE device_id=?';
  const p = [req.params.id];
  if (req.query.metric_type) { sql += ' AND metric_type=?'; p.push(req.query.metric_type); }
  if (req.query.hours) { sql += ` AND timestamp > datetime('now',?)`; p.push(`-${parseInt(req.query.hours)} hours`); }
  sql += ' ORDER BY timestamp DESC LIMIT ' + (parseInt(req.query.limit) || 500);
  res.json(db.prepare(sql).all(...p));
});

router.get('/devices/:id/interfaces', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM interfaces WHERE device_id=? ORDER BY if_index').all(req.params.id));
});

router.get('/devices/:id/ping', requireAuth, async (req, res) => {
  const d = db.prepare('SELECT * FROM devices WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json(await pingPoller.pingHost(d.ip_address));
});

// ── Maps ──
router.get('/maps', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM maps ORDER BY title').all());
});

router.post('/maps', requireAuth, (req, res) => {
  if (!req.body.title) return res.status(400).json({ error: 'title required' });
  const r = db.prepare('INSERT INTO maps (title,background_image,parent_map_id) VALUES (?,?,?)').run(req.body.title, req.body.background_image||null, req.body.parent_map_id||null);
  res.status(201).json({ id: r.lastInsertRowid, message: 'Created' });
});

router.get('/maps/:id', requireAuth, (req, res) => {
  const m = db.prepare('SELECT * FROM maps WHERE id=?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  m.nodes = db.prepare(`SELECT mn.*,d.name as device_name,d.status as device_status,d.ip_address,d.device_type FROM map_nodes mn LEFT JOIN devices d ON mn.device_id=d.id WHERE mn.map_id=?`).all(req.params.id);
  m.links = db.prepare('SELECT * FROM map_links WHERE map_id=?').all(req.params.id);
  res.json(m);
});

router.put('/maps/:id', requireAuth, (req, res) => {
  db.prepare('UPDATE maps SET title=?,background_image=?,parent_map_id=? WHERE id=?').run(req.body.title, req.body.background_image, req.body.parent_map_id, req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/maps/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM maps WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

router.post('/maps/:id/nodes', requireAuth, (req, res) => {
  const b = req.body;
  const r = db.prepare('INSERT INTO map_nodes (map_id,device_id,sub_map_id,x_position,y_position,custom_label,icon_name) VALUES (?,?,?,?,?,?,?)').run(req.params.id, b.device_id||null, b.sub_map_id||null, b.x_position||100, b.y_position||100, b.custom_label||null, b.icon_name||null);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/maps/:mapId/nodes/:nodeId', requireAuth, (req, res) => {
  const b = req.body;
  const sets = [];
  const p = [];
  if (b.x_position !== undefined) { sets.push('x_position=?'); p.push(b.x_position); }
  if (b.y_position !== undefined) { sets.push('y_position=?'); p.push(b.y_position); }
  if (b.custom_label !== undefined) { sets.push('custom_label=?'); p.push(b.custom_label); }
  if (b.icon_name !== undefined) { sets.push('icon_name=?'); p.push(b.icon_name); }
  if (b.device_id !== undefined) { sets.push('device_id=?'); p.push(b.device_id); }
  if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
  p.push(req.params.nodeId, req.params.mapId);
  db.prepare(`UPDATE map_nodes SET ${sets.join(',')} WHERE id=? AND map_id=?`).run(...p);
  res.json({ message: 'Updated' });
});

router.delete('/maps/:mapId/nodes/:nodeId', requireAuth, (req, res) => {
  db.prepare('DELETE FROM map_nodes WHERE id=? AND map_id=?').run(req.params.nodeId, req.params.mapId);
  res.json({ message: 'Deleted' });
});

router.post('/maps/:id/links', requireAuth, (req, res) => {
  const b = req.body;
  if (!b.source_node_id || !b.target_node_id) return res.status(400).json({ error: 'source and target required' });
  const r = db.prepare('INSERT INTO map_links (map_id,source_node_id,target_node_id,source_interface,target_interface,max_speed_bps) VALUES (?,?,?,?,?,?)').run(req.params.id, b.source_node_id, b.target_node_id, b.source_interface||null, b.target_interface||null, b.max_speed_bps||1000000000);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.delete('/maps/:mapId/links/:linkId', requireAuth, (req, res) => {
  db.prepare('DELETE FROM map_links WHERE id=? AND map_id=?').run(req.params.linkId, req.params.mapId);
  res.json({ message: 'Deleted' });
});

// ── Alerts ──
router.get('/alerts', requireAuth, (req, res) => {
  let sql = 'SELECT a.*,d.name as device_name,d.ip_address FROM alerts a LEFT JOIN devices d ON a.device_id=d.id WHERE 1=1';
  const p = [];
  if (req.query.status) { sql += ' AND a.status=?'; p.push(req.query.status); }
  if (req.query.severity) { sql += ' AND a.severity=?'; p.push(req.query.severity); }
  if (req.query.device_id) { sql += ' AND a.device_id=?'; p.push(req.query.device_id); }
  sql += ' ORDER BY a.created_at DESC LIMIT ' + (parseInt(req.query.limit) || 100);
  res.json(db.prepare(sql).all(...p));
});

router.post('/alerts/:id/acknowledge', requireAuth, (req, res) => {
  db.prepare(`UPDATE alerts SET status='acknowledged',acknowledged_by=?,acknowledged_at=datetime('now') WHERE id=?`).run(req.user.id, req.params.id);
  res.json({ message: 'Acknowledged' });
});

router.post('/alerts/:id/resolve', requireAuth, (req, res) => {
  db.prepare(`UPDATE alerts SET status='resolved',resolved_at=datetime('now') WHERE id=?`).run(req.params.id);
  res.json({ message: 'Resolved' });
});

// ── Alert Rules ──
router.get('/alert-rules', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM alert_rules ORDER BY name').all());
});

router.post('/alert-rules', requireAuth, (req, res) => {
  const b = req.body;
  if (!b.name || !b.metric_type) return res.status(400).json({ error: 'name and metric_type required' });
  const r = db.prepare('INSERT INTO alert_rules (name,device_id,metric_type,condition_op,threshold,severity,cooldown_seconds,notify_webhook,notify_email,notify_telegram,notify_browser,enabled) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(b.name, b.device_id||null, b.metric_type, b.condition_op||'gt', b.threshold||0, b.severity||'warning', b.cooldown_seconds||300, b.notify_webhook?1:0, b.notify_email?1:0, b.notify_telegram?1:0, b.notify_browser!==false?1:0, b.enabled!==false?1:0);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.delete('/alert-rules/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM alert_rules WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ── Events ──
router.get('/events', requireAuth, (req, res) => {
  let sql = 'SELECT e.*,d.name as device_name FROM event_log e LEFT JOIN devices d ON e.device_id=d.id WHERE 1=1';
  const p = [];
  if (req.query.device_id) { sql += ' AND e.device_id=?'; p.push(req.query.device_id); }
  if (req.query.event_type) { sql += ' AND e.event_type=?'; p.push(req.query.event_type); }
  sql += ' ORDER BY e.created_at DESC LIMIT ' + (parseInt(req.query.limit) || 200);
  res.json(db.prepare(sql).all(...p));
});

// ── Dashboard ──
router.get('/dashboard/stats', requireAuth, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as c FROM devices').get().c;
  const up = db.prepare("SELECT COUNT(*) as c FROM devices WHERE status='up'").get().c;
  const down = db.prepare("SELECT COUNT(*) as c FROM devices WHERE status='down'").get().c;
  const unknown = db.prepare("SELECT COUNT(*) as c FROM devices WHERE status='unknown'").get().c;
  const activeAlerts = db.prepare("SELECT COUNT(*) as c FROM alerts WHERE status='active'").get().c;
  const criticalAlerts = db.prepare("SELECT COUNT(*) as c FROM alerts WHERE status='active' AND severity='critical'").get().c;
  res.json({ total, up, down, unknown, activeAlerts, criticalAlerts });
});

// ── Tools ──
router.get('/tools/ping/:target', requireAuth, async (req, res) => {
  res.json(await pingPoller.pingHost(req.params.target));
});

router.get('/tools/traceroute/:target', requireAuth, async (req, res) => {
  try { res.json(await tools.traceroute(req.params.target)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/tools/portscan/:target', requireAuth, async (req, res) => {
  const ports = req.query.ports ? req.query.ports.split(',').map(Number) : [21,22,23,25,53,80,110,143,443,993,995,3306,3389,5432,8080,8443];
  try { res.json(await tools.portScan(req.params.target, ports)); }
  catch (e) { res.status(500).json({ error: e.message }); }
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

router.get('/discovery/jobs', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM discovery_jobs ORDER BY created_at DESC LIMIT 50').all());
});

// ── Poll Trigger ──
router.post('/trigger-poll', requireAuth, async (req, res) => {
  const pollerEngine = require('../pollers/poller-engine');
  const results = await pollerEngine.fullPoll();
  res.json({ message: 'Poll completed', devices: results.length });
});

module.exports = router;
