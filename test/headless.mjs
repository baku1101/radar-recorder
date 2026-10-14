import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function launchHeadless(outputDir) {
  const exe = process.env.RADAR_HEADLESS_CHROME ?? path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium_headless_shell-1200', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
  const profile = path.resolve(outputDir, `chrome-${randomUUID()}`); fs.mkdirSync(profile, { recursive: true });
  const child = spawn(exe, ['--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-extensions', '--safebrowsing-disable-download-protection', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--disable-gpu', 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', x => { stderr += x.toString(); });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 200 && !fs.existsSync(portFile); i++) { if (child.exitCode !== null) throw new Error(`Headless browser exited (${child.exitCode}): ${stderr}`); await wait(50); }
  if (!fs.existsSync(portFile)) { child.kill(); throw new Error('Headless browser startup timed out'); }
  const port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const socket = new WebSocket(targets.find(x => x.type === 'page').webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0; const pending = new Map(), events = [];
  socket.addEventListener('message', event => { const data = JSON.parse(event.data); if (data.id && pending.has(data.id)) { const waiter = pending.get(data.id); pending.delete(data.id); clearTimeout(waiter.timer); data.error ? waiter.reject(new Error(JSON.stringify(data.error))) : waiter.resolve(data.result); } else events.push(data); });
  function send(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 25000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
  }
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  return {
    send, events, profile,
    async evaluate(expression) { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; },
    async waitFor(expression, timeout = 10000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await this.evaluate(expression)) return; await wait(50); } throw new Error(`UI condition timed out: ${expression}`); },
    async screenshot(file) { const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }); fs.writeFileSync(file, Buffer.from(result.data, 'base64')); },
    async close() { try { await send('Browser.close'); } catch {} socket.close(); if (child.exitCode === null) child.kill(); for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Browser closed')); } pending.clear(); }
  };
}
