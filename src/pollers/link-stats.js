const db = require('../database/db');

// Compute live Rx/Tx rates (bps) for a device interface from metric_history.
// Uses the last two samples of interface_rx / interface_tx for (device_id, interface_name).
// Returns { rxBps, txBps, rxOctets, txOctets, updatedAt } with nulls when unavailable.
function getInterfaceStats(deviceId, ifName) {
  if (!deviceId || !ifName) return { rxBps: null, txBps: null, rxOctets: null, txOctets: null, updatedAt: null };
  try {
    const q = db.prepare(
      `SELECT value, timestamp FROM metric_history WHERE device_id=? AND metric_type=? AND interface_name=? ORDER BY timestamp DESC LIMIT 2`
    );
    const rx = q.all(deviceId, 'interface_rx', ifName);
    const tx = q.all(deviceId, 'interface_tx', ifName);

    const rate = (rows) => {
      if (!rows || rows.length < 2) return { bps: null, octets: rows && rows.length ? rows[0].value : null, ts: rows && rows.length ? rows[0].timestamp : null };
      const latest = rows[0];
      const prev = rows[1];
      const t1 = new Date(latest.timestamp).getTime();
      const t0 = new Date(prev.timestamp).getTime();
      const dt = (t1 - t0) / 1000;
      if (!isFinite(dt) || dt <= 0) return { bps: null, octets: latest.value, ts: latest.timestamp };
      const d = (Number(latest.value) || 0) - (Number(prev.value) || 0);
      if (d < 0) return { bps: 0, octets: latest.value, ts: latest.timestamp }; // counter reset/wrap
      return { bps: Math.round((d / dt) * 8), octets: latest.value, ts: latest.timestamp };
    };

    const r = rate(rx);
    const t = rate(tx);
    // Fall back to current interfaces-table counters when history has <2 samples
    let rxOctets = r.octets;
    let txOctets = t.octets;
    if (rxOctets == null || txOctets == null) {
      try {
        const row = db.prepare('SELECT if_in_octets, if_out_octets FROM interfaces WHERE device_id=? AND if_name=?').get(deviceId, ifName);
        if (row) {
          if (rxOctets == null) rxOctets = row.if_in_octets;
          if (txOctets == null) txOctets = row.if_out_octets;
        }
      } catch {}
    }
    return {
      rxBps: r.bps,
      txBps: t.bps,
      rxOctets,
      txOctets,
      updatedAt: r.ts || t.ts || null
    };
  } catch {
    return { rxBps: null, txBps: null, rxOctets: null, txOctets: null, updatedAt: null };
  }
}

// Enrich a map_links row with live stats.
// Prefers the source interface; falls back to the target side (covers links
// to static objects like pint_core -> a where only one end is a device).
function enrichLink(link, nodeById) {
  const out = Object.assign({}, link);
  try {
    const src = nodeById ? nodeById[link.source_node_id] : null;
    const dst = nodeById ? nodeById[link.target_node_id] : null;
    let deviceId = null;
    let ifName = null;
    let side = null;
    if (src && src.device_id && link.source_interface) {
      deviceId = src.device_id;
      ifName = link.source_interface;
      side = 'source';
    } else if (dst && dst.device_id && link.target_interface) {
      deviceId = dst.device_id;
      ifName = link.target_interface;
      side = 'target';
    }
    // If only one end is a device with an interface set, use it even if it is
    // stored on the "other" column (tolerates empty-string target_interface).
    if (!deviceId) {
      if (src && src.device_id && link.source_interface) {
        deviceId = src.device_id;
        ifName = link.source_interface;
        side = 'source';
      } else if (dst && dst.device_id && link.target_interface) {
        deviceId = dst.device_id;
        ifName = link.target_interface;
        side = 'target';
      }
    }
    const st = getPersistedStats(deviceId, ifName) || getInterfaceStats(deviceId, ifName);
    const srcSt = sideOperAdmin(nodeById, link.source_node_id, link.source_interface);
    const dstSt = sideOperAdmin(nodeById, link.target_node_id, link.target_interface);
    out.stat_device_id = deviceId;
    out.stat_if_name = ifName;
    out.stat_side = side;
    // Port speed driving link width (stat side; link cap as fallback).
    try {
      out.stat_speed_bps = getIfSpeed(deviceId, ifName) || link.max_speed_bps || null;
    } catch { out.stat_speed_bps = link.max_speed_bps || null; }
    out.rx_bps = st.rxBps;
    out.tx_bps = st.txBps;
    out.rx_octets = st.rxOctets;
    out.tx_octets = st.txOctets;
    out.stats_updated_at = st.updatedAt;
    out.src_oper = srcSt.oper;
    out.src_admin = srcSt.admin;
    out.dst_oper = dstSt.oper;
    out.dst_admin = dstSt.admin;
    // SFP/DOM optical power for fiber links (e.g. device SFP -> internet).
    // Primary fields follow the stat side; per-end fields cover
    // device-to-device fiber where both ends have transceivers.
    try {
      const sfp = getSfpStats(deviceId, ifName);
      out.sfp_rx_dbm = sfp.rxDbm;
      out.sfp_tx_dbm = sfp.txDbm;
      out.sfp_temp_c = sfp.tempC;
      out.sfp_voltage_v = sfp.voltageV;
      out.sfp_bias_ma = sfp.biasMa;
      const srcNode = nodeById ? nodeById[link.source_node_id] : null;
      const dstNode = nodeById ? nodeById[link.target_node_id] : null;
      const srcSfp = srcNode && srcNode.device_id && link.source_interface
        ? getSfpStats(srcNode.device_id, link.source_interface) : null;
      const dstSfp = dstNode && dstNode.device_id && link.target_interface
        ? getSfpStats(dstNode.device_id, link.target_interface) : null;
      out.src_sfp_rx_dbm = srcSfp ? srcSfp.rxDbm : null;
      out.src_sfp_tx_dbm = srcSfp ? srcSfp.txDbm : null;
      out.dst_sfp_rx_dbm = dstSfp ? dstSfp.rxDbm : null;
      out.dst_sfp_tx_dbm = dstSfp ? dstSfp.txDbm : null;
      out.is_fiber = !!(
        (sfp.rxDbm != null || sfp.txDbm != null) ||
        (srcSfp && (srcSfp.rxDbm != null || srcSfp.txDbm != null)) ||
        (dstSfp && (dstSfp.rxDbm != null || dstSfp.txDbm != null)) ||
        isFiberIfName(link.source_interface) || isFiberIfName(link.target_interface)
      );
    } catch {
      out.sfp_rx_dbm = null;
      out.sfp_tx_dbm = null;
      out.is_fiber = isFiberIfName(link.source_interface) || isFiberIfName(link.target_interface);
    }
  } catch {
    out.rx_bps = null;
    out.tx_bps = null;
  }
  return out;
}

// IfSpeed of one interface; 2^32-1 is the SNMP "unknown" sentinel.
function getIfSpeed(deviceId, ifName) {
  if (!deviceId || !ifName) return null;
  try {
    const r = db.prepare('SELECT if_speed FROM interfaces WHERE device_id=? AND if_name=?').get(deviceId, ifName);
    const s = r ? Number(r.if_speed) : NaN;
    if (!isFinite(s) || s <= 0 || s >= 4294967295) return null;
    return s;
  } catch {
    return null;
  }
}

// SFP/DOM optical readings for one interface from the interfaces table.
// Returns nulls when the port is copper or not yet polled.
function getSfpStats(deviceId, ifName) {
  const empty = { rxDbm: null, txDbm: null, tempC: null, voltageV: null, biasMa: null };
  if (!deviceId || !ifName) return empty;
  try {
    const r = db.prepare(
      'SELECT sfp_rx_dbm, sfp_tx_dbm, sfp_temp_c, sfp_voltage_v, sfp_bias_ma FROM interfaces WHERE device_id=? AND if_name=?'
    ).get(deviceId, ifName);
    if (!r) return empty;
    const num = (v) => (v === null || v === undefined || !isFinite(Number(v)) ? null : Number(v));
    return { rxDbm: num(r.sfp_rx_dbm), txDbm: num(r.sfp_tx_dbm), tempC: num(r.sfp_temp_c), voltageV: num(r.sfp_voltage_v), biasMa: num(r.sfp_bias_ma) };
  } catch {
    return empty;
  }
}

function isFiberIfName(ifName) {
  if (!ifName) return false;
  return /sfp|sfp\+|xfp|qsfp|cfp|fiber|fibre|optic|pon|gpon|combo|spsfp|mini-?gbic/i.test(String(ifName));
}

// Oper/admin status of one link end from the interfaces table.
function sideOperAdmin(nodeById, nodeId, ifName) {
  try {
    const n = nodeById ? nodeById[nodeId] : null;
    if (!n || !n.device_id || !ifName) return { oper: null, admin: null };
    const r = db.prepare('SELECT if_oper_status, if_admin_status FROM interfaces WHERE device_id=? AND if_name=?').get(n.device_id, ifName);
    return { oper: r ? r.if_oper_status : null, admin: r ? r.if_admin_status : null };
  } catch {
    return { oper: null, admin: null };
  }
}

module.exports = { getInterfaceStats, getPersistedStats, getBoundInterfaces, getSfpStats, isFiberIfName, recordInterfaceRates, pruneLinkHistory, enrichLink };

// Latest server-computed rate for an interface from on-disk link_rate_history.
// This is the same series the hover graph draws and the same number the live
// label shows, so label and graph always agree.
function getPersistedStats(deviceId, ifName) {
  if (!deviceId || !ifName) return null;
  try {
    const row = db.prepare(
      `SELECT rx_bps, tx_bps, timestamp FROM link_rate_history WHERE device_id=? AND interface_name=? ORDER BY timestamp DESC LIMIT 1`
    ).get(deviceId, ifName);
    if (!row) return null;
    let rxOctets = null;
    let txOctets = null;
    try {
      const cur = db.prepare('SELECT if_in_octets, if_out_octets FROM interfaces WHERE device_id=? AND if_name=?').get(deviceId, ifName);
      if (cur) { rxOctets = cur.if_in_octets; txOctets = cur.if_out_octets; }
    } catch {}
    return { rxBps: row.rx_bps, txBps: row.tx_bps, rxOctets, txOctets, updatedAt: row.timestamp };
  } catch {
    return null;
  }
}

// Set of 'deviceId|ifName' for every interface bound to a map link.
// Only these interfaces get per-cycle rate rows persisted.
function getBoundInterfaces() {
  const set = new Set();
  try {
    const nodes = db.prepare('SELECT id, device_id FROM map_nodes WHERE device_id IS NOT NULL').all();
    const devByNode = {};
    nodes.forEach((n) => { devByNode[n.id] = n.device_id; });
    const links = db.prepare('SELECT source_node_id, target_node_id, source_interface, target_interface FROM map_links').all();
    links.forEach((l) => {
      const sd = devByNode[l.source_node_id];
      const td = devByNode[l.target_node_id];
      if (sd && l.source_interface) set.add(sd + '|' + l.source_interface);
      if (td && l.target_interface) set.add(td + '|' + l.target_interface);
    });
  } catch {}
  return set;
}

// Previous-poll counters keyed by 'deviceId|ifName' (process clock, no TZ skew).
const _prev = new Map();
// Last computed rate + timestamp + consecutive miss count per bound interface.
// Used to carry forward non-zero values when SNMP misses an interface.
const _lastRate = new Map(); // key -> { rxBps, txBps, t, misses }
const MAX_CARRY = 3; // carry forward for up to 3 consecutive misses

// Compute per-cycle rates for a device's polled interfaces, persist rows for
// link-bound interfaces, and return [{deviceId,ifName,rxBps,txBps,rxOctets,txOctets}].
// MUST be called BEFORE saveInterfaces() overwrites the interfaces table.
function recordInterfaceRates(deviceId, interfaces, boundSet) {
  const out = [];
  const now = Date.now();
  let ins = null;
  try { ins = db.prepare(`INSERT INTO link_rate_history (device_id, interface_name, rx_bps, tx_bps) VALUES (?,?,?,?)`); } catch { return out; }
  const seen = new Set();
  for (const i of interfaces || []) {
    try {
      if (!i || !i.if_name || String(i.if_name).trim() === '' || i.if_in_octets == null || i.if_out_octets == null) continue;
      const rx = Number(i.if_in_octets) || 0;
      const tx = Number(i.if_out_octets) || 0;
      const key = deviceId + '|' + i.if_name;
      const p = _prev.get(key);
      _prev.set(key, { rx, tx, t: now });
      seen.add(key);
      let rxBps = null;
      let txBps = null;
      if (p) {
        const dt = (now - p.t) / 1000;
        if (dt > 0) {
          const drx = rx - p.rx;
          const dtx = tx - p.tx;
          const cRx = drx < 0 ? 0 : Math.round((drx / dt) * 8);
          const cTx = dtx < 0 ? 0 : Math.round((dtx / dt) * 8);
          if (!boundSet || boundSet.has(key)) {
            // Anomaly guard: a computed rate above the port's own speed is
            // physically impossible (stale/out-of-order counter read), and a
            // sudden both-zero right after non-zero traffic is a 32-bit wrap
            // or missed counter update — not an idle link. Repeat the
            // previous values for up to MAX_CARRY cycles; the _prev clock
            // keeps moving so the next cycle self-heals.
            const speed = Number(i.if_speed) || 0;
            const prevRate = _lastRate.get(key);
            const lrMiss = (prevRate && prevRate.misses) || 0;
            const overSpeed = speed > 0 && (cRx > speed * 1.1 || cTx > speed * 1.1);
            // A side reading exactly 0 right after carrying real traffic is
            // a stale counter read, not an idle link (a busy link doesn't
            // move zero bytes in a 4s window). 1Mbps floor keeps near-idle
            // noise truthful.
            const zeroDip = prevRate &&
              ((cRx === 0 && prevRate.rxBps > 1e6) || (cTx === 0 && prevRate.txBps > 1e6));
            if ((overSpeed || zeroDip) && lrMiss < MAX_CARRY) {
              const nMiss = lrMiss + 1;
              _lastRate.set(key, { rxBps: prevRate.rxBps, txBps: prevRate.txBps, t: now, misses: nMiss });
              try { ins.run(deviceId, i.if_name, prevRate.rxBps, prevRate.txBps); } catch {}
              rxBps = prevRate.rxBps; txBps = prevRate.txBps;
            } else {
              // Sustained anomaly (or confirmed idle): store truth — zeros
              // for impossible speeds, computed values otherwise.
              const fRx = overSpeed ? 0 : cRx, fTx = overSpeed ? 0 : cTx;
              try { ins.run(deviceId, i.if_name, fRx, fTx); } catch {}
              _lastRate.set(key, { rxBps: fRx, txBps: fTx, t: now, misses: 0 });
              rxBps = fRx; txBps = fTx;
            }
          }
        }
      }
      out.push({ deviceId, ifName: i.if_name, rxBps, txBps, rxOctets: rx, txOctets: tx,
        sfpRxDbm: i.sfp_rx_dbm, sfpTxDbm: i.sfp_tx_dbm, sfpTempC: i.sfp_temp_c });
    } catch {}
  }
  // Carry forward: bound interfaces of THIS device missing from this poll
  // keep their last non-zero rate for up to MAX_CARRY cycles (graph stays
  // flat instead of dropping to zero or leaving gaps). After that, an
  // explicit zero row is written so the graph draws a zero line instead of
  // a gap — continuous until the device stops being polled (down/backoff).
  if (boundSet && ins) {
    for (const key of boundSet) {
      if (seen.has(key)) continue;
      if (!key.startsWith(deviceId + '|')) continue;
      const lr = _lastRate.get(key);
      if (!lr) continue;
      lr.misses++;
      lr.t = now;
      const ifName = key.slice(String(deviceId).length + 1);
      const useZero = lr.misses > MAX_CARRY;
      const rxBps = useZero ? 0 : lr.rxBps;
      const txBps = useZero ? 0 : lr.txBps;
      try { ins.run(deviceId, ifName, rxBps, txBps); } catch {}
      // No SFP keys: a carried cycle has no fresh DOM data, and explicit
      // nulls would wipe the edge label's SFP line in the frontend.
      out.push({ deviceId, ifName, rxBps, txBps, rxOctets: null, txOctets: null });
    }
  }
  return out;
}

// Bound table growth: keep ~6h of per-cycle rows.
function pruneLinkHistory() {
  try { db.prepare(`DELETE FROM link_rate_history WHERE timestamp < datetime('now','-6 hours')`).run(); } catch {}
}
