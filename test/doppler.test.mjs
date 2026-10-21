import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { projectFrame, visiblePoints, pointBounds, PointSampler, PLOT_LIMITS } from '../public/plot-model.mjs';
import { savedPreview } from '../src/preview.mjs';
import { DetectionMonitor } from '../src/monitor.mjs';
import { createApp } from '../src/server.mjs';
import { liveEnvelope } from '../src/live.mjs';
import { prepareLive } from '../src/capture-storage.mjs';
import { setup, source, readAll, eventually } from './helpers.mjs';
import { livePeer, syntheticCamera } from './live-fixture.mjs';

const detection = { ts: 0, detections: { attributes: ['doppler_bin', 'magnitude_dBFS', 'speed_mps', 'range_m'], data: [[-7, -42, -.625, 2], [0, -50, 0, 1], [9, -30, .75, 3]] } };
const message = JSON.stringify(detection);
const frame = (time = 1200) => ({ data_kind: 'detections', pc_receive_time: { value: time }, receiver_sequence: 9, attributes: detection.detections.attributes, data: detection.detections.data });

test('plot preserves reordered source fields, negative/zero values and receive-time origin without a spectrum conversion', () => {
  const points = projectFrame(frame(), 1000);
  assert.equal(points.length, 3); assert.deepEqual(points.map(p => [p.t_s, p.speed_mps, p.doppler_bin, p.magnitude_dBFS]), [[.2, -.625, -7, -42], [.2, 0, 0, -50], [.2, .75, 9, -30]]);
  assert.equal(points[0].receiver_sequence, 9); assert.equal(points[2].row_index, 2); assert.equal(points[0].frequency_hz, undefined);
  assert.deepEqual(visiblePoints(points, 'speed_mps', .2, .2), points); assert.equal(visiblePoints(points, 'speed_mps', .3, 1).length, 0);
});
test('plot never invents missing speed, bins or timestamps, or combines malformed rows', () => {
  const f = frame(); f.attributes = ['range_m', 'speed_mps']; f.data = [[2, null], [3, '1'], [4, 0], [5], [6, NaN]];
  const points = projectFrame(f, 1000); assert.equal(points.length, 4); assert.deepEqual(points.map(p => p.speed_mps), [null, null, 0, null]); assert.ok(points.every(p => p.doppler_bin === null));
  assert.equal(visiblePoints(points, 'speed_mps', 0, 1).length, 1);
  assert.deepEqual(projectFrame({ ...f, pc_receive_time: { value: 'unknown' } }, 1000), []); assert.deepEqual(projectFrame(f, 'unknown'), []);
  assert.deepEqual(projectFrame({ ...f, data_kind: 'event' }, 1000), []);
  const [lo, hi] = pointBounds(projectFrame(frame(), 1000), 'speed_mps'); assert.ok(lo < -.625 && hi > .75); assert.equal(-lo, hi);
});
test('bounded plot sampler retains actual first/latest observations and reports every omitted point', () => {
  const sampler = new PointSampler(40), originals = Array.from({ length: 10001 }, (_, index) => ({ t_s: index, speed_mps: index % 3 }));
  originals.forEach(p => sampler.push(p)); const result = sampler.result();
  assert.ok(result.points.length <= 40); assert.equal(result.points[0], originals[0]); assert.equal(result.points.at(-1), originals.at(-1)); assert.ok(result.points.every(p => originals.includes(p)));
  assert.equal(result.display_omitted_points + result.points.length, originals.length);
});
test('saved plot seeks exact source times without changing records, hashes or acquisition state', async t => {
  const store = setup(t), m = source(store, null, { mode: 'demo' }); await readAll(store, m.id);
  const before = fs.readFileSync(store.file(m.id, 'frames.jsonl')), manifest = fs.readFileSync(store.file(m.id, 'manifest.json'));
  const preview = await savedPreview(store, m.id, { startS: 3, endS: 7 });
  assert.equal(preview.points.length, 41); assert.ok(preview.points.every(p => p.t_s >= 3 && p.t_s <= 7)); assert.equal(preview.points[0].t_s, 3); assert.equal(preview.points.at(-1).t_s, 7);
  assert.equal(preview.clock, 'original_pc_decode_time_relative_to_first_timed_event'); assert.equal(preview.full_spectrum, false); assert.equal(preview.device_loss, 'unknown');
  assert.deepEqual(fs.readFileSync(store.file(m.id, 'frames.jsonl')), before); assert.deepEqual(fs.readFileSync(store.file(m.id, 'manifest.json')), manifest); assert.equal(store.verify(m.id).ok, true);
});
test('saved plot reaches beyond the old 5000 record page, yields to reception and bounds tail/point memory', async t => {
  const store = setup(t), m = store.create({ mode: 'live' }), f = frame(1000), lines = [];
  for (let i = 0; i < 6500; i++) lines.push(JSON.stringify({ ...f, receiver_sequence: i + 1, pc_receive_time: { value: 1000 + i * 10 }, padding: 'synthetic'.repeat(40) }));
  fs.writeFileSync(store.file(m.id, 'frames.jsonl'), lines.join('\n') + '\n'); m.count = 6500; m.time_range = { first_pc_ms: 1000, duration_s: 64.99 }; store.save(m);
  let yielded = false; setImmediate(() => { yielded = true; });
  const all = await savedPreview(store, m.id, { endS: 64.99, limit: 20 }); assert.equal(yielded, true); assert.equal(all.points.at(-1).receiver_sequence, 6500); assert.equal(all.matched_points, 19500); assert.ok(all.points.length <= 20);
  const tail = await savedPreview(store, m.id, { startS: 60, endS: 64.99, tail: true }); assert.equal(tail.history_truncated, true); assert.ok(tail.bytes_read <= PLOT_LIMITS.tail_bytes); assert.equal(tail.points.at(-1).receiver_sequence, 6500);
  assert.equal(tail.clock, 'pc_receive_time_relative_to_first_timed_record'); assert.ok(tail.points.every(p => p.t_s >= 60));
});
test('saved plot omits oversized/partial/missing-clock data explicitly; canceled reads stop independently', async t => {
  const store = setup(t), m = store.create(); m.time_range = { first_pc_ms: 1000, duration_s: 1 }; store.save(m);
  fs.writeFileSync(store.file(m.id, 'frames.jsonl'), 'x'.repeat(PLOT_LIMITS.line_bytes + 10) + '\n' + JSON.stringify({ ...frame(), pc_receive_time: { value: 'unknown' } }) + '\n' + JSON.stringify(frame()) + '\n' + '{partial');
  const p = await savedPreview(store, m.id, { endS: 1 }); assert.equal(p.oversized_records, 1); assert.equal(p.untimed_records, 1); assert.equal(p.invalid_records, 1); assert.equal(p.points.length, 3);
  const abort = new AbortController(); abort.abort(); assert.equal((await savedPreview(store, m.id, { endS: 1, signal: abort.signal })).records_read, 0);
  await assert.rejects(savedPreview(store, m.id, { endS: 121 }), { code: 'INVALID_PREVIEW_WINDOW' }); await assert.rejects(savedPreview(store, m.id, { limit: 6001 }), { code: 'INVALID_PREVIEW_WINDOW' });
});
test('memory-only monitor receives real WebSocket frames, pauses only display and releases for a fresh start', async t => {
  const peer = await livePeer({ intervalMs: 5, message }), monitor = new DetectionMonitor({ delayMs: 2, maxPoints: 2 }); t.after(async () => { await monitor.close(); await peer.close(); });
  const input = { transport: 'local_websocket_events', url: peer.url, request_id: 'one' };
  await Promise.all([monitor.start(input), monitor.start(input)]); await eventually(() => monitor.count >= 5);
  const first = monitor.view(); assert.equal(first.recording, false); assert.equal(first.camera, false); assert.equal(first.full_spectrum, false); assert.ok(first.display_evicted_points > 0); assert.equal(first.retained_points, 2); assert.ok(first.fields.includes('speed_mps')); assert.equal(first.points.at(-1).speed_mps, .75);
  assert.equal(monitor.view({ paused: true }).points.length, 0); const count = monitor.count; await eventually(() => monitor.count > count);
  await assert.rejects(monitor.start({ ...input, request_id: 'other' }), { code: 'MONITOR_ALREADY_RUNNING' });
  await monitor.stop(); const stopped = monitor.count; await new Promise(r => setTimeout(r, 30)); assert.equal(monitor.count, stopped); assert.equal(monitor.busy, false); assert.equal(monitor.adapter.socket, null);
  await monitor.start({ ...input, request_id: 'new' }); await eventually(() => monitor.count > 0); assert.equal(monitor.state, 'running');
});
test('monitor heartbeat expiry, source disconnect and invalid messages remain explicit', async t => {
  const peer = await livePeer({ intervalMs: 5, message: 'invalid' }), monitor = new DetectionMonitor({ delayMs: 2, leaseMs: 200 }); t.after(async () => { await monitor.close(); await peer.close(); });
  await monitor.start({ transport: 'local_websocket_events', url: peer.url, request_id: 'lease' }); await eventually(() => monitor.state === 'error');
  assert.equal(monitor.error.code, 'MONITOR_HEARTBEAT_LOST'); assert.ok(monitor.invalid > 0); assert.equal(monitor.view().points.length, 0); assert.equal(monitor.busy, false);
  await monitor.start({ transport: 'local_websocket_events', url: peer.url, request_id: 'drop' }); peer.drop(); await eventually(() => monitor.state === 'error'); assert.equal(monitor.error.code, 'LIVE_DISCONNECTED');
});
test('stop during pending monitor start cannot leave a hidden receiver or release its reservation too early', async () => {
  let release, disconnected = 0;
  const adapter = { configure() {}, async connect() {}, start: () => new Promise(resolve => { release = resolve; }), async disconnect() { disconnected++; } };
  const monitor = new DetectionMonitor({ factory: () => adapter }); const pending = monitor.start({ transport: 'local_websocket_events', request_id: 'cancel' }); await eventually(() => release);
  const stopping = monitor.stop(); assert.equal(monitor.busy, true); release(); await assert.rejects(pending, { code: 'MONITOR_CANCELED' }); await stopping; assert.ok(disconnected); assert.equal(monitor.state, 'stopped'); assert.equal(monitor.busy, false); assert.equal(monitor.timer, undefined); await monitor.close();
});
test('monitor failure holds live reservation until disconnect completes', async () => {
  let release;
  const adapter = { configure() {}, async connect() {}, async start() {}, async read() { throw new Error('synthetic failure'); }, disconnect: () => new Promise(resolve => { release = resolve; }) };
  const monitor = new DetectionMonitor({ factory: () => adapter, delayMs: 1 }); await monitor.start({ transport: 'local_websocket_events', request_id: 'failure' }); await eventually(() => release); assert.equal(monitor.busy, true); release(); await eventually(() => !monitor.busy);
  adapter.disconnect = async () => {}; await monitor.close();
});
test('duplicate monitor stop shares one release and blocks restart until the port is free', async () => {
  let release, disconnects = 0;
  const adapter = { configure() {}, async connect() {}, async start() {}, async read() { return null; }, disconnect: () => { disconnects++; return new Promise(resolve => { release = resolve; }); } };
  const monitor = new DetectionMonitor({ factory: () => adapter }); await monitor.start({ transport: 'local_websocket_events', request_id: 'one' });
  const a = monitor.stop(), b = monitor.stop(); await eventually(() => release); assert.equal(disconnects, 1); assert.equal(monitor.busy, true);
  await assert.rejects(monitor.start({ transport: 'local_websocket_events', request_id: 'two' }), { code: 'MONITOR_STOPPING' }); release(); await Promise.all([a, b]); assert.equal(monitor.busy, false);
  adapter.disconnect = async () => {}; await monitor.close();
});
test('HTTP monitor needs no session or camera; monitor and recording cannot acquire the same source', async t => {
  const store = setup(t), peer = await livePeer({ message }), app = await createApp({ port: 0, root: store.root }); store.beforeCleanup = async () => { await app.close(); await peer.close(); };
  const post = async (url, body, token = app.token) => { const r = await fetch(app.origin + url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-radar-token': token }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
  const input = { transport: 'local_websocket_events', url: peer.url, request_id: 'http' };
  assert.equal((await post('/api/monitor/start', input, 'wrong')).status, 403); assert.equal((await post('/api/monitor/start', { ...input, data_kind: 'adc' })).data.error.code, 'UNSUPPORTED_SETTING');
  assert.equal((await post('/api/monitor/start', { ...input, url: 'ws://example.com' })).status, 400); assert.equal((await post('/api/monitor/start', input)).status, 200); await eventually(() => app.monitor.count >= 2);
  assert.deepEqual(fs.readdirSync(store.root), []); assert.equal((await fetch(app.origin + '/api/monitor?paused=1').then(r => r.json())).points.length, 0);
  const m = store.create({ mode: 'live' }); prepareLive(store, m.id, { url: peer.url, camera: syntheticCamera }); await assert.rejects(app.controller.start(m.id), { code: 'LIVE_ALREADY_RUNNING' });
  assert.equal((await post('/api/monitor/stop', {})).status, 200);
  const next = store.create({ mode: 'live' }); prepareLive(store, next.id, { url: peer.url, camera: syntheticCamera }); await app.controller.start(next.id);
  assert.equal((await post('/api/monitor/start', { ...input, request_id: 'blocked' })).data.error.code, 'LIVE_SOURCE_BUSY'); await app.controller.stop(next.id);
  const module = await fetch(app.origin + '/plot-model.mjs'); assert.match(module.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(app.origin + '/api/monitor?window_s=121')).status, 400);
});
