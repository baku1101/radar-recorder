import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fft,validateRawConfig,validateProcessing,decodeRaw,rawBytes,microDoppler,syntheticRaw } from '../src/raw-dsp.mjs';
import { RawService } from '../src/raw-service.mjs';
import { createApp } from '../src/server.mjs';
import { setup,eventually } from './helpers.mjs';

const fixture=syntheticRaw({frames:2,toneHz:62.5}), c=fixture.header.config;
const range=299792458*1e6*16/(2*1e13*128), processing=validateProcessing(c,{range_min_m:range-.01,range_max_m:range+.01});
const requestProcessing={range_min_m:range-.01,range_max_m:range+.01};
const spectrum=(f=fixture.frames[0],p=processing)=>microDoppler(rawBytes(f,c),c,p,f.frame_start_s);
const peak=(s,column=s.columns[0])=>s.frequencies_hz[column.power_db.indexOf(Math.max(...column.power_db))];
test('independent radix-2 complex FFT matches direct DFT including phase and negative frequencies',()=>{
 const re=Float64Array.from([1,2,0,-3,4,1,-2,0]),im=Float64Array.from([0,1,2,0,-1,3,0,-2]), ar=Array.from(re),ai=Array.from(im);fft(re,im);
 for(let k=0;k<8;k++){let r=0,b=0;for(let j=0;j<8;j++){const a=-2*Math.PI*j*k/8;r+=ar[j]*Math.cos(a)-ai[j]*Math.sin(a);b+=ar[j]*Math.sin(a)+ai[j]*Math.cos(a);}assert.ok(Math.abs(re[k]-r)<1e-10);assert.ok(Math.abs(im[k]-b)<1e-10);}
});
test('raw metadata rejects unknown sample timing, wrong shape, non-raw detections and unspecified IQ format',()=>{
 for(const key of ['sample_rate_hz','carrier_hz','chirp_interval_s','chirp_slope_hz_per_s'])assert.throws(()=>validateRawConfig({...c,[key]:'unknown'}),{code:'RAW_TIMING_UNKNOWN'});
 assert.throws(()=>validateRawConfig({...c,data_kind:'detections'}),{code:'NOT_RAW_ADC'});assert.throws(()=>validateRawConfig({...c,layout:'rx_chirp_sample'}),{code:'RAW_LAYOUT_REQUIRED'});assert.throws(()=>validateRawConfig({...c,rx_order:[]}),{code:'RAW_RX_ORDER_REQUIRED'});
 assert.throws(()=>validateProcessing(c,{window_chirps:512}),{code:'RAW_PROCESSING_INVALID'});assert.throws(()=>validateProcessing(c,{range_min_m:99,range_max_m:100}),{code:'RAW_RANGE_EMPTY'});
});
test('original ADC byte count, base64 canonical form, hash and nonfinite samples are checked before analysis',()=>{
 const f=fixture.frames[0];assert.equal(rawBytes(f,c).length,65536);assert.throws(()=>rawBytes({...f,payload_base64:f.payload_base64.slice(4)},c),{code:'RAW_BYTE_COUNT'});assert.throws(()=>rawBytes({...f,payload_sha256:'wrong'},c),{code:'RAW_HASH_MISMATCH'});assert.throws(()=>rawBytes({kind:'detections'},c),{code:'RAW_FRAME_INVALID'});
 const cf=validateRawConfig({...c,sample_format:'float32_le'}),b=Buffer.alloc(cf.frame_bytes);b.writeFloatLE(NaN);assert.throws(()=>decodeRaw(b,cf),{code:'RAW_NONFINITE_SAMPLE'});
 const bytes=rawBytes(f,c),decoded=decodeRaw(bytes,c);assert.equal(decoded.re[0],bytes.readInt16LE(0)/32768);assert.equal(decoded.im[0],0);
});
test('raw real ADC range FFT and STFT recover known signed tone, physical axes and ADC amplitude',()=>{
 const s=spectrum();assert.equal(peak(s),62.5);assert.equal(s.frequencies_hz[1]-s.frequencies_hz[0],7.8125);assert.equal(s.columns[0].time_s,.0635);assert.equal(s.columns.length,5);
 const i=s.frequencies_hz.indexOf(62.5);assert.ok(Math.abs(s.velocities_mps[i]-299792458*62.5/(2*60e9))<1e-12);assert.ok(Math.abs(s.columns[0].power_db[i]-20*Math.log10(16000/32768))<.01);assert.ok(Math.abs(s.range_bin_spacing_m*16-range)<1e-12);
 const negative=syntheticRaw({frames:1,toneHz:-62.5}).frames[0];assert.equal(peak(spectrum(negative)),-62.5);
});
test('range gate excludes unrelated reflectors; static removal is explicit and changes DC power without manufacturing motion',()=>{
 const rejected=spectrum(fixture.frames[0],validateProcessing(c,{range_min_m:range+.5,range_max_m:range+.6}));assert.ok(Math.max(...rejected.columns[0].power_db)<-70);
 const stationary=syntheticRaw({frames:1,toneHz:0}).frames[0],kept=spectrum(stationary),removed=spectrum(stationary,{...processing,remove_static:true});assert.equal(peak(kept),0);assert.ok(Math.max(...kept.columns[0].power_db)>-7);assert.ok(Math.max(...removed.columns[0].power_db)<-120);assert.equal(removed.static_removal,true);
});
test('analytic moving-limb raw fixture produces a time-varying spectrum instead of detection-point interpolation',()=>{
 const f=syntheticRaw({frames:3}),spectra=f.frames.map(frame=>spectrum(frame));const peaks=spectra.flatMap(s=>s.columns.map(col=>{const candidates=s.frequencies_hz.map((frequency,i)=>({frequency,power:col.power_db[i]})).filter(x=>Math.abs(x.frequency-20)>25);return candidates.sort((a,b)=>b.power-a.power)[0].frequency;}));
 assert.ok(Math.max(...peaks)-Math.min(...peaks)>100);assert.ok(spectra.every(s=>s.columns.every(col=>col.power_db.length===128&&col.power_db.every(Number.isFinite))));
});
test('complex IQ bytes keep their complex phase and use the declared sample scale',()=>{
 const ci=validateRawConfig({...c,data_kind:'complex_iq',sample_format:'complex64_le',adc_full_scale:1}),bytes=Buffer.alloc(ci.frame_bytes);
 for(let chirp=0;chirp<256;chirp++)for(let sample=0;sample<128;sample++){const phase=2*Math.PI*(16*sample/128-62.5*chirp*.001),i=(chirp*128+sample)*8;bytes.writeFloatLE(.5*Math.cos(phase),i);bytes.writeFloatLE(.5*Math.sin(phase),i+4);}
 const s=microDoppler(bytes,ci,processing,0);assert.equal(peak(s),-62.5);assert.ok(Math.abs(Math.max(...s.columns[0].power_db)-20*Math.log10(.5))<.001);
});
test('raw import preserves exact source bytes, raw binaries, timing/shape/settings and derived spectrum readback',async t=>{
 const store=setup(t),raw=new RawService(store.root);store.beforeCleanup=()=>raw.close();const staged=store.root+'/capture.raw.jsonl',text=[fixture.header,...fixture.frames].map(x=>JSON.stringify(x)).join('\r\n')+'\r\n';fs.writeFileSync(staged,text);
 const m=await raw.importFile(staged,{range_min_m:range-.01,range_max_m:range+.01});await raw.runtime.job;const final=raw.get(m.id);assert.equal(final.state,'completed');assert.equal(final.frame_count,2);assert.equal(final.processed_frames,2);assert.equal(final.column_count,10);assert.equal(raw.verify(m.id).ok,true);
 assert.equal(fs.readFileSync(raw.file(m.id,'source.raw.jsonl'),'utf8'),text);assert.deepEqual(fs.readFileSync(raw.file(m.id,'adc-000001.bin')),rawBytes(fixture.frames[0],c));const metadata=JSON.parse(fs.readFileSync(raw.file(m.id,'adc-000001.json'),'utf8'));assert.deepEqual(metadata.shape,[256,1,128]);assert.equal(metadata.time_basis,'synthetic_sample_clock');assert.equal(metadata.device_sequence,'unknown');
 const view=await raw.view(m.id,{start:.1,end:.4,tail:false});assert.ok(view.columns.every(x=>x.time_s>=.1&&x.time_s<=.4));assert.equal(view.manifest.real_hardware_raw_verified,false);assert.equal(view.manifest.device_loss,'unknown');assert.ok(raw.exportFiles(m.id).some(x=>x.name==='adc-000001.bin'));
 fs.appendFileSync(raw.file(m.id,'adc-000001.bin'),'tamper');assert.equal(raw.verify(m.id).ok,false);assert.throws(()=>raw.exportFiles(m.id),{code:'RAW_READBACK_FAILED'});
});
test('raw missing frames retain discontinuities and never coherently join unknown gaps',async t=>{
 const store=setup(t),raw=new RawService(store.root);store.beforeCleanup=()=>raw.close();const m=raw.create(fixture.header,requestProcessing,{});await raw.ingest(m.id,fixture.frames[0],JSON.stringify(fixture.frames[0]));const second={...fixture.frames[1],sequence:3,frame_start_s:2};await raw.ingest(m.id,second,JSON.stringify(second));const saved=raw.get(m.id);assert.equal(saved.source_sequence_discontinuities,1);assert.equal(saved.time_discontinuities,1);assert.equal(saved.device_loss,'unknown');const view=await raw.view(m.id);assert.equal(view.columns.filter(x=>x.time_s>.3&&x.time_s<2).length,0);await assert.rejects(raw.ingest(m.id,second,JSON.stringify(second)),{code:'RAW_SEQUENCE_ORDER'});
});
test('raw live backpressure and stop retain committed bytes and release acquisition reservation',async t=>{
 const store=setup(t);let readCount=0,stopped=false;const adapter={discarded:1,async open(){},read(){if(readCount<2){const frame=fixture.frames[readCount++];return {text:JSON.stringify(frame),pc_receive_unix_ms:Date.now(),pc_receive_monotonic_ns:'1'};}throw Object.assign(new Error('synthetic overflow'),{code:'RAW_BACKPRESSURE'});},async stop(){stopped=true;}};
 const raw=new RawService(store.root,{factory:()=>adapter});store.beforeCleanup=()=>raw.close();const m=await raw.start({transport:'local_websocket_raw_adc',url:'ws://127.0.0.1:1234',header:fixture.header,processing:requestProcessing,request_id:'test'});await raw.runtime.job;assert.equal(raw.get(m.id).error.code,'RAW_BACKPRESSURE');assert.equal(raw.get(m.id).frame_count,2);assert.equal(raw.get(m.id).source_messages_not_saved,1);assert.equal(raw.verify(m.id).ok,true);assert.equal(raw.busy,false);assert.equal(stopped,true);
});
test('worker processing yields to HTTP/receive timers; app never claims current CSK detections are raw',async t=>{
 const store=setup(t),app=await createApp({port:0,root:store.root});store.beforeCleanup=()=>app.close();const post=async(body,token=app.token)=>{const r=await fetch(app.origin+'/api/raw/start',{method:'POST',headers:{'Content-Type':'application/json','x-radar-token':token},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 assert.equal((await post({transport:'synthetic_raw'},'bad')).status,403);const unavailable=await post({transport:'csk_current_firmware'});assert.equal(unavailable.status,409);assert.equal(unavailable.body.error.code,'CURRENT_CSK_RAW_PATH_UNAVAILABLE');assert.equal(app.raw.list().length,0);
 const started=await post({transport:'synthetic_raw',processing:{range_min_m:range-.01,range_max_m:range+.01}});let ticks=0;const timer=setInterval(()=>ticks++,5);await eventually(()=>app.raw.get(started.body.id).processed_frames>0,10000);const url=app.origin+'/api/raw/'+started.body.id;const view=await fetch(url).then(r=>r.json());assert.ok(view.columns.length>0);assert.equal(view.manifest.provenance,'synthetic');assert.ok(ticks>0);clearInterval(timer);await app.raw.stop(started.body.id);assert.equal(app.raw.verify(started.body.id).ok,true);assert.equal((await fetch(url+'/export')).status,200);
});
test('first-use raw HTTP import creates storage lazily, rejects bad processing and preserves the original file',async t=>{
 const store=setup(t),app=await createApp({port:0,root:store.root});store.beforeCleanup=()=>app.close();assert.equal(fs.existsSync(app.raw.root),false);
 const text=[fixture.header,fixture.frames[0]].map(x=>JSON.stringify(x)).join('\n')+'\n',headers={'x-radar-token':app.token,'Content-Type':'application/x-ndjson'};
 const bad=await fetch(app.origin+'/api/raw/import?processing=bad-json',{method:'POST',headers,body:text});assert.equal(bad.status,400);assert.equal(fs.existsSync(app.raw.root),false);
 const reply=await fetch(app.origin+'/api/raw/import',{method:'POST',headers,body:text});assert.equal(reply.status,200);const m=await reply.json();await app.raw.runtime.job;assert.equal(app.raw.get(m.id).state,'completed');assert.equal(fs.readFileSync(app.raw.file(m.id,'source.raw.jsonl'),'utf8'),text);assert.equal(app.raw.verify(m.id).ok,true);
});
