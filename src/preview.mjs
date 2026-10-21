import fs from 'node:fs';
import { setImmediate as yieldToAcquisition } from 'node:timers/promises';
import { AppError } from './adapters.mjs';
import { radarClockForMode } from './sync.mjs';
import { PLOT_LIMITS, PointSampler, projectFrame } from '../public/plot-model.mjs';

// Read-only, asynchronous and bounded separately from acquisition/commit locks.
// A client can cancel an expensive saved-log seek without stopping acquisition.
export async function savedPreview(store, id, { startS = 0, endS, tail = false, limit = PLOT_LIMITS.points, signal } = {}) {
  const m = store.get(id), duration = typeof m.time_range.duration_s === 'number' ? m.time_range.duration_s : 0;
  endS ??= duration;
  if (![startS, endS].every(Number.isFinite) || startS < 0 || endS < startS || endS - startS > PLOT_LIMITS.window_s + 1e-6 || !Number.isSafeInteger(limit) || limit < 1 || limit > PLOT_LIMITS.points) throw new AppError('INVALID_PREVIEW_WINDOW', '表示範囲は0秒以上・最大120秒、表示上限は1〜6000点で指定してください');
  const file = store.file(id, 'frames.jsonl'), size = (await fs.promises.stat(file)).size, begin = tail ? Math.max(0, size - PLOT_LIMITS.tail_bytes) : 0;
  const sampler = new PointSampler(limit), stats = { records_read: 0, invalid_records: 0, untimed_records: 0, oversized_records: 0, history_truncated: begin > 0, bytes_read: 0 };
  if (size) {
    const stream = fs.createReadStream(file, { start: begin, end: size - 1, highWaterMark: 64 * 1024 });
    let pending = Buffer.alloc(0), discard = begin > 0, processed = 0;
    try {
      for await (const chunk of stream) {
        if (signal?.aborted) break;
        stats.bytes_read += chunk.length;
        let offset = 0;
        for (;;) {
          const newline = chunk.indexOf(10, offset), end = newline < 0 ? chunk.length : newline;
          const piece = chunk.subarray(offset, end);
          if (!discard) {
            if (pending.length + piece.length > PLOT_LIMITS.line_bytes) { discard = true; pending = Buffer.alloc(0); stats.oversized_records++; }
            else pending = Buffer.concat([pending, piece]);
          }
          if (newline < 0) break;
          if (!discard && pending.length) {
            stats.records_read++;
            try {
              const frame = JSON.parse(pending.toString('utf8'));
              if (frame.data_kind === 'invalid') stats.invalid_records++;
              if (typeof frame.pc_receive_time?.value !== 'number') stats.untimed_records++;
              for (const point of projectFrame(frame, m.time_range.first_pc_ms)) if (point.t_s >= startS && point.t_s <= endS) sampler.push(point);
            } catch { stats.invalid_records++; }
            if (++processed % 64 === 0) { await yieldToAcquisition(); if (signal?.aborted) break; }
          }
          pending = Buffer.alloc(0); discard = false; offset = newline + 1;
          if (offset === chunk.length) break;
        }
      }
    } finally { stream.destroy(); }
    // A trailing partial frame is not interpreted as a complete observation.
    if (pending.length) stats.invalid_records++;
  }
  return { ...sampler.result(), ...stats, mode: m.mode, state: m.state, session_id: id, total_saved_records: m.count, start_s: startS, end_s: endS, duration_s: duration, clock: radarClockForMode(m.mode), data_source: 'saved_detection_events', full_spectrum: false, device_loss: 'unknown', missing_values: 'not_interpolated_or_reconstructed' };
}
