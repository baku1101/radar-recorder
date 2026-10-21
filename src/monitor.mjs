import { performance } from 'node:perf_hooks';
import { AppError } from './adapters.mjs';
import { defaultLiveFactory, normalizeLiveEnvelope } from './live.mjs';
import { PLOT_LIMITS, PointSampler, projectFrame } from '../public/plot-model.mjs';

// Ephemeral preview: no SessionStore, file writes, camera, or video recorder.
export class DetectionMonitor {
  constructor({ factory = defaultLiveFactory, canAcquire = () => true, leaseMs = 15000, delayMs = 20, maxPoints = PLOT_LIMITS.monitor_points } = {}) {
    Object.assign(this, { factory, canAcquire, leaseMs, delayMs, maxPoints }); this.state = 'idle'; this.busy = false; this.generation = 0; this.operation = Promise.resolve(); this.closed = false; this.reset();
  }
  reset() { this.points = []; this.count = 0; this.detectionPoints = 0; this.evicted = 0; this.invalid = 0; this.originMs = null; this.duration = 0; this.lastTime = null; this.clockBackwards = 0; this.fields = new Set(); this.error = null; this.metadata = null; }
  async start(input) {
    if (this.stopping) throw new AppError('MONITOR_STOPPING', '接続を解放しています。停止完了を待ってください', 409);
    if (this.closed) throw new AppError('SHUTTING_DOWN', 'アプリは終了中です', 409);
    if (this.busy) { if (this.requestId === input.request_id) { await this.operation; return this.view(); } throw new AppError('MONITOR_ALREADY_RUNNING', 'ライブモニターは既に動作しています', 409); }
    if (!this.canAcquire()) throw new AppError('LIVE_SOURCE_BUSY', '直接収録中です。収録を停止してからモニターを開始してください', 409);
    if (!['csk_uart_installed_vendor_api', 'local_websocket_events'].includes(input.transport)) throw new AppError('UNSUPPORTED_TRANSPORT', '対応していない接続方式です');
    this.reset(); this.busy = true; this.state = 'connecting'; this.requestId = input.request_id; const generation = ++this.generation;
    this.operation = (async () => {
      try {
        const connection = input.transport === 'csk_uart_installed_vendor_api' ? { transport: input.transport, port: input.port } : { transport: input.transport, url: input.url };
        this.adapter = this.factory(connection); this.adapter.configure({ data_kind: input.data_kind ?? 'detections' }); await this.adapter.connect();
        if (this.closed || generation !== this.generation) throw new AppError('MONITOR_CANCELED', 'モニターの開始を取り消しました', 409);
        await this.adapter.start();
        if (this.closed || generation !== this.generation) throw new AppError('MONITOR_CANCELED', 'モニターの開始を取り消しました', 409);
        this.metadata = this.adapter.metadata ?? null; this.state = 'running'; this.heartbeat = performance.now(); this.began = performance.now(); this.schedule();
      } catch (error) { await this.adapter?.disconnect(); this.busy = false; this.state = generation === this.generation ? 'error' : 'stopped'; this.error = { code: error.code ?? 'MONITOR_FAILED', message: error.message }; throw error; }
    })();
    await this.operation; return this.view();
  }
  schedule() { if (this.state === 'running') this.timer = setTimeout(() => { this.pumping = this.pump().finally(() => { this.pumping = null; }); }, this.delayMs); }
  async pump() {
    try {
      if (this.state !== 'running') return;
      if (performance.now() - this.heartbeat > this.leaseMs) throw new AppError('MONITOR_HEARTBEAT_LOST', '表示画面との接続が切れたためモニターを停止しました');
      if (performance.now() - this.began > 3600000) throw new AppError('MONITOR_TIME_LIMIT', 'モニターの1時間上限に達しました');
      for (let i = 0; i < 64 && this.state === 'running'; i++) {
        const envelope = await this.adapter.read(); if (!envelope) break;
        const frame = normalizeLiveEnvelope(JSON.stringify(envelope), ++this.count);
        this.originMs ??= frame.pc_receive_time.value;
        if (frame.data_kind === 'invalid') this.invalid++;
        const time = (frame.pc_receive_time.value - this.originMs) / 1000;
        if (this.lastTime !== null && time < this.lastTime) this.clockBackwards++;
        this.lastTime = time; this.duration = Math.max(this.duration, time);
        const points = projectFrame(frame, this.originMs); this.detectionPoints += points.length;
        for (const point of points) for (const field of ['speed_mps', 'doppler_bin', 'range_m', 'magnitude_dBFS']) if (point[field] !== null) this.fields.add(field);
        if (points.length >= this.maxPoints) {
          this.evicted += this.points.length + points.length - this.maxPoints; this.points = points.slice(-this.maxPoints);
        } else {
          for (const point of points) this.points.push(point);
          if (this.points.length > this.maxPoints) { const remove = this.points.length - this.maxPoints; this.points.splice(0, remove); this.evicted += remove; }
        }
      }
      this.schedule();
    } catch (error) { this.state = 'error'; this.error = { code: error.code ?? 'MONITOR_FAILED', message: error.message }; try { await this.adapter?.disconnect(); } finally { this.busy = false; } }
  }
  view({ windowS = 30, paused = false } = {}) {
    if (!Number.isFinite(windowS) || windowS <= 0 || windowS > PLOT_LIMITS.window_s) throw new AppError('INVALID_PREVIEW_WINDOW', '表示幅は0秒より大きく120秒以内で指定してください');
    this.heartbeat = performance.now();
    const start = Math.max(0, this.duration - windowS), sampler = new PointSampler();
    if (!paused) for (const point of this.points) if (point.t_s >= start && point.t_s <= this.duration) sampler.push(point);
    const fw = this.metadata?.firmware?.payload;
    return { ...sampler.result(), state: this.state, records_received: this.count, total_detection_points: this.detectionPoints, retained_points: this.points.length, display_evicted_points: this.evicted, invalid_records: this.invalid, clock_backwards_count: this.clockBackwards, fields: [...this.fields], start_s: start, end_s: this.duration, duration_s: this.duration, clock: 'pc_receive_time_relative_to_first_timed_record', device: fw ? { sensor: fw.sensor_info?.name ?? 'unknown', firmware: fw.version ?? 'unknown', driver: fw.sensor_info?.driver_version ?? 'unknown', configuration_query: this.metadata?.sensor_configuration?.state ?? 'unknown' } : null, error: this.error, data_source: 'live_detection_monitor_memory_only', recording: false, camera: false, full_spectrum: false, device_loss: 'unknown', missing_values: 'not_interpolated_or_reconstructed' };
  }
  async stop() {
    if (this.stopping) return this.stopping;
    ++this.generation; clearTimeout(this.timer); this.busy = true; if (this.state !== 'error') this.state = 'stopped';
    this.stopping = (async () => {
      await this.operation.catch(() => {}); await this.pumping;
      try { await this.adapter?.disconnect(); } finally { this.busy = false; }
      return this.view();
    })().finally(() => { this.stopping = null; });
    return this.stopping;
  }
  async close() { this.closed = true; await this.stop(); }
}
