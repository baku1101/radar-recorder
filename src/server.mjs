import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { SessionStore } from './storage.mjs';
import { SessionController } from './controller.mjs';
import { AppError, VideoLabelAdapter, JsonlFileAdapter } from './adapters.mjs';
import { tarFiles } from './archive.mjs';
import { prepareLive, saveVideoChunk, finishCamera, CAPTURE_LIMITS } from './capture-storage.mjs';
import { DetectionMonitor } from './monitor.mjs';
import { savedPreview } from './preview.mjs';
import { PLOT_LIMITS } from '../public/plot-model.mjs';
import { RawService, RAW_HARDWARE_STATUS } from './raw-service.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), project = path.dirname(here);
const MAX_UPLOAD = 256 * 1024 * 1024;
function assertKeys(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('INVALID_REQUEST', '入力はJSON objectで指定してください');
  const unsupported = Object.keys(body).filter(key => !keys.includes(key));
  if (unsupported.length) throw new AppError('UNSUPPORTED_SETTING', `未対応の要求です: ${unsupported.join(', ')}`);
}
async function jsonBody(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 2 * 1024 * 1024) throw new AppError('BODY_TOO_LARGE', 'JSON入力は2 MiB以内です', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('INVALID_JSON', 'JSON入力を読み取れません'); }
}
async function upload(req, target, limit = MAX_UPLOAD) {
  let size = 0, fd = fs.openSync(target, 'wx');
  try {
    for await (const chunk of req) {
      size += chunk.length; if (size > limit) throw new AppError('UPLOAD_TOO_LARGE', '保存サイズの上限を超えています', 413);
      fs.writeSync(fd, chunk);
    }
    fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
    if (!size) throw new AppError('EMPTY_UPLOAD', 'ファイルが空です');
  } catch (error) { if (fd !== null) fs.closeSync(fd); if (fs.existsSync(target)) fs.unlinkSync(target); throw error; }
}
function serveVideo(req, res, file, mime) {
  const size = fs.statSync(file).size;
  let start = 0, end = size - 1;
  if (req.headers.range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!m || !m[1] && !m[2]) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    if (!m[1]) start = Math.max(0, size - Number(m[2]));
    else { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), size - 1); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
  } else res.writeHead(200, { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Content-Length': size });
  fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
}

export async function createApp({ root = path.join(project, 'data', 'sessions'), port = 8765, delayMs = 10, storeOptions = {}, liveFactory, leaseMs } = {}) {
  let monitor, raw;
  const store = new SessionStore(root, storeOptions), controller = new SessionController(store, { delayMs, liveFactory, leaseMs, canAcquireLive: () => !monitor?.busy && !raw?.busy });
  const recordingIdle=()=>!controller.liveReservation && ![...controller.runtime.values()].some(runtime=>runtime.live);
  monitor = new DetectionMonitor({ factory: liveFactory, leaseMs, canAcquire: () => recordingIdle() && !raw?.busy });
  raw = new RawService(root,{canAcquire:()=>recordingIdle()&&!monitor.busy,leaseMs});
  const recoveryProblems = controller.initialize(), token = randomUUID(), model = new VideoLabelAdapter();
  let origin;
  const json = (res, body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    try {
      const allowedHosts = new Set([new URL(origin).host, `localhost:${server.address().port}`]);
      if (!allowedHosts.has(req.headers.host) || req.headers.origin && ![origin, `http://localhost:${server.address().port}`].includes(req.headers.origin)) throw new AppError('LOCAL_ONLY', 'このアプリは同じPCの画面から利用してください', 403);
      if (!['GET', 'POST'].includes(req.method)) throw new AppError('METHOD_NOT_ALLOWED', '未対応の操作です', 405);
      if (req.method === 'POST' && req.headers['x-radar-token'] !== token) throw new AppError('LOCAL_TOKEN_REQUIRED', '画面を再読込みしてください', 403);
      const url = new URL(req.url, origin), parts = url.pathname.split('/').filter(Boolean);
      if(req.method==='GET'&&url.pathname==='/api/raw')return json(res,{sessions:raw.list(),hardware:RAW_HARDWARE_STATUS});
      if(req.method==='POST'&&url.pathname==='/api/raw/start'){const body=await jsonBody(req);assertKeys(body,['transport','url','header','processing','request_id','port']);return json(res,await raw.start(body));}
      if(req.method==='POST'&&url.pathname==='/api/raw/import'){let processing;if(url.searchParams.has('processing')){try{processing=JSON.parse(url.searchParams.get('processing'));}catch{throw new AppError('INVALID_JSON','processing JSON is invalid');}}fs.mkdirSync(raw.root,{recursive:true});const staged=path.join(raw.root,`upload-${randomUUID()}.tmp`);try{await upload(req,staged,64*1024*1024);return json(res,await raw.importFile(staged,processing));}finally{if(fs.existsSync(staged))fs.unlinkSync(staged);}}
      if(parts[0]==='api'&&parts[1]==='raw'&&parts[2]){
        const id=parts[2],action=parts[3];raw.get(id);
        if(req.method==='GET'&&!action)return json(res,await raw.view(id,{start:Number(url.searchParams.get('start_s')??0),end:url.searchParams.has('end_s')?Number(url.searchParams.get('end_s')):Infinity,tail:url.searchParams.get('tail')!=='0'}));
        if(req.method==='POST'&&action==='stop'){assertKeys(await jsonBody(req),[]);return json(res,await raw.stop(id));}
        if(req.method==='GET'&&action==='verify')return json(res,raw.verify(id));
        if(req.method==='GET'&&action==='export'){const files=raw.exportFiles(id);res.writeHead(200,{'Content-Type':'application/gzip','Content-Disposition':`attachment; filename="raw-adc-${id}.tar.gz"`});return await pipeline(Readable.from(tarFiles(files)),createGzip(),res);}
      }
      if (req.method === 'POST' && url.pathname === '/api/monitor/start') {
        const body = await jsonBody(req); assertKeys(body, ['transport', 'port', 'url', 'request_id', 'data_kind']);
        if (typeof body.request_id !== 'string' || !body.request_id) throw new AppError('REQUEST_ID_REQUIRED', '表示開始操作のIDが必要です');
        return json(res, await monitor.start(body));
      }
      if (req.method === 'POST' && url.pathname === '/api/monitor/stop') { assertKeys(await jsonBody(req), []); return json(res, await monitor.stop()); }
      if (req.method === 'GET' && url.pathname === '/api/monitor') return json(res, monitor.view({ windowS: Number(url.searchParams.get('window_s') ?? 30), paused: url.searchParams.get('paused') === '1' }));
      if (req.method === 'GET' && url.pathname === '/api/bootstrap') return json(res, { token, capabilities: { ...new JsonlFileAdapter('').capabilities(), live_capture: true, live_sources: ['csk_uart_installed_vendor_api', 'local_websocket_events'], detection_monitor: { implemented: true, recording: false, camera: false, axes: ['speed_mps', 'doppler_bin'], full_spectrum: false, limits: PLOT_LIMITS }, raw_micro_doppler: { implemented: true, inputs: ['raw_jsonl', 'synthetic_raw', 'local_websocket_raw_adc', 'csk_raw_uart'], hardware: RAW_HARDWARE_STATUS, cross_frame_stitching: false }, camera_capture: true, device_configuration: false, autonomous_csk_uart_start: false, capture_limits: CAPTURE_LIMITS, auto_label: model.capabilities(), max_upload_bytes: MAX_UPLOAD }, ...store.list(), recovery_problems: recoveryProblems, runtime_failure: controller.lastFailure ?? null });
      if (req.method === 'GET' && url.pathname === '/api/sessions') return json(res, { ...store.list(), runtime_failure: controller.lastFailure ?? null });
      if (req.method === 'POST' && url.pathname === '/api/sessions') {
        const body = await jsonBody(req);
        assertKeys(body, ['title', 'subject', 'scenario', 'split_group', 'mode', 'historical_device', 'request_id']);
        const existing = body.request_id && store.list().sessions.find(x => x.request_id === body.request_id);
        if (existing) return json(res, existing);
        const m = store.create(body); m.request_id = body.request_id ?? null; store.save(m); return json(res, m, 201);
      }
      if (req.method === 'POST' && url.pathname === '/api/demo') {
        const body = await jsonBody(req);
        const existing = body.request_id && store.list().sessions.find(x => x.request_id === body.request_id);
        if (existing) return json(res, existing);
        const m = store.create({ title: 'デモ：合成レーダーと合成動画', subject: 'synthetic', scenario: 'fixture_12s', mode: 'demo', split_group: 'demo_only' });
        m.request_id = body.request_id ?? null; store.save(m);
        const staged = store.file(m.id, 'upload-demo.tmp'); fs.copyFileSync(path.join(project, 'fixtures', 'demo.events.jsonl'), staged);
        store.attachSource(m.id, staged, { name: 'demo.events.jsonl', provenance: 'synthetic_fixture_no_hardware' });
        const video = store.file(m.id, 'upload-video.tmp'); fs.copyFileSync(path.join(project, 'fixtures', 'demo.webm'), video);
        store.attachVideo(m.id, video, 'demo.webm'); await controller.start(m.id); return json(res, store.get(m.id), 201);
      }
      if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2]) {
        const id = parts[2], action = parts[3]; store.get(id);
        if (req.method === 'GET' && !action) return json(res, { ...store.get(id), runtime_failure: controller.lastFailure?.id === id ? controller.lastFailure : null });
        if (req.method === 'GET' && action === 'frames') {
          const all = store.frames(id), offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0)), limit = Math.min(5000, Math.max(1, Number(url.searchParams.get('limit') ?? 1000)));
          if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit)) throw new AppError('INVALID_PAGE', '件数指定が不正です');
          return json(res, { frames: all.slice(offset, offset + limit), total: all.length, next_offset: offset + limit < all.length ? offset + limit : null });
        }
        if (req.method === 'GET' && action === 'plot') {
          const abort = new AbortController(); res.once('close', () => { if (!res.writableEnded) abort.abort(); });
          const result = await savedPreview(store, id, { startS: Number(url.searchParams.get('start_s') ?? 0), endS: url.searchParams.has('end_s') ? Number(url.searchParams.get('end_s')) : undefined, tail: url.searchParams.get('tail') === '1', limit: Number(url.searchParams.get('limit') ?? 6000), signal: abort.signal });
          if (!abort.signal.aborted) return json(res, result); return;
        }
        if (req.method === 'GET' && action === 'verify') return json(res, store.verify(id));
        if (req.method === 'GET' && action === 'configuration') return json(res, JSON.parse(fs.readFileSync(store.file(id, 'session-config.json'), 'utf8')));
        if (req.method === 'GET' && action === 'video') {
          const video = store.get(id).video; if (!video) throw new AppError('VIDEO_NOT_FOUND', '動画がありません', 404);
          return serveVideo(req, res, store.file(id, video.file), video.file.endsWith('.webm') ? 'video/webm' : video.file.endsWith('.mov') ? 'video/quicktime' : 'video/mp4');
        }
        if (req.method === 'GET' && action === 'export') {
          return await controller.lock(id, async () => {
            const format = url.searchParams.get('format') ?? 'archive';
            if (format === 'json') return json(res, store.dataset(id));
            const files = store.exportFiles(id);
            if (format === 'csv') { res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${id}-training.csv"` }); return await pipeline(fs.createReadStream(store.file(id, 'training.csv')), res); }
            res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="radar-session-${id}.tar.gz"` });
            await pipeline(Readable.from(tarFiles(files)), createGzip(), res);
          });
        }
        if (req.method === 'POST' && action === 'start') { assertKeys(await jsonBody(req), ['request_id']); return json(res, await controller.start(id)); }
        if (req.method === 'POST' && action === 'stop') { assertKeys(await jsonBody(req), ['request_id']); return json(res, await controller.stop(id)); }
        if (req.method === 'POST' && action === 'capture-start') {
          const body = await jsonBody(req); assertKeys(body, ['transport', 'port', 'url', 'data_kind', 'device', 'camera', 'resumed_from', 'request_id']);
          if (typeof body.request_id !== 'string' || !body.request_id) throw new AppError('REQUEST_ID_REQUIRED', '収録操作のIDが必要です');
          await controller.lock(id, () => { let m = store.get(id); if (!m.capture) { m = prepareLive(store, id, body); m.capture.start_request_id = body.request_id; store.save(m); return m; } if (m.capture.start_request_id !== body.request_id) throw new AppError('CAPTURE_ALREADY_EXISTS', '既存収録を変更できません。新しい収録を作成してください', 409); });
          return json(res, await controller.start(id));
        }
        if (req.method === 'POST' && action === 'capture-heartbeat') { assertKeys(await jsonBody(req), []); controller.heartbeat(id); return json(res, { ok: true, state: store.get(id).state }); }
        if (req.method === 'POST' && action === 'camera-chunk') {
          return await controller.lock(id, async () => {
            const staged = store.file(id, `upload-${randomUUID()}.tmp`);
            try { await upload(req, staged, CAPTURE_LIMITS.chunk_bytes); controller.heartbeat(id); return json(res, saveVideoChunk(store, id, staged, Number(url.searchParams.get('index')), Number(url.searchParams.get('end_ms')))); }
            finally { if (fs.existsSync(staged)) fs.unlinkSync(staged); }
          });
        }
        if (req.method === 'POST' && action === 'capture-finish') {
          const body = await jsonBody(req); assertKeys(body, ['expected_chunks', 'stopped_monotonic_ms', 'stopped_unix_ms']);
          await controller.stop(id); return await controller.lock(id, () => json(res, finishCamera(store, id, body)));
        }
        if (req.method === 'POST' && action === 'capture-error') {
          const body = await jsonBody(req); assertKeys(body, ['message']);
          return await controller.lock(id, async () => { const m = store.get(id), message = String(body.message ?? '動画収録が中断しました').slice(0, 500); if (m.last_error && m.state === 'error') { if (m.capture) m.capture.camera.error = message; store.save(m); } else await controller.fail(id, new AppError('CAMERA_CAPTURE_FAILED', message)); return json(res, store.get(id)); });
        }
        if (req.method === 'POST' && ['radar', 'video'].includes(action)) {
          return await controller.lock(id, async () => {
            const name = (url.searchParams.get('name') ?? '').split(/[\\/]/).pop();
            if (!name || name.length > 200) throw new AppError('FILENAME_REQUIRED', 'ファイル名を指定してください');
            const m = store.get(id);
            if (m[action === 'radar' ? 'source' : 'video']) throw new AppError('ALREADY_IMPORTED', '既に取り込まれています。新しいセッションを作成してください', 409);
            const staged = store.file(id, `upload-${randomUUID()}.tmp`);
            try {
              await upload(req, staged);
              if (action === 'video') return json(res, store.attachVideo(id, staged, name));
              if (![null, 'jsonl', 'diagnostic'].includes(url.searchParams.get('format'))) throw new AppError('UNSUPPORTED_FORMAT', '初版は同梱1.1 JSONLと診断サンプルのみ対応します');
              const diagnostic = url.searchParams.get('format') === 'diagnostic';
              if (!diagnostic) return json(res, store.attachSource(id, staged, { name }));
              let entries; try { entries = JSON.parse(fs.readFileSync(staged, 'utf8').replace(/^\uFEFF/, '')); } catch { throw new AppError('INVALID_DIAGNOSTIC', '診断サンプルJSONが不正です'); }
              if (!Array.isArray(entries) || !entries.length || entries.some(e => !e.Payload || typeof e.Payload !== 'object')) throw new AppError('INVALID_DIAGNOSTIC', 'LogTimeLocal / Timezone / Payloadを含む診断サンプル配列を指定してください');
              const transformed = store.file(id, `upload-${randomUUID()}.tmp`);
              fs.writeFileSync(transformed, entries.map(e => JSON.stringify(e)).join('\n') + '\n', { flag: 'wx' });
              return json(res, store.attachSource(id, transformed, { name, diagnostic: true, provenance: 'selected_existing_debug_log_samples_not_complete_capture', originalFile: staged }));
            } finally { if (fs.existsSync(staged)) fs.unlinkSync(staged); }
          });
        }
        if (req.method === 'POST') {
          const body = await jsonBody(req);
          return await controller.lock(id, async () => {
            if (action === 'video-metadata') return json(res, store.videoMetadata(id, body));
            if (action === 'sync') return json(res, store.setSync(id, body.anchors));
            if (action === 'labels' && !parts[4]) return json(res, store.addLabel(id, body));
            if (action === 'labels' && parts[4]) return json(res, store.reviewLabel(id, parts[4], body));
            if (action === 'candidates') {
              if (!Array.isArray(body.candidates) || body.candidates.length > 1000) throw new AppError('INVALID_CANDIDATES', 'candidates配列を1000件以内で指定してください');
              const m = store.get(id); if (!m.video || body.video_sha256 !== m.video.sha256) throw new AppError('CANDIDATE_VIDEO_MISMATCH', '候補JSONのvideo_sha256が対象動画と一致しません');
              for (const candidate of body.candidates) store.validateLabel(candidate, m.video.duration_s);
              const requestId = body.request_id ?? randomUUID();
              for (const [i, candidate] of body.candidates.entries()) store.addLabel(id, { ...candidate, request_id: `${requestId}:${i}` }, { importedCandidate: true });
              return json(res, store.get(id));
            }
            if (action === 'auto-label') return json(res, await model.propose(body));
            throw new AppError('NOT_FOUND', '操作が見つかりません', 404);
          });
        }
      }
      if (req.method === 'GET' && ['/', '/app.js', '/capture.js', '/doppler.js', '/micro.js', '/plot-model.mjs', '/style.css'].includes(url.pathname)) {
        const file = path.join(project, 'public', url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        res.writeHead(200, { 'Content-Type': /\.m?js$/.test(url.pathname) ? 'text/javascript; charset=utf-8' : url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return fs.createReadStream(file).pipe(res);
      }
      throw new AppError('NOT_FOUND', 'ページが見つかりません', 404);
    } catch (error) {
      req.resume();
      if (res.headersSent) { res.destroy(); return; }
      json(res, { error: { code: error.code ?? 'IO_ERROR', message: error instanceof AppError ? error.message : `保存または読出しに失敗しました: ${error.message}` } }, error.status ?? 500);
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, store, controller, monitor, raw, origin, token, async close() { await raw.close(); await monitor.close(); await controller.close(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.RADAR_PORT ?? 8765);
  const app = await createApp({ port, root: process.env.RADAR_DATA_DIR || undefined });
  console.log(`レーダーレビュー 0.2.0\n${app.origin}\n保存先: ${app.store.root}\n直接収録は画面の操作から開始します。終了: Ctrl+C`);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await app.close(); process.exit(0); };
  process.on('SIGINT', close); process.on('SIGTERM', close);
}
