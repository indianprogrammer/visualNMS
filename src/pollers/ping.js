const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

async function pingHost(ip, timeoutMs = 3000) {
  try {
    const { stdout } = await execAsync(`ping -c 1 -W 1 -w 1 ${ip}`, { timeout: 3000 });
    const avgMatch = stdout.match(/min\/avg\/max.*?=? ([\d.]+)/);
    const lossMatch = stdout.match(/(\d+)% packet loss/);
    return {
      reachable: true,
      latencyMs: avgMatch ? parseFloat(avgMatch[1]) : 0,
      packetLoss: lossMatch ? parseInt(lossMatch[1]) : 0
    };
  } catch {
    return { reachable: false, latencyMs: -1, packetLoss: 100 };
  }
}

module.exports = { pingHost };
