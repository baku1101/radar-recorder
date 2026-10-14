import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let k = 0; k < 8; k++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
function pngChunk(type, data) { const t = Buffer.from(type), out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); t.copy(out, 4); data.copy(out, 8); out.writeUInt32BE(crc32(Buffer.concat([t, data])), data.length + 8); return out; }
function makePng(index) {
  const w = 320, h = 180, raw = Buffer.alloc((w * 3 + 1) * h), xTarget = 32 + Math.round(index / 119 * 252);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const position = y * (w * 3 + 1) + 1 + x * 3, target = (x - xTarget) ** 2 + (y - 75) ** 2 < 16 ** 2;
    const progress = y > 150 && y < 160 && x > 20 && x < 20 + index / 119 * 280;
    const stripe = y % 30 === 0 || x % 40 === 0;
    const color = target ? [239, 177, 98] : progress ? [44, 163, 151] : stripe ? [47, 72, 82] : [24, 44, 55];
    raw[position] = color[0]; raw[position + 1] = color[1]; raw[position + 2] = color[2];
  }
  const info = Buffer.alloc(13); info.writeUInt32BE(w); info.writeUInt32BE(h, 4); info[8] = 8; info[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', info), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const attributes = ['range_m', 'azimuth_deg', 'elevation_deg', 'magnitude_dBFS', 'speed_mps', 'rx_idx', 'range_bin', 'doppler_bin', 'sequence_num', 'type', 'seq_count_1', 'seq_count_2', 'ir_stat'];
  const format = ms => { const hours = Math.floor(ms / 3600000); return `${hours}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`; };
  const base = Date.UTC(2026, 9, 12), lines = [JSON.stringify({ ts: '0', types: { detections: { attributes } }, fixture: 'synthetic_no_hardware' })];
  for (let i = 0; i <= 120; i++) { const t = i / 10, range = t < 3 ? 2.8 : t < 7 ? 2.8 - (t - 3) * .45 : 1 + Math.sin((t - 7) / 5 * Math.PI) * .1; lines.push(JSON.stringify({ ts: format(base + i * 100), detections: { attributes, data: [[Number(range.toFixed(3)), Number((Math.sin(t) * 12).toFixed(2)), 0, -30, t < 3 || t >= 7 ? 0 : -.45, 0, Math.round(range * 10), t < 3 || t >= 7 ? 0 : -4, i, 2, i % 2, (i + 1) % 2, 5120]] } })); }
  fs.writeFileSync(path.join(project, 'fixtures', 'demo.events.jsonl'), lines.join('\n') + '\n');
  const dir = path.join(project, 'test-output', 'fixture-frames'); fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 120; i++) fs.writeFileSync(path.join(dir, `frame-${String(i).padStart(3, '0')}.png`), makePng(i));
  console.log('Synthetic JSONL and 120 synthetic PNG frames created; no sensor/camera used.');
}
