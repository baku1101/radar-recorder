'use strict';
let captureRuntime = null, failedCapture = null;
function captureControls() {
  const running = !!captureRuntime;
  const monitoring = window.DopplerView?.monitorBusy || window.MicroView?.hardwareBusy;
  $('capture-start').disabled = busy || running || monitoring;
  $('capture-stop').disabled = !running || captureRuntime?.stopping;
  $('capture-resume').disabled = busy || running || monitoring || current?.mode !== 'live' || ['running', 'ready'].includes(current?.state);
  $('capture-transport').disabled = running || monitoring;
  $('capture-com-row').hidden = $('capture-transport').value !== 'csk_uart_installed_vendor_api';
  $('capture-url-row').hidden = !$('capture-com-row').hidden;
}
function cameraMime() {
  if (typeof MediaRecorder === 'undefined') throw new Error('このブラウザーはカメラ収録に対応していません。最新版のChromeまたはEdgeを使ってください。');
  const mime = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'].find(x => MediaRecorder.isTypeSupported(x));
  if (!mime) throw new Error('WebM動画の収録に対応していません');
  return mime;
}
async function beginLiveCapture(resumedFrom = null) {
  if (captureRuntime) return;
  if (window.DopplerView?.monitorBusy) throw new Error('表示を止めて接続を解放してから収録を始めてください');
  if (window.MicroView?.hardwareBusy) throw new Error('raw取得を停止してからカメラ収録を始めてください');
  const mime = cameraMime();
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('このブラウザーでカメラを利用できません');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 15 } } });
  let runtime;
  try {
    const m = await api('/api/sessions', { title: $('capture-title').value || '直接収録', subject: $('subject').value || 'unknown', scenario: $('scenario').value || 'unknown', split_group: $('split').value || 'unassigned', mode: 'live', request_id: uid() });
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 1000000 });
    runtime = captureRuntime = { id: m.id, stream, recorder, count: 0, saved: 0, pending: new Map(), pendingBytes: 0, chain: Promise.resolve(), stopping: false, failure: null };
    $('live-preview').srcObject = stream; $('live-preview').hidden = false; $('live-preview').play().catch(() => {});
    $('capture-status').textContent = 'カメラを開始し、レーダーに接続しています';
    recorder.ondataavailable = event => {
      if (!event.data.size) return;
      const index = runtime.count++, end = performance.now(); runtime.pending.set(index, event.data); runtime.pendingBytes += event.data.size;
      if (runtime.pendingBytes > 32 * 1024 * 1024 || runtime.pending.size > 10) { runtime.failure ??= new Error('動画の保存が収録に追いつかないため停止しました'); stopLiveCapture(true).catch(e => message(e.message, true)); }
      runtime.chain = runtime.chain.then(async () => {
        if (runtime.failure) return;
        let error;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { await api(`/api/sessions/${runtime.id}/camera-chunk?index=${index}&end_ms=${end}`, event.data, { raw: true }); runtime.saved++; runtime.pending.delete(index); runtime.pendingBytes -= event.data.size; return; }
          catch (failure) { error = failure; }
        }
        runtime.failure = error; queueMicrotask(() => stopLiveCapture(true).catch(e => message(e.message, true)));
      });
    };
    recorder.onerror = event => { runtime.failure = event.error ?? new Error('カメラ収録に失敗しました'); stopLiveCapture(true).catch(e => message(e.message, true)); };
    stream.getVideoTracks()[0].addEventListener('ended', () => { if (!runtime.stopping) { runtime.failure = new Error('カメラとの接続が切れました'); stopLiveCapture(true).catch(e => message(e.message, true)); } });
    const began = await new Promise((resolve, reject) => { recorder.addEventListener('start', () => resolve({ started_unix_ms: Date.now(), started_monotonic_ms: performance.now(), time_origin_ms: performance.timeOrigin }), { once: true }); recorder.addEventListener('error', e => reject(e.error), { once: true }); recorder.start(1000); });
    runtime.camera = { ...began, mime_type: recorder.mimeType, width: stream.getVideoTracks()[0].getSettings().width ?? 'unknown', height: stream.getVideoTracks()[0].getSettings().height ?? 'unknown', frame_rate: stream.getVideoTracks()[0].getSettings().frameRate ?? 'unknown', source: 'browser_getUserMedia_video_only' };
    const body = { transport: $('capture-transport').value, port: $('capture-com').value, url: $('capture-url').value, data_kind: 'detections', camera: runtime.camera, resumed_from: resumedFrom, request_id: uid() };
    await api(`/api/sessions/${m.id}/capture-start`, body);
    runtime.heartbeat = setInterval(async () => {
      try { const response = await api(`/api/sessions/${runtime.id}/capture-heartbeat`, {}); if (response.state !== 'running') { runtime.sourceFailed = true; await stopLiveCapture(); } }
      catch (error) { runtime.failure = error; await stopLiveCapture(true); }
    }, 3000);
    await refreshList(); await selectSession(m.id);
    $('capture-status').textContent = '収録中 · レーダーと動画をこのPCに保存しています';
    message('直接収録を開始しました。開始側と終了側で、両方に見える同期目印を残してください。');
  } catch (error) {
    if (runtime) { runtime.failure = error; await stopLiveCapture(true); } else stream.getTracks().forEach(track => track.stop());
    throw error;
  } finally { captureControls(); }
}
async function stopLiveCapture(failed = false) {
  const runtime = captureRuntime; if (!runtime || runtime.stopping) return;
  runtime.stopping = true; clearInterval(runtime.heartbeat); captureControls(); $('capture-status').textContent = '停止して動画の最後の分割を保存しています';
  let stopped;
  try {
    if (failed) await api(`/api/sessions/${runtime.id}/capture-error`, { message: runtime.failure?.message ?? '動画収録が中断しました' });
    else await api(`/api/sessions/${runtime.id}/stop`, {});
  } catch (error) { runtime.failure ??= error; }
  try {
    if (runtime.recorder.state !== 'inactive') await new Promise(resolve => { runtime.recorder.addEventListener('stop', resolve, { once: true }); runtime.recorder.stop(); });
    stopped = { stopped_monotonic_ms: performance.now(), stopped_unix_ms: Date.now() };
    runtime.stream.getTracks().forEach(track => track.stop()); $('live-preview').srcObject = null; $('live-preview').hidden = true;
    await runtime.chain;
    if (!runtime.failure) await api(`/api/sessions/${runtime.id}/capture-finish`, { ...stopped, expected_chunks: runtime.count });
    if (runtime.failure) {
      failedCapture = runtime; $('capture-rescue').hidden = !runtime.pending.size;
      await api(`/api/sessions/${runtime.id}/capture-error`, { message: runtime.failure.message }).catch(() => {});
      throw runtime.failure;
    }
    $('capture-status').textContent = runtime.sourceFailed ? 'レーダーが中断しました。保存済み動画と受信記録を保持しました' : '収録を停止し、動画を保存しました';
    await refreshList(); await selectSession(runtime.id);
    message(runtime.sourceFailed ? 'レーダー出力が中断しました。保存した範囲を確認してください。' : '収録を保存しました。2つの目印で同期し、区間を本人レビューしてください。', runtime.sourceFailed);
  } catch (error) { $('capture-status').textContent = '収録が中断しました。保存済みデータと動画分割を保持しています'; message(error.message, true); }
  finally { runtime.stream.getTracks().forEach(track => track.stop()); captureRuntime = null; captureControls(); }
}
$('capture-form').onsubmit = event => { event.preventDefault(); act(() => beginLiveCapture()); };
$('capture-stop').onclick = () => stopLiveCapture().catch(e => message(e.message, true));
$('capture-resume').onclick = () => act(async () => { const previous = current; $('capture-title').value = `${previous.title} · 再開`; if (configuration?.connection) { $('capture-transport').value = configuration.connection.transport; if (configuration.connection.port) $('capture-com').value = configuration.connection.port; if (configuration.connection.url) $('capture-url').value = configuration.connection.url; } await beginLiveCapture(previous.id); });
$('capture-transport').onchange = captureControls;
$('capture-rescue').onclick = () => { if (!failedCapture?.pending.size) return; const blob = new Blob([...failedCapture.pending.values()], { type: 'video/webm' }), url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = `${failedCapture.id}-unsaved-camera-tail.webm`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); message('未保存の末尾分割を取得しました。単独の完成動画とは限りません。保存済み分割と一緒に保持してください。'); };
window.addEventListener('pagehide', () => { const runtime = captureRuntime; if (runtime) { runtime.stream.getTracks().forEach(track => track.stop()); runtime.recorder.state !== 'inactive' && runtime.recorder.stop(); } });
captureControls();
