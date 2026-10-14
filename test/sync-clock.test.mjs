import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fitSync, mapVideoTime, radarClockForMode } from '../src/sync.mjs';
import { liveEnvelope } from '../src/live.mjs';
import { prepareLive, appendLive, sealLive, saveVideoChunk, finishCamera } from '../src/capture-storage.mjs';
import { createApp } from '../src/server.mjs';
import { setup, source, readAll, video, anchors } from './helpers.mjs';
import { syntheticCamera } from './live-fixture.mjs';

const numericalSync = sync => ({ anchors: sync.anchors, offset_s: sync.offset_s, scale: sync.scale, drift_ppm: sync.drift_ppm, equation: sync.equation, reviewed_at: sync.reviewed_at });
async function sessionFor(store, mode) {
  const events = Array.from({ length: 5 }, (_, i) => ({ ts: `00:00:${String(10 - i * 2).padStart(2, '0')}.000`, detections: { attributes: ['range_m'], data: [[1 + i / 10]] } }));
  let m;
  if (mode === 'live') {
    m = store.create({ mode }); prepareLive(store, m.id, { url: 'ws://127.0.0.1:8767', camera: syntheticCamera });
    for (const [i, event] of events.entries()) appendLive(store, m.id, liveEnvelope(JSON.stringify(event), { now: 1700000000000 + i * 1000, monotonicNs: String(1000000000 + i * 1000000000) }));
    sealLive(store, m.id); store.transition(m.id, 'stopped');
    const staged = store.file(m.id, 'upload-synthetic-video.tmp'); fs.copyFileSync(new URL('../fixtures/demo.webm', import.meta.url), staged);
    saveVideoChunk(store, m.id, staged, 0, 4010); finishCamera(store, m.id, { expected_chunks: 1, stopped_monotonic_ms: 4010, stopped_unix_ms: syntheticCamera.started_unix_ms + 4000 });
  } else {
    // The imported decode-clock axis has the same relative spacing as live.
    const imported = events.map((event, i) => JSON.stringify({ ...event, ts: `00:00:${String(i + 1).padStart(2, '0')}.000` })).join('\n') + '\n';
    m = source(store, imported, { mode }); await readAll(store, m.id); video(store, m.id, 4);
  }
  store.setSync(m.id, anchors(4));
  store.addLabel(m.id, { label: '合成区間', start_video_s: 1, end_video_s: 3 });
  store.reviewLabel(m.id, store.get(m.id).labels[0].id, { action: 'confirm', expected_revision: 1 });
  return store.get(m.id);
}
function writeLegacySync(store, id) {
  const m = store.get(id), original = structuredClone(m.sync);
  m.sync.radar_clock = 'original_pc_decode_time_relative_to_first_timed_event';
  m.sync_history = [{ ...structuredClone(m.sync), reviewed_at: '2020-01-01T00:00:00.000Z' }];
  fs.writeFileSync(store.file(id, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  return { current: numericalSync(original), history: numericalSync(m.sync_history[0]) };
}

test('clock identity follows mode while offset, drift, uncertainty and extrapolation calculations are identical', () => {
  const points = [{ radar_s: 1, video_s: 0, radar_uncertainty_s: .1, video_uncertainty_s: .2, note: 'start' }, { radar_s: 11.2, video_s: 10, radar_uncertainty_s: .3, video_uncertainty_s: .1, note: 'end' }];
  const imported = fitSync(points, 13, 12), live = fitSync(points, 13, 12, { mode: 'live' });
  assert.equal(imported.radar_clock, 'original_pc_decode_time_relative_to_first_timed_event'); assert.equal(live.radar_clock, 'pc_receive_time_relative_to_first_timed_record');
  for (const key of ['anchors', 'offset_s', 'scale', 'drift_ppm', 'equation']) assert.deepEqual(live[key], imported[key]);
  assert.equal(live.offset_s, 1); assert.ok(Math.abs(live.scale - 1.02) < 1e-15); assert.ok(Math.abs(live.drift_ppm - 20000) < 1e-8);
  for (const position of [0, 5, 10, 11]) assert.deepEqual(mapVideoTime(live, position), mapVideoTime(imported, position));
  assert.ok(Math.abs(mapVideoTime(live, 5).radar_s - 6.1) < 1e-8); assert.ok(Math.abs(mapVideoTime(live, 0).uncertainty_s - .304) < 1e-8);
  assert.equal(live.physical_sync_accuracy_verified, false);
});
test('import/demo/live dataset clocks and warnings match the actual axis without changing selected intervals', async t => {
  const store = setup(t), results = [];
  for (const mode of ['import', 'demo', 'live']) {
    const m = await sessionFor(store, mode), dataset = store.dataset(m.id); results.push(dataset);
    assert.equal(m.sync.radar_clock, radarClockForMode(mode)); assert.equal(dataset.sync.radar_clock, radarClockForMode(mode));
    assert.match(dataset.warnings[0], mode === 'live' ? /PC受信時刻/ : /PC解読時刻/);
    assert.deepEqual(dataset.intervals[0].receiver_sequences, [2, 3]); assert.equal(dataset.intervals[0].start_radar_s, 1); assert.equal(dataset.intervals[0].end_radar_s, 3); assert.equal(dataset.integrity.ok, true);
    if (mode === 'live') { const frames = store.frames(m.id); assert.equal(frames[0].source_pc_decode_time.value, 10000); assert.equal(frames[0].pc_receive_time.value, 1700000000000); assert.equal(m.time_range.backwards_count, 0); }
  }
  for (const dataset of results.slice(1)) for (const key of ['start_radar_s', 'end_radar_s', 'start_uncertainty_s', 'end_uncertainty_s', 'receiver_sequences']) assert.deepEqual(dataset.intervals[0][key], results[0].intervals[0][key]);
});
test('legacy live sync and history are corrected on read/export while source, config and numerical values remain unchanged', async t => {
  const store = setup(t), m = await sessionFor(store, 'live'), expected = writeLegacySync(store, m.id);
  const file = store.file(m.id, 'manifest.json'), oldManifest = fs.readFileSync(file);
  const originals = Object.fromEntries(['raw.events.jsonl', 'frames.jsonl', 'session-config.json'].map(name => [name, fs.readFileSync(store.file(m.id, name))]));
  const corrected = store.get(m.id);
  assert.deepEqual(fs.readFileSync(file), oldManifest, 'reading only reconciles an in-memory copy');
  assert.equal(corrected.sync.radar_clock, radarClockForMode('live')); assert.equal(corrected.sync_history[0].radar_clock, radarClockForMode('live'));
  assert.equal(corrected.sync.radar_clock_metadata_correction.previous_radar_clock, 'original_pc_decode_time_relative_to_first_timed_event'); assert.equal(corrected.sync.radar_clock_metadata_correction.scope, 'metadata_only_no_refit');
  assert.deepEqual(numericalSync(corrected.sync), expected.current); assert.deepEqual(numericalSync(corrected.sync_history[0]), expected.history);
  store.exportFiles(m.id);
  const archived = JSON.parse(fs.readFileSync(file, 'utf8')), training = JSON.parse(fs.readFileSync(store.file(m.id, 'training.json'), 'utf8'));
  assert.equal(archived.sync.radar_clock, training.sync.radar_clock); assert.deepEqual(numericalSync(archived.sync), expected.current); assert.deepEqual(numericalSync(archived.sync_history[0]), expected.history); assert.deepEqual(training.intervals[0].receiver_sequences, [2, 3]);
  for (const [name, bytes] of Object.entries(originals)) assert.deepEqual(fs.readFileSync(store.file(m.id, name)), bytes, name);
  assert.deepEqual(store.get(m.id).sync.radar_clock_metadata_correction, corrected.sync.radar_clock_metadata_correction); assert.equal(store.verify(m.id).ok, true);
});
test('already correct imported clocks are preserved and missing legacy clock metadata is repaired without refitting', async t => {
  const store = setup(t), imported = await sessionFor(store, 'import'); assert.equal(imported.sync.radar_clock_metadata_correction, undefined);
  const live = await sessionFor(store, 'live'), original = numericalSync(live.sync); delete live.sync.radar_clock;
  fs.writeFileSync(store.file(live.id, 'manifest.json'), JSON.stringify(live) + '\n');
  const corrected = store.get(live.id); assert.equal(corrected.sync.radar_clock, radarClockForMode('live')); assert.equal(corrected.sync.radar_clock_metadata_correction.previous_radar_clock, 'unknown'); assert.deepEqual(numericalSync(corrected.sync), original);
});
test('live clock origin is the first timed record even when a metadata header precedes detections', t => {
  const store = setup(t), m = store.create({ mode: 'live' }); prepareLive(store, m.id, { url: 'ws://127.0.0.1:8767', camera: syntheticCamera });
  appendLive(store, m.id, liveEnvelope('{"ts":0,"types":{"detections":{}}}', { now: 1700000000000, monotonicNs: '1000' }));
  appendLive(store, m.id, liveEnvelope('{"ts":0,"detections":{"attributes":["range_m"],"data":[[1]]}}', { now: 1700000001000, monotonicNs: '1000001000' }));
  sealLive(store, m.id); store.transition(m.id, 'stopped'); video(store, m.id, 1); store.setSync(m.id, anchors(1));
  const saved = store.get(m.id); assert.equal(saved.time_range.first_pc_ms, 1700000000000); assert.equal(saved.time_range.duration_s, 1); assert.equal(saved.sync.radar_clock, 'pc_receive_time_relative_to_first_timed_record'); assert.equal(saved.sync.offset_s, 0); assert.equal(saved.sync.scale, 1);
});
test('application startup and HTTP sync/export keep existing live clock metadata consistent without device access', async t => {
  const store = setup(t), m = await sessionFor(store, 'live'), original = writeLegacySync(store, m.id);
  const app = await createApp({ root: store.root, port: 0, liveFactory: () => { throw new Error('No live connection is allowed in this regression'); } }); store.beforeCleanup = () => app.close();
  const saved = JSON.parse(fs.readFileSync(store.file(m.id, 'manifest.json'), 'utf8')); assert.equal(saved.sync.radar_clock, radarClockForMode('live')); assert.deepEqual(numericalSync(saved.sync), original.current); assert.deepEqual(numericalSync(saved.sync_history[0]), original.history);
  let response = await fetch(app.origin + `/api/sessions/${m.id}`); assert.equal((await response.json()).sync.radar_clock, radarClockForMode('live'));
  response = await fetch(app.origin + `/api/sessions/${m.id}/sync`, { method: 'POST', headers: { 'x-radar-token': app.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ anchors: anchors(4) }) }); assert.equal(response.status, 200); assert.equal((await response.json()).sync.radar_clock, radarClockForMode('live'));
  response = await fetch(app.origin + `/api/sessions/${m.id}/export?format=json`); const dataset = await response.json(); assert.equal(dataset.sync.radar_clock, radarClockForMode('live')); assert.match(dataset.warnings[0], /PC受信時刻/); assert.deepEqual(dataset.intervals[0].receiver_sequences, [2, 3]);
});
