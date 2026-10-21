import http from 'node:http';
import { createHash } from 'node:crypto';

// Independent RFC 6455 test peer: unmasked server text frames, no hardware.
export async function livePeer({ intervalMs = 20, message = null } = {}) {
  const sockets = new Set(), timers = new Set();
  const server = http.createServer();
  const send = (socket, text, opcode = 1) => {
    const payload = Buffer.from(text); let header;
    if(payload.length<126)header=Buffer.from([0x80|opcode,payload.length]);
    else if(payload.length<65536)header=Buffer.from([0x80|opcode,126,payload.length>>8,payload.length&255]);
    else {header=Buffer.alloc(10);header[0]=0x80|opcode;header[1]=127;header.writeBigUInt64BE(BigInt(payload.length),2);}
    socket.write(Buffer.concat([header, payload]));
  };
  let sequence = 0;
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    if (intervalMs) {
      const timer = setInterval(() => { if (!socket.destroyed) send(socket, message ?? JSON.stringify({ ts: 0, detections: { attributes: ['range_m', 'sequence_num'], data: [[1 + sequence++ / 1000, 8]] } })); }, intervalMs);
      timers.add(timer); socket.once('close', () => { clearInterval(timer); timers.delete(timer); });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `ws://127.0.0.1:${server.address().port}`, send(text, opcode) { for (const socket of sockets) send(socket, text, opcode); }, drop() { for (const socket of sockets) socket.destroy(); }, async close() { for (const timer of timers) clearInterval(timer); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
export const syntheticCamera = { mime_type: 'video/webm', started_unix_ms: 1700000000000, started_monotonic_ms: 10, time_origin_ms: 1699999999990, source: 'synthetic_fixture_no_camera' };
