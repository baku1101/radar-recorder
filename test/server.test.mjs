import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';
import { createApp } from '../src/server.mjs';
import { setup, eventually, anchors } from './helpers.mjs';
async function appFor(t, options = {}) {
  const store = setup(t), app = await createApp({ root: store.root, port: 0, delayMs: 1, ...options }); store.beforeCleanup = () => app.close();
  const call = async (url, body, extra = {}) => {
    const response = await fetch(app.origin + url, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? extra : { 'x-radar-token': app.token, 'Content-Type': 'application/json', ...extra }, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    const data = await response.json(); return { response, data };
  };
  return { app, call };
}
async function imported(call) {
  const { data: m } = await call('/api/sessions', { title: 'API fixture' });
  const bytes = fs.readFileSync(new URL('../fixtures/demo.events.jsonl', import.meta.url)); await call(`/api/sessions/${m.id}/radar?name=input.events.jsonl`, bytes);
  await call(`/api/sessions/${m.id}/start`, {}); return m.id;
}
test('HTTP serves Japanese GUI locally with a CSP and no external resource dependencies', async t => {
  const { app } = await appFor(t), response = await fetch(app.origin), html = await response.text();
  assert.equal(response.status, 200); assert.ok(html.includes('レーダーレビュー')); assert.ok(response.headers.get('Content-Security-Policy').includes("connect-src 'self'")); assert.equal(/https?:\/\//.test(html), false);
  const bootstrap = await (await fetch(app.origin + '/api/bootstrap')).json(); assert.equal(bootstrap.app.id,'radar-recorder-local');assert.equal(bootstrap.app.version,JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).version);assert.ok(Number.isFinite(Date.parse(bootstrap.app.started_at)));assert.equal(bootstrap.capabilities.live_capture, true); assert.equal(bootstrap.capabilities.auto_label.implemented, false);
});
test('external Origin / unexpected Host / unauthenticated mutations are rejected', async t => {
  const { app } = await appFor(t);
  assert.equal((await fetch(app.origin + '/api/sessions', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await fetch(app.origin + '/api/bootstrap', { headers: { Origin: 'https://unrelated.example' } })).status, 403);
  const forgedHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(app.origin + '/', { headers: { Host: 'unrelated.example' } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject);
  });
  assert.equal(forgedHostStatus, 403);
  assert.equal((await fetch(app.origin + '/not-found')).status, 404);
});
test('create / JSONL receive / duplicate start / stop / resume / readback / archive contain originals', async t => {
  const { app, call } = await appFor(t, { delayMs: 3 });
  const a = await call('/api/sessions', { title: '日本語', request_id: 'same-create' }), b = await call('/api/sessions', { title: '日本語', request_id: 'same-create' }); assert.equal(a.data.id, b.data.id);
  const id = a.data.id, bytes = fs.readFileSync(new URL('../fixtures/demo.events.jsonl', import.meta.url));
  assert.equal((await call(`/api/sessions/${id}/radar?name=fixture.events.jsonl`, bytes)).response.status, 200);
  assert.equal((await call(`/api/sessions/${id}/radar?name=fixture.events.jsonl`, bytes)).response.status, 409);
  await Promise.all([call(`/api/sessions/${id}/start`, {}), call(`/api/sessions/${id}/start`, {})]); await eventually(() => app.store.get(id).count >= 5);
  await Promise.all([call(`/api/sessions/${id}/stop`, {}), call(`/api/sessions/${id}/stop`, {})]); assert.equal(app.store.get(id).state, 'stopped');
  await call(`/api/sessions/${id}/start`, {}); await eventually(() => app.store.get(id).state === 'completed');
  const verify = await call(`/api/sessions/${id}/verify`); assert.equal(verify.data.ok, true); assert.equal(verify.data.count, 122);
  assert.deepEqual(fs.readFileSync(app.store.file(id, 'raw.events.jsonl')), bytes);
  const response = await fetch(app.origin + `/api/sessions/${id}/export`); assert.equal(response.status, 200);
  const tar = zlib.gunzipSync(Buffer.from(await response.arrayBuffer())); const names = []; let offset = 0;
  while (offset < tar.length && tar[offset]) { const name = tar.subarray(offset, offset + 100).toString().split('\0')[0], size = parseInt(tar.subarray(offset + 124, offset + 136).toString().replace(/\0/g, ''), 8); names.push(name); if (name === 'raw.events.jsonl') assert.deepEqual(tar.subarray(offset + 512, offset + 512 + size), bytes); offset += 512 + Math.ceil(size / 512) * 512; }
  for (const name of ['raw.events.jsonl', 'manifest.json', 'session-config.json', 'frames.jsonl', 'training.json', 'training.csv', 'labels-review.json', 'readback-report.json']) assert.ok(names.includes(name), name);
});
test('video import serves byte ranges and records browser metadata without camera capture', async t => {
  const { app, call } = await appFor(t), id = await imported(call); await eventually(() => app.store.get(id).state === 'completed');
  const bytes = fs.readFileSync(new URL('../fixtures/demo.webm', import.meta.url)); const importedVideo = await call(`/api/sessions/${id}/video?name=demo.webm`, bytes); assert.equal(importedVideo.response.status, 200);
  assert.equal(importedVideo.data.video.capture_started_by_this_app, false);
  const partial = await fetch(app.origin + `/api/sessions/${id}/video`, { headers: { Range: 'bytes=0-9' } }); assert.equal(partial.status, 206); assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(0, 10));
  const suffix = await fetch(app.origin + `/api/sessions/${id}/video`, { headers: { Range: 'bytes=-10' } }); assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(bytes.length - 10));
  assert.equal((await fetch(app.origin + `/api/sessions/${id}/video`, { headers: { Range: 'bytes=99999999999-' } })).status, 416);
  await call(`/api/sessions/${id}/video-metadata`, { duration_s: 12, sha256: importedVideo.data.video.sha256 });
  assert.equal((await call(`/api/sessions/${id}/video?name=demo.webm`, bytes)).response.status, 409);
  assert.equal((await call(`/api/sessions/${id}/video-metadata`, { duration_s: 12, sha256: 'wrong' })).response.status, 409);
});
test('sync / candidates / self review / auto-label unsupported / training export preserve distinctions', async t => {
  const { app, call } = await appFor(t), id = await imported(call); await eventually(() => app.store.get(id).state === 'completed');
  const { data: m } = await call(`/api/sessions/${id}/video?name=demo.webm`, fs.readFileSync(new URL('../fixtures/demo.webm', import.meta.url)));
  await call(`/api/sessions/${id}/video-metadata`, { duration_s: 12, sha256: m.video.sha256 });
  const synced = await call(`/api/sessions/${id}/sync`, { anchors: anchors() }); assert.equal(synced.data.sync.physical_sync_accuracy_verified, false);
  const candidate = { label: '歩く', start_video_s: 2, end_video_s: 5, model: 'fixture-only', provenance: 'synthetic manually authored candidate' };
  assert.equal((await call(`/api/sessions/${id}/candidates`, { video_sha256: 'wrong', candidates: [candidate] })).response.status, 400);
  const result = await call(`/api/sessions/${id}/candidates`, { video_sha256: m.video.sha256, candidates: [candidate], request_id: 'same-import' }); const label = result.data.labels[0]; assert.equal(label.status, 'pending');
  await call(`/api/sessions/${id}/candidates`, { video_sha256: m.video.sha256, candidates: [candidate], request_id: 'same-import' }); assert.equal(app.store.get(id).labels.length, 1);
  await call(`/api/sessions/${id}/labels/${label.id}`, { action: 'confirm', expected_revision: result.data.review_revision, request_id: 'review' });
  const exported = await call(`/api/sessions/${id}/export?format=json`); assert.equal(exported.data.intervals.length, 1); assert.equal(exported.data.intervals[0].origin, 'automatic_candidate_import'); assert.equal(exported.data.intervals[0].status, 'confirmed');
  assert.equal((await call(`/api/sessions/${id}/auto-label`, {})).response.status, 501);
});
test('aborted upload is discarded and never marks a source ready', async t => {
  const { app, call } = await appFor(t), { data: m } = await call('/api/sessions', { title: 'abort upload' });
  await new Promise(resolve => {
    const req = http.request(app.origin + `/api/sessions/${m.id}/radar?name=partial.jsonl`, { method: 'POST', headers: { 'x-radar-token': app.token, 'Content-Length': '1000000' } });
    req.on('error', resolve); req.write('{"partial":'); setTimeout(() => req.destroy(), 30);
  });
  await eventually(() => !fs.readdirSync(app.store.dir(m.id)).some(x => x.startsWith('upload-')));
  assert.equal(app.store.get(m.id).source, null); assert.equal(app.store.get(m.id).state, 'created');
});
test('synthetic diagnostic import stays unsynchronizable and original bytes are retained', async t => {
  const { app, call } = await appFor(t), { data: m } = await call('/api/sessions', { title: '合成診断例' }), id = m.id;
  const bytes = fs.readFileSync(new URL('../fixtures/synthetic-diagnostic-samples.json', import.meta.url));
  await call(`/api/sessions/${id}/radar?name=debug-payload-samples.json&format=diagnostic`, bytes); await call(`/api/sessions/${id}/start`, {}); await eventually(() => app.store.get(id).state === 'completed');
  assert.equal(app.store.get(id).count, 3); assert.equal(app.store.get(id).mode, 'diagnostic'); assert.equal(app.store.get(id).time_range.duration_s, 'unknown');
  assert.deepEqual(fs.readFileSync(app.store.file(id, 'diagnostic-original.json')), bytes); assert.equal((await call(`/api/sessions/${id}/verify`)).data.ok, true);
});
test('running export is rejected instead of claiming a complete recording', async t => {
  const { app, call } = await appFor(t, { delayMs: 100 }); const id = await imported(call);
  assert.equal(app.store.get(id).state, 'running'); assert.equal((await call(`/api/sessions/${id}/export?format=json`)).response.status, 409);
});
test('unsupported HTTP settings and data formats are explicit errors', async t => {
  const { app, call } = await appFor(t);
  assert.equal((await call('/api/sessions', { title: 'ADC', data_kind: 'adc' })).data.error.code, 'UNSUPPORTED_SETTING');
  const { data: m } = await call('/api/sessions', { title: 'requests' });
  assert.equal((await call(`/api/sessions/${m.id}/start`, { frame_interval_s: .1 })).data.error.code, 'UNSUPPORTED_SETTING');
  const result = await call(`/api/sessions/${m.id}/radar?name=sample.jsonl&format=raw_adc`, Buffer.from('{}\n'));
  assert.equal(result.data.error.code, 'UNSUPPORTED_FORMAT'); assert.equal(app.store.get(m.id).source, null);
});
