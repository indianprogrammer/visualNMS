const snmp = require('net-snmp');
const db = require('../database/db');
const config = require('../config/config');

const OIDS = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  ifNumber: '1.3.6.1.2.1.2.1.0',
  ifTable: '1.3.6.1.2.1.2.2',
  hrStorage: '1.3.6.1.2.1.25.2.3',
  ifDescr: '1.3.6.1.2.1.2.2.1.2',
  ifType: '1.3.6.1.2.1.2.2.1.3',
  ifSpeed: '1.3.6.1.2.1.2.2.1.5',
  ifOperStatus: '1.3.6.1.2.1.2.2.1.8',
  ifAdminStatus: '1.3.6.1.2.1.2.2.1.7',
  ifInOctets: '1.3.6.1.2.1.2.2.1.10',
  ifOutOctets: '1.3.6.1.2.1.2.2.1.16',
  ifInErrors: '1.3.6.1.2.1.2.2.1.14',
  ifOutErrors: '1.3.6.1.2.1.2.2.1.20',
  hrProcessorLoad: '1.3.6.1.2.1.25.3.3.1.2',
  hrStorageUsed: '1.3.6.1.2.1.25.2.3.1.6',
  hrStorageSize: '1.3.6.1.2.1.25.2.3.1.5',
  hrStorageDescr: '1.3.6.1.2.1.25.2.3.1.3'
};

function createSession(device) {
  const port = device.snmp_port || 161;
  if (device.snmp_version === '3') {
    const opts = { port, timeout: config.poller.snmpTimeoutMs, retries: config.poller.snmpRetries, transport: 'udp4',
      user: device.snmp_user || '', version: snmp.UserSecurityModel.AUTH_PRIV };
    if (device.snmp_auth_protocol && device.snmp_auth_protocol !== 'none') {
      opts.authProtocol = snmp.AuthProtocols[device.snmp_auth_protocol.toUpperCase()];
      opts.authPassword = device.snmp_auth_pass;
    }
    if (device.snmp_priv_protocol && device.snmp_priv_protocol !== 'none') {
      opts.privProtocol = snmp.PrivProtocols[device.snmp_priv_protocol.toUpperCase()];
      opts.privPassword = device.snmp_priv_pass;
    }
    return snmp.createSession(device.ip_address, device.snmp_user, opts);
  }
  return snmp.createSession(device.ip_address, device.snmp_community || 'public', { port, timeout: config.poller.snmpTimeoutMs, retries: config.poller.snmpRetries });
}

function snmpGet(session, oid) {
  return new Promise((resolve, reject) => {
    session.get([oid], (err, varbinds) => {
      if (err) return reject(err);
      const v = varbinds?.[0];
      if (v && v.type !== snmp.ObjectType.NoSuchObject && v.type !== snmp.ObjectType.NoSuchInstance) resolve(v.value);
      else resolve(null);
    });
  });
}

function snmpWalk(session, oid) {
  return new Promise((resolve, reject) => {
    const results = [];
    // NOTE: net-snmp feedCb receives ONLY the varbinds array (no err arg);
    // a truthy return value STOPS the walk. net-snmp walks past the
    // requested subtree, so filter to it and stop at its end.
    const prefix = oid + '.';
    const feedCb = (varbinds) => {
      let outside = false;
      for (const vb of varbinds || []) {
        if (typeof vb.oid !== 'string' || (vb.oid !== oid && !vb.oid.startsWith(prefix))) { outside = true; continue; }
        if (vb.type !== snmp.ObjectType.NoSuchObject && vb.type !== snmp.ObjectType.NoSuchInstance) {
          results.push({ oid: vb.oid, value: vb.value });
        }
      }
      return outside;
    };
    session.walk(oid, 20, feedCb, (err) => {
      if (err && results.length === 0) reject(err);
      else resolve(results);
    });
  });
}

function extractInterfaces(walks) {
  const ifaces = {};
  for (const w of walks) {
    const idx = w.oid.match(/\.(\d+)$/)?.[1];
    if (!idx) continue;
    if (!ifaces[idx]) ifaces[idx] = { if_index: parseInt(idx) };
    const o = w.oid;
    if (o.endsWith('.2.' + idx)) ifaces[idx].if_name = w.value?.toString() || '';
    else if (o.endsWith('.3.' + idx)) ifaces[idx].if_type = w.value;
    else if (o.endsWith('.5.' + idx)) ifaces[idx].if_speed = Number(w.value) || 0;
    else if (o.endsWith('.8.' + idx)) ifaces[idx].if_oper_status = w.value;
    else if (o.endsWith('.7.' + idx)) ifaces[idx].if_admin_status = w.value;
    else if (o.endsWith('.10.' + idx)) ifaces[idx].if_in_octets = Number(w.value) || 0;
    else if (o.endsWith('.16.' + idx)) ifaces[idx].if_out_octets = Number(w.value) || 0;
    else if (o.endsWith('.14.' + idx)) ifaces[idx].if_in_errors = Number(w.value) || 0;
    else if (o.endsWith('.20.' + idx)) ifaces[idx].if_out_errors = Number(w.value) || 0;
  }
  return Object.values(ifaces);
}

async function pollDevice(device) {
  let session;
  try { session = createSession(device); } catch { return { error: 'session failed' }; }

  const result = { deviceId: device.id, ip: device.ip_address, sysDescr: null, sysName: null, cpuLoad: null, memoryPct: null, interfaces: [], timestamp: new Date().toISOString() };

  try {
    const [d, n] = await Promise.all([snmpGet(session, OIDS.sysDescr).catch(()=>null), snmpGet(session, OIDS.sysName).catch(()=>null)]);
    result.sysDescr = d?.toString() || null;
    result.sysName = n?.toString() || null;
  } catch {}

  try {
    const ifWalk = await snmpWalk(session, OIDS.ifTable);
    result.interfaces = extractInterfaces(ifWalk);
  } catch {}

  try {
    const loads = await snmpWalk(session, OIDS.hrProcessorLoad).catch(()=>[]);
    if (loads.length > 0) result.cpuLoad = Math.round(loads.reduce((s,c) => s + (Number(c.value)||0), 0) / loads.length);
  } catch {}

  try {
    const stor = await snmpWalk(session, OIDS.hrStorage).catch(()=>[]);
    const um = {}, sm = {}, dm = {};
    for (const x of stor) {
      const m = x.oid.match(/\.25\.2\.3\.1\.(\d+)\.(\d+)$/);
      if (!m) continue;
      if (m[1] === '3') dm[m[2]] = x.value?.toString() || '';
      else if (m[1] === '5') sm[m[2]] = Number(x.value) || 0;
      else if (m[1] === '6') um[m[2]] = Number(x.value) || 0;
    }
    for (const i of Object.keys(sm)) {
      if (dm[i] && (dm[i].toLowerCase().includes('ram') || dm[i].toLowerCase().includes('memory') || i === '1')) {
        const total = sm[i] * 1024;
        if (total > 0) { result.memoryPct = Math.round((um[i] * 1024 / total) * 100); break; }
      }
    }
  } catch {}

  try { session.close(); } catch {}
  return result;
}

function saveInterfaces(deviceId, interfaces) {
  const upsert = db.prepare(`INSERT INTO interfaces (device_id,if_index,if_name,if_type,if_speed,if_oper_status,if_admin_status,if_in_octets,if_out_octets,if_in_errors,if_out_errors,last_updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(device_id,if_index) DO UPDATE SET if_name=excluded.if_name,if_type=excluded.if_type,if_speed=excluded.if_speed,if_oper_status=excluded.if_oper_status,if_admin_status=excluded.if_admin_status,if_in_octets=excluded.if_in_octets,if_out_octets=excluded.if_out_octets,if_in_errors=excluded.if_in_errors,if_out_errors=excluded.if_out_errors,last_updated=datetime('now')`);
  const metric = db.prepare(`INSERT INTO metric_history (device_id,metric_type,interface_name,value) VALUES (?,?,?,?)`);
  const txn = db.transaction(() => {
    for (const i of interfaces) {
      upsert.run(deviceId, i.if_index, i.if_name||'', i.if_type||0, i.if_speed||0, i.if_oper_status||0, i.if_admin_status||0, i.if_in_octets||0, i.if_out_octets||0, i.if_in_errors||0, i.if_out_errors||0);
      if (i.if_in_octets) metric.run(deviceId, 'interface_rx', i.if_name, i.if_in_octets);
      if (i.if_out_octets) metric.run(deviceId, 'interface_tx', i.if_name, i.if_out_octets);
    }
  });
  txn();
}

module.exports = { OIDS, createSession, snmpGet, snmpWalk, pollDevice, saveInterfaces };
