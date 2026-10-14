import { AppError, UNKNOWN } from './adapters.mjs';
const finite = (value, name) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new AppError('INVALID_TIME', `${name}は有限の数値で指定してください`);
  return value;
};
export function radarClockForMode(mode = 'import') {
  return mode === 'live' ? 'pc_receive_time_relative_to_first_timed_record' : 'original_pc_decode_time_relative_to_first_timed_event';
}
export function reconcileSyncClock(sync, mode) {
  if (!sync || sync.radar_clock === radarClockForMode(mode)) return sync;
  return { ...sync, radar_clock: radarClockForMode(mode), radar_clock_metadata_correction: { previous_radar_clock: sync.radar_clock ?? UNKNOWN, mode, scope: 'metadata_only_no_refit' } };
}
export function fitSync(anchors, radarDuration, videoDuration, { mode = 'import' } = {}) {
  if (!Array.isArray(anchors) || anchors.length !== 2) throw new AppError('TWO_ANCHORS_REQUIRED', '開始側・終了側の2つの対応目印が必要です');
  if (typeof radarDuration !== 'number') throw new AppError('RADAR_CLOCK_UNKNOWN', 'レーダー側のPC時計が不明なため同期できません');
  if (typeof videoDuration !== 'number') throw new AppError('VIDEO_DURATION_UNKNOWN', '動画の長さを確認してから同期してください');
  const checked = anchors.map((a, i) => {
    const r = finite(a.radar_s, 'レーダー秒'), v = finite(a.video_s, '動画秒');
    const ru = finite(a.radar_uncertainty_s, 'レーダー目印の不確かさ'), vu = finite(a.video_uncertainty_s, '動画目印の不確かさ');
    if (r < 0 || r > radarDuration + 1e-6 || v < 0 || v > videoDuration + 1e-6 || ru < 0 || vu < 0) throw new AppError('ANCHOR_OUT_OF_RANGE', '対応目印の時刻または不確かさが範囲外です');
    if (typeof a.note !== 'string' || !a.note.trim()) throw new AppError('ANCHOR_NOTE_REQUIRED', '両方の記録で確認した目印の内容を入力してください');
    return { radar_s: r, video_s: v, radar_uncertainty_s: ru, video_uncertainty_s: vu, note: a.note.trim(), position: i === 0 ? 'start' : 'end' };
  });
  const [a, b] = checked;
  if (b.radar_s <= a.radar_s || b.video_s <= a.video_s) throw new AppError('INVALID_ANCHOR_ORDER', '終了側の目印は開始側より後にしてください');
  const scale = (b.radar_s - a.radar_s) / (b.video_s - a.video_s);
  return { schema_version: 1, anchors: checked, offset_s: a.radar_s - scale * a.video_s, scale, drift_ppm: (scale - 1) * 1e6, equation: 'radar_relative_s = offset_s + scale * video_s', radar_clock: radarClockForMode(mode), video_clock: 'media_currentTime_s', uncertainty_model: 'linear worst-case marker uncertainty; unmeasured nonlinear drift/transport latency remains unknown', unmeasured_latency_s: UNKNOWN, physical_sync_accuracy_verified: false, method: 'self_reviewed_start_end_landmarks_linear_fit', reviewed_at: new Date().toISOString() };
}
export function mapVideoTime(sync, videoS) {
  if (!sync) return { radar_s: UNKNOWN, uncertainty_s: UNKNOWN, extrapolated: UNKNOWN };
  finite(videoS, '動画秒');
  const [a, b] = sync.anchors;
  const w = (videoS - a.video_s) / (b.video_s - a.video_s);
  const u = x => x.radar_uncertainty_s + Math.abs(sync.scale) * x.video_uncertainty_s;
  return { radar_s: sync.offset_s + sync.scale * videoS, uncertainty_s: Math.abs(1 - w) * u(a) + Math.abs(w) * u(b), extrapolated: w < 0 || w > 1 };
}
