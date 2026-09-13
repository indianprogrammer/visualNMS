const { MongoClient } = require('mongodb');
const config = require('../config/config');

// MongoDB-backed data layer. Replaces the old synchronous better-sqlite3
// API with async helpers that mirror the app's access patterns. All entities
// keep a numeric auto-increment `id` (via the `counters` collection) so the
// existing JSON/HTTP contract is unchanged. `_id` is Mongo's ObjectId.
const db = {};

let client = null;
let mdb = null;

const COLLECTIONS = ['counters', 'users', 'devices', 'maps', 'map_nodes', 'map_links', 'interfaces', 'metric_history', 'last_metrics', 'alerts', 'alert_rules', 'event_log', 'snmp_profiles', 'settings', 'discovery_jobs', 'link_rate_history'];

// Last-used sequence per collection; first insert yields id 1.
const SEED_SEQ = { users: 0, devices: 0, maps: 0, map_nodes: 0, map_links: 0, interfaces: 0, metric_history: 0, last_metrics: 0, alerts: 0, alert_rules: 0, event_log: 0, snmp_profiles: 1, discovery_jobs: 0, link_rate_history: 0 };

async function connect() {
  client = new MongoClient(config.database.uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  mdb = client.db(config.database.name);

  // Raw collection handles (db.col('devices')).
  db.col = (n) => mdb.collection(n);

  await ensureIndexes();
  await seedDefaults();
  return db;
}

async function ensureIndexes() {
  const idx = async (c, keys, opts) => mdb.collection(c).createIndex(keys, opts || {});
  await idx('users', { username: 1 }, { unique: true });
  await idx('devices', { ip_address: 1 }, { unique: true });
  await idx('devices', { name: 1 });
  await idx('interfaces', { device_id: 1, if_index: 1 }, { unique: true });
  await idx('interfaces', { device_id: 1, if_name: 1 });
  await idx('last_metrics', { device_id: 1, metric_type: 1 }, { unique: true });
  await idx('metric_history', { device_id: 1, timestamp: -1 });
  await idx('metric_history', { device_id: 1, metric_type: 1, interface_name: 1, timestamp: -1 });
  await idx('link_rate_history', { device_id: 1, interface_name: 1, timestamp: -1 });
  await idx('link_rate_history', { timestamp: 1 });
  await idx('alerts', { device_id: 1, created_at: -1 });
  await idx('alerts', { status: 1 });
  await idx('alert_rules', { enabled: 1 });
  await idx('event_log', { created_at: -1 });
  await idx('event_log', { device_id: 1, created_at: -1 });
  await idx('event_log', { event_type: 1 });
  await idx('snmp_profiles', { name: 1 }, { unique: true });
  await idx('map_nodes', { map_id: 1 });
  await idx('map_links', { map_id: 1 });
  await idx('discovery_jobs', { created_at: -1 });
}

async function seedDefaults() {
  for (const [name, seq] of Object.entries(SEED_SEQ)) {
    await mdb.collection('counters').updateOne({ _id: name }, { $setOnInsert: { seq } }, { upsert: true });
  }
  for (const key of ['snmp_interval_ms', 'ping_interval_ms']) {
    await mdb.collection('settings').updateOne({ _id: key }, { $setOnInsert: { value: '5000' } }, { upsert: true });
  }
  const defProfile = await mdb.collection('snmp_profiles').findOne({ name: 'Default v2c' });
  if (!defProfile) {
    await mdb.collection('snmp_profiles').insertOne({ id: 1, name: 'Default v2c', snmp_version: '2c', snmp_community: 'public', snmp_port: 161, created_at: new Date() });
  }
}

// ── core primitives ──
db.id = (v) => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

db.nextId = async (colName) => {
  const r = await mdb.collection('counters').findOneAndUpdate(
    { _id: colName },
    { $inc: { seq: 1 } },
    { upsert: true, includeResultMetadata: false, returnDocument: 'after' }
  );
  return r.seq;
};

db.find = (col, filter, opts) => mdb.collection(col).find(filter || {}, opts || {}).toArray();
db.findOne = (col, filter, opts) => mdb.collection(col).findOne(filter || {}, opts || {});
db.updateOne = (col, filter, update, opts) => mdb.collection(col).updateOne(filter || {}, update, opts || {});
db.updateMany = (col, filter, update, opts) => mdb.collection(col).updateMany(filter || {}, update, opts || {});
db.deleteOne = (col, filter) => mdb.collection(col).deleteOne(filter || {});
db.deleteMany = (col, filter) => mdb.collection(col).deleteMany(filter || {});

// Insert a doc, stamping a numeric id + created_at. Returns the id.
db.ins = async (colName, doc) => {
  const d = { ...doc };
  if (d.id === undefined || d.id === null) d.id = await db.nextId(colName);
  if (d.created_at === undefined || d.created_at === null) d.created_at = new Date();
  await mdb.collection(colName).insertOne(d);
  return d.id;
};

// Bulk insert with sequential ids (metric_history / link_rate_history).
async function bulkSeq(colName, rows, mapRow) {
  if (!rows || !rows.length) return;
  const r = await mdb.collection('counters').findOneAndUpdate(
    { _id: colName },
    { $inc: { seq: rows.length } },
    { upsert: true, includeResultMetadata: false, returnDocument: 'after' }
  );
  let start = r.seq - rows.length + 1;
  const ts = new Date();
  await mdb.collection(colName).insertMany(rows.map((row) => mapRow(row, start++, ts)));
}

// ── settings ──
db.getSettingRaw = async (key, fallback) => {
  try {
    const row = await db.findOne('settings', { _id: key });
    if (!row || row.value === null || row.value === undefined || String(row.value) === '') return fallback;
    return String(row.value);
  } catch { return fallback; }
};
db.getSetting = async (key, fallback) => {
  const v = await db.getSettingRaw(key, null);
  if (v === null || v === undefined) return fallback;
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
};
db.setSetting = (key, value) => db.updateOne('settings', { _id: key }, { $set: { value: String(value) } }, { upsert: true });

// ── events ──
db.addEvent = (deviceId, type, message, source, severity) =>
  db.ins('event_log', {
    device_id: deviceId === null || deviceId === undefined ? null : db.id(deviceId),
    event_type: type || 'system',
    message: String(message),
    source: source || 'system',
    severity: severity || 'info'
  });

// ── devices ──
db.allDevices = () => db.find('devices', {}, { sort: { name: 1 } });
db.devById = async (id) => { const n = db.id(id); return n === null ? null : db.findOne('devices', { id: n }); };
db.devByIp = (ip) => db.findOne('devices', { ip_address: ip });
db.setDevStatus = (id, status) => db.updateOne('devices', { id }, { $set: { status, last_seen: new Date() } });

// ── metrics (metric_history / last_metrics) ──
db.addMetric = (deviceId, type, value, ifName) =>
  db.ins('metric_history', { device_id: db.id(deviceId), metric_type: type, interface_name: ifName || null, value });

db.addMetricsBulk = (rows) => bulkSeq('metric_history', rows, (r, id, ts) => ({
  id, device_id: r.device_id, metric_type: r.metric_type, interface_name: r.interface_name || null, value: r.value, timestamp: ts
}));

db.upsertLastM = async (deviceId, type, value) => {
  const exists = await db.findOne('last_metrics', { device_id: db.id(deviceId), metric_type: type }, { projection: { _id: 1 } });
  const setId = exists ? null : await db.nextId('last_metrics');
  await db.updateOne(
    'last_metrics',
    { device_id: db.id(deviceId), metric_type: type },
    { $set: { value, timestamp: new Date() }, ...(setId !== null ? { $setOnInsert: { id: setId } } : {}) },
    { upsert: true }
  );
};

db.lastMetricsByDev = (deviceId) => db.find('last_metrics', { device_id: db.id(deviceId), metric_type: { $in: ['cpu', 'memory', 'disk', 'uptime'] } });
db.allLastMetrics = () => db.find('last_metrics', { metric_type: { $in: ['cpu', 'memory', 'disk', 'uptime'] } });
db.metricHistory = async (deviceId, opts) => {
  const o = opts || {};
  const filter = { device_id: db.id(deviceId) };
  if (o.metric_type) filter.metric_type = o.metric_type;
  if (o.interface_name) filter.interface_name = o.interface_name;
  if (o.hours) filter.timestamp = { $gte: new Date(Date.now() - o.hours * 3600000) };
  return db.find('metric_history', filter, { sort: { timestamp: -1 }, limit: Math.min(Math.max(o.limit || 500, 1), 2000) });
};

// ── interfaces ──
db.upsertInterface = async (deviceId, ifIndex, set) => {
  const exists = await db.findOne('interfaces', { device_id: db.id(deviceId), if_index: ifIndex }, { projection: { _id: 1 } });
  const setId = exists ? null : await db.nextId('interfaces');
  await db.updateOne(
    'interfaces',
    { device_id: db.id(deviceId), if_index: ifIndex },
    { $set: { ...set, last_updated: new Date() }, ...(setId !== null ? { $setOnInsert: { id: setId } } : {}) },
    { upsert: true }
  );
};
db.ifByDevIndex = (deviceId, ifIndex) => db.findOne('interfaces', { device_id: db.id(deviceId), if_index: ifIndex });
db.ifByName = (deviceId, ifName) => db.findOne('interfaces', { device_id: db.id(deviceId), if_name: ifName });
db.interfacesByDev = (deviceId) => db.find('interfaces', { device_id: db.id(deviceId), if_name: { $ne: null }, if_name: { $ne: '' } }, { sort: { if_index: 1 } });

// ── link_rate_history ──
db.addRateBulk = (rows) => bulkSeq('link_rate_history', rows, (r, id, ts) => ({
  id, device_id: r.deviceId, interface_name: r.ifName, rx_bps: r.rxBps, tx_bps: r.txBps, timestamp: ts
}));
db.persistedRate = (deviceId, ifName) => db.findOne('link_rate_history', { device_id: db.id(deviceId), interface_name: ifName }, { sort: { timestamp: -1 } });
db.rateHistory = (deviceId, ifName, limit) => db.find('link_rate_history', { device_id: db.id(deviceId), interface_name: ifName }, { sort: { timestamp: -1 }, limit });
db.pruneRates = (olderThan) => db.deleteMany('link_rate_history', { timestamp: { $lt: olderThan } });

// ── alerts / alert_rules ──
db.addAlert = (deviceId, severity, message) => db.ins('alerts', { device_id: deviceId === null || deviceId === undefined ? null : db.id(deviceId), severity, message, status: 'active' });
db.ackAlert = (id, userId) => db.updateOne('alerts', { id }, { $set: { status: 'acknowledged', acknowledged_by: userId, acknowledged_at: new Date() } });
db.resolveAlert = (id) => db.updateOne('alerts', { id }, { $set: { status: 'resolved', resolved_at: new Date() } });
db.alertById = (id) => db.findOne('alerts', { id });
db.alertByNameSince = (deviceId, name, since) => db.findOne('alerts', {
  device_id: db.id(deviceId), status: 'active', message: { $regex: escapeRegExp('' + name) }, created_at: { $gt: since }
}, { projection: { id: 1 } });
db.allRules = (enabledOnly) => db.find('alert_rules', enabledOnly ? { enabled: 1 } : {}, { sort: { name: 1 } });

// ── map entities ──
db.mapById = async (id) => { const n = db.id(id); return n === null ? null : db.findOne('maps', { id: n }); };
db.mapNodesByMap = (mapId) => db.find('map_nodes', { map_id: db.id(mapId) });
db.mapLinksByMap = (mapId) => db.find('map_links', { map_id: db.id(mapId) });
db.mapNodesAll = () => db.find('map_nodes', { device_id: { $ne: null } });
db.mapLinksAll = () => db.find('map_links', {});

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

db.connect = connect;

module.exports = db;