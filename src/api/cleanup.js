// Manual data cleanup dashboard: category sizes + destructive-but-explicit
// sweep actions (orphan data, old logs, graphs, per-device data...).
const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { requireAuth, requireRole } = require('./auth');

const DAY_MS = 86400000;

// Collections carrying a device_id make up "per-device" data. map_nodes is
// included so device-linked map entries count toward a device's footprint.
const REF_COLS = ['metric_history', 'link_rate_history', 'last_metrics', 'interfaces', 'event_log', 'alerts', 'map_nodes'];

const CATS = [
  { key: 'graphs', label: 'Graph History', desc: 'All chart data (CPU / RAM / ping + interface counters)', cols: ['metric_history'], actions: ['prune', 'counters', 'all'] },
  { key: 'rates', label: 'Link Rate History', desc: 'Per-cycle link throughput series', cols: ['link_rate_history'], actions: ['prune', 'all'] },
  { key: 'lasts', label: 'Live Metric Snapshot', desc: 'Most recent value per device + metric', cols: ['last_metrics'], actions: ['all'] },
  { key: 'interfaces', label: 'Interface Tables', desc: 'SNMP interface rows per device', cols: ['interfaces'], actions: ['all'] },
  { key: 'events', label: 'Event Log', desc: 'Syslog / trap / alert system events', cols: ['event_log'], actions: ['prune', 'all'] },
  { key: 'alerts', label: 'Alerts', desc: 'Prune clears resolved/acknowledged; Clean clears everything', cols: ['alerts'], actions: ['prune', 'all'] },
  { key: 'rules', label: 'Alert Rules', desc: 'Threshold rule definitions', cols: ['alert_rules'], actions: ['all'] },
  { key: 'jobs', label: 'Discovery Jobs', desc: 'Network scan job history', cols: ['discovery_jobs'], actions: ['all'] },
  { key: 'maps', label: 'Maps', desc: 'Topology maps + nodes + links', cols: ['maps', 'map_nodes', 'map_links'], actions: ['all'] },
  { key: 'devices', label: 'Devices', desc: 'All devices + every stored bit of their data', cols: ['devices'], actions: ['all'] }
];

async function stat(col) {
  try {
    const s = await db.col(col).db.command({ collStats: col });
    return { count: s.count || 0, size: s.size || 0 };
  } catch { return { count: 0, size: 0 }; }
}

async function wipe(col) {
  const before = (await stat(col)).size;
  const r = await db.deleteMany(col, {});
  return { removed: r.deletedCount || 0, freed: before > 0 ? before : (await stat(col)).size };
}

// Delete with a filter and report the real freed bytes (before vs after).
async function delAndFreed(col, filter) {
  const before = (await stat(col)).size;
  const r = await db.deleteMany(col, filter);
  const after = (await stat(col)).size;
  return { removed: r.deletedCount || 0, freed: Math.max(0, before - after) };
}

// Per-device row/size map across the reference collections, plus the orphan
// bucket (rows whose device_id no longer exists). Bytes are approximated by
// the collection's average document size.
async function deviceStats() {
  const valid = new Set((await db.allDevices()).map((d) => d.id));
  const byDev = {};
  for (const c of REF_COLS) {
    const { count: total, size: bytes } = await stat(c);
    const bpd = total > 0 ? bytes / total : 0;
    let groups = [];
    try { groups = await db.col(c).aggregate([{ $match: { device_id: { $ne: null } } }, { $group: { _id: '$device_id', n: { $sum: 1 } } }]).toArray(); } catch {}
    for (const g of groups) {
      const id = db.id(g._id);
      if (id === null) continue;
      if (!byDev[id]) byDev[id] = { rows: 0, size: 0 };
      byDev[id].rows += g.n;
      byDev[id].size += Math.round(g.n * bpd);
    }
  }
  const orphans = { rows: 0, size: 0 };
  const deviceRows = [];
  for (const d of await db.allDevices()) {
    const b = byDev[d.id] || { rows: 0, size: 0 };
    deviceRows.push({ id: d.id, name: d.name, ip: d.ip_address || '', rows: b.rows, size: b.size });
  }
  for (const id of Object.keys(byDev)) {
    if (!valid.has(Number(id))) { orphans.rows += byDev[id].rows; orphans.size += byDev[id].size; }
  }
  return { orphans, deviceRows };
}

async function orphanSweep() {
  const valid = new Set((await db.allDevices()).map((d) => d.id));
  let removed = 0, freed = 0;
  for (const c of REF_COLS) {
    const { count: total, size: bytes } = await stat(c);
    const bpd = total > 0 ? bytes / total : 0;
    let groups = [];
    try { groups = await db.col(c).aggregate([{ $match: { device_id: { $ne: null } } }, { $group: { _id: '$device_id', n: { $sum: 1 } } }]).toArray(); } catch {}
    for (const g of groups) {
      if (valid.has(db.id(g._id))) continue;
      const r = await delAndFreed(c, { device_id: g._id });
      removed += r.removed;
      freed += r.freed || Math.round((r.removed || 0) * bpd);
    }
  }
  return { removed, freed };
}

router.get('/', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const categories = [];
    for (const c of CATS) {
      let count = 0, size = 0;
      for (const col of c.cols) { const s = await stat(col); count += s.count; size += s.size; }
      categories.push({ key: c.key, label: c.label, desc: c.desc, count, size, actions: c.actions });
    }
    const ds = await deviceStats();
    res.json({ categories, orphans: ds.orphans, devices: ds.deviceRows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    const action = String(body.action || '');
    const days = parseInt(body.days);
    const dayCut = (d) => new Date(Date.now() - (Number.isFinite(d) && d > 0 ? d : 30) * DAY_MS);
    let out = { removed: 0, freed: 0, message: 'Nothing done' };

    switch (action) {
      case 'graphs.prune':
        out = { ...(await delAndFreed('metric_history', { timestamp: { $lt: dayCut(days) } })), message: 'Old graph rows deleted' };
        break;
      case 'graphs.counters':
        out = { ...(await delAndFreed('metric_history', { metric_type: { $in: ['interface_rx', 'interface_tx'] } })), message: 'Interface counter history cleared' };
        break;
      case 'graphs.all':
        out = { ...(await wipe('metric_history')), message: 'Graph history cleared' };
        break;
      case 'rates.prune':
        out = { ...(await delAndFreed('link_rate_history', { timestamp: { $lt: dayCut(days) } })), message: 'Old rate rows deleted' };
        break;
      case 'rates.all':
        out = { ...(await wipe('link_rate_history')), message: 'Link rate history cleared' };
        break;
      case 'lasts.all':
        out = { ...(await wipe('last_metrics')), message: 'Live metric snapshot cleared' };
        break;
      case 'interfaces.all':
        out = { ...(await wipe('interfaces')), message: 'Interface tables cleared' };
        break;
      case 'events.prune':
        out = { ...(await delAndFreed('event_log', { created_at: { $lt: dayCut(days) } })), message: 'Old events deleted' };
        break;
      case 'events.all':
        out = { ...(await wipe('event_log')), message: 'Event log cleared' };
        break;
      case 'alerts.prune':
        out = { ...(await delAndFreed('alerts', { status: { $in: ['resolved', 'acknowledged'] }, created_at: { $lt: dayCut(days) } })), message: 'Old resolved/acknowledged alerts deleted' };
        break;
      case 'alerts.all':
        out = { ...(await wipe('alerts')), message: 'Alerts cleared' };
        break;
      case 'rules.all':
        out = { ...(await wipe('alert_rules')), message: 'Alert rules cleared' };
        break;
      case 'jobs.all':
        out = { ...(await wipe('discovery_jobs')), message: 'Discovery jobs cleared' };
        break;
      case 'maps.all': {
        const m = await wipe('maps'); const n = await wipe('map_nodes'); const l = await wipe('map_links');
        out = { removed: m.removed + n.removed + l.removed, freed: m.freed + n.freed + l.freed, message: 'Maps cleared' };
        break;
      }
      case 'devices.all': {
        const d = await wipe('devices');
        const sweep = await orphanSweep();
        out = { removed: d.removed + sweep.removed, freed: d.freed + sweep.freed, message: 'Devices and their stored data cleared' };
        break;
      }
      case 'orphans':
        out = { ...(await orphanSweep()), message: 'Orphaned device data removed' };
        break;
      case 'old-logs': {
        const cut = dayCut(days);
        const ev = await delAndFreed('event_log', { created_at: { $lt: cut } });
        const al = await delAndFreed('alerts', { status: { $in: ['resolved', 'acknowledged'] }, created_at: { $lt: cut } });
        out = { removed: ev.removed + al.removed, freed: ev.freed + al.freed, message: 'Old logs and resolved alerts removed' };
        break;
      }
      case 'device': {
        const id = db.id(body.device_id);
        if (id === null) return res.status(400).json({ error: 'device_id required' });
        let removed = 0, freed = 0;
        for (const c of REF_COLS) {
          const r = await delAndFreed(c, { device_id: id });
          removed += r.removed; freed += r.freed;
        }
        removed += (await db.deleteOne('devices', { id })).deletedCount || 0;
        out = { removed, freed, message: 'Device data removed' };
        break;
      }
      default:
        return res.status(400).json({ error: 'Unknown cleanup action: ' + action });
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;