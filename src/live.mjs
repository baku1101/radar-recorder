import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AppError, AcquisitionAdapter, UNKNOWN, normalizeRecord, sha256 } from './adapters.mjs';

export function localWebSocketUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new AppError('INVALID_LIVE_URL', 'レーダー出力のWebSocket URLを指定してください'); }
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.hash) throw new AppError('LOCAL_LIVE_ONLY', '同じPCのws://127.0.0.1またはlocalhostの出力だけ接続できます');
  return url.href;
}

export function liveEnvelope(message, { now = Date.now(), monotonicNs = process.hrtime.bigint().toString() } = {}) {
  const value = { schema_version: 1, message_utf8: message, pc_receive_unix_ms: now, pc_receive_monotonic_ns: monotonicNs, transport: 'local_websocket_text' };
  return { ...value, envelope_sha256: sha256(JSON.stringify(value)) };
}
export function normalizeLiveEnvelope(line, sequence) {
  let envelope;
  try { envelope = JSON.parse(line); } catch { throw new AppError('CORRUPT_LIVE_SOURCE', '保存した受信記録が破損しています', 409); }
  const { envelope_sha256, ...value } = envelope;
  if (sha256(JSON.stringify(value)) !== envelope_sha256 || typeof value.message_utf8 !== 'string' || !Number.isFinite(value.pc_receive_unix_ms) || !/^\d+$/.test(value.pc_receive_monotonic_ns)) throw new AppError('CORRUPT_LIVE_SOURCE', '受信記録のハッシュまたは時計が一致しません', 409);
  const frame = normalizeRecord(value.decoded_payload ? JSON.stringify(value.decoded_payload) : value.message_utf8, sequence, sequence, { replayTime: value.pc_receive_unix_ms });
  frame.source_pc_decode_time = frame.pc_receive_time;
  frame.pc_receive_time = { value: value.pc_receive_unix_ms, unit: 'ms', basis: 'unix_epoch_utc', provenance: `${value.transport}_callback_not_sensor_capture` };
  frame.pc_receive_monotonic_time = { value: value.pc_receive_monotonic_ns, unit: 'ns', basis: value.pc_receive_monotonic_basis ?? 'this_node_process_hrtime', provenance: 'PC_receive_callback' };
  if (value.decoded_payload) frame.decoding_provenance = 'installed_Infineon_1.1_API_decode_message';
  if (value.decode_error) frame.errors.push({ code: 'VENDOR_DECODE_ERROR', message: value.decode_error });
  frame.errors = frame.errors.filter(e => e.code !== 'PC_TIME_UNKNOWN');
  frame.raw_line_sha256 = sha256(line);
  delete frame.record_sha256;
  frame.record_sha256 = sha256(JSON.stringify(frame));
  return frame;
}

// The installed Infineon tool's event WebSocket is the acquisition boundary.
// This adapter sends no commands to the source, COM port, sensor, or firmware.
export class WebSocketDetectionAdapter extends AcquisitionAdapter {
  constructor(url, { idleMs = 5000, connectMs = 4000, maxQueue = 256, maxBytes = 8 * 1024 * 1024 } = {}) {
    super(); this.url = localWebSocketUrl(url); Object.assign(this, { idleMs, connectMs, maxQueue, maxBytes }); this.queue = []; this.bytes = 0; this.active = false;
  }
  capabilities() { return { transport: 'local_websocket_events', implemented: true, live_capture: true, data_kinds: ['detections', 'metadata', 'event'], device_configuration: false, adc: false, fft: false, fpga: false, autonomous_csk_uart_start: false, resume: 'new_session_with_explicit_gap' }; }
  configure(requested = {}) {
    if (Object.keys(requested).some(k => k !== 'data_kind') || requested.data_kind && requested.data_kind !== 'detections') throw new AppError('UNSUPPORTED_SETTING', 'この収録経路は検出イベントだけに対応します。ADC・FFT・センサー設定は未対応です');
    return this.configuration = { requested, applied: { data_kind: 'detections' }, device_applied: UNKNOWN, reason: 'PCの受信形式のみ。機器の測定設定は変更・照会しない。' };
  }
  async connect() {
    if (this.socket) return;
    const socket = this.socket = new WebSocket(this.url);
    socket.addEventListener('message', event => {
      if (!this.active || this.failure) return;
      if (typeof event.data !== 'string') { this.failure = new AppError('UNSUPPORTED_LIVE_PAYLOAD', 'バイナリ出力は未対応です。ADCとして保存しません'); return; }
      const size = Buffer.byteLength(event.data);
      if (size > 1024 * 1024 || this.queue.length >= this.maxQueue || this.bytes + size > this.maxBytes) { this.failure = new AppError('LIVE_QUEUE_OVERFLOW', '受信バッファの上限を超えたため収録を停止します。アプリ受信欠損が発生しました'); return; }
      this.lastReceived = performance.now(); this.queue.push({ envelope: liveEnvelope(event.data), size }); this.bytes += size;
    });
    socket.addEventListener('error', () => { this.failure ??= new AppError(this.active ? 'LIVE_DISCONNECTED' : 'LIVE_CONNECTION_FAILED', this.active ? 'レーダー出力との接続が切れました' : 'レーダー出力へ接続できません。公式ツールのWebSocketサーバー設定とURLを確認してください'); });
    socket.addEventListener('close', () => { if (this.active) this.failure ??= new AppError('LIVE_DISCONNECTED', 'レーダー出力との接続が切れました。収録中断として保存します'); });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new AppError('LIVE_CONNECT_TIMEOUT', 'レーダー出力への接続がタイムアウトしました')), this.connectMs);
        const open = () => finish(), error = () => finish(this.failure ?? new AppError('LIVE_CONNECTION_FAILED', 'レーダー出力へ接続できません'));
        function finish(error) { clearTimeout(timer); socket.removeEventListener('open', open); socket.removeEventListener('error', errorHandler); error ? reject(error) : resolve(); }
        const errorHandler = error;
        socket.addEventListener('open', open, { once: true }); socket.addEventListener('error', errorHandler, { once: true });
      });
    } catch (error) { await this.disconnect(); throw error; }
  }
  async start() { if (this.socket?.readyState !== WebSocket.OPEN) throw new AppError('NOT_CONNECTED', 'レーダー出力へ接続してください'); this.active = true; this.lastReceived = performance.now(); }
  async read() {
    if (this.failure) throw this.failure;
    if (!this.active) throw new AppError('NOT_RUNNING', '直接収録は停止しています');
    const item = this.queue.shift();
    if (item) { this.bytes -= item.size; return item.envelope; }
    if (performance.now() - this.lastReceived > this.idleMs) throw new AppError('LIVE_IDLE_TIMEOUT', 'レーダー出力が一定時間届きません。空の収録を成功扱いせず停止します');
    return null;
  }
  async stop() { this.active = false; }
  async disconnect() { this.active = false; this.socket?.close(); this.socket = null; this.queue = []; this.bytes = 0; }
}

export function cskRuntime() {
  const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  return { python: process.env.RADAR_CSK_PYTHON ?? path.join(project, '.runtime', 'python311', 'python.exe'), vendorLib: process.env.RADAR_CSK_VENDOR_LIB ?? path.join(os.homedir(), 'Infineon', 'Tools', 'XENSIV-CMOS-Radar-Visualization-Tool', '1.1.0', 'lib'), bridge: path.join(project, 'src', 'csk-bridge.py') };
}
export class CskDetectionAdapter extends WebSocketDetectionAdapter {
  constructor(port, options = {}) { super('ws://127.0.0.1', { idleMs: 8000, ...options }); if (!/^COM\d{1,3}$/i.test(port)) throw new AppError('INVALID_COM_PORT', 'COM番号を指定してください'); this.port = port.toUpperCase(); this.launch = options.launch ?? spawn; this.runtimePaths = options.runtimePaths ?? cskRuntime(); }
  capabilities() { return { ...super.capabilities(), transport: 'csk_uart_installed_vendor_api', autonomous_csk_uart_start: 'receive_existing_firmware_events_without_reconfiguration', metadata_query: true }; }
  async connect() {
    const r = this.runtimePaths;
    if (![r.python, r.bridge, path.join(r.vendorLib, 'ifxapp')].every(p => fs.existsSync(p))) throw new AppError('CSK_RUNTIME_REQUIRED', '公式ツール1.1とPython 3.11が必要です。READMEのCSK準備手順を実行してください');
    const child = this.child = this.launch(r.python, ['-u', r.bridge, '--vendor-lib', r.vendorLib, '--port', this.port], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONUTF8: '1' } });
    this.stderr = ''; child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-4000); });
    this.lines = readline.createInterface({ input: child.stdout });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new AppError('CSK_CONNECT_TIMEOUT', 'CSKの照会がタイムアウトしました')), 10000);
      let settled = false;
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); };
      child.once('error', error => finish(new AppError('CSK_PROCESS_FAILED', error.message)));
      child.once('exit', code => { if (!settled) finish(new AppError('CSK_CONNECTION_FAILED', this.failure?.message ?? `CSK受信が終了しました (${code})`)); else if (this.active) this.failure ??= new AppError('CSK_DISCONNECTED', 'CSK受信が中断しました'); });
      this.lines.on('line', line => {
        let msg; try { msg = JSON.parse(line); } catch { this.failure = new AppError('CSK_BRIDGE_PROTOCOL', 'CSK受信プロセスの出力が不正です'); finish(this.failure); return; }
        if (msg.kind === 'error') { this.failure = new AppError('CSK_CONNECTION_FAILED', msg.message); finish(this.failure); }
        if (msg.kind === 'ready') { this.metadata = msg; finish(); }
        if (msg.kind === 'event' && this.active && !this.failure) {
          const { kind, ...value } = msg, size = Buffer.byteLength(line);
          if (size > 1024 * 1024 || this.queue.length >= this.maxQueue || this.bytes + size > this.maxBytes) { this.failure = new AppError('LIVE_QUEUE_OVERFLOW', 'CSK受信バッファが上限を超えました'); return; }
          this.lastReceived = performance.now(); this.queue.push({ size, envelope: { ...value, envelope_sha256: sha256(JSON.stringify(value)) } }); this.bytes += size;
        }
      });
    }).catch(async error => { await this.disconnect(); throw error; });
  }
  async start() { if (!this.child || this.child.exitCode !== null) throw new AppError('NOT_CONNECTED', 'CSKへ接続してください'); this.active = true; this.lastReceived = performance.now(); }
  async disconnect() {
    this.active = false;
    const child = this.child; this.child = null;
    if (child && child.exitCode === null) { child.stdin.end('stop\n'); await new Promise(resolve => { const timer = setTimeout(() => { child.kill(); resolve(); }, 3000); child.once('exit', () => { clearTimeout(timer); resolve(); }); }); }
    this.lines?.close(); this.queue = []; this.bytes = 0;
  }
}
export const defaultLiveFactory = connection => connection.transport === 'csk_uart_installed_vendor_api' ? new CskDetectionAdapter(connection.port) : new WebSocketDetectionAdapter(connection.url);
