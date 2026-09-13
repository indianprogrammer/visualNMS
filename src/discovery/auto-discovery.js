const { exec } = require('child_process');
const { promisify } = require('util');
const db = require('../database/db');
const config = require('../config/config');
const pingPoller = require('../pollers/ping');
const snmpPoller = require('../pollers/snmp');
const execAsync = promisify(exec);

function ipToNum(ip) { return ip.split('.').reduce((a, o) => (a << 8) + parseInt(o), 0) >>> 0; }
function numToIp(n) { return [(n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255].join('.'); }

function expandCIDR(cidr) {
  const [base, bits] = cidr.split('/');
  const mask = bits ? ~(2**(32-parseInt(bits))-1) : 0xFFFFFFFF;
  const b = ipToNum(base) & mask;
  const end = b | ~mask;
  const hosts = [];
  for (let i = b+1; i < end; i++) hosts.push(numToIp(i));
  return hosts;
}

function detectVendor(mac) {
  if (!mac) return null;
  const m = mac.toLowerCase().substring(0,8);
  const map = {
    'd4:01':'TP-Link','d4:6e':'TP-Link','50:c7':'TP-Link',
    '00:0c:29':'VMware','00:50:56':'VMware','08:00:27':'VirtualBox',
    'b8:27:eb':'Raspberry Pi','dc:a6:32':'Raspberry Pi',
    '6c:3b:6b':'MikroTik','e4:8d:8c':'MikroTik','4c:5e:0c':'MikroTik',
    '00:1e:58':'D-Link','1c:5f:2b':'D-Link',
    '00:1b:2f':'Netgear','c0:ff:d4':'Netgear',
    '00:1e:ec':'Cisco','28:8a:1c':'Cisco','c8:b3:73':'Cisco',
    '00:0e:8f':'Huawei','48:46:fb':'Huawei','88:cf:98':'Huawei',
    'e0:2f:6d':'Ubiquiti','04:18:d6':'Ubiquiti','18:e8:29':'Ubiquiti',
    '00:1a:92':'ZyXEL','00:22:6b':'ZTE'
  };
  for (const [k,v] of Object.entries(map)) if (m.startsWith(k)) return v;
  return null;
}

function identifyType(desc) {
  if (!desc) return 'generic';
  const d = desc.toLowerCase();
  if (d.includes('routeros')||d.includes('mikrotik')) return 'router';
  if (d.includes('router')) return 'router';
  if (d.includes('switch')||d.includes('catalyst')) return 'switch';
  if (d.includes('linux')||d.includes('windows')||d.includes('microsoft')) return 'server';
  if (d.includes('access point')||d.includes('wireless')||d.includes('ubnt')) return 'wireless_ap';
  if (d.includes('firewall')||d.includes('fortigate')||d.includes('fortinet')) return 'firewall';
  if (d.includes('ont')||d.includes('gpon')) return 'ont';
  return 'generic';
}

async function scanSubnet(subnet, io) {
  const hosts = expandCIDR(subnet);
  const jobId = await db.ins('discovery_jobs', { subnet, status: 'running', total_ips: hosts.length, started_at: new Date() });
  const found = [];

  for (let i = 0; i < hosts.length; i += 50) {
    const batch = hosts.slice(i, i+50);
    const results = await Promise.allSettled(batch.map(async (ip) => {
      const ping = await pingPoller.pingHost(ip, 1000);
      if (!ping.reachable) return null;
      let sysDescr = null, sysName = null;
      try {
        const sess = snmpPoller.createSession({ ip_address:ip, snmp_community:'public', snmp_version:'2c', snmp_port:161 });
        sysDescr = await snmpPoller.snmpGet(sess, '1.3.6.1.2.1.1.1.0').catch(()=>null);
        sysName = await snmpPoller.snmpGet(sess, '1.3.6.1.2.1.1.5.0').catch(()=>null);
        try { sess.close(); } catch {}
      } catch {}
      const dtype = identifyType(sysDescr?.toString());
      const name = sysName?.toString() || `${dtype}-${ip.split('.').pop()}`;
      return { ip, name, dtype, sysDescr: sysDescr?.toString() };
    }));

    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      const dev = r.value;
      const exists = await db.devByIp(dev.ip);
      if (exists) continue;
      const id = await db.ins('devices', { name: dev.name, ip_address: dev.ip, device_type: dev.dtype, snmp_community: 'public', status: 'up' });
      found.push({ id, name: dev.name, ip: dev.ip, deviceType: dev.dtype });
      if (io) io.emit('discovery:device_found', { id, name: dev.name, ip: dev.ip });
    }
  }

  await db.updateOne('discovery_jobs', { id: jobId }, { $set: { status: 'completed', found_devices: found.length, completed_at: new Date() } });
  if (io) io.emit('discovery:complete', { subnet, devicesFound: found.length, devices: found });
}

module.exports = { expandCIDR, scanSubnet };
