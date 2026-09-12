const db = require('../database/db');
const pingPoller = require('./ping');
const snmpPoller = require('./snmp');
const linkStats = require('./link-stats');
const config = require('../config/config');

// Full SNMP walk cadence (hourly). The fast light cycle below uses effSnmpMs().
const FULL_SNMP_MS = 3600000;

let io = null;
let interval = null;
let snmpInterval = null;
let fullSnmpInterval = null;
let running = false;
let pingCycleInProgress = false;
let snmpCycleInProgress = false;
let lightCycleInProgress = false;
let fullCycleInProgress = false;
let lastSnmpFailSig = null;

// Cycle counters: proves whether the overlap guards are starving any loop.
// Exposed via GET /api/poller/stats. lastMs = wall time of last completed run.
const loopStats = {
  ping: { runs: 0, skips: 0, lastMs: null },
  light: { runs: 0, skips: 0, lastMs: null },
  full: { runs: 0, skips: 0, lastMs: null }
};
function getCycleStats() { return JSON.parse(JSON.stringify(loopStats)); }

function setIO(sio) { io = sio; }

const insertMetric = db.prepare(`INSERT INTO metric_history (device_id,metric_type,value) VALUES (?,?,?)`);
const updateDevice = db.prepare(`UPDATE devices SET status=?, last_seen=datetime('now') WHERE id=?`);
const insertLastPing = db.prepare(`INSERT INTO last_metrics (device_id,metric_type,value) VALUES (?,?,?) ON CONFLICT(device_id,metric_type) DO UPDATE SET value=excluded.value, timestamp=datetime('now')`);

async function pingCycles() {
  if (pingCycleInProgress) { loopStats.ping.skips++; return []; }
  pingCycleInProgress = true;
  const t0 = Date.now();
  try {
    const devices = db.prepare('SELECT * FROM devices').all();
    const results = [];
    const batchSize = 400;

    for (let i = 0; i < devices.length; i += batchSize) {
      const batch = devices.slice(i, i + batchSize);
      const batchResults = await Promise.allSettled(batch.map(async (device) => {
        const pingResult = await pingPoller.pingHost(device.ip_address, config.poller.pingTimeoutMs);
        const status = pingResult.reachable ? 'up' : 'down';
        updateDevice.run(status, device.id);
        if (pingResult.reachable) {
          insertMetric.run(device.id, 'ping', pingResult.latencyMs);
          insertLastPing.run(device.id, 'ping', pingResult.latencyMs);
        }
        return { deviceId: device.id, deviceName: device.name, ip: device.ip_address, ping: pingResult, snmp: null };
      }));

      for (const r of batchResults) if (r.status === 'fulfilled') results.push(r.value);
    }

    if (io) io.emit('poll:results', results);
    loopStats.ping.runs++;
    loopStats.ping.lastMs = Date.now() - t0;
    return results;
  } finally {
    pingCycleInProgress = false;
  }
}

// Consecutive-failure backoff: devices that never answer SNMP (public DNS,
// dead hosts) are skipped after 5 straight failures and re-probed every
// 12th cycle, so one cycle stops taking ~50s of pure timeouts.
let snmpFailCount = {};
let snmpCycleCount = 0;

async function fullPoll() {
  if (snmpCycleInProgress || fullCycleInProgress) { loopStats.full.skips++; return []; }
  fullCycleInProgress = true;
  snmpCycleInProgress = true;
  const t0 = Date.now();
  try {
    snmpCycleCount++;
    const devices = db.prepare('SELECT * FROM devices').all();
    const results = [];
    const batchSize = 200;
    const boundSet = linkStats.getBoundInterfaces();
    const cycleStats = [];

    const failures = [];
    for (let i = 0; i < devices.length; i += batchSize) {
      const batch = devices.slice(i, i + batchSize);
      const batchResults = await Promise.allSettled(batch.map(async (device) => {
        let snmpResult = null;
        if (device.snmp_community || device.snmp_version === '3') {
          const fails = snmpFailCount[device.id] || 0;
          try {
            snmpResult = await snmpPoller.pollDevice(device);
            if (snmpResult && !snmpResult.error) {
              // NOTE: no recordInterfaceRates here — the light cycle owns rate
              // math. Two writers racing on the same counters produced 0-dips
              // and multi-Gbps spikes on 1G links.
              if (snmpResult.interfaces.length) snmpPoller.saveInterfaces(device.id, snmpResult.interfaces);
              if (snmpResult.cpuLoad !== null) { insertMetric.run(device.id, 'cpu', snmpResult.cpuLoad); insertLastPing.run(device.id, 'cpu', snmpResult.cpuLoad); }
              if (snmpResult.memoryPct !== null) { insertMetric.run(device.id, 'memory', snmpResult.memoryPct); insertLastPing.run(device.id, 'memory', snmpResult.memoryPct); }
              if (snmpResult.diskPct !== null && snmpResult.diskPct !== undefined) { insertMetric.run(device.id, 'disk', snmpResult.diskPct); insertLastPing.run(device.id, 'disk', snmpResult.diskPct); }
              if (snmpResult.sysUpTime !== null && snmpResult.sysUpTime !== undefined) insertLastPing.run(device.id, 'uptime', snmpResult.sysUpTime);
            }
          } catch {}
          const hasData = snmpResult && !snmpResult.error && (snmpResult.sysDescr || snmpResult.interfaces.length || snmpResult.cpuLoad !== null || snmpResult.memoryPct !== null || (snmpResult.diskPct !== null && snmpResult.diskPct !== undefined));
          if (!hasData) {
            snmpFailCount[device.id] = fails + 1;
            const reason = (snmpResult && (snmpResult.error || (snmpResult.errors && snmpResult.errors[0]))) || 'no response';
            failures.push(`${device.name} (${device.ip_address}): ${reason}`);
          } else {
            snmpFailCount[device.id] = 0;
          }
        }
        return { deviceId: device.id, deviceName: device.name, ip: device.ip_address, ping: null, snmp: snmpResult };
      }));

      for (const r of batchResults) if (r.status === 'fulfilled') results.push(r.value);
    }

    const failSig = failures.slice().sort().join('|');
    if (failSig !== lastSnmpFailSig) {
      lastSnmpFailSig = failSig;
      if (failures.length) console.warn(`[Poller] SNMP failed for ${failures.length} device(s): ${failures.slice(0, 5).join('; ')}${failures.length > 5 ? ` (+${failures.length - 5} more)` : ''}`);
      else console.log('[Poller] SNMP: all devices responding');
    }
    checkAlertRules(results);
    if (io) io.emit('poll:snmp', results);
    if (io && cycleStats.length) io.emit('link:stats', cycleStats);
    loopStats.full.runs++;
    loopStats.full.lastMs = Date.now() - t0;
    return results;
  } finally {
    snmpCycleInProgress = false;
    fullCycleInProgress = false;
  }
}

// Light cycle (every few seconds): CPU/RAM/disk + targeted GETs for the
// map-bound interfaces only. Dead devices use the same consecutive-failure
// backoff, re-probed every 12th light cycle.
// NOTE: light no longer waits out a full poll — the old
// `|| fullCycleInProgress` guard starved link stats/graphs for the whole
// (multi-minute) full walk, including right after every server restart.
// Concurrent full+light SNMP is safe: the light cycle solely owns rate math
// (single writer — concurrent writers caused 0-dips and phantom spikes) and
// all DB writes are synchronous/atomic via better-sqlite3.
async function lightPoll() {
  if (lightCycleInProgress) { loopStats.light.skips++; return []; }
  lightCycleInProgress = true;
  const t0light = Date.now();
  try {
    snmpCycleCount++;
    const devices = db.prepare('SELECT * FROM devices').all();
    const boundSet = linkStats.getBoundInterfaces();
    // ifIndex lookup for bound interfaces (built by full polls / refresh).
    const idxByKey = {};
    try {
      db.prepare('SELECT device_id, if_index, if_name FROM interfaces').all()
        .forEach((r) => { if (r.if_name) idxByKey[r.device_id + '|' + r.if_name] = r.if_index; });
    } catch {}
    const results = [];
    const batchSize = 200;
    const needFull = new Set();
    const cycleStats = [];

    for (let i = 0; i < devices.length; i += batchSize) {
      const batch = devices.slice(i, i + batchSize);
      const batchResults = await Promise.allSettled(batch.map(async (device) => {
        let snmpResult = null;
        if (device.snmp_community || device.snmp_version === '3') {
          const fails = snmpFailCount[device.id] || 0;
          if (fails >= 5 && (snmpCycleCount % 12 !== 0)) {
            snmpResult = { skipped: true, deviceId: device.id, ip: device.ip_address, timestamp: new Date().toISOString() };
          } else {
            const bound = [];
            boundSet.forEach((key) => {
              const sep = key.indexOf('|');
              if (String(key.slice(0, sep)) !== String(device.id)) return;
              const ifName = key.slice(sep + 1);
              const idx = idxByKey[key];
              if (idx == null) needFull.add(device.id);
              else bound.push({ if_index: idx, if_name: ifName });
            });
            try {
              snmpResult = await snmpPoller.pollLight(device, bound);
              snmpResult.partial = true;
              if (snmpResult && snmpResult.domFullPollNeeded) needFull.add(device.id);
              if (snmpResult && !snmpResult.error) {
                linkStats.recordInterfaceRates(device.id, snmpResult.interfaces, boundSet).forEach((r) => cycleStats.push(r));
                if (snmpResult.interfaces.length) snmpPoller.saveInterfaces(device.id, snmpResult.interfaces);
                if (snmpResult.cpuLoad !== null) { insertMetric.run(device.id, 'cpu', snmpResult.cpuLoad); insertLastPing.run(device.id, 'cpu', snmpResult.cpuLoad); }
                if (snmpResult.memoryPct !== null) { insertMetric.run(device.id, 'memory', snmpResult.memoryPct); insertLastPing.run(device.id, 'memory', snmpResult.memoryPct); }
                if (snmpResult.diskPct !== null && snmpResult.diskPct !== undefined) { insertMetric.run(device.id, 'disk', snmpResult.diskPct); insertLastPing.run(device.id, 'disk', snmpResult.diskPct); }
                if (snmpResult.sysUpTime !== null && snmpResult.sysUpTime !== undefined) insertLastPing.run(device.id, 'uptime', snmpResult.sysUpTime);
              }
            } catch {}
          }
          const hasData = snmpResult && !snmpResult.error && !snmpResult.skipped && (snmpResult.cpuLoad !== null || snmpResult.memoryPct !== null || (snmpResult.diskPct !== null && snmpResult.diskPct !== undefined) || (snmpResult.interfaces && snmpResult.interfaces.length));
          if (snmpResult && snmpResult.skipped) {
            // neutral
          } else if (!hasData) {
            snmpFailCount[device.id] = fails + 1;
          } else {
            snmpFailCount[device.id] = 0;
          }
        }
        return { deviceId: device.id, deviceName: device.name, ip: device.ip_address, ping: null, snmp: snmpResult };
      }));
      for (const r of batchResults) if (r.status === 'fulfilled') results.push(r.value);
    }

    checkAlertRules(results);
    if (io) io.emit('poll:snmp', results);
    if (io && cycleStats.length) io.emit('link:stats', cycleStats);
    // Devices with bound interfaces missing an ifIndex mapping — or with a
    // missing SFP/DOM sensor layout — get one background full poll to
    // (re)build it.
    needFull.forEach((id) => {
      fullPollDevice(id).catch(() => {});
    });
    loopStats.light.runs++;
    loopStats.light.lastMs = Date.now() - t0light;
    return results;
  } finally {
    lightCycleInProgress = false;
  }
}

// Full poll of a single device (context-menu refresh / missing mappings).
async function fullPollDevice(deviceId) {
  const device = db.prepare('SELECT * FROM devices WHERE id=?').get(deviceId);
  if (!device) return null;
  const boundSet = linkStats.getBoundInterfaces();
  let snmpResult = null;
  let devStats = [];
  if (device.snmp_community || device.snmp_version === '3') {
    try {
      snmpResult = await snmpPoller.pollDevice(device);
      if (snmpResult && !snmpResult.error) {
        // No recordInterfaceRates: light cycle owns rate math (single writer).
        if (snmpResult.interfaces.length) snmpPoller.saveInterfaces(device.id, snmpResult.interfaces);
        if (snmpResult.cpuLoad !== null) { insertMetric.run(device.id, 'cpu', snmpResult.cpuLoad); insertLastPing.run(device.id, 'cpu', snmpResult.cpuLoad); }
        if (snmpResult.memoryPct !== null) { insertMetric.run(device.id, 'memory', snmpResult.memoryPct); insertLastPing.run(device.id, 'memory', snmpResult.memoryPct); }
        if (snmpResult.diskPct !== null && snmpResult.diskPct !== undefined) { insertMetric.run(device.id, 'disk', snmpResult.diskPct); insertLastPing.run(device.id, 'disk', snmpResult.diskPct); }
        if (snmpResult.sysUpTime !== null && snmpResult.sysUpTime !== undefined) insertLastPing.run(device.id, 'uptime', snmpResult.sysUpTime);
        snmpFailCount[device.id] = 0;
      } else {
        snmpFailCount[device.id] = (snmpFailCount[device.id] || 0) + 1;
      }
    } catch {}
  }
  const result = { deviceId: device.id, deviceName: device.name, ip: device.ip_address, ping: null, snmp: snmpResult };
  checkAlertRules([result]);
  if (io) io.emit('poll:snmp', [result]);
  if (io && devStats.length) io.emit('link:stats', devStats);
  return result;
}

function checkAlertRules(results) {
  const rules = db.prepare('SELECT * FROM alert_rules WHERE enabled = 1').all();
  const insertAlert = db.prepare(`INSERT INTO alerts (device_id,severity,message) VALUES (?,?,?)`);
  const insertEvent = db.prepare(`INSERT INTO event_log (device_id,event_type,message,source,severity) VALUES (?,?,?,?,?)`);

  for (const rule of rules) {
    for (const r of results) {
      if (rule.device_id && rule.device_id !== r.deviceId) continue;
      let value;
      switch (rule.metric_type) {
        case 'cpu': value = r.snmp?.cpuLoad; break;
        case 'memory': value = r.snmp?.memoryPct; break;
        case 'disk': value = r.snmp?.diskPct; break;
      }
      if (value === null || value === undefined) continue;

      let triggered = false;
      switch (rule.condition_op) {
        case 'gt': triggered = value > rule.threshold; break;
        case 'lt': triggered = value < rule.threshold; break;
        case 'ge': triggered = value >= rule.threshold; break;
        case 'le': triggered = value <= rule.threshold; break;
        case 'eq': triggered = value === rule.threshold; break;
      }

      if (triggered) {
        const recent = db.prepare(`SELECT id FROM alerts WHERE device_id=? AND message LIKE ? AND status='active' AND created_at > datetime('now','-${rule.cooldown_seconds} seconds')`).get(r.deviceId, `%${rule.name}%`);
        if (!recent) {
          const msg = `${rule.name}: ${rule.metric_type}=${value} on ${r.deviceName} (${r.ip})`;
          insertAlert.run(r.deviceId, rule.severity, msg);
          insertEvent.run(r.deviceId, 'alert', msg, 'alerting', rule.severity);
          if (io) io.emit('alert:new', { deviceId: r.deviceId, severity: rule.severity, message: msg });
        }
      }
    }
  }
}

function effPingMs() { return db.getSetting('ping_interval_ms', config.poller.pingIntervalMs); }
function effSnmpMs() { return db.getSetting('snmp_interval_ms', config.poller.snmpIntervalMs); }

function armTimers() {
  if (interval) { clearInterval(interval); interval = null; }
  if (snmpInterval) { clearInterval(snmpInterval); snmpInterval = null; }
  if (fullSnmpInterval) { clearInterval(fullSnmpInterval); fullSnmpInterval = null; }
  interval = setInterval(() => pingCycles().catch(e => console.error('[Poller] Ping error:', e.message)), effPingMs());
  snmpInterval = setInterval(() => lightPoll().catch(e => console.error('[Poller] Light poll error:', e.message)), effSnmpMs());
  fullSnmpInterval = setInterval(() => fullPoll().catch(e => console.error('[Poller] SNMP error:', e.message)), FULL_SNMP_MS);
}

function start() {
  if (running) return;
  running = true;
  console.log(`[Poller] Ping cycle: ${effPingMs()}ms | Light SNMP: ${effSnmpMs()}ms | Full SNMP: ${FULL_SNMP_MS}ms`);
  pingCycles().catch(e => console.error('[Poller] Initial ping error:', e.message));
  fullPoll().catch(e => console.error('[Poller] Initial snmp error:', e.message));
  armTimers();
}

function applyIntervals() {
  if (!running) return;
  armTimers();
  console.log(`[Poller] Intervals updated: ping ${effPingMs()}ms | SNMP ${effSnmpMs()}ms | Full ${FULL_SNMP_MS}ms`);
}

function stop() {
  if (interval) { clearInterval(interval); interval = null; }
  if (snmpInterval) { clearInterval(snmpInterval); snmpInterval = null; }
  if (fullSnmpInterval) { clearInterval(fullSnmpInterval); fullSnmpInterval = null; }
  running = false;
}

module.exports = { setIO, pingCycles, fullPoll, lightPoll, fullPollDevice, start, stop, applyIntervals, effPingMs, effSnmpMs, getCycleStats, FULL_SNMP_MS };