const db = require('../database/db');
const pingPoller = require('./ping');
const snmpPoller = require('./snmp');
const config = require('../config/config');

let io = null;
let interval = null;
let snmpInterval = null;
let running = false;
let pingCycleInProgress = false;
let snmpCycleInProgress = false;
let lastSnmpFailSig = null;

function setIO(sio) { io = sio; }

const insertMetric = db.prepare(`INSERT INTO metric_history (device_id,metric_type,value) VALUES (?,?,?)`);
const updateDevice = db.prepare(`UPDATE devices SET status=?, last_seen=datetime('now') WHERE id=?`);
const insertLastPing = db.prepare(`INSERT INTO last_metrics (device_id,metric_type,value) VALUES (?,?,?) ON CONFLICT(device_id,metric_type) DO UPDATE SET value=excluded.value, timestamp=datetime('now')`);

async function pingCycles() {
  if (pingCycleInProgress) return [];
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
    return results;
  } finally {
    pingCycleInProgress = false;
  }
}

async function fullPoll() {
  if (snmpCycleInProgress) return [];
  snmpCycleInProgress = true;
  const t0 = Date.now();
  try {
    const devices = db.prepare('SELECT * FROM devices').all();
    const results = [];
    const batchSize = 200;

    const failures = [];
    for (let i = 0; i < devices.length; i += batchSize) {
      const batch = devices.slice(i, i + batchSize);
      const batchResults = await Promise.allSettled(batch.map(async (device) => {
        let snmpResult = null;
        if (device.snmp_community || device.snmp_version === '3') {
          try {
            snmpResult = await snmpPoller.pollDevice(device);
            if (snmpResult && !snmpResult.error) {
              if (snmpResult.interfaces.length) snmpPoller.saveInterfaces(device.id, snmpResult.interfaces);
              if (snmpResult.cpuLoad !== null) { insertMetric.run(device.id, 'cpu', snmpResult.cpuLoad); insertLastPing.run(device.id, 'cpu', snmpResult.cpuLoad); }
              if (snmpResult.memoryPct !== null) { insertMetric.run(device.id, 'memory', snmpResult.memoryPct); insertLastPing.run(device.id, 'memory', snmpResult.memoryPct); }
            }
          } catch {}
          const hasData = snmpResult && !snmpResult.error && (snmpResult.sysDescr || snmpResult.interfaces.length || snmpResult.cpuLoad !== null || snmpResult.memoryPct !== null);
          if (!hasData) {
            const reason = (snmpResult && (snmpResult.error || (snmpResult.errors && snmpResult.errors[0]))) || 'no response';
            failures.push(`${device.name} (${device.ip_address}): ${reason}`);
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
    return results;
  } finally {
    snmpCycleInProgress = false;
  }
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
  interval = setInterval(() => pingCycles().catch(e => console.error('[Poller] Ping error:', e.message)), effPingMs());
  snmpInterval = setInterval(() => fullPoll().catch(e => console.error('[Poller] SNMP error:', e.message)), effSnmpMs());
}

function start() {
  if (running) return;
  running = true;
  console.log(`[Poller] Ping cycle: ${effPingMs()}ms | SNMP cycle: ${effSnmpMs()}ms`);
  pingCycles().catch(e => console.error('[Poller] Initial ping error:', e.message));
  fullPoll().catch(e => console.error('[Poller] Initial snmp error:', e.message));
  armTimers();
}

function applyIntervals() {
  if (!running) return;
  armTimers();
  console.log(`[Poller] Intervals updated: ping ${effPingMs()}ms | SNMP ${effSnmpMs()}ms`);
}

function stop() {
  if (interval) { clearInterval(interval); interval = null; }
  if (snmpInterval) { clearInterval(snmpInterval); snmpInterval = null; }
  running = false;
}

module.exports = { setIO, pingCycles, fullPoll, start, stop, applyIntervals, effPingMs, effSnmpMs };