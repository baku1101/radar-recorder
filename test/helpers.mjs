import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonlFileAdapter } from '../src/adapters.mjs';
import { SessionStore } from '../src/storage.mjs';
export const project = path.dirname(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, '$1')));
export function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-test-'));
  const store = new SessionStore(path.join(root, 'sessions'), options);
  t.after(async () => {
    await store.beforeCleanup?.();
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(root).startsWith('radar-test-')) throw new Error('Unsafe test cleanup path');
    fs.rmSync(root, { recursive: true, force: true });
  });
  return store;
}
export function source(store, text = null, create = {}) {
  const m = store.create(create), staged = store.file(m.id, 'upload-fixture.tmp');
  if (text === null) fs.copyFileSync(new URL('../fixtures/demo.events.jsonl', import.meta.url), staged); else fs.writeFileSync(staged, text);
  store.attachSource(m.id, staged, { name: 'fixture.events.jsonl' }); return store.get(m.id);
}
export async function readAll(store, id) {
  const m = store.get(id), adapter = new JsonlFileAdapter(store.file(id, m.source.file), { diagnostic: m.source.diagnostic, skipSourceLines: m.last_source_line, receiverSequence: m.count });
  await adapter.connect(); adapter.configure({ data_kind: 'detections' }); await adapter.start();
  for (;;) { const f = await adapter.read(); if (!f) break; store.append(id, f); }
  await adapter.disconnect(); return store.transition(id, 'completed');
}
export function video(store, id, duration = 12) {
  const staged = store.file(id, 'upload-video.tmp'); fs.copyFileSync(new URL('../fixtures/demo.webm', import.meta.url), staged);
  const m = store.attachVideo(id, staged, 'fixture.webm'); return store.videoMetadata(id, { sha256: m.video.sha256, duration_s: duration });
}
export const anchors = (end = 12) => [{ radar_s: 0, video_s: 0, radar_uncertainty_s: .1, video_uncertainty_s: .1, note: 'synthetic start' }, { radar_s: end, video_s: end, radar_uncertainty_s: .1, video_uncertainty_s: .1, note: 'synthetic end' }];
export async function eventually(fn, timeout = 4000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Timed out waiting for condition'); }
