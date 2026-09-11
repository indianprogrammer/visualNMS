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
    out.rx_bps = st.rxBps;
    out.tx_bps = st.txBps;
    out.rx_octets = st.rxOctets;
    out.tx_octets = st.txOctets;
    out.stats_updated_at = st.updatedAt;
    out.src_oper = srcSt.oper;
    out.src_admin = srcSt.admin;
    out.dst_oper = dstSt.oper;
    out.dst_admin = dstSt.admin;
  } catch {
    out.rx_bps = null;
    out.tx_bps = null;
  }
  return out;
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

module.exports = { getInterfaceStats, getPersistedStats, getBoundInterfaces, recordInterfaceRates, pruneLinkHistory, enrichLink };

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

// Compute per-cycle rates for a device's polled interfaces, persist rows for
// link-bound interfaces, and return [{deviceId,ifName,rxBps,txBps,rxOctets,txOctets}].
// MUST be called BEFORE saveInterfaces() overwrites the interfaces table.
function recordInterfaceRates(deviceId, interfaces, boundSet) {
  const out = [];
  const now = Date.now();
  let ins = null;
  try { ins = db.prepare(`INSERT INTO link_rate_history (device_id, interface_name, rx_bps, tx_bps) VALUES (?,?,?,?)`); } catch { return out; }
  for (const i of interfaces || []) {
    try {
      if (!i || !i.if_name || i.if_in_octets == null || i.if_out_octets == null) continue;
      const rx = Number(i.if_in_octets) || 0;
      const tx = Number(i.if_out_octets) || 0;
      const key = deviceId + '|' + i.if_name;
      const p = _prev.get(key);
      _prev.set(key, { rx, tx, t: now });
      let rxBps = null;
      let txBps = null;
      if (p) {
        const dt = (now - p.t) / 1000;
        if (dt > 0) {
          const drx = rx - p.rx;
          const dtx = tx - p.tx;
          rxBps = drx < 0 ? 0 : Math.round((drx / dt) * 8);
          txBps = dtx < 0 ? 0 : Math.round((dtx / dt) * 8);
          if (!boundSet || boundSet.has(key)) {
            try { ins.run(deviceId, i.if_name, rxBps, txBps); } catch {}
          }
        }
      }
      out.push({ deviceId, ifName: i.if_name, rxBps, txBps, rxOctets: rx, txOctets: tx });
    } catch {}
  }
  return out;
}

// Bound table growth: keep ~6h of per-cycle rows.
function pruneLinkHistory() {
  try { db.prepare(`DELETE FROM link_rate_history WHERE timestamp < datetime('now','-6 hours')`).run(); } catch {}
}
