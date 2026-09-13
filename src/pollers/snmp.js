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
  hrStorageDescr: '1.3.6.1.2.1.25.2.3.1.3',
  // ENTITY-MIB (RFC 2737) physical table — SFP container discovery
  entPhysicalDescr: '1.3.6.1.2.1.47.1.1.1.1.2',
  entPhysicalContainedIn: '1.3.6.1.2.1.47.1.1.1.1.4',
  entPhysicalClass: '1.3.6.1.2.1.47.1.1.1.1.5',
  entPhysicalName: '1.3.6.1.2.1.47.1.1.1.1.7',
  entAliasMappingIdentifier: '1.3.6.1.2.1.47.1.3.2.1.2',
  // ENTITY-SENSOR-MIB (RFC 3433) — optical DOM (Rx/Tx dBm, temp, volts, bias)
  entPhySensorType: '1.3.6.1.2.1.99.1.1.1.1',
  entPhySensorScale: '1.3.6.1.2.1.99.1.1.1.2',
  entPhySensorPrecision: '1.3.6.1.2.1.99.1.1.1.3',
  entPhySensorValue: '1.3.6.1.2.1.99.1.1.1.4',
  entPhySensorOperStatus: '1.3.6.1.2.1.99.1.1.1.5',
  entPhySensorUnitsDisplay: '1.3.6.1.2.1.99.1.1.1.6',
  // CISCO-ENTITY-SENSOR-MIB — same semantics, dBm(14) added
  ceSensorType: '1.3.6.1.4.1.9.9.91.1.1.1.1.1',
  ceSensorScale: '1.3.6.1.4.1.9.9.91.1.1.1.1.2',
  ceSensorPrecision: '1.3.6.1.4.1.9.9.91.1.1.1.1.3',
  ceSensorValue: '1.3.6.1.4.1.9.9.91.1.1.1.1.4',
  ceSensorStatus: '1.3.6.1.4.1.9.9.91.1.1.1.1.5',
  // MIKROTIK-MIB mtxrOpticalTable — per-SFP DOM indexed by ifIndex.
  // Columns: .2 name, .6 temp °C, .7 supply mV, .8 tx-bias mA,
  // .9 tx-power dBm*1000, .10 rx-power dBm*1000, .11 vendor, .12 part/serial.
  mtxrOptical: '1.3.6.1.4.1.14988.1.1.19.1.1'
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
  const found = findHrStorageInstances(stor);
  return { memoryPct: found.memoryPct, diskPct: found.diskPct };
}

// Same selection rules as parseStorage, but also returns the winning table
// indexes so light polls can GET those exact cells instead of re-walking.
function findHrStorageInstances(stor) {
  const um = {}, sm = {}, dm = {}, tm = {};
  for (const x of stor || []) {
    const m = String(x.oid || '').match(/\.25\.2\.3\.1\.(\d+)\.(\d+)$/);
    if (!m) continue;
    if (m[1] === '2') tm[m[2]] = String(x.value ?? '').replace(/[^0-9.]/g, '');
    else if (m[1] === '3') dm[m[2]] = x.value?.toString() || '';
    else if (m[1] === '5') sm[m[2]] = Number(x.value) || 0;
    else if (m[1] === '6') um[m[2]] = Number(x.value) || 0;
  }
  let memoryPct = null, memIdx = null;
  for (const i of Object.keys(sm)) {
    if (dm[i] && (dm[i].toLowerCase().includes('ram') || dm[i].toLowerCase().includes('memory') || i === '1')) {
      const total = sm[i] * 1024;
      if (total > 0) { memoryPct = Math.round((um[i] * 1024 / total) * 100); memIdx = i; break; }
    }
  }
  // Main fixed disk = largest hrStorageFixedDisk volume (by total size).
  let diskPct = null, diskIdx = null;
  let bestSize = 0;
  for (const i of Object.keys(sm)) {
    if (tm[i] && tm[i].endsWith('25.2.1.4') && sm[i] > 0) {
      const pct = Math.round(((um[i] || 0) / sm[i]) * 100);
      if (sm[i] > bestSize) { bestSize = sm[i]; diskPct = pct; diskIdx = i; }
    }
  }
  return { memoryPct, diskPct, memIdx, diskIdx };
}

// Per-device host-resource instance cache (deviceId -> {cpu:[idx], memU, memS,
// diskU, diskS, ts}). Full walks (and light-walk fallbacks) record the exact
// cells; light polls then GET those cells in one parallel batch — a couple of
// round trips instead of a per-row GETNEXT walk over high-RTT links.
const _hrCache = new Map();

function recordHrCache(deviceId, loadsRows, storRows) {
  try {
    if (deviceId == null) return;
    const cpu = [];
    for (const x of loadsRows || []) {
      const idx = String(x.oid || '').match(/\.(\d+)$/)?.[1];
      if (idx) cpu.push(idx);
    }
    const found = findHrStorageInstances(storRows);
    if (!cpu.length && !found.memIdx && !found.diskIdx) return;
    _hrCache.set(deviceId, {
      cpu,
      memU: found.memIdx ? OIDS.hrStorageUsed + '.' + found.memIdx : null,
      memS: found.memIdx ? OIDS.hrStorageSize + '.' + found.memIdx : null,
      diskU: found.diskIdx ? OIDS.hrStorageUsed + '.' + found.diskIdx : null,
      diskS: found.diskIdx ? OIDS.hrStorageSize + '.' + found.diskIdx : null,
      ts: Date.now()
    });
  } catch {}
}

// Compute cpu/memory/disk from targeted-GET values using the same math as
// parseStorage. vals: {cpu:[raw], memU, memS, diskU, diskS}.
function computeHrFromCells(vals) {
  const out = { cpuLoad: null, memoryPct: null, diskPct: null };
  try {
    const nums = (vals.cpu || []).map(Number).filter((n) => isFinite(n));
    if (nums.length) out.cpuLoad = Math.round(nums.reduce((s, c) => s + c, 0) / nums.length);
    const memS = Number(vals.memS), memU = Number(vals.memU);
    if (isFinite(memS) && isFinite(memU)) {
      const total = memS * 1024;
      if (total > 0) out.memoryPct = Math.round((memU * 1024 / total) * 100);
    }
    const diskS = Number(vals.diskS), diskU = Number(vals.diskU);
    if (isFinite(diskS) && diskS > 0) out.diskPct = Math.round(((isFinite(diskU) ? diskU : 0) / diskS) * 100);
  } catch {}
  return out;
}

// ── SFP / fiber DOM (digital optical monitoring) ─────────────────────
// Reads ENTITY-SENSOR-MIB (RFC 3433) and CISCO-ENTITY-SENSOR-MIB sensor
// tables and maps each sensor to an ifIndex, so a link bound to an SFP /
// fiber interface can show Rx/Tx optical power (dBm).
// Mapping strategy per sensor entPhysicalIndex:
//   1. entAliasMappingIdentifier -> ifIndex OID (direct, most reliable)
//   2. walk up entPhysicalContainedIn parents for such a mapping
//   3. substring match of sensor/parent descr+name against ifDescr
// Scale/precision (RFC 3433): actual = raw * 10^((scale-9)*3 - precision).
// watts(6) optical power is converted to dBm: 10*log10(W*1000).

const SENSOR_TYPE = { OTHER: 1, UNKNOWN: 2, VOLTS_AC: 3, VOLTS_DC: 4, AMPERES: 5, WATTS: 6, HERTZ: 7, CELSIUS: 8, DBM: 14 };

function scaleToExponent(scale) {
  const s = Number(scale);
  if (!isFinite(s)) return 0;
  if (s >= 1 && s <= 17) return (s - 9) * 3;
  if (s >= -24 && s <= 24) return s; // defensive: agent already sent exponent
  return 0;
}

function sensorActual(raw, scale, precision) {
  const r = Number(raw);
  if (!isFinite(r)) return null;
  const exp = scaleToExponent(scale);
  let prec = Number(precision);
  if (!isFinite(prec)) prec = 0;
  if (prec < -8) prec = -8;
  if (prec > 9) prec = 9;
  const v = r * Math.pow(10, exp - prec);
  return isFinite(v) ? v : null;
}

function wattsToDbm(w) {
  const x = Number(w);
  if (!isFinite(x) || x <= 0) return null;
  const dbm = 10 * Math.log10(x * 1000);
  if (!isFinite(dbm) || dbm < -60 || dbm > 30) return null; // sanity: DOM range
  return Math.round(dbm * 100) / 100;
}

function round2(v) {
  if (v === null || v === undefined || !isFinite(Number(v))) return null;
  return Math.round(Number(v) * 100) / 100;
}

// Heuristic: does this interface look like SFP/fiber from its name?
function isSfpInterfaceName(ifName) {
  if (!ifName) return false;
  return /sfp|sfp\+|xfp|qsfp|cfp|fiber|fibre|optic|pon|gpon|combo|spsfp|mini-?gbic/i.test(String(ifName));
}

function classifyDomSensor(ctx) {
  // ctx: { type, units, descr, name, parentDescr, parentName }
  const text = [ctx.descr, ctx.name, ctx.parentDescr, ctx.parentName, ctx.units].filter(Boolean).join(' | ').toLowerCase();
  const has = (...subs) => subs.some((s) => text.includes(s));
  const rxWord = has('rx power', 'receive power', 'rx-pwr', 'rx_pwr', 'rx optical', 'optical rx', 'rx level', 'input power', 'rx_pwr(') || (/rx\b/.test(text) && has('power', 'dbm', 'optical', 'watt'));
  const txWord = has('tx power', 'transmit power', 'tx-pwr', 'tx_pwr', 'tx optical', 'optical tx', 'tx level', 'output power', 'tx_pwr(') || (/tx\b/.test(text) && has('power', 'dbm', 'optical', 'watt'));
  if (rxWord && !txWord) return 'rx';
  if (txWord && !rxWord) return 'tx';
  if (has('temperatur')) return 'temp';
  if (has('tx bias', 'laser bias', 'bias current', 'bias')) return 'bias';
  if (has('vcc', 'voltage', 'volt')) return 'voltage';
  // Fall back to sensor type when text is silent (e.g. bare "Sensor 42").
  const t = Number(ctx.type);
  if (t === SENSOR_TYPE.CELSIUS) return 'temp';
  if (t === SENSOR_TYPE.VOLTS_AC || t === SENSOR_TYPE.VOLTS_DC) return 'voltage';
  if (t === SENSOR_TYPE.AMPERES) return 'bias';
  return null; // watts/dBm without rx/tx direction stay unmapped (no guessing)
}

function ifIndexFromAliasValue(v) {
  if (v === null || v === undefined) return null;
  const s = Array.isArray(v) ? v.join('.') : String(v);
  // ifIndex mapping identifier: ...1.3.6.1.2.1.2.2.1.1.<ifIndex>
  let m = s.match(/1\.3\.6\.1\.2\.1\.2\.2\.1\.1\.(\d+)/);
  if (m) return parseInt(m[1], 10);
  return null;
}

function mapDomSensorsToInterfaces(interfaces, phys, sensors) {
  // phys: { descr{}, name{}, containedIn{}, aliasIf{} } keyed by entIndex string
  // sensors: [{ ent, type, scale, precision, value, units, src }]
  const byIfIndex = {};
  if (!interfaces || !interfaces.length || !sensors || !sensors.length) return byIfIndex;
  const ifByIndex = {};
  const ifNames = [];
  for (const i of interfaces) {
    if (i.if_index == null) continue;
    ifByIndex[String(i.if_index)] = i;
    if (i.if_name) ifNames.push({ idx: i.if_index, lower: String(i.if_name).toLowerCase(), raw: String(i.if_name) });
  }
  const textFor = (ent) => ({
    descr: phys.descr[String(ent)] || '',
    name: phys.name[String(ent)] || '',
    parentDescr: '',
    parentName: ''
  });
  const resolveIfIndex = (ent) => {
    // 1. direct alias mapping
    if (phys.aliasIf[String(ent)] != null) return phys.aliasIf[String(ent)];
    // 2. walk up containment (sensor -> SFP container -> slot -> ...)
    let cur = String(ent);
    const seen = new Set();
    for (let d = 0; d < 6; d++) {
      if (seen.has(cur)) break;
      seen.add(cur);
      const parent = phys.containedIn[cur];
      if (parent == null || parent === '0' || parent === 0) break;
      const p = String(parent);
      if (phys.aliasIf[p] != null) return phys.aliasIf[p];
      // parent descr/name directly names the interface?
      const pd = String(phys.descr[p] || '').toLowerCase();
      const pn = String(phys.name[p] || '').toLowerCase();
      if (pd || pn) {
        for (const n of ifNames) {
          if (n.lower && (pd.includes(n.lower) || pn.includes(n.lower))) return n.idx;
        }
      }
      cur = p;
    }
    // 3. fuzzy match sensor + parent text against ifDescr
    const t = textFor(ent);
    // enrich with parent chain text
    let cur2 = String(ent);
    const seen2 = new Set();
    for (let d = 0; d < 6; d++) {
      if (seen2.has(cur2)) break;
      seen2.add(cur2);
      const parent = phys.containedIn[cur2];
      if (parent == null || parent === '0' || parent === 0) break;
      const p = String(parent);
      if (phys.descr[p]) t.parentDescr += ' ' + phys.descr[p];
      if (phys.name[p]) t.parentName += ' ' + phys.name[p];
      cur2 = p;
    }
    const hay = [t.descr, t.name, t.parentDescr, t.parentName].join(' | ').toLowerCase();
    if (hay.trim()) {
      for (const n of ifNames) {
        if (n.lower && hay.includes(n.lower)) return n.idx;
      }
      // short-form: interface "SFP1" vs sensor "sfp-1 rx power"
      for (const n of ifNames) {
        const squashed = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const a = squashed(n.lower);
        if (a.length >= 4 && squashed(hay).includes(a)) return n.idx;
      }
    }
    return null;
  };

  for (const s of sensors) {
    try {
      if (s.value === null || s.value === undefined) continue;
      const t = textFor(s.ent);
      // attach parent text for classification as well
      let cur = String(s.ent);
      const seen = new Set();
      for (let d = 0; d < 6; d++) {
        if (seen.has(cur)) break;
        seen.add(cur);
        const parent = phys.containedIn[cur];
        if (parent == null || parent === '0' || parent === 0) break;
        const p = String(parent);
        if (phys.descr[p]) t.parentDescr += ' ' + phys.descr[p];
        if (phys.name[p]) t.parentName += ' ' + phys.name[p];
        cur = p;
      }
      const kind = classifyDomSensor({ type: s.type, units: s.units, descr: t.descr, name: t.name, parentDescr: t.parentDescr, parentName: t.parentName });
      if (!kind) continue;
      const ifIndex = resolveIfIndex(s.ent);
      if (ifIndex == null || !ifByIndex[String(ifIndex)]) continue;
      const actual = sensorActual(s.value, s.scale, s.precision);
      if (actual === null) continue;
      const key = String(ifIndex);
      if (!byIfIndex[key]) byIfIndex[key] = {};
      const unitsLower = String(s.units || '').toLowerCase();
      const typ = Number(s.type);
      if (kind === 'rx' || kind === 'tx') {
        let dbm = null;
        if (typ === SENSOR_TYPE.WATTS) dbm = wattsToDbm(actual);
        else if (typ === SENSOR_TYPE.DBM || unitsLower.includes('dbm')) {
          dbm = actual;
          if (!isFinite(dbm) || dbm < -60 || dbm > 30) continue;
          dbm = round2(dbm);
        } else if (unitsLower.includes('watt') || unitsLower === 'w') dbm = wattsToDbm(actual);
        else if (typ === SENSOR_TYPE.WATTS || typ === SENSOR_TYPE.OTHER || typ === SENSOR_TYPE.UNKNOWN) {
          // Ambiguous unit: accept plausible dBm range directly, else try watts.
          if (actual <= 30 && actual >= -60) dbm = round2(actual);
          else dbm = wattsToDbm(actual);
        } else dbm = round2(actual);
        if (dbm === null) continue;
        byIfIndex[key][kind === 'rx' ? 'rxDbm' : 'txDbm'] = dbm;
      } else if (kind === 'temp') {
        if (actual < -50 || actual > 150) continue;
        byIfIndex[key].tempC = round2(actual);
      } else if (kind === 'voltage') {
        if (actual < 0 || actual > 20) continue;
        byIfIndex[key].voltageV = round2(actual);
      } else if (kind === 'bias') {
        let ma = null;
        if (typ === SENSOR_TYPE.AMPERES) ma = actual * 1000;
        else if (unitsLower.includes('ma')) ma = actual;
        else if (unitsLower.includes('ua')) ma = actual / 1000;
        else if (unitsLower.includes(' a') || unitsLower === 'a') ma = actual * 1000;
        else ma = actual < 1 ? actual * 1000 : actual; // bias usually single-digit mA
        if (!isFinite(ma) || ma < 0 || ma > 200) continue;
        byIfIndex[key].biasMa = round2(ma);
      }
    } catch {}
  }
  return byIfIndex;
}

function rowsByIndex(rows) {
  const m = {};
  for (const r of rows || []) {
    const idx = String(r.oid || '').match(/\.(\d+)$/)?.[1];
    if (idx) m[idx] = r.value;
  }
  return m;
}

// In-memory DOM layout cache: deviceId -> { byEnt: {ent: {ifIndex, kind, type, scale, precision, src}}, ts }
const _domCache = new Map();

function buildDomCacheEntry(interfaces, phys, sensorMeta) {
  // sensorMeta: [{ ent, type, scale, precision, units, src, descr, name, parentDescr, parentName }]
  const byEnt = {};
  if (!interfaces || !interfaces.length) return { byEnt, ts: Date.now() };
  const ifByIndex = {};
  interfaces.forEach((i) => { if (i.if_index != null) ifByIndex[String(i.if_index)] = i; });
  const ifNames = interfaces.filter((i) => i.if_name).map((i) => ({ idx: i.if_index, lower: String(i.if_name).toLowerCase() }));
  const resolve = (ent) => {
    if (phys.aliasIf[String(ent)] != null) return phys.aliasIf[String(ent)];
    let cur = String(ent);
    const seen = new Set();
    for (let d = 0; d < 6; d++) {
      if (seen.has(cur)) break;
      seen.add(cur);
      const parent = phys.containedIn[cur];
      if (parent == null || parent === '0' || parent === 0) break;
      const p = String(parent);
      if (phys.aliasIf[p] != null) return phys.aliasIf[p];
      const pd = String(phys.descr[p] || '').toLowerCase();
      const pn = String(phys.name[p] || '').toLowerCase();
      for (const n of ifNames) if (n.lower && (pd.includes(n.lower) || pn.includes(n.lower))) return n.idx;
      cur = p;
    }
    return null;
  };
  for (const s of sensorMeta) {
    try {
      const kind = classifyDomSensor(s);
      if (!kind) continue;
      let ifIndex = resolve(s.ent);
      if (ifIndex == null) {
        // fuzzy fallback on combined text
        const hay = [s.descr, s.name, s.parentDescr, s.parentName].join(' | ').toLowerCase();
        for (const n of ifNames) if (n.lower && hay.includes(n.lower)) { ifIndex = n.idx; break; }
      }
      if (ifIndex == null || !ifByIndex[String(ifIndex)]) continue;
      byEnt[String(s.ent)] = { ifIndex, kind, type: s.type, scale: s.scale, precision: s.precision, units: s.units, src: s.src };
    } catch {}
  }
  return { byEnt, ts: Date.now() };
}

// Full DOM discovery (heavy: ENTITY + sensor walks). Returns byIfIndex map.
// deviceId may be null (ad-hoc); when given, the sensor->ifIndex layout is
// cached so cheap light polls can refresh values without re-walking ENTITY.
async function pollDomFull(session, deviceId, interfaces, cap) {
  const negCache = () => { try { if (deviceId != null) _domCache.set(deviceId, { byEnt: {}, ts: Date.now() }); } catch {} };
  try {
    if (!interfaces || !interfaces.length) return {};
    // Cheap probes first: ENTITY/Cisco sensor values + MikroTik optical table.
    const [probeEntity, probeCisco, probeMtxr] = await Promise.all([
      cap('domProbe', snmpWalk(session, OIDS.entPhySensorValue, 50)),
      cap('domProbeC', snmpWalk(session, OIDS.ceSensorValue, 50)),
      cap('domProbeM', snmpWalk(session, OIDS.mtxrOptical, 100))
    ]);
    const mtxrByIf = parseMtxrOptical(probeMtxr, interfaces);
    try {
      if (deviceId != null) _mtxrProbe.set(deviceId, { ok: !!(probeMtxr && probeMtxr.length), ts: Date.now() });
    } catch {}
    if ((!probeEntity || !probeEntity.length) && (!probeCisco || !probeCisco.length)) {
      // No ENTITY/Cisco sensors: MikroTik-only devices still get optics.
      negCache();
      return mtxrByIf;
    }
    const [pDescr, pName, pCont, pClass, pAlias, tType, tScale, tPrec, tVal, tStatus, tUnits, cType, cScale, cPrec, cVal, cStatus] = await Promise.all([
      cap('entDescr', snmpWalk(session, OIDS.entPhysicalDescr)),
      cap('entName', snmpWalk(session, OIDS.entPhysicalName)),
      cap('entCont', snmpWalk(session, OIDS.entPhysicalContainedIn)),
      cap('entClass', snmpWalk(session, OIDS.entPhysicalClass)),
      cap('entAlias', snmpWalk(session, OIDS.entAliasMappingIdentifier)),
      cap('senType', snmpWalk(session, OIDS.entPhySensorType)),
      cap('senScale', snmpWalk(session, OIDS.entPhySensorScale)),
      cap('senPrec', snmpWalk(session, OIDS.entPhySensorPrecision)),
      Promise.resolve(probeEntity && probeEntity.length ? probeEntity : cap('senVal', snmpWalk(session, OIDS.entPhySensorValue, 50))),
      cap('senStatus', snmpWalk(session, OIDS.entPhySensorOperStatus)),
      cap('senUnits', snmpWalk(session, OIDS.entPhySensorUnitsDisplay)),
      cap('ceType', snmpWalk(session, OIDS.ceSensorType)),
      cap('ceScale', snmpWalk(session, OIDS.ceSensorScale)),
      cap('cePrec', snmpWalk(session, OIDS.ceSensorPrecision)),
      Promise.resolve(probeCisco && probeCisco.length ? probeCisco : cap('ceVal', snmpWalk(session, OIDS.ceSensorValue, 50))),
      cap('ceStatus', snmpWalk(session, OIDS.ceSensorStatus))
    ]);
    const descrM = rowsByIndex(pDescr);
    const nameM = rowsByIndex(pName);
    const contM = rowsByIndex(pCont);
    const aliasM = rowsByIndex(pAlias);
    const phys = { descr: {}, name: {}, containedIn: {}, aliasIf: {} };
    Object.keys(descrM).forEach((k) => { phys.descr[k] = Buffer.isBuffer(descrM[k]) ? descrM[k].toString('utf8') : String(descrM[k] ?? ''); });
    Object.keys(nameM).forEach((k) => { phys.name[k] = Buffer.isBuffer(nameM[k]) ? nameM[k].toString('utf8') : String(nameM[k] ?? ''); });
    Object.keys(contM).forEach((k) => { phys.containedIn[k] = Number(contM[k]); });
    Object.keys(aliasM).forEach((k) => { const ii = ifIndexFromAliasValue(aliasM[k]); if (ii != null) phys.aliasIf[k] = ii; });
    void pClass; void tStatus; void cStatus;

    const typeM = rowsByIndex(tType);
    const scaleM = rowsByIndex(tScale);
    const precM = rowsByIndex(tPrec);
    const valM = rowsByIndex(tVal);
    const unitsM = rowsByIndex(tUnits);
    const cTypeM = rowsByIndex(cType);
    const cScaleM = rowsByIndex(cScale);
    const cPrecM = rowsByIndex(cPrec);
    const cValM = rowsByIndex(cVal);

    const sensors = [];
    const sensorMeta = [];
    const allEnts = new Set([...Object.keys(valM), ...Object.keys(cValM)]);
    for (const ent of allEnts) {
      if (valM[ent] !== undefined) {
        const units = unitsM[ent] !== undefined ? (Buffer.isBuffer(unitsM[ent]) ? unitsM[ent].toString('utf8') : String(unitsM[ent])) : '';
        sensors.push({ ent, type: typeM[ent] !== undefined ? Number(typeM[ent]) : null, scale: scaleM[ent] !== undefined ? Number(scaleM[ent]) : 9, precision: precM[ent] !== undefined ? Number(precM[ent]) : 0, value: Number(valM[ent]), units, src: 'entity' });
      }
      if (cValM[ent] !== undefined && cValM[ent] !== null && String(cValM[ent]) !== '') {
        sensors.push({ ent, type: cTypeM[ent] !== undefined ? Number(cTypeM[ent]) : null, scale: cScaleM[ent] !== undefined ? Number(cScaleM[ent]) : 9, precision: cPrecM[ent] !== undefined ? Number(cPrecM[ent]) : 0, value: Number(cValM[ent]), units: 'cisco', src: 'cisco' });
      }
    }
    // parent text for meta
    for (const s of sensors) {
      let pd = '', pn = '';
      let cur = String(s.ent);
      const seen = new Set();
      for (let d = 0; d < 6; d++) {
        if (seen.has(cur)) break;
        seen.add(cur);
        const parent = phys.containedIn[cur];
        if (parent == null || parent === '0' || parent === 0) break;
        const p = String(parent);
        if (phys.descr[p]) pd += ' ' + phys.descr[p];
        if (phys.name[p]) pn += ' ' + phys.name[p];
        cur = p;
      }
      sensorMeta.push({ ent: s.ent, type: s.type, scale: s.scale, precision: s.precision, units: s.units, src: s.src, descr: phys.descr[String(s.ent)] || '', name: phys.name[String(s.ent)] || '', parentDescr: pd, parentName: pn });
    }
    const out = mapDomSensorsToInterfaces(interfaces, phys, sensors);
    // MikroTik optical readings merge in (indexed by ifIndex, no mapping
    // ambiguity); they fill ports the ENTITY walk didn't cover.
    try {
      for (const [k, v] of Object.entries(mtxrByIf)) {
        out[k] = Object.assign({}, out[k], v);
      }
    } catch {}
    try {
      // Always (re)build the layout cache — including the empty one, so light
      // polls don't request a full re-poll every cycle for DOM-less devices.
      if (deviceId != null) _domCache.set(deviceId, sensorMeta.length ? buildDomCacheEntry(interfaces, phys, sensorMeta) : { byEnt: {}, ts: Date.now() });
    } catch {}
    return out;
  } catch { return {}; }
}

// Light DOM refresh. Returns { map, needFull } — map is byIfIndex DOM for the
// given (bound) interfaces, needFull asks the engine for one background full
// poll to (re)build the ENTITY sensor layout. ENTITY values reuse the cached
// layout (values-only walks); MikroTik optics walk their single table,
// gated by a capability probe so other vendors pay no per-cycle cost.
async function pollDomLight(session, deviceId, interfaces, cap) {
  const ret = (map, needFull) => ({ map, needFull: !!needFull });
  try {
    if (!interfaces || !interfaces.length) return ret({}, false);
    const now = Date.now();
    const cached = _domCache.get(deviceId);
    const layoutEnts = cached && cached.byEnt ? Object.keys(cached.byEnt) : [];
    const layoutStale = !cached || (layoutEnts.length === 0 && now - (cached.ts || 0) > 3600000);
    const probe = _mtxrProbe.get(deviceId);
    const wantMtxr = !probe || probe.ok || now - (probe.ts || 0) > 3600000;
    if (!layoutEnts.length && !wantMtxr) {
      // Layout unknown/negative-fresh and optics known-absent: nothing to do,
      // unless the negative layout is stale (>1h) — then one full re-probe.
      return ret({}, layoutStale);
    }
    const jobs = [];
    if (layoutEnts.length) {
      jobs.push(cap('senVal', snmpWalk(session, OIDS.entPhySensorValue, 50)));
      jobs.push(cap('ceVal', snmpWalk(session, OIDS.ceSensorValue, 50)));
    } else {
      jobs.push(Promise.resolve([]), Promise.resolve([]));
    }
    // Known-capable MikroTik: GET just the bound SFP cells (~1 RTT) instead
    // of walking the whole optical table. Unknown devices still walk once
    // for capability discovery.
    let mGetOids = null;
    if (wantMtxr && probe && probe.ok) {
      mGetOids = [];
      for (const b of interfaces) {
        if (!b || b.if_index == null) continue;
        for (const col of ['2', '6', '7', '8', '9', '10']) mGetOids.push(OIDS.mtxrOptical + '.' + col + '.' + b.if_index);
      }
      if (!mGetOids.length) mGetOids = null;
    }
    if (mGetOids) jobs.push(Promise.all(mGetOids.map((o) => snmpGet(session, o).catch(() => null))));
    else if (wantMtxr) jobs.push(cap('domMtxr', snmpWalk(session, OIDS.mtxrOptical, 100)));
    else jobs.push(Promise.resolve(null)); // null = skipped, not a failure
    const [eVal, cVal, mVal] = await Promise.all(jobs);
    const byIfIndex = {};
    if (layoutEnts.length) {
      const eM = rowsByIndex(eVal);
      const cM = rowsByIndex(cVal);
      for (const [ent, meta] of Object.entries(cached.byEnt)) {
      try {
        let raw = null;
        if (meta.src === 'cisco') raw = cM[ent] !== undefined ? Number(cM[ent]) : null;
        else raw = eM[ent] !== undefined ? Number(eM[ent]) : null;
        if (raw === null || !isFinite(raw)) continue;
        const actual = sensorActual(raw, meta.scale != null ? meta.scale : 9, meta.precision);
        const typ = Number(meta.type);
        const unitsLower = String(meta.units || '').toLowerCase();
        const key = String(meta.ifIndex);
        if (!byIfIndex[key]) byIfIndex[key] = {};
        if (meta.kind === 'rx' || meta.kind === 'tx') {
          let dbm = null;
          if (typ === SENSOR_TYPE.WATTS) dbm = wattsToDbm(actual);
          else if (typ === SENSOR_TYPE.DBM || unitsLower.includes('dbm')) {
            if (!isFinite(actual) || actual < -60 || actual > 30) continue;
            dbm = round2(actual);
          } else if (unitsLower.includes('watt') || unitsLower === 'w') dbm = wattsToDbm(actual);
          else if (actual <= 30 && actual >= -60) dbm = round2(actual);
          else dbm = wattsToDbm(actual);
          if (dbm === null) continue;
          byIfIndex[key][meta.kind === 'rx' ? 'rxDbm' : 'txDbm'] = dbm;
        } else if (meta.kind === 'temp') {
          if (actual < -50 || actual > 150) continue;
          byIfIndex[key].tempC = round2(actual);
        } else if (meta.kind === 'voltage') {
          if (actual < 0 || actual > 20) continue;
          byIfIndex[key].voltageV = round2(actual);
        } else if (meta.kind === 'bias') {
          let ma;
          if (typ === SENSOR_TYPE.AMPERES) ma = actual * 1000;
          else if (unitsLower.includes('ma')) ma = actual;
          else if (unitsLower.includes('ua')) ma = actual / 1000;
          else ma = actual < 1 ? actual * 1000 : actual;
          if (!isFinite(ma) || ma < 0 || ma > 200) continue;
          byIfIndex[key].biasMa = round2(ma);
        }
      } catch {}
    }
    let needFull = false;
    try {
      if (mVal !== null) {
        let rows;
        if (mGetOids) {
          // Targeted-GET path: reassemble walk-shaped rows for the parser.
          rows = [];
          mGetOids.forEach((o, n) => { if (mVal[n] !== null && mVal[n] !== undefined) rows.push({ oid: o, value: mVal[n] }); });
          try { _mtxrProbe.set(deviceId, { ok: true, ts: Date.now() }); } catch {}
        } else {
          // Walk path: refresh capability stamp and merge readings.
          rows = Array.isArray(mVal) ? mVal : [];
          try { _mtxrProbe.set(deviceId, { ok: rows.length > 0, ts: Date.now() }); } catch {}
        }
        const mByIf = parseMtxrOptical(rows, interfaces);
        for (const [k, v] of Object.entries(mByIf)) byIfIndex[k] = Object.assign({}, byIfIndex[k], v);
      }
      if (!layoutEnts.length && !(_mtxrProbe.get(deviceId) || {}).ok) {
        // Neither ENTITY layout nor optics: one full poll to be sure, unless
        // we already hold a fresh negative layout (then stay quiet).
        const c = _domCache.get(deviceId);
        needFull = !c || Date.now() - (c.ts || 0) > 3600000;
      }
    } catch {}
    return ret(byIfIndex, needFull);
    } // end if (layoutEnts.length)
  } catch { return { map: {}, needFull: false }; }
}

// MikroTik mtxrOpticalTable (indexed by ifIndex): .2 name, .6 temp °C,
// .7 supply mV, .8 tx-bias mA, .9 tx dBm*1000, .10 rx dBm*1000.
// All-zero rows (port down / no DDM) are skipped, never stored as 0 dBm.
function parseMtxrOptical(rows, interfaces) {
  const out = {};
  if (!rows || !rows.length) return out;
  const cols = {};
  for (const r of rows) {
    const m = String(r.oid || '').match(/\.19\.1\.1\.(\d+)\.(\d+)$/);
    if (!m) continue;
    (cols[m[1]] = cols[m[1]] || {})[m[2]] = r.value;
  }
  const names = cols['2'] || {};
  const ifByIndex = {};
  const ifByName = {};
  for (const i of interfaces || []) {
    if (i.if_index != null) ifByIndex[String(i.if_index)] = i;
    if (i.if_name) ifByName[String(i.if_name).toLowerCase()] = i;
  }
  const str = (v) => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v ?? ''));
  for (const idx of Object.keys(names)) {
    try {
      const rxRaw = Number(cols['10']?.[idx]);
      const txRaw = Number(cols['9']?.[idx]);
      const tempRaw = Number(cols['6']?.[idx]);
      const voltRaw = Number(cols['7']?.[idx]);
      const biasRaw = Number(cols['8']?.[idx]);
      if (!isFinite(rxRaw) || !isFinite(txRaw)) continue;
      // All-zero row = no live DOM (SFP absent/down) — skip, don't show 0 dBm.
      if (rxRaw === 0 && txRaw === 0 && !(tempRaw > 0) && !(voltRaw > 0)) continue;
      const rxDbm = round2(rxRaw / 1000);
      const txDbm = round2(txRaw / 1000);
      if (!isFinite(rxDbm) || rxDbm < -40 || rxDbm > 10) continue;
      if (!isFinite(txDbm) || txDbm < -40 || txDbm > 10) continue;
      let key = null;
      if (ifByIndex[idx]) key = String(ifByIndex[idx].if_index);
      else {
        const nm = str(names[idx]).toLowerCase();
        if (nm && ifByName[nm]) key = String(ifByName[nm].if_index);
      }
      if (key === null) continue;
      const entry = { rxDbm, txDbm };
      if (isFinite(tempRaw) && tempRaw > -40 && tempRaw < 100) entry.tempC = round2(tempRaw);
      if (isFinite(voltRaw) && voltRaw > 0 && voltRaw < 6600) entry.voltageV = round2(voltRaw / 1000);
      if (isFinite(biasRaw) && biasRaw >= 0 && biasRaw < 200) entry.biasMa = round2(biasRaw);
      out[key] = entry;
    } catch {}
  }
  return out;
}

// Per-device MikroTik-optical capability probe cache (deviceId -> ts ms).
// Light polls walk the optical table only for capable devices; failures are
// remembered for an hour so non-MikroTik devices pay no per-cycle cost.
const _mtxrProbe = new Map(); // deviceId -> { ok: bool, ts: number }

function applyDomToInterfaces(interfaces, byIfIndex, opts) {  const full = !!(opts && opts.full);
  const hasAny = byIfIndex && Object.keys(byIfIndex).length > 0;
  for (const i of interfaces || []) {
    if (i.if_index == null) continue;
    const d = byIfIndex ? byIfIndex[String(i.if_index)] : null;
    if (d) {
      if (d.rxDbm !== undefined) i.sfp_rx_dbm = d.rxDbm;
      if (d.txDbm !== undefined) i.sfp_tx_dbm = d.txDbm;
      if (d.tempC !== undefined) i.sfp_temp_c = d.tempC;
      if (d.voltageV !== undefined) i.sfp_voltage_v = d.voltageV;
      if (d.biasMa !== undefined) i.sfp_bias_ma = d.biasMa;
    } else if (full && hasAny) {
      // Full discovery proved DOM support (≥1 sensor mapped): interfaces
      // without DOM are copper — clear any stale optical values.
      // When nothing was discovered at all (unsupported/transient), leave
      // stored values untouched instead of wiping them.
      i.sfp_rx_dbm = null;
      i.sfp_tx_dbm = null;
      i.sfp_temp_c = null;
      i.sfp_voltage_v = null;
      i.sfp_bias_ma = null;
    }
  }
}


async function pollDevice(device) {
  let session;
  try { session = createSession(device); } catch (e) { return { error: 'session failed: ' + (e.message || e), errors: ['session: ' + (e.message || e)] }; }

  const result = { deviceId: device.id, ip: device.ip_address, sysDescr: null, sysName: null, sysUpTime: null, cpuLoad: null, memoryPct: null, diskPct: null, interfaces: [], errors: [], timestamp: new Date().toISOString() };
  const errMsg = (e) => (e && e.message ? e.message : String(e));
  const cap = async (label, promise) => { try { return await promise; } catch (e) { result.errors.push(label + ': ' + errMsg(e)); return []; } };

  try {
    const [d, n, u] = await Promise.all([snmpGet(session, OIDS.sysDescr).catch(()=>null), snmpGet(session, OIDS.sysName).catch(()=>null), snmpGet(session, OIDS.sysUpTime).catch(()=>null)]);
    result.sysDescr = d?.toString() || null;
    result.sysName = n?.toString() || null;
    const cs = Number(u);
    result.sysUpTime = (u !== null && u !== undefined && isFinite(cs) && cs >= 0) ? Math.round(cs) : null;
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

  let hrLoads = [], hrStor = [];
  try {
    hrLoads = await cap('hrProcessorLoad', snmpWalk(session, OIDS.hrProcessorLoad));
    if (hrLoads.length > 0) result.cpuLoad = Math.round(hrLoads.reduce((s,c) => s + (Number(c.value)||0), 0) / hrLoads.length);
  } catch {}

  try {
    hrStor = await cap('hrStorage', snmpWalk(session, OIDS.hrStorage));
    const parsed = parseStorage(hrStor);
    result.memoryPct = parsed.memoryPct;
    result.diskPct = parsed.diskPct;
  } catch {}
  // Remember exact hr cells so light polls can GET them instead of walking.
  recordHrCache(device.id, hrLoads, hrStor);

  // SFP/DOM optical power (best-effort: never fails the poll).
  try {
    if (result.interfaces && result.interfaces.length) {
      const domByIf = await pollDomFull(session, device.id, result.interfaces, cap);
      applyDomToInterfaces(result.interfaces, domByIf, { full: true });
    }
  } catch {}

  try { session.close(); } catch {}
  return result;
}

// Light poll (5s cadence): CPU/RAM/disk plus targeted GETs for map-bound
// interfaces only — no full table walks. boundIfs = [{if_index, if_name}].
async function pollLight(device, boundIfs) {
  let session;
  try { session = createSession(device); } catch (e) { return { error: 'session failed: ' + (e.message || e), errors: ['session: ' + (e.message || e)] }; }

  const result = { deviceId: device.id, ip: device.ip_address, sysDescr: null, sysName: null, sysUpTime: null, cpuLoad: null, memoryPct: null, diskPct: null, interfaces: [], errors: [], timestamp: new Date().toISOString() };
  const errMsg = (e) => (e && e.message ? e.message : String(e));
  const cap = async (label, promise) => { try { return await promise; } catch (e) { if (result.errors.length < 8) result.errors.push(label + ': ' + errMsg(e)); return []; } };
  // sysUpTime rides along concurrently (single cheap GET, awaited at the end).
  const upP = snmpGet(session, OIDS.sysUpTime).catch(() => null);

  // Fast path: GET the exact hr cells recorded by an earlier walk (one
  // parallel batch, ~1 RTT) instead of two per-row GETNEXT walks.
  let hrDone = false;
  try {
    const hr = _hrCache.get(device.id);
    if (hr && (hr.cpu.length || hr.memU || hr.diskU)) {
      const getOids = [];
      hr.cpu.forEach((i) => getOids.push({ k: 'cpu' + i, oid: OIDS.hrProcessorLoad + '.' + i }));
      if (hr.memU) { getOids.push({ k: 'memU', oid: hr.memU }); getOids.push({ k: 'memS', oid: hr.memS }); }
      if (hr.diskU) { getOids.push({ k: 'diskU', oid: hr.diskU }); getOids.push({ k: 'diskS', oid: hr.diskS }); }
      const vals = await Promise.all(getOids.map((g) => snmpGet(session, g.oid).catch(() => null)));
      const byK = {};
      getOids.forEach((g, n) => { byK[g.k] = vals[n]; });
      const computed = computeHrFromCells({
        cpu: hr.cpu.map((i) => byK['cpu' + i]),
        memU: byK.memU, memS: byK.memS, diskU: byK.diskU, diskS: byK.diskS
      });
      if (computed.cpuLoad !== null || computed.memoryPct !== null || computed.diskPct !== null) {
        result.cpuLoad = computed.cpuLoad;
        result.memoryPct = computed.memoryPct;
        result.diskPct = computed.diskPct;
        hrDone = true;
      }
    }
  } catch {}
  if (!hrDone) {
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
    // Walk fallback also (re)builds the cache for subsequent fast cycles.
    recordHrCache(device.id, loads, stor);
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

  // SFP/DOM refresh for bound interfaces (values-only walks via layout cache
  // plus a capability-gated MikroTik optical walk). needFull asks the engine
  // for one background full poll to (re)build the sensor->ifIndex layout.
  try {
    if (result.interfaces.length) {
      const dom = await pollDomLight(session, device.id, result.interfaces, cap);
      if (dom && dom.needFull) result.domFullPollNeeded = true;
      if (dom && dom.map) applyDomToInterfaces(result.interfaces, dom.map, { full: false });
    }
  } catch {}

  if (result.cpuLoad === null && result.memoryPct === null && result.diskPct === null && result.interfaces.length === 0) {
    result.error = 'no response';
    result.errors.push('system: no response');
  }

  try {
    const u = await upP;
    const cs = Number(u);
    result.sysUpTime = (u !== null && u !== undefined && isFinite(cs) && cs >= 0) ? Math.round(cs) : null;
  } catch {}

  try { session.close(); } catch {}
  return result;
}

async function saveInterfaces(deviceId, interfaces) {
  const cols = ['if_name', 'if_type', 'if_speed', 'if_oper_status', 'if_admin_status', 'if_in_octets', 'if_out_octets', 'if_in_errors', 'if_out_errors', 'sfp_rx_dbm', 'sfp_tx_dbm', 'sfp_temp_c', 'sfp_voltage_v', 'sfp_bias_ma'];
  const metricRows = [];
  for (const i of interfaces) {
    // Never store a row we can't show status for — a missing oper status
    // (timed-out walk) must not overwrite good data with 0 (= Down).
    if (i.if_oper_status === undefined) continue;
    // Nameless interfaces are not stored at all.
    if (!i.if_name || String(i.if_name).trim() === '') continue;
    const set = {};
    for (const c of cols) if (i[c] !== undefined) set[c] = i[c];
    await db.upsertInterface(deviceId, i.if_index, set);
    if (i.if_name && i.if_in_octets) metricRows.push({ device_id: deviceId, metric_type: 'interface_rx', interface_name: i.if_name, value: i.if_in_octets });
    if (i.if_name && i.if_out_octets) metricRows.push({ device_id: deviceId, metric_type: 'interface_tx', interface_name: i.if_name, value: i.if_out_octets });
  }
  if (metricRows.length) await db.addMetricsBulk(metricRows);
}

module.exports = { OIDS, createSession, snmpGet, snmpWalk, pollDevice, pollLight, pollDomFull, pollDomLight, parseMtxrOptical, findHrStorageInstances, computeHrFromCells, applyDomToInterfaces, isSfpInterfaceName, scaleToExponent, sensorActual, wattsToDbm, saveInterfaces, parseStorage };
