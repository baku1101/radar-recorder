import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { defaultLiveFactory } from '../src/live.mjs';
import { livePeer } from './live-fixture.mjs';
import { launchHeadless } from './headless.mjs';
import { eventually } from './helpers.mjs';

// No hardware by default. Explicit USB mode stores real events privately only.
const usbPort = process.env.RADAR_DOPPLER_USB;
const project = path.dirname(path.dirname(fileURLToPath(import.meta.url))), output = path.join(project, 'test-output'), evidence = path.join(project, 'evidence');
fs.mkdirSync(output, { recursive: true }); fs.mkdirSync(evidence, { recursive: true });
const originals = [], message = JSON.stringify({ ts: 0, detections: { attributes: ['doppler_bin', 'magnitude_dBFS', 'speed_mps', 'range_m'], data: [[-7, -42, -.625, 2], [0, -50, 0, 1], [9, -30, .75, 3]] } });
const peer = usbPort ? null : await livePeer({ intervalMs: 40, message });
const app = await createApp({ port: 0, root: path.join(output, `doppler-ui-${randomUUID()}`), liveFactory: connection => {
  const adapter = defaultLiveFactory(connection), read = adapter.read.bind(adapter);
  adapter.read = async () => { const envelope = await read(); if (envelope) originals.push(envelope); return envelope; }; return adapter;
} });
const browser = await launchHeadless(output), checks = [];
const check = (name, details = true) => { checks.push({ name, passed: true, details }); console.log(`PASS ${name}`); };
const evaluate = expression => browser.evaluate(expression);
const click = async selector => { await browser.waitFor(`!busy && !document.querySelector(${JSON.stringify(selector)}).disabled`); await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); };
const change = async (id, value, event = 'change') => evaluate(`document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(value)};document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event(${JSON.stringify(event)}))`);
try {
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1050, deviceScaleFactor: 1, mobile: false });
  await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: "window.cameraCalls=0;Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>{window.cameraCalls++;throw new Error('Camera forbidden in Doppler display test');}},configurable:true});" });
  await browser.send('Page.navigate', { url: app.origin }); await browser.waitFor("typeof token === 'string' && !!window.DopplerView");
  check('Doppler controls load without opening a camera');
  await click('#demo'); await browser.waitFor("current?.state==='completed' && DopplerView.snapshot?.total_saved_records===122", 15000);
  assert.match(await evaluate("document.getElementById('doppler-origin').textContent"), /合成デモ/); assert.ok(await evaluate('DopplerView.drawnPoints.length>0'));
  assert.equal(await evaluate('DopplerView.snapshot.full_spectrum'), false); check('Saved synthetic events render with explicit demo and acquisition provenance');
  await change('doppler-axis', 'doppler_bin'); assert.ok(await evaluate('DopplerView.drawnPoints.some(p=>p.doppler_bin===-4)')); assert.match(await evaluate("document.getElementById('doppler-chart').getAttribute('aria-label')"), /bin/); check('Doppler-bin axis uses original integer bins and units');
  await change('doppler-axis', 'speed_mps'); assert.ok(await evaluate('DopplerView.drawnPoints.some(p=>p.speed_mps===-.45)'));
  await change('doppler-seek', 5, 'input'); await browser.waitFor('DopplerView.snapshot?.end_s===5'); assert.ok(await evaluate('DopplerView.drawnPoints.every(p=>p.t_s<=5)')); check('Saved-log seek selects the requested time window');
  await click('#doppler-play'); await browser.waitFor('DopplerView.snapshot?.end_s>5.2'); await click('#doppler-play'); check('Saved-log playback advances by source PC timestamps');
  await click('#doppler-latest'); await browser.waitFor('DopplerView.snapshot?.end_s===12'); await change('doppler-window', '10'); await browser.waitFor('DopplerView.snapshot?.start_s===2'); check('Display window and latest-position controls work');
  await evaluate("document.getElementById('doppler-card').scrollIntoView({block:'center'})");
  await browser.screenshot(path.join(evidence, 'doppler-synthetic.png')); check('Synthetic graph screenshot saved privately');
  const clip = await evaluate("(()=>{const b=document.getElementById('doppler-card').getBoundingClientRect();return {x:b.x+scrollX,y:b.y+scrollY,width:b.width,height:b.height,scale:1}})()");
  const graphImage = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip }); fs.writeFileSync(path.join(evidence, 'doppler-synthetic-graph.png'), Buffer.from(graphImage.data, 'base64'));
  const sessionCount = app.store.list().sessions.length;
  await change('capture-transport', usbPort ? 'csk_uart_installed_vendor_api' : 'local_websocket_events');
  if (usbPort) await evaluate(`document.getElementById('capture-com').value=${JSON.stringify(usbPort)}`); else await evaluate(`document.getElementById('capture-url').value=${JSON.stringify(peer.url)}`);
  await click('#monitor-start'); await browser.waitFor("DopplerView.monitor?.state==='running' && DopplerView.snapshot?.records_received>=5 && DopplerView.screenPoints?.length>0", 16000);
  assert.equal(await evaluate('window.cameraCalls'), 0); assert.equal(app.store.list().sessions.length, sessionCount); assert.equal(app.monitor.view().recording, false); check('Live display starts without camera permission or a recording session', { hardware: !!usbPort });
  const firstCount = app.monitor.count; await browser.waitFor(`DopplerView.snapshot?.records_received>${firstCount}`); check('Incoming live events advance graph timestamps and receive counts');
  if (!usbPort) {
    await browser.send('Page.reload'); await browser.waitFor("typeof token==='string' && DopplerView.monitorBusy && current?.id"); await change('doppler-source', 'monitor'); await browser.waitFor('DopplerView.snapshot?.records_received>0 && DopplerView.drawnPoints?.length>0');
    check('Page reload restores the active monitor controls without reopening the sensor');
  }
  await change('doppler-axis', 'doppler_bin'); assert.ok(await evaluate('DopplerView.drawnPoints.length>0')); check('Live display switches from speed to source Doppler bins');
  await click('#doppler-pause'); const frozen = await evaluate('DopplerView.snapshot.records_received'); await eventually(() => app.monitor.count > frozen + 4, 6000); assert.equal(await evaluate('DopplerView.snapshot.records_received'), frozen); check('Display pause freezes the graph while reception continues');
  assert.equal(await evaluate("document.getElementById('capture-start').disabled"), true); assert.equal(await evaluate('window.cameraCalls'), 0); check('Recording cannot open a camera while the display owns the sensor');
  await click('#doppler-pause'); await browser.waitFor(`DopplerView.snapshot.records_received>${frozen}`); check('Display resumes at newly received events');
  await click('#monitor-stop'); await browser.waitFor("!DopplerView.monitorBusy && DopplerView.monitor.state==='stopped'");
  const stopped = app.monitor.count; await new Promise(r => setTimeout(r, 120)); assert.equal(app.monitor.count, stopped); assert.equal(app.monitor.busy, false); check('Stop halts reception and releases the adapter');
  const actual = app.monitor.view({ windowS: 120 }); let checked = 0;
  for (const p of actual.points) {
    const envelope = originals[p.receiver_sequence - 1], payload = envelope.decoded_payload ?? JSON.parse(envelope.message_utf8), row = payload.detections.data[p.row_index], attrs = payload.detections.attributes;
    assert.equal(p.t_s, (envelope.pc_receive_unix_ms - originals[0].pc_receive_unix_ms) / 1000);
    for (const name of ['speed_mps', 'doppler_bin', 'magnitude_dBFS']) { const index = attrs.indexOf(name); assert.equal(p[name], index < 0 ? null : row[index]); checked++; }
  }
  assert.ok(checked > 0); check('Displayed time, speed, Doppler bin and magnitude match the received source rows exactly', { checked_values: checked, records: stopped });
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'), false);
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }); assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'), false); check('Desktop and narrow layouts avoid horizontal overflow');
  assert.equal(browser.events.filter(x => x.method === 'Runtime.exceptionThrown').length, 0); const requests = browser.events.filter(x => x.method === 'Network.requestWillBeSent').map(x => x.params.request.url); assert.deepEqual(requests.filter(x => !x.startsWith(app.origin) && x !== 'about:blank' && !x.startsWith('blob:') && !x.startsWith('data:')), []); check('No browser JavaScript exceptions or external browser requests');
  const report = { passed: true, checks, hardware: !!usbPort, actual_records: stopped, camera_calls: await evaluate('window.cameraCalls'), source_values_verified: true, human_motion_recognition_tested: false, full_spectrum: false, executed_at: new Date().toISOString() };
  fs.writeFileSync(path.join(evidence, usbPort ? 'private-doppler-usb-ui.json' : 'doppler-ui-results.json'), JSON.stringify(report, null, 2));
  if (usbPort) fs.writeFileSync(path.join(evidence, 'private-doppler-usb-events.jsonl'), originals.map(x => JSON.stringify(x)).join('\n') + '\n');
} catch (error) {
  if (!usbPort) await browser.screenshot(path.join(output, 'doppler-ui-failure.png')).catch(() => {});
  fs.writeFileSync(path.join(evidence, usbPort ? 'private-doppler-usb-ui.json' : 'doppler-ui-results.json'), JSON.stringify({ passed: false, checks, error: error.message }, null, 2)); throw error;
} finally { await browser.close(); await app.close(); await peer?.close(); }
