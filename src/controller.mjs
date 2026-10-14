import { JsonlFileAdapter, AppError } from './adapters.mjs';
import { defaultLiveFactory } from './live.mjs';
import fs from 'node:fs';
import { atomicJson, fileSha } from './storage.mjs';
import { appendLive, recoverLive, sealLive, CAPTURE_LIMITS } from './capture-storage.mjs';
import { performance } from 'node:perf_hooks';
export class SessionController {
  constructor(store, { delayMs = 10, liveFactory = defaultLiveFactory, leaseMs = 15000 } = {}) { this.store = store; this.delayMs = delayMs; this.liveFactory = liveFactory; this.leaseMs = leaseMs; this.runtime = new Map(); this.locks = new Map(); this.closed = false; this.liveReservation = null; }
  async lock(id, callback) {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(callback); this.locks.set(id, current);
    try { return await current; } finally { if (this.locks.get(id) === current) this.locks.delete(id); }
  }
  initialize() {
    const problems = [];
    for (const m of this.store.list().sessions) {
      try { m.mode === 'live' ? recoverLive(this.store, m.id) : this.store.recover(m.id); } catch (error) { problems.push({ id: m.id, code: error.code, message: error.message }); }
    }
    return problems;
  }
  async start(id) {
    return this.lock(id, async () => {
      if (this.closed) throw new AppError('SHUTTING_DOWN', 'アプリは終了処理中です', 409);
      let m = this.store.get(id);
      if (m.state === 'running' && this.runtime.has(id)) return m;
      if (m.state === 'completed') return m;
      if (m.mode === 'live') {
        if (!m.capture || m.state !== 'ready') throw new AppError('NEW_LIVE_SESSION_REQUIRED', '直接収録の再開は新しいセッションで開始します。停止中の空白をつなげません', 409);
        if (this.liveReservation || [...this.runtime.values()].some(r => r.live)) throw new AppError('LIVE_ALREADY_RUNNING', '直接収録は同時に1件だけ開始できます', 409);
        this.liveReservation = id;
        const configuration = JSON.parse(fs.readFileSync(this.store.file(id, 'session-config.json'), 'utf8'));
        let adapter;
        try { adapter = this.liveFactory(configuration.connection); adapter.configure(configuration.requested); await adapter.connect(); if (this.closed) throw new AppError('SHUTTING_DOWN', '終了中のため直接収録を開始しません', 409); await adapter.start(); }
        catch (error) { await adapter?.disconnect(); this.liveReservation = null; await this.fail(id, error); throw error; }
        this.liveReservation = null;
        try { if (adapter.metadata) {
          configuration.device_query = adapter.metadata;
          const fw = adapter.metadata.firmware?.payload;
          if (fw?.sensor_info?.name) configuration.device = { sensor: fw.sensor_info.name, board: 'unknown', firmware_name: fw.name ?? 'unknown', firmware_version: fw.version ?? 'unknown', sensor_driver_version: fw.sensor_info.driver_version ?? 'unknown', application_version: 'Visualization Tool 1.1 API', provenance: 'live_readonly_firmware_response' };
          configuration.device_applied = adapter.metadata.sensor_configuration?.payload && Object.keys(adapter.metadata.sensor_configuration.payload).length ? adapter.metadata.sensor_configuration.payload : 'unknown';
          atomicJson(this.store.file(id, 'session-config.json'), configuration, this.store.beforeWrite); m.config_sha256 = fileSha(this.store.file(id, 'session-config.json'));
        } } catch (error) { await adapter.disconnect(); await this.fail(id, error); throw error; }
        const now = performance.now(), runtime = { adapter, live: true, timer: null, heartbeat: now, began: now };
        this.runtime.set(id, runtime);
        try { m.capture.status = 'recording'; m.capture.radar_started_unix_ms = Date.now(); m.capture.radar_started_monotonic_ns = process.hrtime.bigint().toString(); this.store.save(m); m = this.store.transition(id, 'running'); }
        catch (error) { await adapter.disconnect(); this.runtime.delete(id); throw error; }
        this.schedule(id); return m;
      }
      if (!m.source) throw new AppError('SOURCE_REQUIRED', '先にJSONLファイルを取り込んでください');
      m = this.store.recover(id);
      let adapter = this.runtime.get(id)?.adapter;
      if (!adapter) {
        adapter = new JsonlFileAdapter(this.store.file(id, m.source.file), { diagnostic: m.source.diagnostic, skipSourceLines: m.last_source_line, receiverSequence: m.count });
        await adapter.connect(); adapter.configure({ data_kind: 'detections' });
      }
      await adapter.start();
      const runtime = { adapter, timer: null }; this.runtime.set(id, runtime);
      try { m = this.store.transition(id, 'running'); }
      catch (error) { await adapter.disconnect(); this.runtime.delete(id); throw error; }
      if (this.lastFailure?.id === id) this.lastFailure = null;
      this.schedule(id); return m;
    });
  }
  schedule(id) {
    const runtime = this.runtime.get(id); if (!runtime || this.closed) return;
    runtime.timer = setTimeout(() => { this.pump(id).catch(() => {}); }, this.delayMs);
  }
  async pump(id) {
    await this.lock(id, async () => {
      const runtime = this.runtime.get(id);
      if (!runtime || this.store.get(id).state !== 'running') return;
      try {
        if (runtime.live && performance.now() - runtime.heartbeat > this.leaseMs) throw new AppError('CAMERA_HEARTBEAT_LOST', '収録画面との接続が切れたためレーダーも停止しました');
        if (runtime.live && performance.now() - runtime.began > CAPTURE_LIMITS.max_seconds * 1000) throw new AppError('CAPTURE_LIMIT', '収録時間の上限に達しました');
        const frame = await runtime.adapter.read();
        if (runtime.live) { if (frame) appendLive(this.store, id, frame); this.schedule(id); return; }
        if (!frame) {
          await runtime.adapter.disconnect(); this.runtime.delete(id);
          this.store.transition(id, 'completed');
          const report = this.store.verify(id);
          if (!report.ok) throw new AppError('READBACK_FAILED', `読み戻し不一致: ${report.failures.join(', ')}`);
          return;
        }
        this.store.append(id, frame); this.schedule(id);
      } catch (error) {
        clearTimeout(runtime.timer); await runtime.adapter.disconnect(); this.runtime.delete(id);
        await this.fail(id, error); throw error;
      }
    });
  }
  heartbeat(id) { const runtime = this.runtime.get(id); if (runtime?.live) runtime.heartbeat = performance.now(); }
  async fail(id, error) {
    const runtime = this.runtime.get(id);
    if (runtime) { clearTimeout(runtime.timer); await runtime.adapter.disconnect(); this.runtime.delete(id); }
    this.lastFailure = { id, code: error.code ?? 'SAVE_FAILED', message: error.message };
    try { const m = this.store.get(id); m.state = 'error'; m.last_error = { ...this.lastFailure, at: new Date().toISOString() }; m.state_history.push({ state: 'error', ...m.last_error }); if (m.capture) { m.capture.status = 'partial'; m.capture.camera.state = 'interrupted'; m.capture.gaps.push({ reason: m.last_error.code, from: m.time_range.last_pc_ms, to: 'unknown' }); } this.store.save(m); if (m.mode === 'live') sealLive(this.store, id); } catch { /* Keep durable raw envelopes, frames and video chunks on storage failure. */ }
  }
  async stop(id, { interrupted = false } = {}) {
    return this.lock(id, async () => {
      const m = this.store.get(id), runtime = this.runtime.get(id);
      if (runtime) { clearTimeout(runtime.timer); await runtime.adapter.disconnect(); this.runtime.delete(id); }
      if (m.state !== 'running' && m.state !== 'stopping') return m;
      if (m.mode === 'live') { m.capture.status = interrupted ? 'interrupted' : 'finalizing'; m.capture.radar_stopped_unix_ms = Date.now(); if (interrupted) m.capture.camera.state = 'interrupted'; this.store.save(m); sealLive(this.store, id); }
      return this.store.transition(id, interrupted ? 'interrupted' : 'stopped');
    });
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.locks.values()]);
    for (const id of [...this.runtime.keys()]) await this.stop(id, { interrupted: true });
  }
}
