const { exec } = require('child_process');
const { promisify } = require('util');
const net = require('net');
const execAsync = promisify(exec);

async function traceroute(target, maxHops = 30) {
  try {
    const { stdout } = await execAsync(`traceroute -n -m ${maxHops} -w 2 ${target}`, { timeout: 30000 });
    const lines = stdout.trim().split('\n').slice(1);
    const hops = lines.map(line => {
      const parts = line.trim().split(/\s+/);
      const hop = parseInt(parts[0]);
      const ips = parts.slice(1).filter(p => p !== '*' && /^\d+\.\d+\.\d+\.\d+$/.test(p));
      const times = parts.slice(1).filter(p => p !== '*' && /[\d.]+ms/.test(p)).map(t => parseFloat(t));
      return { hop, ip: ips[0] || '*', avgMs: times.length ? times.reduce((a,b)=>a+b,0)/times.length : null };
    });
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

module.exports = { traceroute, portScan };
