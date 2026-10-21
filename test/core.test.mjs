import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseBundledTimestamp, normalizeRecord, JsonlFileAdapter, UnavailableHardwareAdapter, VideoLabelAdapter, sha256 } from '../src/adapters.mjs';
import { SessionController } from '../src/controller.mjs';
import { fitSync, mapVideoTime } from '../src/sync.mjs';
import { setup, source, readAll, video, anchors, eventually } from './helpers.mjs';

test('bundled H+:MM:SS.mmm parsing preserves unbounded epoch hours; numeric ts remains unknown', () => {
  assert.equal(parseBundledTimestamp('500000:12:34.567'), 1800000754567);
  assert.equal(parseBundledTimestamp('00:00:01.000'), 1000);
  for (const x of [0, 1770000000000, '500000:99:00.000', '00:00:00', null, '9999999999999999:00:00.000']) assert.equal(parseBundledTimestamp(x), 'unknown');
});
test('optional types header / shape / source packet loss / target sequence are separate', () => {
  assert.equal(normalizeRecord('{"ts":"0","types":{"detections":{}}}', 1, 1).data_kind, 'metadata');
  const raw = '{"ts":"500000:00:00.000","detections":{"attributes":["range_m","sequence_num"],"data":[[2,8]]},"frames_dropped":3}';
  const f = normalizeRecord(raw, 2, 2); assert.deepEqual(f.shape, [1, 2]); assert.deepEqual(f.target_sequence_nums, [8]); assert.equal(f.source_packet_sequence, 'unknown'); assert.equal(f.missing.device_packets, 'unknown'); assert.equal(f.missing.reported_frames_dropped, 3);
  assert.equal(f.device_time.value, 'unknown'); assert.equal(f.pc_receive_time.value, 1800000000000); assert.equal(f.raw_line_sha256, sha256(raw));
});
test('invalid JSON / detection shape / unknown events are saved with explicit errors', () => {
  assert.equal(normalizeRecord('not JSON', 1, 1).data_kind, 'invalid');
  assert.equal(normalizeRecord('{"ts":"500000:00:00.000","detections":{"attributes":["x"],"data":[[1,2]]}}', 2, 2).data_kind, 'invalid');
  assert.equal(normalizeRecord('{"warning":"example"}', 3, 3).pc_receive_time.value, 'unknown');
  const f = normalizeRecord('{"ts":0,"device_time":{"value":12,"basis":"sensor_ticks","unit":"ticks"}}', 4, 4); assert.equal(f.device_time.value, 12); assert.equal(f.pc_receive_time.value, 'unknown');
});
test('common adapter connect / capabilities / configure / start / read / stop / disconnect', async t => {
  const store = setup(t), m = source(store), a = new JsonlFileAdapter(store.file(m.id, 'raw.events.jsonl'));
  assert.equal(a.capabilities().live_capture, false); assert.equal(a.capabilities().adc, false);
  await assert.rejects(a.start(), { code: 'NOT_CONNECTED' }); await a.connect();
  assert.throws(() => a.configure({ data_kind: 'adc' }), { code: 'UNSUPPORTED_SETTING' });
  assert.throws(() => a.configure({ frame_interval_s: .1 }), { code: 'UNSUPPORTED_SETTING' });
  assert.equal(a.configure({ data_kind: 'detections' }).device_applied, 'unknown');
  await a.start(); assert.equal((await a.read()).receiver_sequence, 1); await a.stop();
  await assert.rejects(a.read(), { code: 'NOT_RUNNING' }); await a.start(); assert.equal((await a.read()).receiver_sequence, 2); await a.disconnect();
});
test('hardware and automatic model APIs reject unsupported work without side effects', async () => {
  for (const transport of ['uart', 'udp', 'sdk', 'camera', 'fpga']) await assert.rejects(new UnavailableHardwareAdapter(transport).connect(), { code: 'HARDWARE_UNAVAILABLE' });
  const model = new VideoLabelAdapter(); assert.equal(model.capabilities().external_api, false); await assert.rejects(model.propose(), { code: 'AUTO_LABEL_UNAVAILABLE' });
});
test('exact bytes including BOM/CRLF/blanks, record order, count, settings and time range read back', async t => {
  const store = setup(t), original = fs.readFileSync(new URL('../fixtures/demo.events.jsonl', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const text = '\uFEFF' + original.replaceAll('\n', '\r\n\r\n'), m = source(store, text); await readAll(store, m.id);
  assert.equal(fs.readFileSync(store.file(m.id, 'raw.events.jsonl'), 'utf8'), text);
  const r = store.verify(m.id); assert.equal(r.ok, true, JSON.stringify(r.failures)); assert.equal(r.count, 122); assert.equal(r.time_range.duration_s, 12); assert.equal(r.settings_verified, true); assert.equal(r.device_loss, 'unknown');
  const frames = store.frames(m.id); assert.equal(frames[0].data_kind, 'metadata'); assert.equal(frames[1].source_line, 3); assert.equal(frames.at(-1).receiver_sequence, 122);
});
test('raw source corruption and settings edits block readback and resume', async t => {
  const store = setup(t), m = source(store); await readAll(store, m.id);
  fs.appendFileSync(store.file(m.id, 'session-config.json'), ' ');
  assert.ok(store.verify(m.id).failures.includes('CONFIG_HASH_MISMATCH'));
  assert.throws(() => store.recover(m.id), { code: 'READBACK_FAILED' });
  fs.appendFileSync(store.file(m.id, 'raw.events.jsonl'), '{}\n'); assert.ok(store.verify(m.id).failures.includes('SOURCE_HASH_MISMATCH'));
});
test('truncated frame and changed frame contents never become successful completion', async t => {
  const store = setup(t), m = source(store); await readAll(store, m.id);
  const file = store.file(m.id, 'frames.jsonl'), original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.trimEnd()); assert.deepEqual(store.verify(m.id).failures, ['PARTIAL_FRAME']);
  fs.writeFileSync(file, original.replace('"receiver_sequence":1,', '"receiver_sequence":9,'));
  assert.ok(store.verify(m.id).failures.includes('FRAME_HASH_1')); assert.ok(store.verify(m.id).failures.includes('ORDER_1'));
});
test('stop, resume and duplicate clicks retain each record exactly once', async t => {
  const store = setup(t), m = source(store), controller = new SessionController(store, { delayMs: 2 }); t.after(() => controller.close());
  await Promise.all([controller.start(m.id), controller.start(m.id)]); await eventually(() => store.get(m.id).count >= 8);
  await Promise.all([controller.stop(m.id), controller.stop(m.id)]); const checkpoint = store.get(m.id).count;
  await new Promise(r => setTimeout(r, 30)); assert.equal(store.get(m.id).count, checkpoint); assert.equal(store.get(m.id).state, 'stopped');
  await controller.start(m.id); await eventually(() => store.get(m.id).state === 'completed');
  assert.equal(store.get(m.id).count, 122); assert.equal(store.verify(m.id).ok, true);
  await controller.start(m.id); assert.equal(store.get(m.id).count, 122);
});
test('shutdown/interruption and a new controller resume from durable source cursor', async t => {
  const store = setup(t), m = source(store), first = new SessionController(store, { delayMs: 2 });
  await first.start(m.id); await eventually(() => store.get(m.id).count >= 5); await first.close();
  assert.equal(store.get(m.id).state, 'interrupted'); const count = store.get(m.id).count;
  const second = new SessionController(store, { delayMs: 1 }); t.after(() => second.close()); assert.deepEqual(second.initialize(), []);
  await second.start(m.id); await eventually(() => store.get(m.id).state === 'completed'); assert.ok(count < 122); assert.equal(store.get(m.id).count, 122); assert.equal(store.verify(m.id).ok, true);
});
test('frame save failure is visible and resuming uses source rather than losing the consumed row', async t => {
  let fail = false;
  const store = setup(t, { beforeWrite: name => { if (fail && name === 'frames.jsonl') throw new Error('simulated disk full'); } }), m = source(store), c = new SessionController(store, { delayMs: 1 }); t.after(() => c.close());
  // This test checks durable recovery, not scheduler speed on a hosted Windows disk.
  // Other tests cover timer-driven start/stop; drive the same production pump explicitly here.
  c.schedule = () => {};
  fail = true; await c.start(m.id); await assert.rejects(c.pump(m.id), /simulated disk full/); assert.equal(store.get(m.id).state, 'error');
  assert.equal(store.get(m.id).count, 0); assert.match(store.get(m.id).last_error.message, /disk full/);
  fail = false; await c.start(m.id);
  for (let remaining = 123; remaining > 0 && store.get(m.id).state === 'running'; remaining--) await c.pump(m.id);
  assert.equal(store.get(m.id).state, 'completed'); assert.equal(store.get(m.id).count, 122); assert.equal(store.verify(m.id).ok, true);
});
test('manifest failure after fsync is recovered without duplicating the committed frame', async t => {
  let armed = false, failed = false;
  const store = setup(t, { beforeWrite: name => { if (armed && name === 'manifest.json' && !failed) { failed = true; throw new Error('simulated checkpoint write failure'); } } }), m = source(store);
  const a = new JsonlFileAdapter(store.file(m.id, 'raw.events.jsonl')); await a.connect(); a.configure(); await a.start(); const frame = await a.read();
  armed = true; assert.throws(() => store.append(m.id, frame), /checkpoint/); await a.disconnect();
  assert.equal(store.get(m.id).count, 0); assert.equal(store.frames(m.id).length, 1);
  const recovered = store.recover(m.id); assert.equal(recovered.count, 1); await readAll(store, m.id); assert.equal(store.get(m.id).count, 122); assert.equal(store.verify(m.id).ok, true);
});
test('two landmarks compute independent offset / drift and retain uncertainty / extrapolation', () => {
  const sync = fitSync([{ radar_s: 1, video_s: 0, radar_uncertainty_s: .1, video_uncertainty_s: .2, note: 'start' }, { radar_s: 11.2, video_s: 10, radar_uncertainty_s: .3, video_uncertainty_s: .1, note: 'end' }], 13, 12);
  assert.equal(sync.offset_s, 1); assert.ok(Math.abs(sync.drift_ppm - 20000) < 1e-8); assert.ok(Math.abs(mapVideoTime(sync, 5).radar_s - 6.1) < 1e-8);
  assert.ok(Math.abs(mapVideoTime(sync, 0).uncertainty_s - .304) < 1e-8); assert.equal(mapVideoTime(sync, 11).extrapolated, true); assert.equal(sync.physical_sync_accuracy_verified, false); assert.equal(sync.unmeasured_latency_s, 'unknown');
  assert.throws(() => fitSync(anchors(), 'unknown', 12), { code: 'RADAR_CLOCK_UNKNOWN' });
  assert.throws(() => fitSync(anchors(), 12, 'unknown'), { code: 'VIDEO_DURATION_UNKNOWN' });
  assert.throws(() => fitSync([anchors()[1], anchors()[0]], 12, 12), { code: 'INVALID_ANCHOR_ORDER' });
  const bad = anchors(); bad[1].radar_s = 13; assert.throws(() => fitSync(bad, 12, 12), { code: 'ANCHOR_OUT_OF_RANGE' });
});
test('clock going backwards blocks linear sync; software equality is never physical accuracy', async t => {
  const store = setup(t), m = source(store, '{"ts":"500000:00:01.000","detections":{"attributes":[],"data":[]}}\n{"ts":"500000:00:00.000","detections":{"attributes":[],"data":[]}}\n');
  await readAll(store, m.id); video(store, m.id, 12); assert.equal(store.get(m.id).time_range.backwards_count, 1);
  assert.throws(() => store.setSync(m.id, anchors(1)), { code: 'CLOCK_BACKWARDS' });
});
test('labels separate manual/candidate/confirmed/corrected/rejected, preserve original and review history', async t => {
  const store = setup(t), m = source(store); await readAll(store, m.id); video(store, m.id); store.setSync(m.id, anchors());
  const input = { label: '歩く', start_video_s: 2, end_video_s: 5, request_id: 'same-add' };
  store.addLabel(m.id, input, { importedCandidate: true }); store.addLabel(m.id, input, { importedCandidate: true }); assert.equal(store.get(m.id).labels.length, 1); assert.equal(store.dataset(m.id).intervals.length, 0);
  const label = store.get(m.id).labels[0]; assert.equal(label.origin, 'automatic_candidate_import');
  store.reviewLabel(m.id, label.id, { action: 'correct', expected_revision: 1, request_id: 'same-review', label: '不明', start_video_s: 2.1, end_video_s: 4.8, review_duration_ms: 1234 });
  store.reviewLabel(m.id, label.id, { action: 'correct', expected_revision: 1, request_id: 'same-review' });
  const result = store.get(m.id).labels[0]; assert.equal(result.status, 'corrected'); assert.equal(result.candidate.label, '歩く'); assert.equal(result.history.length, 1); assert.equal(result.history[0].review_duration_ms, 1234);
  const dataset = store.dataset(m.id); assert.equal(dataset.intervals.length, 1); assert.equal(dataset.intervals[0].label, '不明'); assert.ok(dataset.intervals[0].receiver_sequences.length > 0); assert.equal(dataset.data_kind, 'detections_not_raw_adc');
  assert.throws(() => store.reviewLabel(m.id, label.id, { action: 'confirm', expected_revision: 1 }), { code: 'STALE_REVIEW' });
  store.reviewLabel(m.id, label.id, { action: 'reject', expected_revision: 2 }); assert.equal(store.dataset(m.id).intervals.length, 0);
  assert.throws(() => store.addLabel(m.id, { label: 'その他', start_video_s: 5, end_video_s: 4 }), { code: 'INVALID_INTERVAL' });
});
test('confirmed labels without sync and intervals with no events are excluded explicitly', async t => {
  const store = setup(t), m = source(store); await readAll(store, m.id); video(store, m.id);
  store.addLabel(m.id, { label: 'その他', start_video_s: .01, end_video_s: .02 }); let label = store.get(m.id).labels[0]; store.reviewLabel(m.id, label.id, { action: 'confirm', expected_revision: 1 });
  assert.equal(store.dataset(m.id).excluded[0].reason, 'sync_missing_or_outside_radar_range'); store.setSync(m.id, anchors()); assert.equal(store.dataset(m.id).excluded[0].reason, 'no_valid_timed_detection_events');
});
test('synthetic diagnostic payloads retain original bytes, unknown PC capture time and nonrepresentative scope', async t => {
  const store = setup(t), m = store.create({ mode: 'diagnostic', historical_device: true });
  const original = fs.readFileSync(new URL('../fixtures/synthetic-diagnostic-samples.json', import.meta.url)); const entries = JSON.parse(original);
  const input = store.file(m.id, 'upload-input.tmp'), staged = store.file(m.id, 'upload-jsonl.tmp'); fs.writeFileSync(input, original); fs.writeFileSync(staged, entries.map(x => JSON.stringify(x)).join('\n') + '\n');
  store.attachSource(m.id, staged, { name: 'synthetic-diagnostic-samples.json', diagnostic: true, originalFile: input }); await readAll(store, m.id);
  const frames = store.frames(m.id); assert.equal(frames.length, 3); assert.equal(store.verify(m.id).ok, true);
  assert.equal(store.get(m.id).source.complete_capture, false); assert.equal(store.get(m.id).time_range.duration_s, 'unknown');
  assert.ok(frames.every(x => x.pc_receive_time.value === 'unknown' && x.device_time.value === 'unknown')); assert.deepEqual(frames[0].shape, [1, 13]); assert.deepEqual(frames[0].target_sequence_nums, [2]);
  assert.deepEqual(fs.readFileSync(store.file(m.id, 'diagnostic-original.json')), original);
});
