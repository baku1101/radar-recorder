import test from 'node:test';import assert from 'node:assert/strict';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {createApp} from '../src/server.mjs';import {setup} from './helpers.mjs';
test('Windows launcher refuses a second server without stopping or replacing the listening application',{skip:process.platform!=='win32'},async t=>{
 const store=setup(t),app=await createApp({root:store.root,port:0});store.beforeCleanup=()=>app.close();const port=new URL(app.origin).port,before=await (await fetch(app.origin+'/api/bootstrap')).json();
 await assert.rejects(promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',new URL('../start.ps1',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'),'-Port',port],{windowsHide:true,timeout:15000}),error=>{assert.match(error.stderr,/already in use/);assert.match(error.stderr,/No second server/);return true;});
 const after=await (await fetch(app.origin+'/api/bootstrap')).json();assert.equal(after.app.started_at,before.app.started_at);assert.equal(after.app.version,before.app.version);assert.equal(app.raw.runtime,null);
});
