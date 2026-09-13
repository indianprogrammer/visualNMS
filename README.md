# visualNMS — Web-Based Network Management System

Real-time network monitoring with a live topology map, per-link traffic graphs,
SFP/fiber optical readings, device health tracking, and built-in diagnostic tools.
Node.js + Express + **MongoDB** + Socket.IO on the backend, Cytoscape.js + Chart.js
on the frontend. Multi-user with role/operation permissions, scheduled data
retention, and a storage cleanup dashboard.

![Dashboard](docs/screenshots/dashboard.png)

## Features

- **Live topology map** — drag-and-drop devices and static endpoints, device-to-device
  and device-to-internet links with real-time Rx/Tx rate labels, oper/admin status
  coloring, and hover graphs. Link width follows port speed (1px @10M → 7px @40G+).
  Device nodes render name, **IP + latency** and CPU/memory/disk on the label.
- **Continuous link graphs** — per-cycle server-computed rates stored in
  `link_rate_history`; transient SNMP misses repeat the last good value (up to
  3 cycles) before drawing zero, so graphs stay continuous while a device is up.
- **SFP / fiber optical power** — Rx/Tx dBm, temperature, voltage and bias polled
  via ENTITY-SENSOR-MIB, CISCO-ENTITY-SENSOR-MIB and MikroTik `mtxrOpticalTable`,
  shown on edge labels, tooltips, context menus and interface tables.
- **Device health** — ping latency (hover mini-graph with current-value overlay),
  CPU / memory / disk, sysUpTime-based uptime, per-interface status and counters.
- **Link editing** — right-click a link to change either endpoint's interface and
  the interface speed, including **Auto (follow live SNMP speed)**.
- **Diagnostic Tools** — Ping, Traceroute, live-streaming **MTR** (cumulative
  loss/sent/last/avg/best/worst table), Port Scan (custom ports), DNS Lookup
  (A/AAAA/NS/MX/TXT/PTR), HTTP Check, SNMP Walk.
- **SNMP profiles** — reusable v1/v2c/v3 credential sets; device form shows
  manual Port/Version/Community fields only in Manual mode.
- **User management** (admin) — create users with **Read Only / Read / Write**
  roles and fine-grained **page + operation** permissions, enforced server-side
  and mirrored in the UI (buttons/nav hidden for users without permission).
- **Data retention & cleanup** — scheduled downsampling of old graph metrics,
  configurable retention, plus a manual **Data Cleanup** dashboard with per-category
  sizes and one-click sweeps: orphaned device data, old logs, all graphs, and per-device.
- **Discovery, alerts, event log, syslog/trap receivers, multi-theme UI.**

![Topology map](docs/screenshots/topology.png)

## Requirements

- **Node.js** 18+ (uses the native MongoDB driver, no external Mongo client needed)
- **MongoDB** 5.0+ (7.0 recommended) — either a local install or Docker:

```bash
docker run -d --name webnms-mongo \
  -p 27017:27017 -v webnms-data:/data/db \
  --restart unless-stopped mongo:7.0
```

## Quick start

```bash
npm install
./start.sh                       # or: PORT=3000 node server.js
# open http://localhost:3000
```

- Default DB: `mongodb://127.0.0.1:27017/webnms` (override with `MONGO_URI` /
  `MONGO_DB`).
- Default login: **admin / admin** (created automatically on first boot — change it!).
- Default ports: **3000** (web), **1514/udp** (syslog), **10162/udp** (SNMP traps).

### Run with Docker (app image only)

```bash
docker run -d --name visualnms -p 3000:3000 \
  -e MONGO_URI=mongodb://<mongo-host>:27017 \
  -e JWT_SECRET=change-me \
  indianprogrammer/visualnms:latest
```

The image bundles only the app; point `MONGO_URI` at any running MongoDB
(local, LAN, cloud, or a linked container — e.g. connect with
`--network host` and `MONGO_URI=mongodb://127.0.0.1:27017`). UDP 1514/10162 for
syslog/traps can be mapped with `-p 1514:1514/udp -p 10162:10162/udp`.

## Manual

### 1. Add a device
Devices → **Add Device** (or map palette → add node). Fill Name, IP, Type, then
either pick an **SNMP Profile** or use **Manual** and enter Port / Version /
Community (v3 expands user/auth/privacy rows).

![Add device](docs/screenshots/add-device.png)

### 2. Build a map
Topology → **New Map**, drag devices (and static endpoints such as "internet"
clouds) from the palette, drag to position. Click the link tool, pick a source
interface, then a target interface to create a link.

### 3. Read the map
- Edge labels show `▼ Rx ▲ Tx`, oper/admin state, and `SFP Rx/Tx dBm` on fiber.
- Hover a link for the live traffic graph; hover a device for the latency
  mini-graph, uptime, CPU/memory/disk.
- Right-click a link → **Edit** (interfaces, speed incl. Auto) or **Delete**.
- Right-click a device → Refresh, Edit, Ping, SNMP poller, Port Scanner, Traceroute.

### 4. Device page
Click a node (or Devices → view) for ping latency and CPU/memory charts plus the
full interface table with live status, counters and SFP columns.

![Device page](docs/screenshots/device.png)

### 5. Diagnostic Tools
Tools page → pick a tool, enter target, **Run**. MTR streams live until **Stop**.

![Diagnostic tools](docs/screenshots/tools.png)

### 6. Settings
- **General** — ping / SNMP poll intervals (applied live, no restart).
- **Notifications** — webhook, Telegram, SMTP for alert delivery.
- **Data Retention** — raw data kept (days) and the point after which graph
  history is downsampled to hourly buckets. Saved changes run immediately
  (admin only).
- **SNMP Profiles** — manage credential sets.
- **Users** (admin only) — create/edit/delete users. Roles: **Read Only**
  (all pages, no mutations), **Read / Write** (pages + operations), or **Admin**.
  Assign pages and operations per user; admins can never lock themselves out.
- **Data Cleanup** (admin only) — live storage sizes per category with one-click
  sweeps: orphaned device data (rows left by deleted devices), old logs &
  resolved alerts, all/counter graph history, link rates, alerts, interface
  tables, live metrics, rules, jobs, maps, all devices, or a single device.

### 7. Polling tiers
**ping 5s → light SNMP 5s** (CPU/mem/disk + map-bound interfaces) →
**full walk hourly** (all interfaces, DOM discovery). Dead devices back off and
re-probe periodically. Cycle counters at `GET /api/poller/stats`, and
`GET /api/cleanup` shows the current storage footprint per category.

## Architecture

```
server.js → Express API (src/api/routes.js) + Socket.IO (src/websocket/)
            maintenance (src/database/maintenance.js) every 10 min
src/pollers/  ping.js · snmp.js (walks, DOM, MikroTik optical)
              link-stats.js (rate math, carry-forward, enrichLink)
              poller-engine.js (ping/light/full cycles, loop stats)
src/database/ db.js (Mongo driver, auto-increment ids, indexes)
              maintenance.js (downsampling + retention pruning)
src/api/      routes.js · auth.js (JWT, roles, permissions) · cleanup.js
              permissions.js (page/op catalog) · users CRUD
public/js/app.js (Cytoscape map, charts, tooltips, tools, cleanup UI)
```

Realtime socket events: `poll:results`, `poll:snmp`, `link:stats`,
`link:history`, `tool:mtr-data`, `map:updated`, `alert:new`.

Environmental overrides: `PORT`, `MONGO_URI`, `MONGO_DB`, `JWT_SECRET`,
`ADMIN_USER`, `ADMIN_PASS`, `WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID`, `SMTP_*`, `ALERT_EMAIL_TO`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Blank page | Hard-reload (Ctrl+Shift+R) — the JS bundle is cache-busted on each release |
| Server exits at boot | MongoDB unreachable — start it (`docker start webnms-mongo`) or point `MONGO_URI` at it |
| Link shows no interface | Bind one via right-click → Edit, or recreate with the interface picker |
| SFP shows nothing on 198-class links | Module exposes no DDM over SNMP (verified empty optical table) — needs a DDM-capable SFP |
| Graph gaps while device up | Check `/api/poller/stats` for light-cycle skips; raise SNMP timeout or reduce per-cycle OIDs |
| DB keeps growing | Tune Settings → Data Retention and use Data Cleanup for orphaned/per-category data |
| SNMP walk tool returns few interfaces | Slow-link walk timeouts are transient — retry |