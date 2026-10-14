// Explicit, optional hardware check. Not executed by npm test or CI.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';
import { prepareLive } from '../src/capture-storage.mjs';
const port = process.env.RADAR_USB_TEST_PORT;
if (!port) throw new Error('Set RADAR_USB_TEST_PORT explicitly only after authorizing a five-second detection-only hardware check.');
const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = await createApp({ port: 0, root: path.join(project, 'data', 'usb-smoke'), delayMs: 10, leaseMs: 10000 });
try {
  const m = app.store.create({ mode: 'live', title: 'USB detection-only integration check' });
  prepareLive(app.store, m.id, { transport: 'csk_uart_installed_vendor_api', port, camera: { mime_type: 'video/webm', started_unix_ms: Date.now(), started_monotonic_ms: performance.now(), time_origin_ms: performance.timeOrigin, source: 'not_connected_usb_only_check' } });
  await app.controller.start(m.id);
  const end = performance.now() + 5000;
  while (performance.now() < end && app.store.get(m.id).state === 'running') { app.controller.heartbeat(m.id); await new Promise(r => setTimeout(r, 100)); }
  await app.controller.stop(m.id);
  const manifest = app.store.get(m.id), frames = app.store.frames(m.id), report = app.store.verify(m.id), config = JSON.parse(fs.readFileSync(app.store.file(m.id, 'session-config.json'), 'utf8'));
  assert.ok(manifest.count > 0); assert.ok(frames.some(f => f.data_kind === 'detections')); assert.equal(report.ok, true);
  assert.equal(config.device_query.firmware.state, 'OK'); assert.equal(config.device_query.sensor_configuration.state, 'OK');
  const summary = { passed: true, duration_budget_s: 5, session_id: m.id, captured_records: manifest.count, detection_records: frames.filter(f => f.data_kind === 'detections').length, shapes: [...new Set(frames.map(f => JSON.stringify(f.shape)))], device: config.device, configuration_response: 'OK; actual register list kept locally only', count_order_raw_settings_time_readback: report.ok, device_loss: 'unknown', real_camera: false, firmware_writes: false, sensor_configuration_writes: false, model_training: false, physical_sync_accuracy_verified: false };
  fs.mkdirSync(path.join(project, 'evidence'), { recursive: true }); fs.writeFileSync(path.join(project, 'evidence', 'private-usb-smoke.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary));
} finally { await app.close(); }
