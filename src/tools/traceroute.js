const { exec } = require('child_process');
const { promisify } = require('util');
const net = require('net');
const execAsync = promisify(exec);

async function traceroute(target, maxHops = 30) {
  if (!/^[a-zA-Z0-9._-]+$/.test(target || '')) return { target, hops: [], completed: false, error: 'Invalid target' };
  const maxH = Math.min(Math.max(parseInt(maxHops) || 30, 1), 64);
  let stdout = '';
  try {
    ({ stdout } = await execAsync(`traceroute -m ${maxH} -q 1 -w 2 ${target}`, { timeout: 90000 }));
  } catch (e) {
    stdout = e.stdout || '';
    if (!String(stdout).trim()) return { target, hops: [], completed: false, error: String((e.stderr || e.message || '')).trim().slice(0, 200) };
  }
  try {
    const lines = String(stdout).trim().split('\n').slice(1);
    const hops = lines.map(line => {
      const parts = line.trim().split(/\s+/);
      const hop = parseInt(parts[0]);
      const ips = parts.slice(1).filter(p => p !== '*' && /^\d+\.\d+\.\d+\.\d+$/.test(p));
      const times = parts.slice(1).filter(p => p !== '*' && /[\d.]+ms/.test(p)).map(t => parseFloat(t));
      return { hop, ip: ips[0] || '*', avgMs: times.length ? times.reduce((a,b)=>a+b,0)/times.length : null };
    }).filter(h => !isNaN(h.hop));
    return { target, hops, completed: true };
  } catch (e) { return { target, hops: [], completed: false, error: e.message }; }
}

function portScan(target, ports, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const results = [];
    let done = 0;
    const total = ports.length;
    const check = () => { if (done >= total) resolve({ target, ports: results.sort((a,b)=>a.port-b.port) }); };
    for (const port of ports) {
      const sock = new net.Socket();
      sock.setTimeout(timeoutMs);
      sock.on('connect', () => { results.push({port,state:'open'}); sock.destroy(); done++; check(); });
      sock.on('timeout', () => { results.push({port,state:'filtered'}); sock.destroy(); done++; check(); });
      sock.on('error', (e) => { results.push({port,state:e.code==='ECONNREFUSED'?'closed':'filtered',error:e.code}); sock.destroy(); done++; check(); });
      sock.connect(port, target);
    }
    setTimeout(() => { if (done < total) resolve({target,ports:results,incomplete:true}); }, timeoutMs + 1000);
  });
}

function parseMtrReport(stdout) {
  const hops = [];
  for (const line of String(stdout).split('\n')) {
    const m = line.match(/^\s*(\d+)\.\|--\s+(\S+)\s+([\d.]+)%\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
    if (m) hops.push({ hop: parseInt(m[1]), host: m[2], loss: parseFloat(m[3]), sent: parseInt(m[4]), last: parseFloat(m[5]), avg: parseFloat(m[6]), best: parseFloat(m[7]), worst: parseFloat(m[8]), stdev: parseFloat(m[9]) });
  }
  return hops;
}

async function mtr(target, cycles = 4) {
  if (!/^[a-zA-Z0-9._-]+$/.test(target || '')) return { target, hops: [], completed: false, error: 'Invalid target' };
  const c = Math.min(Math.max(parseInt(cycles) || 4, 1), 20);
  let stdout = '';
  try {
    ({ stdout } = await execAsync(`mtr --report --report-wide --report-cycles ${c} -i 1 -n ${target}`, { timeout: c * 5000 + 20000 }));
  } catch (e) {
    stdout = e.stdout || '';
    if (!String(stdout).trim()) return { target, hops: [], completed: false, error: String((e.stderr || e.message || '')).trim().slice(0, 200) };
  }
  return { target, hops: parseMtrReport(stdout), completed: true };
}

module.exports = { traceroute, portScan, mtr, parseMtrReport };
