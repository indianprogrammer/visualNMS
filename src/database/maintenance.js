// Database maintenance: timestamp normalization, metric downsampling and
// retention pruning. Lives outside the poller path so heavy cleanup never
// competes with live SNMP writes.
const db = require('./db');

const DAY_MS = 86400000;
const COUNTER_TYPES = ['interface_rx', 'interface_tx'];

const defs = {
  retention_days: 365,
  aggregate_after_days: 30,
  counter_retain_hours: 24,
  rate_retain_hours: 6
};

async function setting(key) {
  const v = await db.getSetting(key, null);
  return v === null || v === undefined ? defs[key] : v;
}

async function countQuery(col, filter) {
  try { return await db.col(col).countDocuments(filter); } catch { return -1; }
}

// Collapse raw non-counter metric_history rows older than `aggDays` into one
// row per device+metric+interface+hour. The bucket keeps its lowest numeric
// id (survivor) carrying avg value + min/max/count; the rest are deleted.
async function downsampleMetrics(aggDays) {
  const aggCut = new Date(Date.now() - aggDays * DAY_MS);
  const col = db.col('metric_history');
  let buckets = 0;
  let deleted = 0;

  // Pass snapshot of the first id saved in a bucket to the survivor so the
  // counter sequence (and uniqueness) stays intact.
  const cursor = col.aggregate([
    { $match: { timestamp: { $lt: aggCut }, metric_type: { $nin: COUNTER_TYPES } } },
    { $group: {
      _id: {
        device_id: '$device_id',
        metric_type: '$metric_type',
        interface_name: '$interface_name',
        hour: { $dateTrunc: { date: '$timestamp', unit: 'hour', timezone: 'UTC' } }
      },
      minId: { $min: '$id' },
      ids: { $push: '$id' },
      values: { $push: '$value' }
    } },
    { $project: {
      _id: 0,
      device_id: '$_id.device_id',
      metric_type: '$_id.metric_type',
      interface_name: '$_id.interface_name',
      hour: '$_id.hour',
      minId: 1,
      ids: 1,
      min: { $min: '$values' },
      max: { $max: '$values' },
      avg: { $avg: '$values' },
      cnt: { $size: '$ids' }
    } }
  ]);

  let chunk = [];
  for await (const g of cursor) {
    const avg = Math.round(Number(g.avg) * 100) / 100;
    await col.updateOne({ id: g.minId }, { $set: { value: avg, agg_min: g.min, agg_max: g.max, agg_cnt: g.cnt, timestamp: g.hour } });
    const others = g.ids.filter(id => Number(id) !== Number(g.minId));
    deleted += others.length;
    buckets++;
    chunk = chunk.concat(others);
    if (chunk.length >= 2000) { await col.deleteMany({ id: { $in: chunk } }); chunk = []; }
  }
  if (chunk.length) await col.deleteMany({ id: { $in: chunk } });
  try { await cursor.close(); } catch {}
  return { buckets, deleted };
}

// SNMP octet counters are only meaningful as recent deltas (rate math reads
// the last 2 rows); the persistent per-cycle series lives in link_rate_history.
async function pruneCounters(hours) {
  const cut = new Date(Date.now() - hours * 3600000);
  const r = await db.deleteMany('metric_history', { metric_type: { $in: COUNTER_TYPES }, timestamp: { $lt: cut } });
  return { deleted: r.deletedCount || 0 };
}

async function pruneMetrics(days) {
  const cut = new Date(Date.now() - days * DAY_MS);
  const r = await db.deleteMany('metric_history', { timestamp: { $lt: cut } });
  return { deleted: r.deletedCount || 0 };
}

// link_rate_history: keep only the recent window used by the map edge tooltips.
async function pruneRates(hours) {
  const r = await db.pruneRates(new Date(Date.now() - hours * 3600000));
  return { deleted: r.deletedCount || 0 };
}

async function pruneEvents(days) {
  const cut = new Date(Date.now() - days * DAY_MS);
  const r = await db.deleteMany('event_log', { created_at: { $lt: cut } });
  return { deleted: r.deletedCount || 0 };
}

// Never drop active alerts - only resolved/acknowledged ones past retention.
async function pruneAlerts(days) {
  const cut = new Date(Date.now() - days * DAY_MS);
  const r = await db.deleteMany('alerts', { status: { $in: ['resolved', 'acknowledged'] }, created_at: { $lt: cut } });
  return { deleted: r.deletedCount || 0 };
}

async function runMaintenance() {
  const retentionDays = await setting('retention_days');
  const aggDays = await setting('aggregate_after_days');
  const counterHours = await setting('counter_retain_hours');
  const rateHours = await setting('rate_retain_hours');

  // Bound aggregate window: must never exceed retention.
  const agg = Math.max(1, Math.min(aggDays, Math.max(1, retentionDays)));

  const out = { retention_days: retentionDays, aggregate_after_days: agg };
  try { Object.assign(out, await downsampleMetrics(agg)); } catch (e) { console.error('[Maint] downsample failed:', e.message); }
  try { Object.assign(out, { counters: (await pruneCounters(counterHours)).deleted }); } catch (e) { console.error('[Maint] counter prune failed:', e.message); }
  try { Object.assign(out, { metrics: (await pruneMetrics(retentionDays)).deleted }); } catch (e) { console.error('[Maint] metric prune failed:', e.message); }
  try { Object.assign(out, { rates: (await pruneRates(rateHours)).deleted }); } catch (e) { console.error('[Maint] rate prune failed:', e.message); }
  try { Object.assign(out, { events: (await pruneEvents(retentionDays)).deleted }); } catch (e) { console.error('[Maint] event prune failed:', e.message); }
  try { Object.assign(out, { alerts: (await pruneAlerts(retentionDays)).deleted }); } catch (e) { console.error('[Maint] alert prune failed:', e.message); }

  const busy = out.buckets > 0 || out.counters > 0 || out.metrics > 0 || out.rates > 0 || out.events > 0 || out.alerts > 0;
  if (busy) console.log(`[Maint] retention=${retentionDays}d agg=${agg}d | downsampled ${out.buckets} buckets (${out.deleted} rows) | pruned counters=${out.counters} metrics=${out.metrics} rates=${out.rates} events=${out.events} alerts=${out.alerts}`);
  return out;
}

module.exports = { runMaintenance, downsampleMetrics, pruneCounters, pruneMetrics, pruneRates, pruneEvents, pruneAlerts };