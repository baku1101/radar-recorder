// Runs with the newly installed portable Node in an isolated distribution, never real COM.
import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';import {spawn} from 'node:child_process';
import {createApp} from '../src/server.mjs';import {rawCskSettings,rawCskRuntime} from '../src/csk-raw.mjs';import {hash} from '../src/raw-dsp.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'portable-smoke-')),settings=rawCskSettings(),r=rawCskRuntime();let opens=0,stops=0,app;
assert.equal(r.serialLib,undefined);assert.ok(r.python.includes(path.join('.runtime','windows','runtimes')));
const b=Buffer.alloc(128*64*2);for(let c=0;c<128;c++)for(let s=0;s<64;s++)b.writeUInt16LE(Math.round(32768+10000*Math.cos(2*Math.PI*(8*s/64+70*c*.000501225))),(c*64+s)*2);
try{
 app=await createApp({root,port:0,rawCskFactory:()=>({metadata:{mock:true,description:'synthetic mock transport; not hardware'},discarded:0,async open(){opens++;},read(){if(this.sent)return null;this.sent=true;return {text:JSON.stringify({kind:'raw_adc_frame',sequence:0,frame_start_s:0,payload_base64:b.toString('base64'),payload_sha256:hash(b)}),pc_receive_unix_ms:Date.now(),pc_receive_monotonic_ns:process.hrtime.bigint().toString()};},async stop(){if(!this.stopped)stops++;this.stopped=true;},diagnostics(){return{mock:true,port_closed:true};}})});
 const bootstrap=await(await fetch(app.origin+'/api/bootstrap')).json();assert.ok(bootstrap.capabilities.raw_micro_doppler.inputs.includes('csk_raw_uart'));assert.equal((await fetch(app.origin+'/micro.js')).status,200);
 const post=async(url,body={})=>{const response=await fetch(app.origin+url,{method:'POST',headers:{'Content-Type':'application/json','x-radar-token':bootstrap.token},body:JSON.stringify(body)});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;};
 for(let restart=0;restart<2;restart++){
  const started=await post('/api/raw/start',{transport:'csk_raw_uart',port:'COM99'});
  for(let n=0;n<200&&!app.raw.get(started.id).processed_frames;n++)await new Promise(r=>setTimeout(r,10));
  const ended=await post('/api/raw/'+started.id+'/stop');assert.equal(ended.processed_frames,1);assert.equal(app.raw.verify(started.id).ok,true);
  const config=JSON.parse(fs.readFileSync(app.raw.file(started.id,'source-config.json'),'utf8'));assert.deepEqual(config.deployment_descriptor,settings);assert.equal(config.requested_registers,undefined);
 }
 assert.equal(opens,2);assert.equal(stops,2);
 const child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('../start.ps1',import.meta.url)),'-Port',new URL(app.origin).port],{windowsHide:true,stdio:['ignore','pipe','pipe']});let text='';child.stderr.on('data',b=>text+=b);const code=await new Promise(r=>child.once('exit',r));assert.notEqual(code,0);assert.match(text,/already in use/);assert.equal((await fetch(app.origin+'/micro.js')).status,200);
 console.log('PASS clean portable mock: bootstrap, module, raw start/stop/restart, save/verify, bundled descriptor and duplicate-server preflight; real hardware opens=0');
}finally{await app?.close();fs.rmSync(root,{recursive:true,force:true});}
