import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { AppError, sha256, UNKNOWN } from './adapters.mjs';
import { fitSync, mapVideoTime, reconcileSyncClock } from './sync.mjs';

export function atomicJson(file, value, beforeWrite = () => {}) {
  beforeWrite(path.basename(file));
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx'); fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function fileSha(file) {
  const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024), fd = fs.openSync(file, 'r');
  try { for (;;) { const count = fs.readSync(fd, buffer, 0, buffer.length, null); if (!count) break; hash.update(buffer.subarray(0, count)); } } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
const safeId = id => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new AppError('INVALID_SESSION_ID', 'セッションIDが不正です');
  return id;
};
const settingKeys = ['adc_sample_rate_hz', 'samples_per_chirp', 'chirps_per_frame', 'rx_antennas', 'rx_order', 'chirp_interval_s', 'frame_interval_s', 'frequency_range_hz', 'gain', 'averaging', 'preprocessing'];
function reconcileManifestSyncClocks(manifest) {
  manifest.sync = reconcileSyncClock(manifest.sync, manifest.mode);
  if (Array.isArray(manifest.sync_history)) manifest.sync_history = manifest.sync_history.map(sync => reconcileSyncClock(sync, manifest.mode));
  return manifest;
}
export class SessionStore {
  constructor(root, { beforeWrite = () => {} } = {}) { this.root = path.resolve(root); this.beforeWrite = beforeWrite; fs.mkdirSync(this.root, { recursive: true }); }
  dir(id) { return path.join(this.root, safeId(id)); }
  file(id, name) { return path.join(this.dir(id), name); }
  save(manifest) { atomicJson(this.file(manifest.id, 'manifest.json'), reconcileManifestSyncClocks(manifest), this.beforeWrite); }
  get(id) {
    try { return reconcileManifestSyncClocks(JSON.parse(fs.readFileSync(this.file(id, 'manifest.json'), 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') throw new AppError('SESSION_NOT_FOUND', 'セッションが見つかりません', 404); throw error; }
  }
  list() {
    const sessions = [], unreadable = [];
    for (const item of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!item.isDirectory() || !/^[a-f0-9-]{36}$/.test(item.name)) continue;
      try { sessions.push(this.get(item.name)); } catch { unreadable.push(item.name); }
    }
    return { sessions: sessions.sort((a, b) => b.created_at.localeCompare(a.created_at)), unreadable };
  }
  create({ title = '新しい記録', subject = UNKNOWN, scenario = UNKNOWN, split_group = 'unassigned', mode = 'import', historical_device = null } = {}) {
    if (!['import', 'demo', 'diagnostic', 'live'].includes(mode)) throw new AppError('UNSUPPORTED_MODE', '保存ファイル取込み・デモ・直接収録に対応しています');
    for (const v of [title, subject, scenario, split_group]) if (typeof v !== 'string' || v.length > 200) throw new AppError('INVALID_METADATA', 'タイトル・被験者・シナリオ・分割グループは200文字以内で指定してください');
    const id = randomUUID(), created_at = new Date().toISOString();
    fs.mkdirSync(this.dir(id));
    const device = historical_device ? { sensor: 'BGT60CUTR13', board: UNKNOWN, firmware_name: 'indoor_people_localization', firmware_version: '0.4.5.dev0+g2b14fe4.d20260212', sensor_driver_version: '0.5.12', application_version: 'Visualization Tool 1.1.0', provenance: '2026-10-09 diagnostic snapshot; association with this imported file is self-declared; not current device interrogation', observed_connection: 'CSK UART COM10 (historical only)' } : { sensor: UNKNOWN, board: UNKNOWN, firmware_name: UNKNOWN, firmware_version: UNKNOWN, sensor_driver_version: UNKNOWN, application_version: UNKNOWN, provenance: mode === 'demo' ? 'synthetic_fixture_no_device' : UNKNOWN };
    const config = { schema_version: 1, app_version: '0.4.0', storage_version: 1, device, connection: 'saved_file_or_local_jsonl_upload', requested: { data_kind: 'detections' }, applied: { data_kind: 'detections' }, device_applied: UNKNOWN, acquisition_settings: Object.fromEntries(settingKeys.map(k => [k, UNKNOWN])), note: '設定の適用値はファイルadapterのデータ種別のみ。センサー実設定は未取得。' };
    atomicJson(this.file(id, 'session-config.json'), config, this.beforeWrite);
    const manifest = { schema_version: 1, id, title: title.trim() || '新しい記録', subject: subject.trim() || UNKNOWN, scenario: scenario.trim() || UNKNOWN, split_group: split_group.trim() || 'unassigned', mode, created_at, state: 'created', state_history: [{ state: 'created', at: created_at }], source: null, video: null, count: 0, event_count: 0, metadata_count: 0, invalid_count: 0, error_count: 0, last_source_line: 0, time_range: { first_pc_ms: UNKNOWN, last_pc_ms: UNKNOWN, min_pc_ms: UNKNOWN, max_pc_ms: UNKNOWN, duration_s: UNKNOWN, backwards_count: 0 }, config_sha256: fileSha(this.file(id, 'session-config.json')), last_error: null, sync: null, sync_history: [], labels: [], review_revision: 0, device_loss: UNKNOWN, physical_sync_accuracy_verified: false };
    fs.writeFileSync(this.file(id, 'frames.jsonl'), '', { flag: 'wx' }); this.save(manifest); return manifest;
  }
  transition(id, state, detail = null) {
    const m = this.get(id); if (m.state === state) return m;
    m.state = state; m.state_history.push({ state, at: new Date().toISOString(), detail }); this.save(m); return m;
  }
  attachSource(id, stagedFile, { name, diagnostic = false, provenance = 'user_import', originalFile = null } = {}) {
    const m = this.get(id);
    if (m.source) throw new AppError('SOURCE_ALREADY_EXISTS', '元データは既に取り込まれています。新しいセッションを作成してください', 409);
    if (!fs.statSync(stagedFile).size) throw new AppError('EMPTY_SOURCE', '空のファイルは取り込めません');
    const raw = this.file(id, 'raw.events.jsonl');
    if (fs.existsSync(raw)) throw new AppError('ORPHAN_SOURCE', '保存途中の元データがあります。新しいセッションを作成してください', 409);
    fs.renameSync(stagedFile, raw);
    if (originalFile) fs.renameSync(originalFile, this.file(id, 'diagnostic-original.json'));
    if (diagnostic) m.mode = 'diagnostic';
    m.source = { name, file: 'raw.events.jsonl', sha256: fileSha(raw), bytes: fs.statSync(raw).size, diagnostic, provenance, complete_capture: diagnostic ? false : UNKNOWN, original_file: originalFile ? 'diagnostic-original.json' : null, original_sha256: originalFile ? fileSha(this.file(id, 'diagnostic-original.json')) : null, transformations: diagnostic ? 'Selected diagnostic JSON array rendered as one envelope per JSONL line. Original array retained unchanged; no PC timestamp substitution.' : 'none; exact uploaded bytes retained' };
    m.state = 'ready'; m.state_history.push({ state: 'ready', at: new Date().toISOString() }); this.save(m); return m;
  }
  applyFrame(m, frame) {
    m.count++; m.last_source_line = frame.source_line;
    if (frame.data_kind === 'metadata') m.metadata_count++; else m.event_count++;
    if (frame.data_kind === 'invalid') m.invalid_count++;
    m.error_count += frame.errors.length;
    const t = frame.pc_receive_time.value, r = m.time_range;
    if (typeof t === 'number') {
      if (r.first_pc_ms === UNKNOWN) r.first_pc_ms = t;
      if (typeof r.last_pc_ms === 'number' && t < r.last_pc_ms) r.backwards_count++;
      r.last_pc_ms = t; r.min_pc_ms = typeof r.min_pc_ms === 'number' ? Math.min(t, r.min_pc_ms) : t;
      r.max_pc_ms = typeof r.max_pc_ms === 'number' ? Math.max(t, r.max_pc_ms) : t;
      r.duration_s = (r.max_pc_ms - r.min_pc_ms) / 1000;
    }
  }
  append(id, frame) {
    this.beforeWrite('frames.jsonl');
    const m = this.get(id);
    if (frame.receiver_sequence !== m.count + 1 || frame.source_line <= m.last_source_line) throw new AppError('CHECKPOINT_MISMATCH', '保存連番または元行の順序が一致しません', 409);
    const fd = fs.openSync(this.file(id, 'frames.jsonl'), 'a');
    try { fs.writeSync(fd, JSON.stringify(frame) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.applyFrame(m, frame); this.save(m); return m;
  }
  frames(id) {
    const text = fs.readFileSync(this.file(id, 'frames.jsonl'), 'utf8');
    if (text && !text.endsWith('\n')) throw new AppError('PARTIAL_FRAME', '保存途中のフレーム行があります。元データを保持し、再開を止めました', 409);
    try { return text.split('\n').filter(Boolean).map(x => JSON.parse(x)); }
    catch { throw new AppError('CORRUPT_FRAMES', '保存フレームが破損しています', 409); }
  }
  verify(id, { checkpoint = true } = {}) {
    const m = this.get(id), failures = [];
    let frames;
    try { frames = this.frames(id); } catch (error) { return { ok: false, failures: [error.code], count: UNKNOWN }; }
    if (fileSha(this.file(id, 'session-config.json')) !== m.config_sha256) failures.push('CONFIG_HASH_MISMATCH');
    let rawLines = [];
    if (m.source) {
      if (!(m.mode === 'live' && (!checkpoint || m.source.sha256 === UNKNOWN)) && fileSha(this.file(id, m.source.file)) !== m.source.sha256) failures.push('SOURCE_HASH_MISMATCH');
      rawLines = fs.readFileSync(this.file(id, m.source.file), 'utf8').split(/\r?\n/);
      if (m.source.original_file && fileSha(this.file(id, m.source.original_file)) !== m.source.original_sha256) failures.push('DIAGNOSTIC_ORIGINAL_HASH_MISMATCH');
    }
    if (m.video && fileSha(this.file(id, m.video.file)) !== m.video.sha256) failures.push('VIDEO_HASH_MISMATCH');
    for (const [index, chunk] of (m.capture?.chunks ?? []).entries()) {
      if (chunk.index !== index || !fs.existsSync(this.file(id, chunk.file)) || fileSha(this.file(id, chunk.file)) !== chunk.sha256) failures.push(`VIDEO_CHUNK_${index}`);
    }
    if (checkpoint && m.mode === 'live' && m.state === 'completed' && (!m.video || m.capture?.camera.state !== 'finalized')) failures.push('INCOMPLETE_LIVE_CAPTURE');
    let priorLine = 0;
    const derived = { count: 0, event_count: 0, metadata_count: 0, invalid_count: 0, error_count: 0, last_source_line: 0, time_range: { first_pc_ms: UNKNOWN, last_pc_ms: UNKNOWN, min_pc_ms: UNKNOWN, max_pc_ms: UNKNOWN, duration_s: UNKNOWN, backwards_count: 0 } };
    for (const [i, frame] of frames.entries()) {
      const { record_sha256, ...record } = frame;
      if (sha256(JSON.stringify(record)) !== record_sha256) failures.push(`FRAME_HASH_${i + 1}`);
      if (frame.receiver_sequence !== i + 1 || frame.source_line <= priorLine || rawLines.slice(priorLine, frame.source_line - 1).some(line => line.trim())) failures.push(`ORDER_${i + 1}`);
      let rawLine = rawLines[frame.source_line - 1]; if (frame.source_line === 1) rawLine = rawLine?.replace(/^\uFEFF/, '');
      if (typeof rawLine !== 'string' || sha256(rawLine) !== frame.raw_line_sha256) failures.push(`RAW_LINE_${i + 1}`);
      priorLine = frame.source_line; this.applyFrame(derived, frame);
    }
    if (checkpoint && (m.count !== frames.length || m.last_source_line !== derived.last_source_line)) failures.push('COUNT_CHECKPOINT_MISMATCH');
    if (checkpoint && JSON.stringify(m.time_range) !== JSON.stringify(derived.time_range)) failures.push('TIME_RANGE_MISMATCH');
    const remaining = rawLines.slice(priorLine).filter(line => line.trim()).length;
    if (checkpoint && m.state === 'completed' && remaining) failures.push('UNREAD_SOURCE_RECORDS');
    return { ok: !failures.length, failures, count: frames.length, order_verified: !failures.some(x => /ORDER|RAW_LINE/.test(x)), time_range: derived.time_range, derived, unread_source_records: remaining, device_loss: UNKNOWN, settings_verified: !failures.includes('CONFIG_HASH_MISMATCH'), physical_sync_accuracy_verified: false, checked_at: new Date().toISOString() };
  }
  recover(id) {
    const m = this.get(id), report = this.verify(id, { checkpoint: false });
    if (!report.ok) throw new AppError('READBACK_FAILED', `読み戻し検証で不一致: ${report.failures.join(', ')}`, 409);
    Object.assign(m, report.derived);
    if (['running', 'stopping'].includes(m.state)) { m.state = 'interrupted'; m.state_history.push({ state: 'interrupted', at: new Date().toISOString(), detail: '前回の処理が終了前に中断。durableなフレームからcheckpointを再構成。' }); }
    this.save(m); return m;
  }
  attachVideo(id, staged, name) {
    const m = this.get(id);
    if (m.video) throw new AppError('VIDEO_ALREADY_EXISTS', '動画は既に登録されています。取り違えを防ぐため、新しいセッションを作成してください', 409);
    if (!/\.(mp4|webm|mov|m4v)$/i.test(name)) throw new AppError('UNSUPPORTED_VIDEO', 'MP4 / WebM / MOV / M4Vを指定してください');
    if (!fs.statSync(staged).size) throw new AppError('EMPTY_VIDEO', '空の動画は取り込めません');
    const target = this.file(id, 'video' + path.extname(name).toLowerCase());
    if (fs.existsSync(target)) throw new AppError('ORPHAN_VIDEO', '前回の動画保存が未完了です。新しいセッションを作成してください', 409);
    fs.renameSync(staged, target);
    m.video = { name, file: path.basename(target), sha256: fileSha(target), bytes: fs.statSync(target).size, duration_s: UNKNOWN, metadata_provenance: UNKNOWN, capture_started_by_this_app: false };
    this.save(m); return m;
  }
  videoMetadata(id, { duration_s, sha256: hash }) {
    const m = this.get(id);
    if (!m.video || m.video.sha256 !== hash) throw new AppError('VIDEO_CHANGED', '動画の識別値が一致しません', 409);
    if (typeof duration_s !== 'number' || !Number.isFinite(duration_s) || duration_s <= 0 || duration_s > 86400) throw new AppError('INVALID_DURATION', '有効な動画時間を取得できません');
    if (m.sync && m.video.duration_s !== duration_s) throw new AppError('DURATION_CHANGED', '同期後に動画時間を変更できません', 409);
    m.video.duration_s = duration_s; m.video.metadata_provenance = 'local_browser_loadedmetadata_unverified_frame_timing'; this.save(m); return m;
  }
  setSync(id, anchors) {
    const m = this.get(id);
    if (m.time_range.backwards_count) throw new AppError('CLOCK_BACKWARDS', 'PC時刻が逆行しています。初版では線形同期を止めます');
    if (['running', 'stopping'].includes(m.state)) throw new AppError('BUSY', '取込みを停止または完了してから同期してください', 409);
    if (m.sync) m.sync_history.push(m.sync);
    m.sync = fitSync(anchors, m.time_range.duration_s, m.video?.duration_s, { mode: m.mode });
    this.save(m); return m;
  }
  addLabel(id, input, { importedCandidate = false } = {}) {
    const m = this.get(id);
    if (!m.video || typeof m.video.duration_s !== 'number') throw new AppError('VIDEO_REQUIRED', '動画を読み込んでから区間を追加してください');
    if (input.request_id && m.labels.some(x => x.request_id === input.request_id)) return m;
    this.validateLabel(input, m.video.duration_s);
    const candidate = { label: input.label.trim(), start_video_s: input.start_video_s, end_video_s: input.end_video_s };
    m.labels.push({ id: randomUUID(), request_id: input.request_id ?? null, ...candidate, channel: input.channel ?? 'current_action', origin: importedCandidate ? 'automatic_candidate_import' : 'manual', candidate: importedCandidate ? candidate : null, model: importedCandidate ? String(input.model ?? UNKNOWN).slice(0, 200) : null, candidate_provenance: importedCandidate ? String(input.provenance ?? 'user_supplied_candidate_not_generated_by_this_app').slice(0, 500) : null, status: 'pending', created_at: new Date().toISOString(), history: [] });
    m.review_revision++; this.save(m); return m;
  }
  validateLabel(input, duration) {
    if (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 200) throw new AppError('LABEL_REQUIRED', '行動名を200文字以内で入力してください。「その他」「不明」も使えます');
    if (!['current_action', 'context', 'quality'].includes(input.channel ?? 'current_action')) throw new AppError('INVALID_CHANNEL', 'ラベル分類が不正です');
    const a = input.start_video_s, b = input.end_video_s;
    if (![a, b].every(x => typeof x === 'number' && Number.isFinite(x)) || a < 0 || b <= a || b > duration + 1e-6) throw new AppError('INVALID_INTERVAL', '0 ≦ 開始 < 終了 ≦ 動画時間で指定してください');
  }
  reviewLabel(id, labelId, input) {
    const m = this.get(id), label = m.labels.find(x => x.id === labelId);
    if (!label) throw new AppError('LABEL_NOT_FOUND', '区間が見つかりません', 404);
    if (input.request_id && label.history.some(x => x.request_id === input.request_id)) return m;
    if (input.expected_revision !== m.review_revision) throw new AppError('STALE_REVIEW', '別の操作で区間が更新されました。再読込みしてください', 409);
    if (!['confirm', 'correct', 'reject'].includes(input.action)) throw new AppError('INVALID_REVIEW', '確認・修正・除外のいずれかを選んでください');
    const before = { label: label.label, start_video_s: label.start_video_s, end_video_s: label.end_video_s, status: label.status };
    if (input.action === 'correct') {
      this.validateLabel(input, m.video.duration_s);
      label.label = input.label.trim(); label.start_video_s = input.start_video_s; label.end_video_s = input.end_video_s;
    }
    const changed = label.history.some(x => x.action === 'correct');
    label.status = input.action === 'correct' ? 'corrected' : input.action === 'reject' ? 'rejected' : changed ? 'corrected' : 'confirmed';
    label.history.push({ request_id: input.request_id ?? null, action: input.action, reviewer: 'self', at: new Date().toISOString(), before, after: { label: label.label, start_video_s: label.start_video_s, end_video_s: label.end_video_s, status: label.status }, review_duration_ms: typeof input.review_duration_ms === 'number' && Number.isFinite(input.review_duration_ms) && input.review_duration_ms >= 0 ? input.review_duration_ms : UNKNOWN });
    m.review_revision++; this.save(m); return m;
  }
  dataset(id) {
    const m = this.get(id), report = this.verify(id);
    if (['running', 'stopping'].includes(m.state)) throw new AppError('BUSY', '停止または完了してから書き出してください', 409);
    if (!report.ok) throw new AppError('READBACK_FAILED', `読み戻し不一致: ${report.failures.join(', ')}`, 409);
    const frames = this.frames(id), intervals = [], excluded = [];
    for (const label of m.labels) {
      if (!['confirmed', 'corrected'].includes(label.status)) { excluded.push({ id: label.id, reason: label.status }); continue; }
      const start = mapVideoTime(m.sync, label.start_video_s), end = mapVideoTime(m.sync, label.end_video_s);
      if (typeof start.radar_s !== 'number' || start.radar_s < -1e-6 || end.radar_s > m.time_range.duration_s + 1e-6) { excluded.push({ id: label.id, reason: 'sync_missing_or_outside_radar_range' }); continue; }
      const selected = frames.filter(f => f.data_kind === 'detections' && typeof f.pc_receive_time.value === 'number' && (f.pc_receive_time.value - m.time_range.first_pc_ms) / 1000 >= start.radar_s - 1e-6 && (f.pc_receive_time.value - m.time_range.first_pc_ms) / 1000 < end.radar_s - 1e-6);
      if (!selected.length) { excluded.push({ id: label.id, reason: 'no_valid_timed_detection_events' }); continue; }
      intervals.push({ ...label, start_radar_s: start.radar_s, end_radar_s: end.radar_s, start_uncertainty_s: start.uncertainty_s, end_uncertainty_s: end.uncertainty_s, extrapolated: start.extrapolated || end.extrapolated, receiver_sequences: selected.map(f => f.receiver_sequence) });
    }
    return { schema_version: 1, session_id: id, subject: m.subject, scenario: m.scenario, split_group: m.split_group, mode: m.mode, data_kind: 'detections_not_raw_adc', interval_convention: '[start,end)', source: m.source, config: JSON.parse(fs.readFileSync(this.file(id, 'session-config.json'), 'utf8')), time_range: m.time_range, sync: m.sync, video: m.video, intervals, excluded, reviewed_label_count: m.labels.filter(x => ['confirmed', 'corrected'].includes(x.status)).length, warnings: [m.mode === 'live' ? '物理同期精度は未実証。PC受信時刻と動画時刻の線形対応。' : '物理同期精度は未実証。PC解読時刻と動画時刻の線形対応。', '機器側欠損はunknown。targetのsequence_numはpacket連番として検証されていない。', '被験者・セッション単位で分割する。重複窓を学習と評価にまたがせない。', ...(m.mode === 'demo' ? ['デモは合成データ。実機収録・学習性能の証拠にはしない。'] : []), ...(m.state !== 'completed' ? ['取込みは未完了。保存済みの範囲のみ書き出す。'] : [])], integrity: report, exported_at: new Date().toISOString() };
  }
  exportFiles(id) {
    const dataset = this.dataset(id);
    // Include the same corrected metadata in both training.json and the archived
    // manifest. No anchors, coefficients, frames, or source clocks are changed.
    this.save(this.get(id));
    atomicJson(this.file(id, 'training.json'), dataset, this.beforeWrite);
    atomicJson(this.file(id, 'readback-report.json'), dataset.integrity, this.beforeWrite);
    atomicJson(this.file(id, 'labels-review.json'), { revision: this.get(id).review_revision, labels: this.get(id).labels }, this.beforeWrite);
    const cell = x => '"' + String(x ?? '').replace(/"/g, '""') + '"';
    const columns = ['session_id', 'subject', 'scenario', 'split_group', 'label', 'channel', 'status', 'origin', 'start_video_s', 'end_video_s', 'start_radar_s', 'end_radar_s', 'start_uncertainty_s', 'end_uncertainty_s', 'receiver_sequences'];
    const rows = dataset.intervals.map(x => columns.map(key => cell(key === 'receiver_sequences' ? x.receiver_sequences.join(';') : x[key] ?? dataset[key])).join(','));
    fs.writeFileSync(this.file(id, 'training.csv'), '\uFEFF' + columns.join(',') + '\r\n' + rows.join('\r\n') + '\r\n');
    return fs.readdirSync(this.dir(id)).filter(name => !name.endsWith('.tmp') && !name.startsWith('upload-')).map(name => ({ name, path: this.file(id, name) }));
  }
}
