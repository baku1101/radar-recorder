import fs from 'node:fs';
import readline from 'node:readline';
import { createHash } from 'node:crypto';

export const UNKNOWN = 'unknown';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export class AppError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export function parseBundledTimestamp(value) {
  // Visualization Tool 1.1 writes time()*1000 as H+:MM:SS.mmm, with unbounded hours.
  if (typeof value !== 'string') return UNKNOWN;
  const match = /^(\d+):([0-5]\d):([0-5]\d)\.(\d{3})$/.exec(value);
  if (!match) return UNKNOWN;
  const ms = Number(match[1]) * 3600000 + Number(match[2]) * 60000 + Number(match[3]) * 1000 + Number(match[4]);
  return Number.isSafeInteger(ms) ? ms : UNKNOWN;
}

export class AcquisitionAdapter {
  async connect() { throw new AppError('NOT_IMPLEMENTED', '接続adapterが未実装です'); }
  capabilities() { throw new AppError('NOT_IMPLEMENTED', '対応機能が未実装です'); }
  configure() { throw new AppError('NOT_IMPLEMENTED', '設定が未実装です'); }
  async start() { throw new AppError('NOT_IMPLEMENTED', '開始が未実装です'); }
  async read() { throw new AppError('NOT_IMPLEMENTED', '読出しが未実装です'); }
  async stop() { throw new AppError('NOT_IMPLEMENTED', '停止が未実装です'); }
  async disconnect() { throw new AppError('NOT_IMPLEMENTED', '切断が未実装です'); }
}

export function normalizeRecord(rawLine, sourceLine, receiverSequence, { diagnostic = false, replayTime = Date.now() } = {}) {
  let source;
  const errors = [];
  try { source = JSON.parse(rawLine); }
  catch { errors.push({ code: 'INVALID_JSON', message: '元の行を保持しました。JSONとして読めません。' }); }
  let payload = diagnostic ? source?.Payload : source;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    errors.push({ code: 'INVALID_RECORD', message: 'イベントはJSON objectである必要があります。' });
    payload = {};
  }
  const metadata = !diagnostic && (Object.hasOwn(payload, 'types') || Object.hasOwn(payload, 'event_info')) && !Object.hasOwn(payload, 'detections');
  const detections = payload.detections;
  let shape = UNKNOWN;
  let attributes = [];
  let data = [];
  if (detections !== undefined) {
    if (!Array.isArray(detections?.attributes) || !detections.attributes.every(a => typeof a === 'string') || !Array.isArray(detections?.data)) {
      errors.push({ code: 'INVALID_DETECTIONS', message: 'detections.attributes / dataが配列ではありません。' });
    } else {
      attributes = detections.attributes;
      data = detections.data;
      shape = [data.length, attributes.length];
      if (new Set(attributes).size !== attributes.length || data.some(row => !Array.isArray(row) || row.length !== attributes.length || row.some(x => typeof x !== 'number' || !Number.isFinite(x)))) {
        errors.push({ code: 'SHAPE_OR_VALUE_MISMATCH', message: '検出配列のshapeまたは値が不正です。元データを確認してください。' });
      }
    }
  }
  const pcMs = diagnostic || metadata ? UNKNOWN : parseBundledTimestamp(payload.ts);
  if (!diagnostic && !metadata && pcMs === UNKNOWN) errors.push({ code: 'PC_TIME_UNKNOWN', message: '同梱1.1のPC解読時刻を確認できません。数値tsを機器時刻とは推定しません。' });
  const sequenceIndex = attributes.indexOf('sequence_num');
  const deviceTime = payload.device_time;
  const declaredDeviceTime = deviceTime && typeof deviceTime.value === 'number' && Number.isFinite(deviceTime.value) && ['ms', 's', 'us', 'ns', 'ticks'].includes(deviceTime.unit) && typeof deviceTime.basis === 'string';
  const result = {
    schema_version: 1, receiver_sequence: receiverSequence, source_line: sourceLine,
    data_kind: errors.some(e => ['INVALID_JSON', 'INVALID_RECORD', 'INVALID_DETECTIONS', 'SHAPE_OR_VALUE_MISMATCH'].includes(e.code)) ? 'invalid' : metadata ? 'metadata' : detections ? 'detections' : 'event',
    shape, attributes, data, source_packet_sequence: UNKNOWN,
    target_sequence_nums: sequenceIndex < 0 ? UNKNOWN : data.map(row => row?.[sequenceIndex] ?? UNKNOWN),
    target_sequence_semantics: 'unknown: 検出対象のsequence_numをpacket連番と同一視しない',
    device_time: declaredDeviceTime ? { ...deviceTime, provenance: 'source_explicit_declaration_unverified' } : { value: UNKNOWN, unit: UNKNOWN, basis: UNKNOWN },
    pc_receive_time: { value: pcMs, unit: 'ms', basis: pcMs === UNKNOWN ? UNKNOWN : 'unix_epoch_utc', provenance: diagnostic ? 'selected_debug_payload_before_pc_timestamp_substitution' : 'bundled_1.1_pc_decode_timestamp_not_sensor_capture' },
    replay_import_time: { value: replayTime, unit: 'ms', basis: 'unix_epoch_utc', provenance: 'this_app_read_time_not_original_receive_time' },
    diagnostic_log_time: diagnostic ? { local: source?.LogTimeLocal ?? UNKNOWN, timezone: source?.Timezone ?? UNKNOWN, provenance: 'selected_log_entry_not_capture_clock' } : UNKNOWN,
    missing: { device_packets: UNKNOWN, physical_capture_loss: UNKNOWN, reason: '機器packet連番の意味・範囲が未確認。PC受信番号から欠損ゼロとは判定しない。', reported_frames_dropped: payload.frames_dropped ?? UNKNOWN },
    errors, raw: source ?? UNKNOWN, raw_line_sha256: sha256(rawLine)
  };
  result.record_sha256 = sha256(JSON.stringify(result));
  return result;
}

export class JsonlFileAdapter extends AcquisitionAdapter {
  constructor(path, { diagnostic = false, skipSourceLines = 0, receiverSequence = 0 } = {}) {
    super(); this.path = path; this.diagnostic = diagnostic; this.sourceLine = 0;
    this.skipSourceLines = skipSourceLines; this.sequence = receiverSequence; this.connected = false; this.active = false;
  }
  async connect() {
    if (this.connected) return;
    if (!fs.statSync(this.path).isFile()) throw new AppError('INVALID_SOURCE', '入力ファイルではありません');
    this.stream = fs.createReadStream(this.path, { encoding: 'utf8' });
    this.lines = readline.createInterface({ input: this.stream, crlfDelay: Infinity });
    this.iterator = this.lines[Symbol.asyncIterator](); this.connected = true;
  }
  capabilities() {
    return { transport: 'saved_file_jsonl', data_kinds: ['detections', 'event', 'metadata'], settings: { data_kind: ['detections'] }, device_configuration: false, live_capture: false, resume: true, adc: false, fft: false, camera: false, fpga: false, format: 'Visualization Tool 1.1 JSONL (optional types header)' };
  }
  configure(requested = {}) {
    const unsupported = Object.keys(requested).filter(key => key !== 'data_kind');
    if (unsupported.length || requested.data_kind && requested.data_kind !== 'detections') throw new AppError('UNSUPPORTED_SETTING', `保存ファイルadapterで未対応の要求です: ${unsupported.join(', ') || requested.data_kind}`);
    this.configuration = { requested: { ...requested }, applied: { data_kind: 'detections' }, device_applied: UNKNOWN, reason: '保存ファイルを読む。センサー設定の変更・現在値の取得は行わない。' };
    return this.configuration;
  }
  async start() { if (!this.connected) throw new AppError('NOT_CONNECTED', '先に接続してください'); this.active = true; }
  async read() {
    if (!this.active) throw new AppError('NOT_RUNNING', '読出しは停止中です');
    for (;;) {
      const item = await this.iterator.next();
      if (item.done) return null;
      this.sourceLine++;
      if (this.sourceLine <= this.skipSourceLines || !item.value.trim()) continue;
      // A UTF-8 BOM is accepted only at the beginning; raw file bytes stay unchanged.
      const rawLine = this.sourceLine === 1 ? item.value.replace(/^\uFEFF/, '') : item.value;
      return normalizeRecord(rawLine, this.sourceLine, ++this.sequence, { diagnostic: this.diagnostic });
    }
  }
  async stop() { this.active = false; }
  async disconnect() { this.active = false; this.lines?.close(); this.stream?.destroy(); this.connected = false; }
}

export class UnavailableHardwareAdapter extends AcquisitionAdapter {
  constructor(transport) { super(); this.transport = transport; }
  capabilities() { return { transport: this.transport, implemented: false, live_capture: false, data_kinds: [] }; }
  async connect() { throw new AppError('HARDWARE_UNAVAILABLE', `${this.transport}は初版で未対応です。COMポート・カメラ・FW・FPGAを操作しません。`); }
}
export class VideoLabelAdapter {
  capabilities() { return { implemented: false, external_api: false, automatic_labels: false }; }
  async propose() { throw new AppError('AUTO_LABEL_UNAVAILABLE', '動画モデルの自動候補生成は未実装です。区間を手動追加するか、候補JSONを読み込んで本人が確認してください。', 501); }
}
