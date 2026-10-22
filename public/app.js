'use strict';
const $ = id => document.getElementById(id);
const stateNames = { created: 'ファイル待ち', ready: '取込み待ち', running: '取込み中', stopping: '停止処理中', stopped: '停止・再開可', interrupted: '中断・再開可', completed: '取込み完了', error: '保存 / 読出し失敗' };
const statusNames = { pending: '未確認', confirmed: '本人確認', corrected: '本人修正', rejected: '除外' };
const liveStateNames = { created: '開始待ち', ready: '接続準備中', running: '収録中', stopping: '停止処理中', stopped: '動画保存待ち', interrupted: '収録中断', completed: '収録を保存済み', error: '収録 / 保存失敗' };
const stateLabel = item => (item.mode === 'live' ? liveStateNames : stateNames)[item.state];
let token, selected, current, configuration, frames = [], busy = false, videoKey = '', labelsKey = '', pollTimer, sessions = [], previewRequest = 0;
const fixed = x => typeof x === 'number' ? x.toFixed(3) : '不明';
const uid = () => crypto.randomUUID();
// This script also exists on older servers. Detect new HTML served by an old
// in-memory router before enabling controls whose module/API cannot be loaded.
window.RawUiHealth = {
  compatible: null, moduleReady: false,
  show(text, error = false, phase = 'ready') {
    const node = $('micro-connection'); if (!node) return;
    node.textContent = text; node.className = 'message' + (error ? ' error' : ''); node.dataset.phase = phase;
  },
  controls() { if (this.compatible !== true || !this.moduleReady) for (const id of ['micro-start','micro-demo','micro-import']) { const node=$(id); if(node)node.disabled=true; } },
  accept(result) {
    this.canListPorts=result.capabilities?.raw_port_enumeration===true;window.MicroView?.installPortPicker?.();
    this.compatible = !!result.capabilities?.raw_micro_doppler?.inputs?.includes('csk_raw_uart');
    if (!this.compatible) this.show('起動中のサーバーが古いため、生ADC画面を読み込めません。収録を終了して起動用ウィンドウをCtrl+Cで閉じ、start.cmdを起動し直して、このページを再読み込みしてください。', true, 'server_outdated');
    else if (this.moduleReady) this.show('準備完了。「接続して実raw表示・保存を開始」を押すと接続します。', false, 'ready');
    this.controls(); window.MicroView?.controls();
  }
};
setTimeout(() => { const health=window.RawUiHealth;if(health.compatible===true&&!health.moduleReady)health.show('生ADC画面のプログラムを読み込めません。このページを再読み込みしてください。改善しない場合はstart.cmdからサーバーを起動し直してください。',true,'module_unavailable');health.controls(); }, 5000);
function message(text, error = false) { $('message').hidden = false; $('message').textContent = text; $('message').className = 'message' + (error ? ' error' : ''); }
async function api(url, body, { raw = false, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const headers = {}; if (method === 'POST') { headers['x-radar-token'] = token; if (!raw) headers['Content-Type'] = 'application/json'; }
  const response = await fetch(url, { method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error?.message ?? `操作に失敗しました (${response.status})`);
  return result;
}
async function act(callback) {
  if (busy) return; busy = true; updateControls();
  try { await callback(); } catch (error) { message(error.message, true); }
  finally { busy = false; updateControls(); }
}
function updateControls() {
  document.querySelectorAll('button').forEach(button => { button.disabled = busy; });
  if (typeof captureControls === 'function') captureControls();
  window.DopplerView?.updateControls();
  window.MicroView?.controls();
  window.RawUiHealth.controls();
  if (!current) return;
  const running = ['running', 'stopping'].includes(current.state);
  $('import-radar').disabled = busy || !!current.source;
  $('import-video').disabled = busy || !!current.video;
  $('start').disabled = busy || !current.source || running || current.state === 'completed' || current.mode === 'live';
  $('stop').disabled = busy || !running;
  for (const id of ['export', 'export-json', 'export-csv']) $(id).disabled = busy || running || !current.source;
  $('sync-form').querySelector('button[type=submit]').disabled = busy || running || !current.video || typeof current.video.duration_s !== 'number' || typeof current.time_range.duration_s !== 'number';
  $('label-form').querySelector('button[type=submit]').disabled = busy || !current.video || typeof current.video.duration_s !== 'number';
}
async function refreshList() {
  const result = await api('/api/sessions'); sessions = result.sessions; renderList();
  if (result.unreadable.length) message(`読み取れない記録が${result.unreadable.length}件あります。保存フォルダを保持して確認してください。`, true);
}
function renderList() {
  $('sessions').replaceChildren();
  if (!sessions.length) { const p = document.createElement('p'); p.className = 'muted small'; p.textContent = 'まだ記録はありません'; $('sessions').append(p); }
  for (const item of sessions) {
    const button = document.createElement('button'); button.className = 'session-item' + (item.id === selected ? ' active' : '');
    const name = document.createElement('span'); name.className = 'name'; name.textContent = item.title;
    const summary = document.createElement('span'); summary.className = 'summary'; summary.textContent = `${item.mode === 'demo' ? 'デモ · ' : ''}${stateLabel(item)} · ${item.count}件`;
    button.append(name, summary); button.onclick = () => act(() => selectSession(item.id)); $('sessions').append(button);
  }
}
async function selectSession(id) {
  clearTimeout(pollTimer); selected = id; current = null; configuration = null; frames = []; labelsKey = ''; videoKey = '';
  sessionStorage.setItem('radar-session', id); await renderSession(true);
  $('new-section').open = false;
}
async function renderSession(newSelection = false) {
  if (!selected) return;
  const id = selected, request = ++previewRequest, m = await api(`/api/sessions/${id}`);
  if (id !== selected || request !== previewRequest) return;
  current = m;
  if (!configuration) configuration = await api(`/api/sessions/${id}/configuration`);
  if (id !== selected || request !== previewRequest) return;
  $('empty').hidden = true; $('workspace').hidden = false;
  $('record-title').textContent = m.title;
  $('mode-badge').textContent = m.mode === 'live' ? '直接収録 · 検出イベントとカメラ · 物理同期精度は未検証' : m.mode === 'demo' ? 'デモ · 合成データ · 実機未使用' : m.source?.diagnostic ? '診断サンプル · 全件の収録データではありません' : '保存済みファイルの取込み';
  $('record-meta').textContent = `被験者 ${m.subject} / シナリオ ${m.scenario} / 分割 ${m.split_group}`;
  $('state').textContent = stateLabel({ ...m, state: m.runtime_failure ? 'error' : m.state }); $('state').className = `state ${m.runtime_failure ? 'error' : m.state}`;
  $('clock-caption').textContent = m.mode === 'live' ? '横軸はこのアプリのPC受信時刻からの秒。機器取得時刻・物理同期精度は未確認です。' : '横軸は元PCの解読時刻からの秒。取得時刻・物理同期精度は未確認です。';
  if (m.last_error || m.runtime_failure) message((m.runtime_failure ?? m.last_error).message, true);
  $('count').textContent = `${m.count} 件`;
  $('duration').textContent = typeof m.time_range.duration_s === 'number' ? `${fixed(m.time_range.duration_s)} s` : '不明';
  $('errors').textContent = `${m.error_count} 件`;
  $('source-name').textContent = m.source ? m.source.name : '未登録';
  $('video-name').textContent = m.video ? `${m.video.name} · ${fixed(m.video.duration_s)} s` : '動画未登録';
  $('provenance').textContent = JSON.stringify({ configuration, source: m.source, video: m.video, capture: m.capture, config_sha256: m.config_sha256, time_range: m.time_range, device_loss: m.device_loss, state_history: m.state_history }, null, 2);
  const key = m.video ? `${m.id}:${m.video.sha256}` : '';
  if (videoKey !== key || newSelection) {
    videoKey = key;
    if (m.video) { $('video').src = `/api/sessions/${m.id}/video`; $('video').load(); $('video-error').textContent = '動画を読み込んでいます'; }
    else { $('video').removeAttribute('src'); $('video').load(); $('video-error').textContent = '既存の動画を取り込んでください'; }
  }
  if (newSelection) {
    for (let i = 0; i < 2; i++) {
      const anchor = m.sync?.anchors[i];
      $(`v${i}`).value = anchor?.video_s ?? (i ? (typeof m.video?.duration_s === 'number' ? Math.floor(m.video.duration_s * 1000) / 1000 : '') : 0);
      $(`r${i}`).value = anchor?.radar_s ?? (i ? (typeof m.time_range.duration_s === 'number' ? m.time_range.duration_s : '') : 0);
      $(`note${i}`).value = anchor?.note ?? (m.mode === 'demo' ? `合成fixtureの${i ? '終了' : '開始'}位置（実機目印ではない）` : '');
      $(`vu${i}`).value = anchor?.video_uncertainty_s ?? 0.1; $(`ru${i}`).value = anchor?.radar_uncertainty_s ?? 0.1;
    }
  }
  if (!m.sync && !['running', 'stopping'].includes(m.state) && !$('r1').value && typeof m.time_range.duration_s === 'number') $('r1').value = m.time_range.duration_s;
  if (m.sync) {
    $('sync-status').textContent = '対応時刻を保存済み'; $('sync-result').hidden = false;
    $('sync-result').textContent = `offset ${fixed(m.sync.offset_s)} s / drift ${m.sync.drift_ppm.toFixed(1)} ppm / scale ${m.sync.scale.toFixed(9)}。レーダー秒 = offset + scale × 動画秒。目印の範囲外は外挿になります。物理同期精度は未実証です。`;
  } else { $('sync-status').textContent = '未同期'; $('sync-result').hidden = true; }
  $('label-progress').textContent = `${m.labels.filter(x => ['confirmed', 'corrected'].includes(x.status)).length} / ${m.labels.length} 区間を本人レビュー済み`;
  const nextLabelsKey = `${m.id}:${m.review_revision}:${m.sync?.reviewed_at ?? ''}`;
  if (labelsKey !== nextLabelsKey) { labelsKey = nextLabelsKey; renderLabels(); }
  window.dispatchEvent(new CustomEvent('radar-session', { detail: { session: m, selectedNew: newSelection } }));
  drawChart(); updateVideoTime(); updateControls();
  sessions = sessions.map(x => x.id === m.id ? m : x); renderList();
  clearTimeout(pollTimer);
  if (m.state === 'running' && !m.runtime_failure) pollTimer = setTimeout(() => renderSession().catch(e => message(e.message, true)), 750);
}
function showDistancePoints(points, id) {
  if (!current || selected !== id) return;
  frames = points.filter(point => point.range_m !== null).map(point => ({ data_kind: 'detections', pc_receive_time: { value: current.time_range.first_pc_ms + point.t_s * 1000 }, attributes: ['range_m'], data: [[point.range_m]], errors: [] }));
  $('chart-caption').textContent = `表示範囲内 ${frames.length}点 / 保存 ${current.count}件`;
  drawChart();
}
function mapped(videoS) {
  if (!current?.sync) return null;
  const sync = current.sync, [a, b] = sync.anchors, w = (videoS - a.video_s) / (b.video_s - a.video_s);
  return { time: sync.offset_s + sync.scale * videoS, uncertainty: Math.abs(1 - w) * (a.radar_uncertainty_s + sync.scale * a.video_uncertainty_s) + Math.abs(w) * (b.radar_uncertainty_s + sync.scale * b.video_uncertainty_s), extrapolated: w < 0 || w > 1 };
}
function updateVideoTime() {
  const time = $('video').currentTime || 0; $('video-time').textContent = `動画 ${fixed(time)} s`;
  const match = mapped(time); $('radar-time').textContent = match ? `レーダー ${fixed(match.time)} s ±${fixed(match.uncertainty)} s${match.extrapolated ? '（外挿）' : ''}` : '対応レーダー時刻：未同期';
  drawChart();
}
function drawChart() {
  const canvas = $('chart'), ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height, l = 48, r = w - 20, top = 20, bottom = h - 40;
  ctx.clearRect(0, 0, w, h); ctx.font = '12px Segoe UI'; ctx.lineWidth = 1;
  const timed = frames.filter(f => typeof f.pc_receive_time.value === 'number' && f.data_kind === 'detections');
  if (!current || !timed.length || typeof current.time_range.duration_s !== 'number') { ctx.fillStyle = '#657b80'; ctx.fillText('表示できる検出時刻がありません', 30, 145); return; }
  const duration = Math.max(.001, current.time_range.duration_s), points = [];
  for (const frame of timed) { const col = frame.attributes.indexOf('range_m'); if (col < 0) continue; for (const row of frame.data) if (typeof row[col] === 'number') points.push({ x: (frame.pc_receive_time.value - current.time_range.first_pc_ms) / 1000, y: row[col], error: frame.errors.length > 0 }); }
  const maxY = Math.max(1, ...points.map(p => p.y));
  for (let i = 0; i <= 4; i++) { const y = bottom - (bottom - top) * i / 4; ctx.strokeStyle = '#e0e9e9'; ctx.beginPath(); ctx.moveTo(l, y); ctx.lineTo(r, y); ctx.stroke(); ctx.fillStyle = '#687c81'; ctx.fillText((maxY * i / 4).toFixed(1), 8, y + 4); }
  for (let i = 0; i <= 4; i++) { const x = l + (r - l) * i / 4; ctx.fillStyle = '#687c81'; ctx.fillText((duration * i / 4).toFixed(1) + ' s', x - 10, h - 14); }
  ctx.fillText('m', 9, 15);
  for (const point of points) { ctx.fillStyle = point.error ? '#bd7f29' : '#168587'; ctx.beginPath(); ctx.arc(l + point.x / duration * (r - l), bottom - Math.max(0, point.y) / maxY * (bottom - top), 2.5, 0, Math.PI * 2); ctx.fill(); }
  const active = mapped($('video').currentTime || 0);
  if (active && active.time >= 0 && active.time <= duration) { const x = l + active.time / duration * (r - l); ctx.strokeStyle = '#e49b54'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke(); }
}
function renderLabels() {
  $('label-list').replaceChildren();
  if (!current.labels.length) { const p = document.createElement('p'); p.textContent = '区間はまだありません。動画を見て追加してください。'; p.className = 'muted small'; $('label-list').append(p); }
  for (const item of current.labels) {
    const reviewStarted = performance.now(), row = document.createElement('div'); row.className = `label-row ${item.status}`; row.dataset.labelId = item.id;
    const top = document.createElement('div'); top.className = 'label-row-top';
    const status = document.createElement('span'); status.textContent = `${statusNames[item.status]} · ${item.origin === 'manual' ? '手動追加' : '自動候補の取込み'} · ${item.channel === 'current_action' ? '現在行動' : item.channel === 'context' ? '文脈' : '品質'}`;
    const origin = document.createElement('span'); origin.textContent = item.candidate ? `元候補：${item.candidate.label} ${fixed(item.candidate.start_video_s)}–${fixed(item.candidate.end_video_s)} s` : '';
    top.append(status, origin); row.append(top);
    const fields = document.createElement('div'); fields.className = 'label-fields'; const inputs = {};
    for (const [key, title] of [['label', '行動名'], ['start_video_s', '開始秒'], ['end_video_s', '終了秒']]) {
      const label = document.createElement('label'); label.textContent = title; const input = document.createElement('input'); input.value = item[key]; input.dataset.field = key;
      if (key !== 'label') { input.type = 'number'; input.step = '0.001'; input.min = '0'; } else input.maxLength = 200;
      label.append(input); fields.append(label); inputs[key] = input;
    }
    row.append(fields); const buttons = document.createElement('div'); buttons.className = 'label-row-actions';
    const jump = document.createElement('button'); jump.className = 'quiet'; jump.textContent = 'この区間を見る'; jump.onclick = () => { $('video').currentTime = item.start_video_s; $('video').focus(); }; buttons.append(jump);
    for (const [action, title] of [['confirm', '本人確認'], ['correct', '修正を保存'], ['reject', '除外']]) {
      const button = document.createElement('button'); button.className = action === 'confirm' ? 'secondary' : 'quiet'; button.textContent = title; button.dataset.action = action;
      button.onclick = () => act(async () => {
        const values = { label: inputs.label.value, start_video_s: Number(inputs.start_video_s.value), end_video_s: Number(inputs.end_video_s.value) };
        if (action === 'confirm' && (values.label !== item.label || values.start_video_s !== item.start_video_s || values.end_video_s !== item.end_video_s)) throw new Error('変更した区間は「修正を保存」でレビューしてください');
        await api(`/api/sessions/${selected}/labels/${item.id}`, { ...values, action, expected_revision: current.review_revision, request_id: uid(), review_duration_ms: Math.round(performance.now() - reviewStarted) });
        await renderSession(); message(`${title}を保存しました`);
      }); buttons.append(button);
    }
    const range = document.createElement('span'); range.className = 'label-mapped'; const a = mapped(item.start_video_s), b = mapped(item.end_video_s);
    range.textContent = a ? `レーダー ${fixed(a.time)}–${fixed(b.time)} s` : '未同期'; buttons.append(range); row.append(buttons); $('label-list').append(row);
  }
}
async function downloaded(format) {
  const response = await fetch(`/api/sessions/${selected}/export?format=${format}`);
  if (!response.ok) { const result = await response.json(); throw new Error(result.error.message); }
  const blob = await response.blob(), link = document.createElement('a'), url = URL.createObjectURL(blob);
  link.href = url; link.download = `radar-${selected}.${format === 'archive' ? 'tar.gz' : format}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  const result = await api(`/api/sessions/${selected}/export?format=json`);
  $('export-summary').textContent = `書出し対象 ${result.intervals.length}区間 / 除外 ${result.excluded.length}区間。${result.excluded.length ? '未確認・未同期・対応範囲外などの理由はJSONに保存しています。' : ''}`;
  message(`読み戻し検証を通過し、${result.intervals.length}区間を書き出しました。物理同期精度は未実証です。`);
}
$('create-form').onsubmit = event => { event.preventDefault(); act(async () => {
  const m = await api('/api/sessions', { title: $('title').value, subject: $('subject').value || 'unknown', scenario: $('scenario').value || 'unknown', split_group: $('split').value || 'unassigned', historical_device: $('historical').checked, request_id: uid() });
  await refreshList(); await selectSession(m.id); message('記録を作成しました。JSONLと動画を取り込んでください。');
}); };
$('demo').onclick = () => act(async () => { const m = await api('/api/demo', { request_id: uid() }); await refreshList(); await selectSession(m.id); message('デモは合成データです。実機やカメラは使っていません。'); });
$('refresh').onclick = () => act(async () => { await refreshList(); if (selected) await renderSession(); });
$('import-radar').onclick = () => act(async () => { const file = $('radar-file').files[0]; if (!file) throw new Error('レーダーファイルを選んでください'); if (file.size > 256 * 1024 * 1024) throw new Error('ファイル上限は256 MiBです'); await api(`/api/sessions/${selected}/radar?name=${encodeURIComponent(file.name)}&format=${$('radar-format').value}`, file, { raw: true }); await renderSession(); message('元ファイルを保存しました。「取込みを開始 / 再開」で読み込みます。'); });
$('import-video').onclick = () => act(async () => { const file = $('video-file').files[0]; if (!file) throw new Error('動画を選んでください'); if (file.size > 256 * 1024 * 1024) throw new Error('ファイル上限は256 MiBです'); await api(`/api/sessions/${selected}/video?name=${encodeURIComponent(file.name)}`, file, { raw: true }); await renderSession(); message('動画を保存しました。再生を確認してください。'); });
$('start').onclick = () => act(async () => { await api(`/api/sessions/${selected}/start`, {}); await renderSession(); message('保存済みファイルの取込みを開始しました'); });
$('stop').onclick = () => act(async () => { if (current?.mode === 'live' && captureRuntime?.id === selected) { await stopLiveCapture(); return; } await api(`/api/sessions/${selected}/stop`, {}); await renderSession(); message(current?.mode === 'live' ? 'レーダーを停止しました。収録画面で動画保存を完了してください。' : '取込みを停止しました。保存済みの次の行から再開できます。'); });
$('verify').onclick = () => act(async () => { const r = await api(`/api/sessions/${selected}/verify`); $('verification').textContent = r.ok ? `${r.count}件 · 件数/順序/元データ/設定/時間範囲を確認` : `不一致: ${r.failures.join(', ')}`; message(r.ok ? '保存内容の読み戻しが一致しました。機器側欠損の検証結果ではありません。' : `読み戻し不一致: ${r.failures.join(', ')}`, !r.ok); });
$('sync-form').onsubmit = event => { event.preventDefault(); act(async () => { const anchors = [0, 1].map(i => ({ video_s: Number($(`v${i}`).value), radar_s: Number($(`r${i}`).value), video_uncertainty_s: Number($(`vu${i}`).value), radar_uncertainty_s: Number($(`ru${i}`).value), note: $(`note${i}`).value })); await api(`/api/sessions/${selected}/sync`, { anchors }); await renderSession(); message('offsetとdrift、目印の不確かさを保存しました'); }); };
for (let i = 0; i < 2; i++) $(`mark${i}`).onclick = () => { $(`v${i}`).value = ($('video').currentTime || 0).toFixed(3); };
$('label-mark-start').onclick = () => { $('label-start').value = ($('video').currentTime || 0).toFixed(3); };
$('label-mark-end').onclick = () => { $('label-end').value = ($('video').currentTime || 0).toFixed(3); };
$('label-form').onsubmit = event => { event.preventDefault(); act(async () => { await api(`/api/sessions/${selected}/labels`, { label: $('label-name').value, channel: $('label-channel').value, start_video_s: Number($('label-start').value), end_video_s: Number($('label-end').value), request_id: uid() }); await renderSession(); message('未確認区間を追加しました。動画を見て本人確認してください。'); }); };
$('action-names').oninput = () => { const names = [...new Set([...$('action-names').value.split('\n').map(x => x.trim()).filter(Boolean), 'その他', '不明'])].slice(0, 100); $('action-chips').replaceChildren(); $('actions').replaceChildren(); for (const name of names) { const button = document.createElement('button'); button.className = 'chip'; button.textContent = name; button.onclick = () => { $('label-name').value = name; }; $('action-chips').append(button); const option = document.createElement('option'); option.value = name; $('actions').append(option); } };
$('action-names').oninput();
$('import-candidates').onclick = () => act(async () => { const file = $('candidate-file').files[0]; if (!file) throw new Error('候補JSONを選んでください'); const data = JSON.parse(await file.text()); await api(`/api/sessions/${selected}/candidates`, { ...data, request_id: uid() }); await renderSession(); message('候補を未確認区間として取り込みました。本人レビューが必要です。'); });
for (const [id, format] of [['export', 'archive'], ['export-json', 'json'], ['export-csv', 'csv']]) $(id).onclick = () => act(() => downloaded(format));
$('video').addEventListener('loadedmetadata', async () => {
  const id = selected, expected = current?.video?.sha256; if (!id || !expected) return;
  try {
    const duration = $('video').duration;
    if (!Number.isFinite(duration) && current?.video?.capture_started_by_this_app) { $('video-error').textContent = `収録動画 ${fixed(current.video.duration_s)} s · ブラウザー開始/終了時計の長さ。フレーム時刻は未検証です`; updateControls(); return; }
    const m = await api(`/api/sessions/${id}/video-metadata`, { duration_s: duration, sha256: expected });
    if (selected !== id) return;
    current.video = m.video; $('video-error').textContent = `動画 ${fixed(duration)} s · 再生して区間を確認できます`;
    $('video-name').textContent = `${m.video.name} · ${fixed(duration)} s`;
    if (!current.sync && !$('v1').value) $('v1').value = Math.floor(duration * 1000) / 1000;
    updateControls();
  } catch (error) { $('video-error').textContent = error.message; message(error.message, true); }
});
$('video').addEventListener('error', () => { if (current?.video) { $('video-error').textContent = 'このブラウザーで動画を再生できません。対応するWebMやMP4で新しい記録を作成してください。'; } });
$('video').addEventListener('timeupdate', updateVideoTime);
$('chart').onclick = event => { if (!current?.sync) return; const box = $('chart').getBoundingClientRect(), x = (event.clientX - box.left) / box.width * $('chart').width; const radar = Math.max(0, Math.min(current.time_range.duration_s, (x - 48) / ($('chart').width - 68) * current.time_range.duration_s)); const video = (radar - current.sync.offset_s) / current.sync.scale; if (video >= 0 && video <= $('video').duration) $('video').currentTime = video; };
(async () => {
  try { const result = await api('/api/bootstrap'); token = result.token; window.RawUiHealth.accept(result); sessions = result.sessions; renderList(); if (result.recovery_problems.length) message('前回の記録に読み戻し不一致があります。元ファイルを保持して確認してください。', true); const saved = sessionStorage.getItem('radar-session'); if (sessions.some(x => x.id === saved)) await selectSession(saved); }
  catch (error) { message(error.message, true); window.RawUiHealth.compatible=false;window.RawUiHealth.show('サーバーに接続できません: '+error.message,true,'server_unavailable');window.RawUiHealth.controls(); }
})();
