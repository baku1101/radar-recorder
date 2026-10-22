import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {readbackFingerprints,validateDeploymentReadback} from '../src/raw-deployment.mjs';import {portableRuntime} from '../src/portable-runtime.mjs';import {rawCskSettings} from '../src/csk-raw.mjs';
import {enumeratePorts} from '../src/ports.mjs';
function encoded(rows){return Buffer.concat(rows.map(([a,v])=>{const b=Buffer.alloc(8);b.writeUInt32LE(a);b.writeUInt32LE(v,4);return b;}));}
test('Portable fingerprint validates profile values and order without shipping vendor register arrays',()=>{
 const b=encoded([[0x100,123],[0x2014,341],[0x300,456]]),fp=readbackFingerprints(b),s={readback_fingerprint:fp};
 let result=validateDeploymentReadback(s,b,{register_count:3});assert.equal(result.matched_non_calibration_count,2);assert.equal(result.pc_wrote_registers,false);
 const changedCal=encoded([[0x100,123],[0x2014,0],[0x300,456]]);result=validateDeploymentReadback(s,changedCal,{register_count:3});assert.deepEqual(result.excluded_calibration_values,[{address:0x2014,readback:0,meaning:'unknown'}]);
 for(const modified of [encoded([[0x100,124],[0x2014,341],[0x300,456]]),encoded([[0x300,456],[0x2014,341],[0x100,123]])])assert.throws(()=>validateDeploymentReadback(s,modified,{register_count:3}),{code:'RAW_CSK_REGISTER_MISMATCH'});
 assert.throws(()=>validateDeploymentReadback(s,b.subarray(0,16),{register_count:3}),{code:'RAW_CSK_READBACK_INVALID'});
});
test('COM picker uses OS enumeration only and reports empty/invalid results separately',async()=>{
 let call;const runtime={python:'mock-python'},result=await enumeratePorts({runtime,execute:async(...args)=>{call=args;return{stdout:JSON.stringify([{port:'COM3',description:'mock USB UART',vid:123,pid:456}])};}});
 assert.equal(call[0],'mock-python');assert.ok(call[1].some(s=>s.endsWith('list-ports.py')));assert.ok(!call[1].includes('csk-raw-reader.py'));assert.equal(result.port_opened,false);assert.equal(result.firmware_checked,false);assert.equal(result.ports[0].port,'COM3');
 const empty=await enumeratePorts({runtime,execute:async()=>({stdout:'[]'})});assert.match(empty.driver_status,/unknown/);
 await assert.rejects(enumeratePorts({runtime,execute:async()=>({stdout:'[{"port":"not-a-COM"}]'})}),{code:'PORT_ENUMERATION_FAILED'});
});
test('Portable runtime is app-local, supports Unicode/spaces, and rejects path traversal',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'raw portable 日本語 ')),marker=path.join(root,'.runtime','windows','current.json');try{assert.equal(portableRuntime(root),null);fs.mkdirSync(path.dirname(marker),{recursive:true});fs.writeFileSync(marker,JSON.stringify({runtime_id:'a'.repeat(16)}));assert.equal(portableRuntime(root).python,path.join(root,'.runtime','windows','runtimes','a'.repeat(16),'python','python.exe'));fs.writeFileSync(marker,JSON.stringify({runtime_id:'../../elsewhere'}));assert.throws(()=>portableRuntime(root),/Invalid portable/);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('Bundled deployment descriptor has timing and fingerprints, without individual data or register values',()=>{
 const old=process.env.RADAR_CSK_RAW_SETTINGS;try{process.env.RADAR_CSK_RAW_SETTINGS=new URL('../profiles/radc-0.2.0-japan128.json',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1');const s=rawCskSettings();assert.equal(s.requested_registers,undefined);assert.equal(s.readback_fingerprint.register_count,433);assert.equal(s.readback_fingerprint.non_calibration_count,413);assert.equal(s.header.config.chirps_per_frame,128);assert.equal(s.header.config.sample_format,'uint16_le');assert.equal(s.header.config.provenance,'real');assert.equal(s.header.config.physical_frame_origin_uncertainty_s,'unknown');assert.ok(!JSON.stringify(s).match(/[A-Za-z]:[\\/]|serial_number|register_readback_base64|payload_base64/));}finally{if(old===undefined)delete process.env.RADAR_CSK_RAW_SETTINGS;else process.env.RADAR_CSK_RAW_SETTINGS=old;}
});
