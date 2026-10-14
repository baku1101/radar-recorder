import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { launchHeadless } from './headless.mjs';
import { livePeer } from './live-fixture.mjs';

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url))), output = path.join(project, 'test-output'); fs.mkdirSync(output, { recursive: true });
const peer = await livePeer(), app = await createApp({ port: 0, root: path.join(output, `capture-ui-${randomUUID()}`), delayMs: 10 });
const browser = await launchHeadless(output), checks = [];
const check = name => { checks.push({ name, passed: true }); console.log(`PASS ${name}`); };
try {
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await browser.send('Page.navigate', { url: app.origin }); await browser.waitFor("typeof token === 'string' && typeof beginLiveCapture === 'function'");
  // Replace getUserMedia only inside this isolated tab with a synthetic animated
  // canvas stream. The production MediaRecorder and upload flow are unchanged.
  await browser.evaluate(`window.testCameraRequests=[]; navigator.mediaDevices.getUserMedia=async options=>{
    testCameraRequests.push(options); const canvas=document.createElement('canvas'); canvas.width=320; canvas.height=240;
    const ctx=canvas.getContext('2d'); let frame=0; const timer=setInterval(()=>{ctx.fillStyle=frame++%2?'#215f75':'#50aa92';ctx.fillRect(0,0,320,240);ctx.fillStyle='white';ctx.fillText('SYNTHETIC '+frame,20,40)},50);
    const stream=canvas.captureStream(15);stream.getTracks()[0].addEventListener('ended',()=>clearInterval(timer));return stream;
  }; document.getElementById('capture-transport').value='local_websocket_events'; captureControls(); document.getElementById('capture-url').value=${JSON.stringify(peer.url)};document.getElementById('capture-title').value='合成直接収録';document.getElementById('capture-form').requestSubmit();`);
  await browser.waitFor("!busy && captureRuntime?.id && current?.mode==='live' && current.state==='running'", 15000);
  const id = await browser.evaluate('selected'); check('One GUI action starts the production recorder and live radar acquisition');
  const requests = await browser.evaluate('testCameraRequests'); assert.equal(requests.length, 1); assert.equal(requests[0].audio, false); check('Camera constraints request video only and never audio');
  await browser.waitFor('captureRuntime.saved >= 2', 15000); check('MediaRecorder chunks are saved while recording');
  await browser.screenshot(path.join(project, 'evidence', 'private-capture-synthetic-ui.png'));
  await browser.evaluate("document.getElementById('stop').click();document.getElementById('capture-stop').click()");
  await browser.waitFor("!captureRuntime && current?.state==='completed'", 15000);
  const m = app.store.get(id); assert.ok(m.count > 0 && m.capture.chunk_count >= 3); assert.equal(m.video.capture_started_by_this_app, true); assert.equal(m.capture.camera.audio, false); assert.equal(app.store.verify(id).ok, true);
  check('Double stop flushes the final video chunk and readback matches radar, video and configuration');
  await browser.waitFor("document.getElementById('video').readyState>=2", 10000); assert.equal(await browser.evaluate("document.getElementById('video').videoWidth"), 320);
  await browser.evaluate("document.getElementById('video').muted=true;document.getElementById('video').play()"); await browser.waitFor("document.getElementById('video').currentTime>0.1"); check('The actual captured WebM replays in the review panel');
  assert.equal(m.sync, null); assert.equal(m.physical_sync_accuracy_verified, false); check('Capture start clocks do not silently create verified physical synchronization');
  await browser.evaluate("document.getElementById('capture-resume').click()"); await browser.waitFor(`!busy && current?.id!==${JSON.stringify(id)} && captureRuntime?.id`, 15000);
  const resumed = await browser.evaluate('selected'); assert.equal(app.store.get(resumed).capture.resumed_from, id); assert.equal(app.store.get(id).count, m.count); check('GUI resumes into a distinct session with an explicit prior-session link');
  await browser.waitFor('captureRuntime.saved >= 1', 10000); peer.drop();
  await browser.waitFor("!captureRuntime && current?.state==='error'", 15000); assert.equal(app.store.get(resumed).capture.status, 'partial'); assert.ok(app.store.get(resumed).video); check('Live disconnect stops camera and keeps the partial radar and playable video');
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); assert.equal(await browser.evaluate('document.documentElement.scrollWidth>innerWidth'), false); check('Direct capture controls fit a narrow viewport');
  assert.equal(browser.events.filter(x => x.method==='Runtime.exceptionThrown').length, 0); check('Capture flow has no browser JavaScript exceptions');
  fs.writeFileSync(path.join(project, 'evidence', 'capture-ui-results.json'), JSON.stringify({ passed: true, checks, source: 'synthetic_local_websocket_and_canvas_only', real_camera: false, real_sensor: false, gpu: false }, null, 2));
} finally { await browser.close(); await app.close(); await peer.close(); }
