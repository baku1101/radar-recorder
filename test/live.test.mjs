import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { liveEnvelope, normalizeLiveEnvelope, localWebSocketUrl, WebSocketDetectionAdapter, CskDetectionAdapter } from '../src/live.mjs';
import { prepareLive, appendLive, recoverLive, sealLive, saveVideoChunk, finishCamera } from '../src/capture-storage.mjs';
import { SessionController } from '../src/controller.mjs';
import { createApp } from '../src/server.mjs';
import { setup, eventually } from './helpers.mjs';
import { livePeer, syntheticCamera } from './live-fixture.mjs';

const event = JSON.stringify({ ts: 0, detections: { attributes: ['range_m', 'sequence_num'], data: [[2, 17]] } });
function prepared(store, url = 'ws://127.0.0.1:8767') { const m = store.create({ mode: 'live' }); return prepareLive(store, m.id, { url, camera: syntheticCamera }); }
function chunk(store, id, value, index = 0, end = 20) { const staged = store.file(id, `upload-chunk-${index}.tmp`); fs.writeFileSync(staged, value); try { return saveVideoChunk(store, id, staged, index, end); } finally { if (fs.existsSync(staged)) fs.unlinkSync(staged); } }
const finish = { expected_chunks: 1, stopped_monotonic_ms: 1010, stopped_unix_ms: 1700000001000 };

test('live message preserves source ts, original text, shape and distinct PC clocks; device loss stays unknown', () => {
  const envelope = liveEnvelope(event, { now: 1700000000001, monotonicNs: '1234567' }), line = JSON.stringify(envelope), f = normalizeLiveEnvelope(line, 1);
  assert.equal(f.raw.ts, 0); assert.deepEqual(f.shape, [1, 2]); assert.equal(f.pc_receive_time.value, 1700000000001); assert.equal(f.source_pc_decode_time.value, 'unknown'); assert.equal(f.device_time.value, 'unknown'); assert.equal(f.missing.device_packets, 'unknown'); assert.deepEqual(f.target_sequence_nums, [17]); assert.equal(f.errors.length, 0); assert.equal(JSON.parse(line).message_utf8, event);
});
test('live endpoints are loopback only and unsupported ADC or sensor settings are explicit errors', () => {
  for (const url of ['https://127.0.0.1:1', 'ws://example.com:1', 'ws://user:password@localhost:1', 'ws://127.0.0.1.example.com:1']) assert.throws(() => localWebSocketUrl(url));
  assert.ok(localWebSocketUrl('ws://localhost:8767'));
  const adapter = new WebSocketDetectionAdapter('ws://127.0.0.1:1'); assert.throws(() => adapter.configure({ data_kind: 'adc' }), { code: 'UNSUPPORTED_SETTING' }); assert.throws(() => adapter.configure({ gain: 1 }), { code: 'UNSUPPORTED_SETTING' });
  assert.throws(() => new CskDetectionAdapter('COM10 & anything'), { code: 'INVALID_COM_PORT' });
});
test('actual RFC6455 peer delivers text through the production WebSocket adapter', async t => {
  const peer = await livePeer(), adapter = new WebSocketDetectionAdapter(peer.url); t.after(async () => { await adapter.disconnect(); await peer.close(); });
  adapter.configure({ data_kind: 'detections' }); await adapter.connect(); await adapter.start(); await eventually(() => adapter.queue.length > 0);
  const e = await adapter.read(); assert.equal(JSON.parse(e.message_utf8).ts, 0); assert.equal(e.transport, 'local_websocket_text');
});
test('live raw envelopes and normalized frames reconcile after frame write failure without duplicating data', t => {
  let fail = false; const store = setup(t, { beforeWrite: file => { if (fail && file === 'frames.jsonl') { fail = false; throw new Error('synthetic disk failure'); } } }), m = prepared(store);
  fail = true; assert.throws(() => appendLive(store, m.id, liveEnvelope(event))); assert.equal(store.frames(m.id).length, 0);
  const recovered = recoverLive(store, m.id); assert.equal(recovered.count, 1); assert.equal(recovered.state, 'interrupted'); assert.equal(store.verify(m.id).ok, true);
  recoverLive(store, m.id); assert.equal(store.get(m.id).count, 1);
});
test('live recovery accepts durable frame beyond manifest and detects source corruption or partial lines', t => {
  let writes = 0, enabled = false; const store = setup(t, { beforeWrite: file => { if (enabled && file === 'manifest.json' && ++writes === 2) { enabled = false; throw new Error('synthetic checkpoint failure'); } } }), m = prepared(store);
  enabled = true; assert.throws(() => appendLive(store, m.id, liveEnvelope(event))); assert.equal(store.frames(m.id).length, 1); assert.equal(recoverLive(store, m.id).count, 1);
  const file = store.file(m.id, 'raw.events.jsonl'), raw = fs.readFileSync(file, 'utf8'); fs.writeFileSync(file, raw.trimEnd()); assert.throws(() => recoverLive(store, m.id), { code: 'PARTIAL_LIVE_SOURCE' });
  fs.writeFileSync(file, raw.replace('"message_utf8"', '"changed"')); assert.throws(() => recoverLive(store, m.id), { code: 'CORRUPT_LIVE_SOURCE' });
});
test('video chunk order, duplicate retries and conflicts are checked before finalization', t => {
  const store = setup(t), m = prepared(store); appendLive(store, m.id, liveEnvelope(event)); sealLive(store, m.id); store.transition(m.id, 'stopped');
  chunk(store, m.id, Buffer.from('synthetic bytes')); chunk(store, m.id, Buffer.from('synthetic bytes')); assert.equal(store.get(m.id).capture.chunk_count, 1);
  assert.throws(() => chunk(store, m.id, Buffer.from('changed')), { code: 'CHUNK_CONFLICT' });
  assert.throws(() => chunk(store, m.id, Buffer.from('gap'), 2), { code: 'CHUNK_ORDER' });
  assert.throws(() => finishCamera(store, m.id, { ...finish, expected_chunks: 2 }), { code: 'INCOMPLETE_VIDEO' });
  assert.equal(finishCamera(store, m.id, finish).state, 'completed'); assert.equal(finishCamera(store, m.id, finish).capture.chunk_count, 1); assert.equal(store.verify(m.id).ok, true);
});
test('video chunk tampering prevents assembly and readback success', t => {
  const store = setup(t), m = prepared(store); appendLive(store, m.id, liveEnvelope(event)); sealLive(store, m.id); store.transition(m.id, 'stopped'); chunk(store, m.id, Buffer.from('original'));
  fs.appendFileSync(store.file(m.id, 'camera-chunk-000000.webm'), 'changed'); assert.equal(store.verify(m.id).ok, false); assert.throws(() => finishCamera(store, m.id, finish), { code: 'VIDEO_CHUNK_HASH_MISMATCH' });
});
test('malformed live messages remain in raw data and cannot make an empty detection run successful', t => {
  const store = setup(t), m = prepared(store); appendLive(store, m.id, liveEnvelope('not JSON')); sealLive(store, m.id); store.transition(m.id, 'stopped'); chunk(store, m.id, Buffer.from('synthetic video'));
  assert.equal(store.frames(m.id)[0].data_kind, 'invalid'); assert.equal(finishCamera(store, m.id, finish).state, 'error'); assert.equal(store.get(m.id).last_error.code, 'NO_VALID_DETECTIONS');
});
async function controllerFor(t, peerOptions = {}, controllerOptions = {}) {
  const peer = await livePeer(peerOptions), store = setup(t), m = prepared(store, peer.url), controller = new SessionController(store, { delayMs: 1, ...controllerOptions });
  store.beforeCleanup = async () => { await controller.close(); await peer.close(); }; return { peer, store, id: m.id, controller };
}
test('duplicate live start and stop are idempotent; a resumed capture must use a new session', async t => {
  const { store, id, controller } = await controllerFor(t); await Promise.all([controller.start(id), controller.start(id)]); await eventually(() => store.get(id).count >= 3);
  await Promise.all([controller.stop(id), controller.stop(id)]); const count = store.get(id).count; await new Promise(r => setTimeout(r, 60)); assert.equal(store.get(id).count, count); assert.equal(store.verify(id).ok, true);
  await assert.rejects(controller.start(id), { code: 'NEW_LIVE_SESSION_REQUIRED' }); const next = store.create({ mode: 'live' }); prepareLive(store, next.id, { url: 'ws://127.0.0.1:8767', camera: syntheticCamera, resumed_from: id }); assert.equal(store.get(next.id).capture.resumed_from, id); assert.equal(store.get(id).count, count);
});
test('live source disconnect stops capture and records an explicit gap', async t => {
  const { peer, store, id, controller } = await controllerFor(t); await controller.start(id); await eventually(() => store.get(id).count > 0); peer.drop(); await eventually(() => store.get(id).state === 'error');
  assert.equal(store.get(id).last_error.code, 'LIVE_DISCONNECTED'); assert.equal(store.get(id).capture.gaps.length, 1); assert.equal(store.get(id).device_loss, 'unknown');
});
test('camera heartbeat loss stops the live source rather than continuing hidden recording', async t => {
  const { store, id, controller } = await controllerFor(t, {}, { leaseMs: 90 }); await controller.start(id); await eventually(() => store.get(id).state === 'error'); assert.equal(store.get(id).last_error.code, 'CAMERA_HEARTBEAT_LOST');
});
test('live idle timeout and binary output are explicit failures', async t => {
  const { store, id, controller } = await controllerFor(t, { intervalMs: 0 }, { liveFactory: c => new WebSocketDetectionAdapter(c.url, { idleMs: 50 }) }); await controller.start(id); await eventually(() => store.get(id).state === 'error'); assert.equal(store.get(id).last_error.code, 'LIVE_IDLE_TIMEOUT');
  const peer = await livePeer({ intervalMs: 0 }), adapter = new WebSocketDetectionAdapter(peer.url); t.after(async () => { await adapter.disconnect(); await peer.close(); }); await adapter.connect(); await adapter.start(); peer.send('bytes', 2); await eventually(() => adapter.failure); await assert.rejects(adapter.read(), { code: 'UNSUPPORTED_LIVE_PAYLOAD' });
});
test('bounded live queue overflow reports application loss instead of device zero-loss', async t => {
  const peer = await livePeer({ intervalMs: 1 }), adapter = new WebSocketDetectionAdapter(peer.url, { maxQueue: 1 }); t.after(async () => { await adapter.disconnect(); await peer.close(); }); await adapter.connect(); await adapter.start(); await eventually(() => adapter.failure); await assert.rejects(adapter.read(), { code: 'LIVE_QUEUE_OVERFLOW' });
});
test('different sessions cannot acquire a live source concurrently', async t => {
  const { store, id, controller, peer } = await controllerFor(t), next = prepared(store, peer.url);
  const starts = await Promise.allSettled([controller.start(id), controller.start(next.id)]); assert.equal(starts.filter(x => x.status === 'fulfilled').length, 1); assert.equal(starts.find(x => x.status === 'rejected').reason.code, 'LIVE_ALREADY_RUNNING');
});
test('HTTP capture saves and joins original synthetic WebM chunks with idempotent operations', async t => {
  const peer = await livePeer(), store = setup(t), app = await createApp({ port: 0, root: store.root, delayMs: 1 }); store.beforeCleanup = async () => { await app.close(); await peer.close(); };
  const post = async (url, body) => { const r = await fetch(app.origin + url, { method: 'POST', headers: { 'x-radar-token': app.token, 'Content-Type': 'application/json' }, body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
  const { data: m } = await post('/api/sessions', { mode: 'live' }), base = `/api/sessions/${m.id}`, start = { url: peer.url, camera: syntheticCamera, request_id: 'synthetic-start' };
  assert.equal((await post(base + '/capture-start', start)).status, 200); assert.equal((await post(base + '/capture-start', start)).status, 200); await eventually(() => app.store.get(m.id).count >= 3);
  const bytes = fs.readFileSync(new URL('../fixtures/demo.webm', import.meta.url)), half = Math.floor(bytes.length / 2);
  assert.equal((await post(base + '/camera-chunk?index=0&end_ms=20', bytes.subarray(0, half))).status, 200);
  assert.equal((await post(base + '/camera-chunk?index=0&end_ms=20', bytes.subarray(0, half))).status, 200);
  assert.equal((await post(base + '/camera-chunk?index=1&end_ms=900', bytes.subarray(half))).status, 200);
  const result = await post(base + '/capture-finish', { ...finish, expected_chunks: 2 }); assert.equal(result.data.state, 'completed'); assert.deepEqual(fs.readFileSync(app.store.file(m.id, 'video-live.webm')), bytes); assert.equal(app.store.verify(m.id).ok, true);
  assert.equal((await post(base + '/capture-finish', { ...finish, expected_chunks: 2 })).status, 200); assert.equal((await post(base + '/start', {})).data.state, 'completed');
  const config = JSON.parse(fs.readFileSync(app.store.file(m.id, 'session-config.json'), 'utf8')); assert.equal(config.device_applied, 'unknown'); assert.equal(config.camera.audio, false);
});
test('HTTP capture forbids ADC, external URLs and unkeyed duplicate changes', async t => {
  const store = setup(t), app = await createApp({ port: 0, root: store.root }); store.beforeCleanup = () => app.close();
  const post = async (url, body) => { const r = await fetch(app.origin + url, { method: 'POST', headers: { 'x-radar-token': app.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
  let m = (await post('/api/sessions', { mode: 'live' })).data;
  assert.equal((await post(`/api/sessions/${m.id}/capture-start`, { url: 'ws://example.com', camera: syntheticCamera, request_id: 'a' })).status, 400);
  assert.equal((await post(`/api/sessions/${m.id}/capture-start`, { url: 'ws://127.0.0.1:1', data_kind: 'adc', camera: syntheticCamera, request_id: 'a' })).data.error.code, 'UNSUPPORTED_SETTING');
});
test('shutdown during live connection disconnects the adapter and never starts hidden recording', async t => {
  const store = setup(t), m = prepared(store); let release, disconnected = 0, started = 0;
  const adapter = { configure() {}, connect: () => new Promise(r => { release = r; }), async start() { started++; }, async disconnect() { disconnected++; } };
  const controller = new SessionController(store, { liveFactory: () => adapter });
  const pending = controller.start(m.id); await eventually(() => release); const closing = controller.close(); release();
  await assert.rejects(pending, { code: 'SHUTTING_DOWN' }); await closing; assert.equal(started, 0); assert.ok(disconnected); assert.equal(controller.runtime.size, 0);
});
test('a configuration checkpoint failure closes the live adapter before a new capture can proceed', async t => {
  let fail = false, disconnected = 0; const store = setup(t, { beforeWrite: file => { if (fail && file === 'session-config.json') { fail = false; throw new Error('synthetic configuration save failure'); } } }), m = prepared(store);
  const adapter = { metadata: { firmware: { payload: {} } }, configure() {}, async connect() {}, async start() {}, async disconnect() { disconnected++; } };
  const controller = new SessionController(store, { liveFactory: () => adapter }); fail = true; await assert.rejects(controller.start(m.id)); assert.ok(disconnected); assert.equal(controller.runtime.size, 0); assert.equal(store.get(m.id).state, 'error'); await controller.close();
});
