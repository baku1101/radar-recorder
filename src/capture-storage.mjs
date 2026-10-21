import fs from 'node:fs';
import path from 'node:path';
import { AppError, UNKNOWN } from './adapters.mjs';
import { atomicJson, fileSha } from './storage.mjs';
import { localWebSocketUrl, normalizeLiveEnvelope } from './live.mjs';

export const CAPTURE_LIMITS = { radar_bytes: 256 * 1024 * 1024, video_bytes: 1024 * 1024 * 1024, chunk_bytes: 8 * 1024 * 1024, max_seconds: 3600 };
const finite = value => typeof value === 'number' && Number.isFinite(value);
export function prepareLive(store, id, input) {
  const m = store.get(id);
  if (m.mode !== 'live' || m.source || m.capture) throw new AppError('LIVE_SESSION_REQUIRED', '新しい直接収録セッションを作成してください', 409);
  const transport = input.transport ?? 'local_websocket_events';
  if (!['local_websocket_events', 'csk_uart_installed_vendor_api'].includes(transport)) throw new AppError('UNSUPPORTED_TRANSPORT', '対応していない接続方式です');
  if (transport === 'csk_uart_installed_vendor_api' && !/^COM\d{1,3}$/i.test(input.port ?? '')) throw new AppError('INVALID_COM_PORT', 'COM番号を指定してください');
  const connection = transport === 'local_websocket_events' ? { transport, url: localWebSocketUrl(input.url) } : { transport, port: input.port.toUpperCase(), baudrate: 2000000 };
  if (input.data_kind && input.data_kind !== 'detections') throw new AppError('UNSUPPORTED_SETTING', 'ADC・FFT出力はこの経路で収録できません');
  const c = input.camera;
  if (!c || !['video/webm', 'video/webm;codecs=vp8', 'video/webm;codecs=vp9'].includes(c.mime_type) || ![c.started_unix_ms, c.started_monotonic_ms, c.time_origin_ms].every(finite)) throw new AppError('CAMERA_METADATA_REQUIRED', 'カメラの開始時計とWebM形式を確認してください');
  const config = JSON.parse(fs.readFileSync(store.file(id, 'session-config.json'), 'utf8'));
  const fields = ['sensor', 'board', 'firmware_name', 'firmware_version', 'sensor_driver_version', 'application_version'];
  config.app_version = '0.4.0'; config.connection = connection;
  config.device = Object.fromEntries(fields.map(key => [key, typeof input.device?.[key] === 'string' ? input.device[key].slice(0, 200) : UNKNOWN]));
  config.device.provenance = 'user_declared_not_live_device_interrogation';
  config.requested = { data_kind: 'detections' }; config.applied = { data_kind: 'detections' }; config.device_applied = UNKNOWN;
  config.note = transport === 'csk_uart_installed_vendor_api' ? '現在のCSK検出出力を受信。FWと実設定をGET照会し、応答はdevice_queryに保存。機器設定書込み・FW変更・ADC転送なし。' : 'WebSocketライブ検出イベントをPCで受信。機器設定は未照会。機器コマンド・FW変更・ADC転送なし。';
  config.camera = { ...c, clock_provenance: 'browser_reported_start_callback_not_exposure_time', audio: false };
  atomicJson(store.file(id, 'session-config.json'), config, store.beforeWrite);
  fs.writeFileSync(store.file(id, 'raw.events.jsonl'), '', { flag: 'wx' });
  m.config_sha256 = fileSha(store.file(id, 'session-config.json'));
  m.source = { name: 'ライブWebSocket検出イベント', file: 'raw.events.jsonl', sha256: UNKNOWN, bytes: 0, diagnostic: false, provenance: 'live_websocket_text_envelopes', complete_capture: false, transformations: 'Original WebSocket text is escaped in message_utf8; PC receive clocks and envelope hash are added. Source ts remains unchanged.' };
  m.capture = { status: 'starting', prepared_at: new Date().toISOString(), camera: { ...config.camera, state: 'recording' }, chunks: [], chunk_count: 0, video_bytes: 0, physical_sync_accuracy_verified: false, limits: CAPTURE_LIMITS, resumed_from: input.resumed_from ?? null, gaps: [] };
  m.state = 'ready'; store.save(m); return m;
}
export function appendLive(store, id, envelope) {
  const m = store.get(id), line = JSON.stringify(envelope), frame = normalizeLiveEnvelope(line, m.count + 1);
  if (m.source.bytes + Buffer.byteLength(line) + 1 > CAPTURE_LIMITS.radar_bytes) throw new AppError('CAPTURE_LIMIT', 'レーダー保存量の上限に達したため収録を停止します');
  store.beforeWrite('raw.events.jsonl');
  const fd = fs.openSync(store.file(id, 'raw.events.jsonl'), 'a');
  try { fs.writeSync(fd, line + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  // A complete durable envelope can be normalized after a later checkpoint failure.
  m.source.bytes = fs.statSync(store.file(id, m.source.file)).size; store.save(m);
  return store.append(id, frame);
}
export function sealLive(store, id) {
  const m = store.get(id);
  if (m.source) { m.source.sha256 = fileSha(store.file(id, m.source.file)); m.source.bytes = fs.statSync(store.file(id, m.source.file)).size; }
  store.save(m); return m;
}
export function recoverLive(store, id) {
  let m = store.get(id); if (!m.source) return m;
  const raw = fs.readFileSync(store.file(id, m.source.file), 'utf8');
  if (raw && !raw.endsWith('\n')) throw new AppError('PARTIAL_LIVE_SOURCE', '受信記録に保存途中の最終行があります。元ファイルを保持し再開を止めました', 409);
  const lines = raw.split('\n').filter(Boolean), generated = lines.map((line, i) => normalizeLiveEnvelope(line, i + 1));
  const report = store.verify(id, { checkpoint: false });
  if (!report.ok) throw new AppError('READBACK_FAILED', `直接収録の読み戻し不一致: ${report.failures.join(', ')}`, 409);
  const frames = store.frames(id);
  if (frames.some((f, i) => generated[i]?.record_sha256 !== f.record_sha256)) throw new AppError('READBACK_FAILED', '元受信記録と保存フレームが一致しません', 409);
  Object.assign(m, report.derived); m.source.bytes = Buffer.byteLength(raw); m.source.sha256 = UNKNOWN; store.save(m);
  for (const frame of generated.slice(frames.length)) store.append(id, frame);
  m = store.get(id);
  if (['running', 'ready', 'stopping'].includes(m.state) || ['starting', 'recording', 'finalizing'].includes(m.capture?.status)) {
    m.state = 'interrupted'; m.capture.status = 'interrupted'; m.capture.camera.state = 'interrupted';
    m.capture.gaps.push({ reason: 'process_or_browser_interruption_unobserved_interval', from: m.time_range.last_pc_ms, to: UNKNOWN });
    m.state_history.push({ state: 'interrupted', at: new Date().toISOString(), detail: 'durable受信記録を復旧。次の収録は別セッションで開始し、空白区間をつなげない。' });
  }
  store.save(m); return sealLive(store, id);
}
export function saveVideoChunk(store, id, staged, index, endMonotonicMs) {
  const m = store.get(id), capture = m.capture;
  if (m.mode !== 'live' || !capture || capture.camera.state === 'finalized') throw new AppError('CAMERA_NOT_RECORDING', '動画分割の保存を受け付ける収録がありません', 409);
  if (!Number.isSafeInteger(index) || index < 0 || !finite(endMonotonicMs) || endMonotonicMs < capture.camera.started_monotonic_ms) throw new AppError('INVALID_CHUNK', '動画分割の連番または時計が不正です');
  const bytes = fs.statSync(staged).size, hash = fileSha(staged);
  if (!bytes || bytes > CAPTURE_LIMITS.chunk_bytes) throw new AppError('VIDEO_CHUNK_LIMIT', '動画分割の保存上限は8 MiBです', 413);
  const existing = capture.chunks[index];
  if (existing) { if (existing.sha256 !== hash || existing.end_monotonic_ms !== endMonotonicMs) throw new AppError('CHUNK_CONFLICT', '同じ連番の動画が別内容です', 409); return m; }
  if (index !== capture.chunks.length) throw new AppError('CHUNK_ORDER', '動画分割の連番が飛んでいます。欠けた分割を再送してください', 409);
  if (index && endMonotonicMs < capture.chunks[index - 1].end_monotonic_ms) throw new AppError('CAMERA_CLOCK_BACKWARDS', '動画分割の時計が逆行しています');
  if (capture.video_bytes + bytes > CAPTURE_LIMITS.video_bytes) throw new AppError('CAPTURE_LIMIT', '動画保存量の上限に達しました', 413);
  const file = `camera-chunk-${String(index).padStart(6, '0')}.webm`, target = store.file(id, file);
  store.beforeWrite(file);
  if (fs.existsSync(target)) { if (fileSha(target) !== hash) throw new AppError('ORPHAN_CHUNK_CONFLICT', '保存途中の動画が別内容です', 409); }
  else fs.renameSync(staged, target);
  capture.chunks.push({ index, file, bytes, sha256: hash, end_monotonic_ms: endMonotonicMs, received_unix_ms: Date.now(), clock_provenance: 'browser_dataavailable_callback_not_exposure_boundary' });
  capture.chunk_count++; capture.video_bytes += bytes; store.save(m); return m;
}
export function finishCamera(store, id, input) {
  let m = store.get(id), c = m.capture;
  if (!c) throw new AppError('LIVE_SESSION_REQUIRED', '直接収録ではありません');
  if (c.camera.state === 'finalized') {
    if (input.expected_chunks !== c.chunk_count || input.stopped_monotonic_ms !== c.camera.stopped_monotonic_ms) throw new AppError('CAMERA_FINISH_CONFLICT', '終了した動画の再送内容が一致しません', 409);
    return m;
  }
  if (m.state === 'running') throw new AppError('STOP_RADAR_FIRST', '先にレーダー収録を停止してください', 409);
  if (!Number.isSafeInteger(input.expected_chunks) || input.expected_chunks !== c.chunk_count || !c.chunk_count) throw new AppError('INCOMPLETE_VIDEO', '動画分割の件数が一致しません。保存済み分割を保持します', 409);
  if (![input.stopped_monotonic_ms, input.stopped_unix_ms].every(finite) || input.stopped_monotonic_ms <= c.camera.started_monotonic_ms || c.chunks.at(-1).end_monotonic_ms > input.stopped_monotonic_ms + 1000) throw new AppError('INVALID_CAMERA_CLOCK', '動画終了時計が不正です');
  verifyChunks(store, id, c);
  const temp = store.file(id, 'camera-finalize.tmp'), target = store.file(id, 'video-live.webm');
  store.beforeWrite('video-live.webm');
  const fd = fs.openSync(temp, 'w'), buffer = Buffer.alloc(64 * 1024);
  try {
    for (const chunk of c.chunks) { const source = fs.openSync(store.file(id, chunk.file), 'r'); try { for (;;) { const n = fs.readSync(source, buffer, 0, buffer.length, null); if (!n) break; fs.writeSync(fd, buffer.subarray(0, n)); } } finally { fs.closeSync(source); } }
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temp, target);
  c.camera.state = 'finalized'; c.camera.stopped_monotonic_ms = input.stopped_monotonic_ms; c.camera.stopped_unix_ms = input.stopped_unix_ms;
  m.video = { name: '直接収録のカメラ動画', file: path.basename(target), bytes: fs.statSync(target).size, sha256: fileSha(target), duration_s: (input.stopped_monotonic_ms - c.camera.started_monotonic_ms) / 1000, metadata_provenance: 'browser_mediarecorder_start_stop_monotonic_callbacks_not_frame_exposure', capture_started_by_this_app: true, audio: false };
  const integrity = store.verify(id);
  const validDetections = store.frames(id).some(f => f.data_kind === 'detections' && !f.errors.length);
  if (m.state === 'stopped' && !m.last_error && validDetections && integrity.ok) { m.state = 'completed'; c.status = 'completed'; m.source.complete_capture = UNKNOWN; }
  else { c.status = 'partial'; if (!validDetections) { m.state = 'error'; m.last_error ??= { code: 'NO_VALID_DETECTIONS', message: '有効な検出結果を受信できませんでした', at: new Date().toISOString() }; } }
  m.state_history.push({ state: m.state, at: new Date().toISOString(), detail: '動画分割を件数・連番・SHA-256で照合し結合。収録時計の一致は物理同期の保証ではない。' });
  store.save(m); return m;
}
export function verifyChunks(store, id, capture) {
  for (const [index, chunk] of (capture?.chunks ?? []).entries()) if (chunk.index !== index || !fs.existsSync(store.file(id, chunk.file)) || fileSha(store.file(id, chunk.file)) !== chunk.sha256) throw new AppError('VIDEO_CHUNK_HASH_MISMATCH', '動画分割の連番またはハッシュが一致しません', 409);
}
