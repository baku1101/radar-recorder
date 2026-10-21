export const PLOT_LIMITS = Object.freeze({ points: 6000, monitor_points: 12000, tail_bytes: 2 * 1024 * 1024, line_bytes: 2 * 1024 * 1024, window_s: 120 });
export const PLOT_AXES = Object.freeze({ speed_mps: { label: '検出速度', unit: 'm/s' }, doppler_bin: { label: 'ドップラービン', unit: 'bin' }, range_m: { label: '検出距離', unit: 'm' } });
const number = value => typeof value === 'number' && Number.isFinite(value);
export function projectFrame(frame, originMs) {
  const t = frame?.pc_receive_time?.value;
  if (frame?.data_kind !== 'detections' || !Array.isArray(frame.attributes) || !Array.isArray(frame.data) || !number(t) || !number(originMs)) return [];
  const columns = Object.fromEntries(['speed_mps', 'doppler_bin', 'range_m', 'magnitude_dBFS', 'type', 'rx_idx'].map(key => [key, frame.attributes.indexOf(key)]));
  const points = [];
  for (const [row_index, row] of frame.data.entries()) {
    if (!Array.isArray(row) || row.length !== frame.attributes.length) continue;
    const point = { t_s: (t - originMs) / 1000, receiver_sequence: frame.receiver_sequence, row_index };
    for (const [key, col] of Object.entries(columns)) point[key] = col >= 0 && number(row[col]) ? row[col] : null;
    if (['speed_mps', 'doppler_bin', 'range_m'].some(key => point[key] !== null)) points.push(point);
  }
  return points;
}
export function visiblePoints(points, axis, startS, endS) {
  return points.filter(point => number(point.t_s) && point.t_s >= startS && point.t_s <= endS && number(point[axis]));
}
export function pointBounds(points, axis) {
  let min = Infinity, max = -Infinity;
  for (const p of points) if (number(p[axis])) { min = Math.min(min, p[axis]); max = Math.max(max, p[axis]); }
  if (!Number.isFinite(min)) return axis === 'speed_mps' ? [-1, 1] : [0, 1];
  if (axis === 'speed_mps') { const extent = Math.max(.1, Math.abs(min), Math.abs(max)) * 1.1; return [-extent, extent]; }
  const padding = max === min ? 1 : (max - min) * .1;
  return [min - padding, max + padding];
}
export class PointSampler {
  constructor(limit = PLOT_LIMITS.points) { this.limit = limit; this.points = []; this.seen = 0; this.stride = 1; this.last = null; }
  push(point) {
    this.seen++; this.last = point;
    if ((this.seen - 1) % this.stride) return;
    this.points.push(point);
    if (this.points.length > this.limit) { this.points = this.points.filter((_, index) => index % 2 === 0); this.stride *= 2; }
  }
  result() { const points = [...this.points]; if (this.last && points.at(-1) !== this.last) { if (points.length >= this.limit) points[points.length - 1] = this.last; else points.push(this.last); } return { points, matched_points: this.seen, display_omitted_points: this.seen - points.length }; }
}
