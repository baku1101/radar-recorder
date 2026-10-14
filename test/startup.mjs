import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(project, 'start.ps1'), '-Port', '0', '-DataDirectory', path.join(project, 'test-output', 'startup-sessions')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = ''; child.stdout.on('data', x => { stdout += x.toString(); }); child.stderr.on('data', x => { stderr += x.toString(); });
try {
  const began = Date.now(); let url;
  while (Date.now() - began < 10000) { url = /http:\/\/127\.0\.0\.1:\d+/.exec(stdout)?.[0]; if (url) break; if (child.exitCode !== null) throw new Error(`Startup failed: ${stderr}`); await new Promise(r => setTimeout(r, 50)); }
  assert.ok(url, 'Startup script prints local URL');
  const response = await fetch(url + '/api/bootstrap', { signal: AbortSignal.timeout(5000) }); assert.equal(response.status, 200);
  const data = await response.json(); assert.equal(data.capabilities.live_capture, true);
  fs.writeFileSync(path.join(project, 'evidence', 'startup-test.json'), JSON.stringify({ passed: true, launch: 'start.ps1 -Port 0 -DataDirectory test-output/startup-sessions', headless: true, local_bootstrap_status: response.status, live_capture: true, real_devices_accessed: false, checked_at: new Date().toISOString() }, null, 2));
  console.log('PASS startup script resolves existing Node runtime, prints localhost URL and serves bootstrap.');
} finally { if (child.exitCode === null) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
