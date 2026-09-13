// Permission catalog for the user management system.
// Pages gate read access to a screen; ops gate mutation/action endpoints.
const PAGES = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'topology', label: 'Topology Map' },
  { key: 'devices', label: 'Devices' },
  { key: 'alerts', label: 'Alerts & Alarms' },
  { key: 'events', label: 'Event Log' },
  { key: 'discovery', label: 'Discovery' },
  { key: 'tools', label: 'Diagnostic Tools' },
  { key: 'settings', label: 'Settings' }
];

const OPS = [
  { key: 'device:add', label: 'Add devices' },
  { key: 'device:edit', label: 'Edit devices' },
  { key: 'device:delete', label: 'Delete devices' },
  { key: 'device:test', label: 'Ping / SNMP test' },
  { key: 'device:refresh', label: 'Manual device refresh' },
  { key: 'map:add', label: 'Add maps' },
  { key: 'map:edit', label: 'Edit maps' },
  { key: 'map:delete', label: 'Delete maps' },
  { key: 'node:add', label: 'Add map nodes' },
  { key: 'node:move', label: 'Move / edit map nodes' },
  { key: 'node:delete', label: 'Delete map nodes' },
  { key: 'link:add', label: 'Add map links' },
  { key: 'link:edit', label: 'Edit map links' },
  { key: 'link:delete', label: 'Delete map links' },
  { key: 'alert:ack', label: 'Acknowledge alerts' },
  { key: 'alert:resolve', label: 'Resolve alerts' },
  { key: 'rules:manage', label: 'Manage alert rules' },
  { key: 'profile:manage', label: 'Manage SNMP profiles' },
  { key: 'settings:save', label: 'Change system settings' },
  { key: 'discovery:run', label: 'Run subnet discovery' },
  { key: 'tool:run', label: 'Run diagnostic tools' },
  { key: 'trigger:poll', label: 'Trigger manual poll' }
];

// Quick-start templates. `user:manage` intentionally stays admin-only.
const TEMPLATES = {
  readonly: { pages: PAGES.map((p) => p.key), ops: [] },
  readwrite: { pages: PAGES.map((p) => p.key), ops: OPS.map((o) => o.key) }
};

const PAGE_KEYS = PAGES.map((p) => p.key);
const OP_KEYS = OPS.map((o) => o.key);

function pick(list, keys) {
  let out = [];
  if (Array.isArray(list)) {
    list.forEach((k) => {
      if (keys.indexOf(k) >= 0 && out.indexOf(k) < 0) out.push(k);
    });
  }
  return out;
}

const sanitize = (perms) => {
  const p = (perms && typeof perms === 'object') ? perms : {};
  return { pages: pick(p.pages, PAGE_KEYS), ops: pick(p.ops, OP_KEYS) };
};

const has = (perms, kind, key) => {
  const list = (perms && perms[kind]) || [];
  return list.indexOf(key) >= 0;
};

module.exports = { PAGES, OPS, TEMPLATES, sanitize, has };