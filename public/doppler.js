import { PLOT_AXES, pointBounds, visiblePoints } from './plot-model.mjs';

const byId = id => document.getElementById(id);
const view = {
  session: null, source: 'session', snapshot: null, monitor: null, monitorBusy: false,
  paused: false, playing: false, playhead: 0, follow: true, pending: false, generation: 0, lastKey: '', lastTick: performance.now(), lastFetch: -Infinity,
  updateControls() {
    const recording = typeof captureRuntime !== 'undefined' && !!captureRuntime;
    byId('monitor-start').disabled = busy || recording || this.monitorBusy;
    byId('monitor-stop').disabled = !this.monitorBusy;
    byId('doppler-play').disabled = this.source !== 'session' || !this.session || !(this.session.time_range.duration_s > 0);
    byId('doppler-seek').disabled = this.source !== 'session' || !this.session || !(this.session.time_range.duration_s > 0);
    byId('doppler-play').textContent = this.playing ? '再生を一時停止' : '保存ログを再生';
    byId('doppler-pause').textContent = this.paused ? '表示を再開' : '表示を一時停止';
    if (typeof captureControls === 'function') captureControls();
  },
  setSession(session, selectedNew = false) {
    const changed = this.session?.id !== session.id; this.session = session;
    if (changed || selectedNew) { this.source = 'session'; byId('doppler-source').value = 'session'; this.playhead = session.time_range.duration_s || 0; this.follow = true; this.playing = false; this.lastKey = ''; this.cancel(); }
    byId('doppler-seek').max = Math.max(0, session.time_range.duration_s || 0);
    this.updateControls(); this.tick();
  },
  cancel() { this.generation++; this.abort?.abort(); this.pending = false; },
  async get(url, signal) { const response = await fetch(url, { signal }); const data = await response.json(); if (!response.ok) throw new Error(data.error?.message ?? '表示データを読み取れません'); return data; },
  async restoreMonitor() {
    try {
      const monitor = await this.get('/api/monitor');
      if (!['running', 'connecting'].includes(monitor.state) || this.monitorBusy) return;
      this.monitor = monitor; this.monitorBusy = true; this.source = 'monitor'; this.snapshot = monitor; byId('doppler-source').value = 'monitor'; this.cancel(); this.status(); this.draw(); this.updateControls();
    } catch (error) { byId('monitor-status').textContent = error.message; }
  },
  async startMonitor() {
    this.monitorBusy = true; this.source = 'monitor'; this.snapshot = null; this.paused = false; this.playing = false; byId('doppler-source').value = 'monitor'; byId('empty').hidden = true; this.cancel(); this.updateControls();
    byId('monitor-status').textContent = 'センサーに接続しています';
    try {
      this.monitor = await api('/api/monitor/start', { transport: byId('capture-transport').value, port: byId('capture-com').value, url: byId('capture-url').value, request_id: crypto.randomUUID(), data_kind: 'detections' });
      this.monitorBusy = this.monitor.state === 'running'; this.lastKey = ''; this.status(); await this.tick(); byId('doppler-card').scrollIntoView({ block: 'nearest' });
    } catch (error) { this.monitorBusy = false; byId('monitor-status').textContent = error.message; throw error; }
    finally { this.updateControls(); }
  },
  async stopMonitor() { await api('/api/monitor/stop', {}); this.monitor = await this.get(`/api/monitor?window_s=${byId('doppler-window').value}`); this.monitorBusy = false; if (this.source === 'monitor') { this.snapshot = this.monitor; this.draw(); } this.status(); this.updateControls(); },
  status() {
    const names = { idle: '未接続', connecting: '接続中', running: '受信中', stopped: '停止・ポート解放済み', error: '受信中断' }, m = this.monitor;
    byId('monitor-status').textContent = m ? `${names[m.state] ?? m.state} · 保存なし · カメラなし${m.error ? ` · ${m.error.message}` : ''}` : '表示だけなら録画やカメラの許可は不要です';
  },
  async tick() {
    const now = performance.now(), delta = (now - this.lastTick) / 1000; this.lastTick = now;
    if (this.playing && this.session && !this.paused) { this.playhead = Math.min(this.session.time_range.duration_s, this.playhead + delta * Number(byId('doppler-rate').value)); if (this.playhead >= this.session.time_range.duration_s) { this.playing = false; this.updateControls(); } }
    if (this.pending || now - this.lastFetch < 500) return;
    this.lastFetch = now;
    const generation = this.generation; this.pending = true;
    try {
      if (this.monitorBusy) {
        this.monitor = await this.get(`/api/monitor?window_s=${byId('doppler-window').value}&paused=${this.paused || this.source !== 'monitor' ? 1 : 0}`);
        if (generation !== this.generation) return;
        this.monitorBusy = ['running', 'connecting'].includes(this.monitor.state); this.status(); this.updateControls();
        if (this.source === 'monitor' && !this.paused) { this.snapshot = this.monitor; this.draw(); }
      }
      if (this.source !== 'session' || !this.session || this.paused) return;
      if (this.follow && !this.playing) this.playhead = this.session.time_range.duration_s || 0;
      const end = Math.max(0, this.playhead), start = Math.max(0, end - Number(byId('doppler-window').value));
      const tail = this.follow && this.session.state === 'running', key = `${this.session.id}:${this.session.count}:${start}:${end}:${tail}`;
      if (key === this.lastKey) return;
      this.abort = new AbortController();
      const snapshot = await this.get(`/api/sessions/${this.session.id}/plot?start_s=${start}&end_s=${end}&tail=${tail ? 1 : 0}`, this.abort.signal);
      if (generation !== this.generation || this.source !== 'session') return;
      this.lastKey = key; this.snapshot = snapshot; this.draw();
      if (typeof showDistancePoints === 'function') showDistancePoints(snapshot.points, this.session.id);
    } catch (error) { if (error.name !== 'AbortError') byId('doppler-summary').textContent = `表示エラー: ${error.message}。受信・保存の状態は別に確認してください。`; }
    finally { if (generation === this.generation) this.pending = false; }
  },
  draw() {
    const canvas = byId('doppler-chart'), ctx = canvas.getContext('2d'), width = canvas.width, height = canvas.height;
    const left = 64, right = width - 20, top = 28, bottom = height - 48, axis = byId('doppler-axis').value, spec = PLOT_AXES[axis];
    ctx.clearRect(0, 0, width, height); ctx.fillStyle = '#fbfdfd'; ctx.fillRect(0, 0, width, height); ctx.font = '12px Segoe UI';
    const data = this.snapshot;
    if (!data) { ctx.fillStyle = '#627a80'; ctx.fillText('デモを選ぶか、保存なしのライブ表示を開始してください', 60, 150); return; }
    const start = data.start_s, end = Math.max(start + .1, data.end_s), points = visiblePoints(data.points, axis, start, end), [min, max] = pointBounds(points, axis);
    this.drawnPoints = points;
    for (let i = 0; i <= 4; i++) { const y = bottom - (bottom - top) * i / 4; ctx.strokeStyle = '#dce7e8'; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke(); ctx.fillStyle = '#526e75'; ctx.fillText((min + (max - min) * i / 4).toFixed(axis === 'doppler_bin' ? 1 : 2), 6, y + 4); }
    for (let i = 0; i <= 5; i++) { const x = left + (right - left) * i / 5; ctx.fillStyle = '#526e75'; ctx.fillText((start + (end - start) * i / 5).toFixed(1), x - 8, height - 27); }
    if (min < 0 && max > 0) { const y = bottom + min / (max - min) * (bottom - top); ctx.strokeStyle = '#829ca1'; ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke(); }
    let lowMagnitude = Infinity, highMagnitude = -Infinity;
    for (const p of points) if (p.magnitude_dBFS !== null) { lowMagnitude = Math.min(lowMagnitude, p.magnitude_dBFS); highMagnitude = Math.max(highMagnitude, p.magnitude_dBFS); }
    this.screenPoints = [];
    for (const point of points) {
      const x = left + (point.t_s - start) / (end - start) * (right - left), y = bottom - (point[axis] - min) / (max - min) * (bottom - top);
      const normalized = point.magnitude_dBFS === null ? null : highMagnitude === lowMagnitude ? .5 : (point.magnitude_dBFS - lowMagnitude) / (highMagnitude - lowMagnitude);
      ctx.fillStyle = normalized === null || !byId('doppler-color').checked ? '#137f89' : `hsl(${210 - normalized * 175} 72% 43%)`;
      ctx.beginPath(); ctx.arc(x, y, 2.7, 0, Math.PI * 2); ctx.fill(); this.screenPoints.push({ x, y, point });
    }
    ctx.fillStyle = '#526e75'; ctx.fillText(`${spec.label} (${spec.unit})`, left, 16); ctx.fillText('PC時計からの相対時間 (s)', Math.max(left, width / 2 - 65), height - 6);
    if (!points.length) { ctx.fillStyle = '#6a8085'; ctx.fillText(`${axis}とPC時刻を含む検出点がこの範囲にありません`, left + 18, height / 2); }
    canvas.setAttribute('aria-label', `${spec.label}の時間変化、単位${spec.unit}、元の検出点${points.length}点`);
    const demo = this.source === 'session' && this.session?.mode === 'demo';
    byId('doppler-origin').textContent = `${demo ? '合成デモ · ' : ''}${this.source === 'monitor' ? 'ライブ検出イベント・メモリ内のみ' : '選択した保存済み検出イベント'} · ${data.clock.startsWith('original_') ? '元PC解読時計' : 'PC受信時計'} · 機器取得時計は未確認`;
    byId('doppler-summary').textContent = `${start.toFixed(2)}〜${data.end_s.toFixed(2)} s · 表示 ${points.length}点 · ${this.source === 'monitor' ? `受信 ${data.records_received}件` : `保存 ${data.total_saved_records}件`} · 表示間引き ${data.display_omitted_points ?? 0}点${data.display_evicted_points ? ` · 保持上限による省略 ${data.display_evicted_points}点` : ''}${data.history_truncated ? ' · 読込みは末尾2 MiBに制限' : ''}${data.untimed_records ? ` · 時計不明 ${data.untimed_records}件` : ''}${data.invalid_records || data.oversized_records ? ` · 表示不能記録 ${(data.invalid_records ?? 0) + (data.oversized_records ?? 0)}件` : ''}${data.clock_backwards_count ? ' · PC時計の逆行あり' : ''} · 機器欠損は不明`;
    byId('doppler-legend').textContent = byId('doppler-color').checked && Number.isFinite(lowMagnitude) ? `色は元のmagnitude_dBFS。表示範囲 ${lowMagnitude.toFixed(1)}〜${highMagnitude.toFixed(1)} dBFS（FFTスペクトルの強度ではありません）` : '点の色は一定。値がない速度・ビンを補間せず、検出がない時間も埋めません。';
    byId('doppler-position').textContent = `${data.end_s.toFixed(2)} s`; byId('doppler-seek').value = this.playhead;
  }
};
window.DopplerView = view;
byId('monitor-start').onclick = () => act(() => view.startMonitor());
byId('monitor-stop').onclick = () => view.stopMonitor().catch(error => message(error.message, true));
byId('doppler-axis').onchange = () => view.draw(); byId('doppler-color').onchange = () => view.draw();
byId('doppler-source').onchange = () => { view.source = byId('doppler-source').value; view.playing = false; view.lastKey = ''; view.cancel(); if (view.source === 'monitor') { view.snapshot = view.monitor; if (view.monitor) view.draw(); } view.updateControls(); view.tick(); };
byId('doppler-window').onchange = async () => { view.lastKey = ''; view.cancel(); if (view.source === 'monitor' && !view.monitorBusy && view.monitor && !view.paused) { try { view.monitor = await view.get(`/api/monitor?window_s=${byId('doppler-window').value}`); view.snapshot = view.monitor; view.draw(); } catch (error) { message(error.message, true); } } else view.tick(); };
byId('doppler-pause').onclick = () => { view.paused = !view.paused; view.updateControls(); if (!view.paused) { view.lastKey = ''; view.tick(); } byId('doppler-paused').hidden = !view.paused; };
byId('doppler-play').onclick = () => { if (!view.session) return; view.follow = false; view.paused = false; view.playing = !view.playing; if (view.playing && view.playhead >= view.session.time_range.duration_s) view.playhead = 0; view.lastTick = performance.now(); view.lastKey = ''; byId('doppler-paused').hidden = true; view.updateControls(); view.tick(); };
byId('doppler-seek').oninput = () => { view.follow = false; view.playhead = Number(byId('doppler-seek').value); view.lastKey = ''; view.cancel(); view.tick(); };
byId('doppler-latest').onclick = () => { view.follow = true; view.playing = false; view.lastKey = ''; view.cancel(); view.tick(); view.updateControls(); };
byId('doppler-chart').onmousemove = event => {
  const canvas = byId('doppler-chart'), box = canvas.getBoundingClientRect(), x = (event.clientX - box.left) / box.width * canvas.width, y = (event.clientY - box.top) / box.height * canvas.height;
  let nearest = null, distance = 100;
  for (const candidate of view.screenPoints ?? []) { const d = (candidate.x - x) ** 2 + (candidate.y - y) ** 2; if (d < distance) { distance = d; nearest = candidate.point; } }
  byId('doppler-point').textContent = nearest ? `${nearest.t_s.toFixed(3)} s · speed_mps ${nearest.speed_mps ?? '不明'} · doppler_bin ${nearest.doppler_bin ?? '不明'} · magnitude_dBFS ${nearest.magnitude_dBFS ?? '不明'} · type ${nearest.type ?? '不明'} · 保存/受信連番 ${nearest.receiver_sequence} / 行 ${nearest.row_index}` : '点にカーソルを合わせると元の値と連番を表示します';
};
window.addEventListener('radar-session', event => view.setSession(event.detail.session, event.detail.selectedNew));
window.addEventListener('pagehide', () => { view.abort?.abort(); });
view.draw(); view.updateControls(); setInterval(() => view.tick(), 500);
view.restoreMonitor();
if (typeof current !== 'undefined' && current) view.setSession(current);
