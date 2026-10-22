// Host 127.0.0.1:8765 -> docker exec pipe -> container 127.0.0.1:8000 (container stays --network none).
import net from 'node:net';
import { spawn } from 'node:child_process';
net.createServer(sock => {
  const p = spawn('docker', ['exec', '-i', 'vinylflow-browser', 'python', '/b/pipe.py'], { stdio: ['pipe', 'pipe', 'ignore'] });
  sock.pipe(p.stdin); p.stdout.pipe(sock);
  const end = () => { try { sock.destroy(); } catch {} try { p.kill(); } catch {} };
  sock.on('error', end); sock.on('close', end); p.on('exit', () => sock.end());
}).listen(8765, '127.0.0.1', () => console.log('proxy on 127.0.0.1:8765'));
