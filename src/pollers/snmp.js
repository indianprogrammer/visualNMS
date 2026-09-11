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

function snmpWalk(session, oid, maxRep = 100) {
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
    session.walk(oid, maxRep, feedCb, (err) => {
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
  // Nameless interfaces are never polled further nor shown anywhere.
  return Object.values(ifaces).filter((i) => i.if_name && String(i.if_name).trim() !== '');
}

// hrStorageFixedDisk type OID suffix; values may arrive as dotted OID strings.
function parseStorage(stor) {
  const um = {}, sm = {}, dm = {}, tm = {};
  for (const x of stor || []) {
    const m = String(x.oid || '').match(/\.25\.2\.3\.1\.(\d+)\.(\d+)$/);
    if (!m) continue;
    if (m[1] === '2') tm[m[2]] = String(x.value ?? '').replace(/[^0-9.]/g, '');
    else if (m[1] === '3') dm[m[2]] = x.value?.toString() || '';
    else if (m[1] === '5') sm[m[2]] = Number(x.value) || 0;
    else if (m[1] === '6') um[m[2]] = Number(x.value) || 0;
  }
  let memoryPct = null;
  for (const i of Object.keys(sm)) {
    if (dm[i] && (dm[i].toLowerCase().includes('ram') || dm[i].toLowerCase().includes('memory') || i === '1')) {
      const total = sm[i] * 1024;
      if (total > 0) { memoryPct = Math.round((um[i] * 1024 / total) * 100); break; }
    }
  }
  // Main fixed disk = largest hrStorageFixedDisk volume (by total size).
  let diskPct = null;
  let bestSize = 0;
  for (const i of Object.keys(sm)) {
    if (tm[i] && tm[i].endsWith('25.2.1.4') && sm[i] > 0) {
      const pct = Math.round(((um[i] || 0) / sm[i]) * 100);
      if (sm[i] > bestSize) { bestSize = sm[i]; diskPct = pct; }
    }
  }
  return { memoryPct, diskPct };
}

async function pollDevice(device) {
  let session;
  try { session = createSession(device); } catch (e) { return { error: 'session failed: ' + (e.message || e), errors: ['session: ' + (e.message || e)] }; }

  const result = { deviceId: device.id, ip: device.ip_address, sysDescr: null, sysName: null, cpuLoad: null, memoryPct: null, diskPct: null, interfaces: [], errors: [], timestamp: new Date().toISOString() };
  const errMsg = (e) => (e && e.message ? e.message : String(e));
  const cap = async (label, promise) => { try { return await promise; } catch (e) { result.errors.push(label + ': ' + errMsg(e)); return []; } };

  try {
    const [d, n] = await Promise.all([snmpGet(session, OIDS.sysDescr).catch(()=>null), snmpGet(session, OIDS.sysName).catch(()=>null)]);
    result.sysDescr = d?.toString() || null;
    result.sysName = n?.toString() || null;
  } catch {}

  // Fast-fail probe: a host answering neither sysDescr nor sysName will answer
  // nothing else either. Skip the 9 table walks (~9× timeout) for dead hosts.
  if (!result.sysDescr && !result.sysName) {
    try { session.close(); } catch {}
    result.error = 'no response';
    result.errors.push('system: no response');
    return result;
  }

  try {
    // Only columns the UI actually uses (ifType/ifAdminStatus are never displayed)
    const colNames = ['ifDescr', 'ifSpeed', 'ifOperStatus', 'ifInOctets', 'ifOutOctets', 'ifInErrors', 'ifOutErrors'];
    const colOids = [OIDS.ifDescr, OIDS.ifSpeed, OIDS.ifOperStatus, OIDS.ifInOctets, OIDS.ifOutOctets, OIDS.ifInErrors, OIDS.ifOutErrors];
    const parts = await Promise.all(colOids.map((o, i) => cap(colNames[i], snmpWalk(session, o))));
    const varbinds = [];
    for (const p of parts) varbinds.push(...p);
    result.interfaces = extractInterfaces(varbinds);
  } catch {}

  try {
    const loads = await cap('hrProcessorLoad', snmpWalk(session, OIDS.hrProcessorLoad));
    if (loads.length > 0) result.cpuLoad = Math.round(loads.reduce((s,c) => s + (Number(c.value)||0), 0) / loads.length);
  } catch {}

  try {
    const stor = await cap('hrStorage', snmpWalk(session, OIDS.hrStorage));
    const parsed = parseStorage(stor);
    result.memoryPct = parsed.memoryPct;
    result.diskPct = parsed.diskPct;
  } catch {}

  try { session.close(); } catch {}
  return result;
}

// Light poll (5s cadence): CPU/RAM/disk plus targeted GETs for map-bound
// interfaces only — no full table walks. boundIfs = [{if_index, if_name}].
async function pollLight(device, boundIfs) {
  let session;
  try { session = createSession(device); } catch (e) { return { error: 'session failed: ' + (e.message || e), errors: ['session: ' + (e.message || e)] }; }

  const result = { deviceId: device.id, ip: device.ip_address, sysDescr: null, sysName: null, cpuLoad: null, memoryPct: null, diskPct: null, interfaces: [], errors: [], timestamp: new Date().toISOString() };
  const errMsg = (e) => (e && e.message ? e.message : String(e));
  const cap = async (label, promise) => { try { return await promise; } catch (e) { if (result.errors.length < 8) result.errors.push(label + ': ' + errMsg(e)); return []; } };

  const [loads, stor] = await Promise.all([
    cap('hrProcessorLoad', snmpWalk(session, OIDS.hrProcessorLoad)),
    cap('hrStorage', snmpWalk(session, OIDS.hrStorage))
  ]);
  if (loads.length > 0) result.cpuLoad = Math.round(loads.reduce((s, c) => s + (Number(c.value) || 0), 0) / loads.length);
  if (stor.length > 0) {
    const parsed = parseStorage(stor);
    result.memoryPct = parsed.memoryPct;
    result.diskPct = parsed.diskPct;
  }

  const list = (boundIfs || []).filter((b) => b && b.if_index != null && b.if_name);
  const colOids = [OIDS.ifOperStatus, OIDS.ifAdminStatus, OIDS.ifSpeed, OIDS.ifInOctets, OIDS.ifOutOctets, OIDS.ifInErrors, OIDS.ifOutErrors];
  const colKeys = ['if_oper_status', 'if_admin_status', 'if_speed', 'if_in_octets', 'if_out_octets', 'if_in_errors', 'if_out_errors'];
  const got = await Promise.all(list.map(async (b) => {
    const vals = await Promise.all(colOids.map((o) => snmpGet(session, o + '.' + b.if_index).catch(() => null)));
    const iface = { if_index: b.if_index, if_name: b.if_name };
    let any = false;
    vals.forEach((v, k) => {
      if (v === null || v === undefined) return;
      any = true;
      iface[colKeys[k]] = (colKeys[k] === 'if_name') ? String(v) : Number(v);
    });
    if (!any) result.errors.push('if:' + b.if_name + ': no response');
    return any ? iface : null;
  }));
  result.interfaces = got.filter(Boolean);

  if (result.cpuLoad === null && result.memoryPct === null && result.diskPct === null && result.interfaces.length === 0) {
    result.error = 'no response';
    result.errors.push('system: no response');
  }

  try { session.close(); } catch {}
  return result;
}

function saveInterfaces(deviceId, interfaces) {
  const ensure = db.prepare(`INSERT OR IGNORE INTO interfaces (device_id,if_index) VALUES (?,?)`);
  const metric = db.prepare(`INSERT INTO metric_history (device_id,metric_type,interface_name,value) VALUES (?,?,?,?)`);
  const cols = ['if_name','if_type','if_speed','if_oper_status','if_admin_status','if_in_octets','if_out_octets','if_in_errors','if_out_errors'];
  const txn = db.transaction(() => {
    for (const i of interfaces) {
      // Never store a row we can't show status for — a missing oper status
      // (timed-out walk) must not overwrite good data with 0 (= Down).
      if (i.if_oper_status === undefined) continue;
      // Nameless interfaces are not stored at all.
      if (!i.if_name || String(i.if_name).trim() === '') continue;
      ensure.run(deviceId, i.if_index);
      const sets = [], vals = [];
      for (const c of cols) if (i[c] !== undefined) { sets.push(c + '=?'); vals.push(i[c]); }
      sets.push("last_updated=datetime('now')");
      db.prepare(`UPDATE interfaces SET ${sets.join(',')} WHERE device_id=? AND if_index=?`).run(...vals, deviceId, i.if_index);
      if (i.if_name && i.if_in_octets) metric.run(deviceId, 'interface_rx', i.if_name, i.if_in_octets);
      if (i.if_name && i.if_out_octets) metric.run(deviceId, 'interface_tx', i.if_name, i.if_out_octets);
    }
  });
  txn();
}

module.exports = { OIDS, createSession, snmpGet, snmpWalk, pollDevice, pollLight, saveInterfaces, parseStorage };
