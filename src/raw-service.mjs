import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { atomicJson, fileSha } from './storage.mjs';
import { localWebSocketUrl } from './live.mjs';
import { AppError } from './adapters.mjs';
import { RAW_LIMITS, validateRawConfig, validateProcessing, rawBytes, syntheticRaw, hash } from './raw-dsp.mjs';
import { CskRawAdapter, rawCskSettings, probeCsk } from './csk-raw.mjs';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const durable = (file, bytes) => { const fd=fs.openSync(file,'wx');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);} };
const append = (file, value) => {const fd=fs.openSync(file,'a');try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
const errorInfo = error => ({ code:error.code??'RAW_CAPTURE_FAILED', message:error.message });
export const RAW_HARDWARE_STATUS = Object.freeze({
  implemented:true, code:'CURRENT_CSK_RAW_PATH_UNAVAILABLE',
  message:'専用raw FWのCSKに接続してADCを取得できます。接続・FW識別は開始時に確認します。標準検出FWのADC転送は未確認で、この経路には使えません。',
  historical_detection_firmware:'indoor_people_localization 0.4.5.dev0+g2b14fe4.d20260212',
  observed_sensor_name:'BGT60CUTR13', historical_native_smartar_discovery:'No connected devices found',
  historical_detection_uart_raw_read_command:'not present in installed TerminalCommand enum',
  confirmed_opn:'KITCSKBGT60CUTR13TOBO1', exact_opn_match:true,
  firmware_changes:'app never flashes; independent raw FW must be prepared separately', rollback_binary:'private original main/work/SFlash snapshots retained; restore write untested',
  raw_processing_implemented:true, candidate_firmware_built:true, direct_uart_transport:'csk_raw_uart',required_firmware:'radc-0.2.0',
});

// Text envelope transport only. It never sends commands to a device or changes settings.
class RawSocket {
  constructor(url){this.url=localWebSocketUrl(url);this.queue=[];this.bytes=0;this.discarded=0;}
  async open(){const socket=this.socket=new WebSocket(this.url);await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new AppError('RAW_CONNECT_TIMEOUT','raw配信への接続がタイムアウトしました')),4000);
    socket.addEventListener('open',()=>{clearTimeout(timer);this.active=true;this.last=performance.now();resolve();},{once:true});
    socket.addEventListener('error',()=>{clearTimeout(timer);this.failure??=new AppError('RAW_DISCONNECTED','raw配信との接続に失敗しました');reject(this.failure);});
    socket.addEventListener('close',()=>{if(this.active)this.failure??=new AppError('RAW_DISCONNECTED','raw配信が切断されました');});
    socket.addEventListener('message',event=>{if(!this.active)return;if(this.failure){this.discarded++;return;}const text=event.data,size=typeof text==='string'?Buffer.byteLength(text):Infinity;
      if(size>2*1024*1024||this.queue.length>=RAW_LIMITS.queue||this.bytes+size>16*1024*1024){this.discarded++;this.failure=new AppError('RAW_BACKPRESSURE','raw保存/処理が受信に追いつかず中断しました。未保存件数を確認してください');return;}
      this.last=performance.now();this.bytes+=size;this.queue.push({text,size,pc_receive_unix_ms:Date.now(),pc_receive_monotonic_ns:process.hrtime.bigint().toString()});});
  });}
  read(){const item=this.queue.shift();if(item){this.bytes-=item.size;return item;}if(this.failure)throw this.failure;if(this.active&&performance.now()-this.last>8000)throw new AppError('RAW_IDLE_TIMEOUT','raw frameを8秒受信できず中断しました');return null;}
  async stop(){this.active=false;const socket=this.socket;this.socket=null;if(socket){socket.close();await Promise.race([new Promise(r=>socket.addEventListener('close',r,{once:true})),wait(300)]);}}
}

export class RawService {
  constructor(root,{canAcquire=()=>true,factory=url=>new RawSocket(url),cskFactory=options=>new CskRawAdapter(options),cskProbe=probeCsk,leaseMs=15000}={}){
    this.root=path.join(root,'raw-adc');Object.assign(this,{canAcquire,factory,cskFactory,cskProbe,leaseMs});this.runtime=null;this.busy=false;this.jobId=0;this.closed=false;this.deviceTask=null;
    for(const m of this.list())if(['running','stopping'].includes(m.state)){m.state='interrupted';m.error={code:'RAW_INTERRUPTED',message:'前回のraw処理が中断しました。元bytesを保持しています。新しい取得を開始してください'};this.save(m);}
  }
  dir(id){if(!/^[a-f0-9-]{36}$/.test(id))throw new AppError('INVALID_RAW_ID','raw記録IDが不正です');return path.join(this.root,id);}
  file(id,name){return path.join(this.dir(id),name);}
  get(id){try{return JSON.parse(fs.readFileSync(this.file(id,'manifest.json'),'utf8'));}catch(e){if(e.code==='ENOENT')throw new AppError('RAW_NOT_FOUND','raw記録が見つかりません',404);throw e;}}
  save(m){atomicJson(this.file(m.id,'manifest.json'),m);return m;}
  list(){if(!fs.existsSync(this.root))return [];return fs.readdirSync(this.root).filter(id=>/^[a-f0-9-]{36}$/.test(id)).flatMap(id=>{try{return [this.get(id)];}catch{return [];}}).sort((a,b)=>b.created_at.localeCompare(a.created_at));}
  create(header,processing,source){
    if(header?.kind!=='raw_adc_header'||header.schema_version!==1)throw new AppError('RAW_HEADER_REQUIRED','先頭にraw_adc_header schema_version 1が必要です');
    const config=validateRawConfig(header.config), applied=validateProcessing(config,processing), id=randomUUID();fs.mkdirSync(this.dir(id),{recursive:true});
    atomicJson(this.file(id,'source-config.json'),{declared:header,device_applied:'unknown; source-supplied metadata is not a sensor readback',source});atomicJson(this.file(id,'processing.json'),{requested:processing??{},applied});
    durable(this.file(id,'raw.envelopes.jsonl'),'');durable(this.file(id,'spectrum.jsonl'),'');
    return this.save({schema_version:1,id,created_at:new Date().toISOString(),state:'created',source,provenance:config.provenance,config,processing:applied,config_sha256:fileSha(this.file(id,'source-config.json')),processing_sha256:fileSha(this.file(id,'processing.json')),frame_count:0,processed_frames:0,raw_bytes:0,column_count:0,records:[],error:null,device_loss:'unknown',source_sequence_discontinuities:0,time_discontinuities:0,source_messages_not_saved:0,real_hardware_raw_verified:false,physical_direction_verified:false});
  }
  compute(bytes,config,processing,start){
    if(!this.worker){const worker=this.worker=new Worker(new URL('./raw-worker.mjs',import.meta.url));this.pending=new Map();const failed=error=>{if(this.worker!==worker)return;this.worker=null;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();};worker.on('message',m=>{const p=this.pending.get(m.id);if(p){clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(Object.assign(new Error(m.error.message),{code:m.error.code})):p.resolve(m.result);}});worker.on('error',failed);worker.on('exit',code=>{if(this.worker===worker)failed(Object.assign(new Error(`raw processor exited (${code})`),{code:'RAW_WORKER_EXIT'}));});}
    return new Promise((resolve,reject)=>{const id=++this.jobId;const timer=setTimeout(()=>{const worker=this.worker;this.worker=null;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Object.assign(new Error('raw processing timed out; original bytes retained'),{code:'RAW_PROCESSING_TIMEOUT'}));}this.pending.clear();worker?.terminate();},30000);this.pending.set(id,{resolve,reject,timer});this.worker.postMessage({id,bytes,config,processing,start});});
  }
  async ingest(id,frame,text,received={pc_receive_unix_ms:Date.now(),pc_receive_monotonic_ns:process.hrtime.bigint().toString()}){
    received={pc_receive_unix_ms:received.pc_receive_unix_ms,pc_receive_monotonic_ns:received.pc_receive_monotonic_ns};
    let m=this.get(id);const bytes=rawBytes(frame,m.config), previous=m.records.at(-1);
    if(m.acquisition_config_sha256&&m.acquisition_config_sha256!=='unknown'&&(frame.packet_protocol!=='RADC0002'||frame.acquisition_config_sha256!==m.acquisition_config_sha256))throw new AppError('RAW_CONFIG_CHANGED','取得中にprofile/hashが変わりました。異なる設定のADCを同じ記録へ混ぜません');
    if(m.frame_count>=RAW_LIMITS.frames||m.raw_bytes+bytes.length>RAW_LIMITS.capture_bytes)throw new AppError('RAW_CAPTURE_LIMIT','raw保存の上限に達しました');
    if(previous&&frame.sequence<=previous.source_sequence)throw new AppError('RAW_SEQUENCE_ORDER','raw入力連番が重複または逆行しています');
    if(previous&&frame.frame_start_s<previous.frame_start_s+m.config.chirps_per_frame*m.config.chirp_interval_s-1e-9)throw new AppError('RAW_TIME_OVERLAP','raw frameのsample時計が重複または逆行しています');
    if(previous&&frame.sequence!==previous.source_sequence+1)m.source_sequence_discontinuities++;
    // Historical field name: counts gaps between declared sample spans, including normal frame idle time.
    // It neither classifies a missing packet nor estimates hardware loss; source sequence gaps are separate.
    if(previous&&Math.abs(frame.frame_start_s-previous.frame_start_s-m.config.chirps_per_frame*m.config.chirp_interval_s)>1e-8)m.time_discontinuities++;
    const index=m.frame_count+1,bin=`adc-${String(index).padStart(6,'0')}.bin`,meta=`adc-${String(index).padStart(6,'0')}.json`;
    append(this.file(id,'raw.envelopes.jsonl'),{message_utf8:text,utf8_sha256:hash(text),...received});durable(this.file(id,bin),bytes);
    const metadata={receiver_sequence:index,source_sequence:frame.sequence,device_sequence:frame.device_sequence??'unknown',frame_start_s:frame.frame_start_s,time_basis:m.config.time_basis,device_capture_time:frame.device_capture_time??'unknown',...received,shape:[m.config.chirps_per_frame,m.config.rx_count,m.config.samples_per_chirp],layout:m.config.layout,packet_protocol:frame.packet_protocol??'source_declared',acquisition_config_sha256:frame.acquisition_config_sha256??'unknown',sample_format:m.config.sample_format,payload_sha256:hash(bytes),config_sha256:m.config_sha256};
    atomicJson(this.file(id,meta),metadata);m.records.push({file:bin,metadata_file:meta,sha256:hash(bytes),metadata_sha256:fileSha(this.file(id,meta)),source_sequence:frame.sequence,frame_start_s:frame.frame_start_s});m.frame_count++;m.raw_bytes+=bytes.length;this.save(m);
    const result=await this.compute(bytes,m.config,m.processing,frame.frame_start_s);
    for(const column of result.columns)append(this.file(id,'spectrum.jsonl'),{...column,receiver_sequence:index,source_sequence:frame.sequence});
    m=this.get(id);m.acquisition_phase='acquiring';m.processed_frames++;m.column_count+=result.columns.length;const {columns,...axes}=result;m.axes=axes;
    const elapsed=Number(process.hrtime.bigint()-BigInt(received.pc_receive_monotonic_ns))/1e6;
    if(Number.isFinite(elapsed)&&elapsed>=0){const stats=m.pc_receive_to_processing_ms??{count:0,min:Infinity,max:0,sum:0};stats.count++;stats.min=Math.min(stats.min,elapsed);stats.max=Math.max(stats.max,elapsed);stats.sum+=elapsed;stats.last=elapsed;stats.mean=stats.sum/stats.count;m.pc_receive_to_processing_ms=stats;}
    m.last_pc_receive_unix_ms=received.pc_receive_unix_ms;this.save(m);
  }
  ensureIdle(){if(this.closed)throw new AppError('RAW_CLOSED','アプリが終了中です',409);if(this.runtime||this.deviceTask)throw new AppError('RAW_ALREADY_RUNNING','別のraw処理が動作中です',409);}
  async start({transport,url,header,processing,request_id,port,profile_id}={}){
    if(this.runtime&&request_id&&this.runtime.request_id===request_id)return this.get(this.runtime.id);
    this.ensureIdle();if(transport==='csk_current_firmware')throw new AppError(RAW_HARDWARE_STATUS.code,'標準検出FWのCSKをraw ADCとして扱いません。専用raw FWの取得元を選択してください',409);
    if(!['synthetic_raw','local_websocket_raw_adc','csk_raw_uart'].includes(transport))throw new AppError('RAW_TRANSPORT_UNSUPPORTED','未対応のraw取得経路です');
    const csk=transport==='csk_raw_uart',live=transport!=='synthetic_raw';if(live&&!this.canAcquire())throw new AppError('LIVE_SOURCE_BUSY','別の取得を停止してからraw取得を開始してください',409);
    if(transport==='local_websocket_raw_adc')localWebSocketUrl(url);
    if(profile_id&&!csk)throw new AppError('RAW_PROFILE_TRANSPORT','profile選択はCSK raw UART専用です');
    const settings=csk?rawCskSettings(profile_id):null,fixture=live?null:syntheticRaw(),m=this.create(csk?settings.header:live?header:fixture.header,processing,{kind:transport,network:csk?'none':live?'loopback producer':'none',hardware:csk?'CSK FIFO via independent raw firmware':live?'source-declared; not independently verified':'none',...(csk?{port:port??'COM10',requested_profile_id:profile_id??'legacy-fixed',requested_acquisition_config_sha256:settings.acquisition_profile?.config_sha256??'unknown'}:{})});
    const runtime=this.runtime={id:m.id,request_id,live,stop:false,heartbeat:performance.now()};this.busy=live;m.state='running';m.acquisition_phase=csk?'connecting':'awaiting_adc';m.phase_updated_at=new Date().toISOString();this.save(m);
    runtime.job=(async()=>{try{
      if(live){const onProgress=phase=>{if(!runtime.stop&&['connecting','firmware_identity','configuration_apply','configuration_readback','awaiting_adc'].includes(phase)){const current=this.get(m.id);current.acquisition_phase=phase;current.phase_updated_at=new Date().toISOString();this.save(current);}};const onApplied=metadata=>{const current=this.get(m.id);if(runtime.stop&&!metadata.validation_error)throw new AppError('RAW_CONFIG_CANCELLED','停止要求後はSTARTを許可しません');atomicJson(this.file(m.id,'source-config.json'),{declared:settings.header,requested_profile:settings.acquisition_profile??null,device_applied:metadata,requested_registers:settings.requested_registers,deployment_descriptor:settings.readback_fingerprint?settings:undefined,source:current.source});current.config_sha256=fileSha(this.file(m.id,'source-config.json'));current.applied_config_validation=metadata.register_readback_validation??'unknown';current.acquisition_config_sha256=metadata.acquisition_config_sha256??'unknown';current.configuration_accepted=!metadata.validation_error;this.save(current);};runtime.adapter=csk?this.cskFactory({port:port??'COM10',settings,dir:this.dir(m.id),onProgress,onApplied}):this.factory(url);await runtime.adapter.open();onProgress('awaiting_adc');
        if(csk){onApplied(runtime.adapter.metadata);const current=this.get(m.id);current.firmware_identity_confirmed=true;this.save(current);}
        while(!runtime.stop){if(performance.now()-runtime.heartbeat>this.leaseMs)throw new AppError('RAW_HEARTBEAT_LOST','画面からの確認が途絶えたためraw取得を停止しました');const item=runtime.adapter.read();if(item){await this.ingest(m.id,JSON.parse(item.text),item.text,item);if(csk){const current=this.get(m.id);current.real_hardware_raw_verified=true;this.save(current);}}else await wait(10);}await runtime.adapter.stop();for(;;){const item=runtime.adapter.read();if(!item)break;await this.ingest(m.id,JSON.parse(item.text),item.text,item);}}
      else for(const frame of fixture.frames){if(runtime.stop)break;await this.ingest(m.id,frame,JSON.stringify(frame));await wait(100);}
      const final=this.get(m.id);final.state=runtime.stop?'stopped':'completed';final.acquisition_phase=final.state;this.save(final);
    }catch(error){const final=this.get(m.id);final.state='error';final.acquisition_phase='error';final.error=errorInfo(error);this.save(final);}finally{try{await runtime.adapter?.stop();const final=this.get(m.id);final.source_messages_not_saved=runtime.adapter?.discarded??0;if(csk){final.transport_diagnostics=runtime.adapter?.diagnostics();if(final.transport_diagnostics?.start_sent===true&&final.transport_diagnostics?.stop_acknowledged===false&&final.state!=='error'){final.state='error';final.acquisition_phase='error';final.error={code:'RAW_STOP_UNCONFIRMED',message:'STOP応答を確認できませんでした。機器の停止は未確認です。保存済みbytesは保持しています'};}if(!final.configuration_accepted&&runtime.adapter?.observedConfiguration){atomicJson(this.file(m.id,'configuration-failure.json'),runtime.adapter.observedConfiguration);final.configuration_failure_sha256=fileSha(this.file(m.id,'configuration-failure.json'));}}final.envelopes_sha256=fileSha(this.file(m.id,'raw.envelopes.jsonl'));final.spectrum_sha256=fileSha(this.file(m.id,'spectrum.jsonl'));this.save(final);}finally{this.runtime=null;this.busy=false;}}})();return this.get(m.id);
  }
  async probeDevice({port}={}){
    this.ensureIdle();if(!this.canAcquire())throw new AppError('LIVE_SOURCE_BUSY','別の取得を停止してからFW機能を確認してください',409);
    if(!/^COM\d{1,3}$/i.test(port))throw new AppError('INVALID_COM_PORT','このPCのCOM番号を指定してください');
    this.busy=true;const task=this.deviceTask=Promise.resolve().then(async()=>{const dir=path.join(this.root,'device-probes',randomUUID());try{fs.mkdirSync(dir,{recursive:true});const result=await this.cskProbe({port,dir});atomicJson(path.join(dir,'result.json'),result);return result;}finally{this.busy=false;this.deviceTask=null;}});return task;
  }
  async importFile(staged,processing){
    this.ensureIdle();let m, runtime, iterator;
    try{iterator=this.lines(staged)[Symbol.asyncIterator]();const first=await iterator.next();m=this.create(JSON.parse(first.value),processing,{kind:'raw_jsonl_import',hardware:'source-declared; not independently verified'});fs.renameSync(staged,this.file(m.id,'source.raw.jsonl'));m.source_sha256=fileSha(this.file(m.id,'source.raw.jsonl'));m.state='running';this.save(m);runtime=this.runtime={id:m.id,live:false,stop:false};
      runtime.job=(async()=>{try{for(;;){if(runtime.stop)break;const line=await iterator.next();if(line.done)break;await this.ingest(m.id,JSON.parse(line.value),line.value);}const final=this.get(m.id);final.state=runtime.stop?'stopped':'completed';final.acquisition_phase=final.state;this.save(final);}catch(error){const final=this.get(m.id);final.state='error';final.acquisition_phase='error';final.error=errorInfo(error);this.save(final);}finally{await iterator.return?.();const final=this.get(m.id);final.envelopes_sha256=fileSha(this.file(m.id,'raw.envelopes.jsonl'));final.spectrum_sha256=fileSha(this.file(m.id,'spectrum.jsonl'));this.save(final);this.runtime=null;}})();return this.get(m.id);
    }catch(error){await iterator?.return?.();if(fs.existsSync(staged))fs.unlinkSync(staged);throw error;}
  }
  async *lines(file,startByte=0){let pending='',discard=startByte>0;for await(const chunk of fs.createReadStream(file,{encoding:'utf8',start:startByte,highWaterMark:65536})){pending+=chunk;if(pending.length>3*1024*1024&&!pending.includes('\n'))throw new AppError('RAW_LINE_TOO_LARGE','raw JSONLの1行は3 MiB以下です');for(;;){const i=pending.indexOf('\n');if(i<0)break;const line=pending.slice(0,i).replace(/\r$/,'');pending=pending.slice(i+1);if(discard){discard=false;continue;}if(line.length>3*1024*1024)throw new AppError('RAW_LINE_TOO_LARGE','raw JSONLの1行は3 MiB以下です');if(line)yield line;}}if(pending.trim()&&!discard)yield pending;}
  async stop(id){const r=this.runtime;if(!r||r.id!==id)return this.get(id);r.stop=true;const m=this.get(id);m.state='stopping';m.acquisition_phase='stopping';this.save(m);await r.job;return this.get(id);}
  async view(id,{start=0,end=Infinity,tail=true}={}){
    const m=this.get(id);if(this.runtime?.id===id)this.runtime.heartbeat=performance.now();
    if(!Number.isFinite(start)||start<0||!(Number.isFinite(end)||end===Infinity)||end<start)throw new AppError('RAW_WINDOW_INVALID','raw表示時間が不正です');
    const file=this.file(id,'spectrum.jsonl'),size=(await fs.promises.stat(file)).size,begin=tail?Math.max(0,size-8*1024*1024):0,columns=[];let matched=0,read=0;
    for await(const line of this.lines(file,begin)){let column;try{column=JSON.parse(line);}catch{continue;}if(column.time_s>end)break;if(column.time_s>=start){matched++;columns.push(column);if(columns.length>RAW_LIMITS.columns)columns.shift();}if(++read%64===0)await new Promise(resolve=>setImmediate(resolve));}
    return {manifest:m,columns,history_truncated:begin>0,display_omitted_columns:Math.max(0,matched-columns.length),raw_capture_modified:false};
  }
  verify(id){const m=this.get(id),errors=[];for(const r of m.records)for(const [name,expected]of [[r.file,r.sha256],[r.metadata_file,r.metadata_sha256]]){try{if(fileSha(this.file(id,name))!==expected)errors.push(name);}catch{errors.push(name);}}
    for(const [name,expected]of [['source-config.json',m.config_sha256],['processing.json',m.processing_sha256],['source.raw.jsonl',m.source_sha256],['raw.envelopes.jsonl',m.envelopes_sha256],['spectrum.jsonl',m.spectrum_sha256],['configuration-failure.json',m.configuration_failure_sha256]])if(expected&&fileSha(this.file(id,name))!==expected)errors.push(name);
    const actualBins=fs.readdirSync(this.dir(id)).filter(x=>/^adc-\d+\.bin$/.test(x)).length;if(!m.frame_count)errors.push('no raw frames');if(actualBins!==m.frame_count)errors.push('unindexed raw files');if(m.processed_frames!==m.frame_count)errors.push('unprocessed raw frames');if(['running','stopping'].includes(m.state))errors.push('capture still running');return {ok:!errors.length,errors,frames:m.frame_count,processed:m.processed_frames,device_loss:m.device_loss,provenance:m.provenance};
  }
  exportFiles(id){if(!this.verify(id).ok)throw new AppError('RAW_READBACK_FAILED','raw読み戻し検証に失敗しました');return fs.readdirSync(this.dir(id)).filter(name=>/^[a-zA-Z0-9.-]+$/.test(name)).map(name=>({name,path:this.file(id,name)}));}
  async close(){this.closed=true;await this.deviceTask?.catch(()=>{});if(this.runtime)await this.stop(this.runtime.id);await this.worker?.terminate();}
}
