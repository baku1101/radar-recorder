import {acquisitionProfile,acquisitionCatalog} from './acquisition.mjs';
// Independent UART producer adapter; official driver assets remain private.
import fs from 'node:fs';import path from 'node:path';import readline from 'node:readline';import {spawn,execFile} from 'node:child_process';import {promisify} from 'node:util';import {fileURLToPath} from 'node:url';import {performance} from 'node:perf_hooks';
import {validateDeploymentReadback} from './raw-deployment.mjs';import {portableRuntime} from './portable-runtime.mjs';import {cskRuntime} from './live.mjs';import {AppError} from './adapters.mjs';import {RawPacketParser} from './raw-packet.mjs';import {hash,validateRawConfig,RAW_LIMITS} from './raw-dsp.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function rawCskSettings(profileId){
 if(profileId){const p=acquisitionProfile(profileId);const legacy=rawCskSettings();return {...p,acquisition_profile:p,header:p.header,firmware:'radc-0.3.0',profile_header_sha256:legacy.profile_header_sha256,legacy_settings:profileId==='japan-default'?legacy:null};}
 const legacy=path.join(root,'.runtime','csk-profiles','raw-deployment.json');
 const file=process.env.RADAR_CSK_RAW_SETTINGS??(fs.existsSync(legacy)?legacy:path.join(root,'profiles','radc-0.2.0-japan128.json'));
 if(!fs.existsSync(file))throw new AppError('RAW_CSK_NOT_DEPLOYED','実機raw FWと設定が未準備です。READMEの実機準備手順を確認してください',409);
 const s=JSON.parse(fs.readFileSync(file,'utf8')),c=validateRawConfig(s.header?.config);
 if(c.data_kind!=='real_adc'||c.sample_format!=='uint16_le'||c.time_basis!=='device_fifo_callback_clock_with_configured_chirp_spacing')throw new AppError('RAW_CSK_SETTINGS_INVALID','CSK FIFOはuint16実数ADCとcallback時計の明示が必要です');
 if(s.firmware!=='radc-0.2.0'||!/^[a-f0-9]{64}$/.test(s.profile_header_sha256)||(!Array.isArray(s.requested_registers)&&!s.readback_fingerprint))throw new AppError('RAW_CSK_SETTINGS_INVALID','raw実機設定の識別情報が不正です');const fp=s.readback_fingerprint;
 if(!s.requested_registers&&(!Number.isInteger(fp?.register_count)||fp.register_count<1||fp.register_count>4096||!Number.isInteger(fp.non_calibration_count)||fp.non_calibration_count<1||fp.non_calibration_count>fp.register_count||![fp.address_order_sha256,fp.non_calibration_sha256].every(v=>/^[a-f0-9]{64}$/.test(v))))throw new AppError('RAW_CSK_SETTINGS_INVALID','配布profileのfingerprintが不正です');
 return s;
}
export function rawCskRuntime(){
 const portable=portableRuntime(root),python=process.env.RADAR_RAW_PYTHON??process.env.RADAR_CSK_PYTHON??portable?.python??path.join(root,'.runtime','python311','python.exe');
 return {python,serialLib:process.env.RADAR_RAW_SERIAL_LIB??process.env.RADAR_CSK_VENDOR_LIB??(!portable?cskRuntime().vendorLib:undefined)};
}
export class CskRawAdapter{
 constructor({port='COM10',settings,dir,launch=spawn,runtime=rawCskRuntime(),onProgress=()=>{},onApplied=()=>{}}={}){if(!/^COM\d{1,3}$/i.test(port))throw new AppError('INVALID_COM_PORT','COM番号を指定してください');Object.assign(this,{port,settings,dir,launch,runtime,onProgress,onApplied});this.queue=[];this.bytes=0;this.discarded=0;this.stopping=false;this.firstTick=null;this.lastTick=null;this.wrap=0;this.last=performance.now();}
 async open(){
  const r=this.runtime;if(!fs.existsSync(r.python))throw new AppError('RAW_CSK_RUNTIME_REQUIRED','専用Pythonがありません。setup.cmdを実行し、doctor.cmdで確認してください');
  const c=validateRawConfig(this.settings.header.config);this.parser=new RawPacketParser({frameBytes:c.frame_bytes});
  this.parser.on('frame',f=>{try{if(this.lastTick!==null&&f.callback_tick_ms<this.lastTick){if(this.lastTick-f.callback_tick_ms>0x80000000)this.wrap+=2**32;else throw new Error('MCU callback clock moved backwards');}this.lastTick=f.callback_tick_ms;const tick=this.wrap+this.lastTick;if(this.firstTick===null)this.firstTick=tick;
   const frame={kind:'raw_adc_frame',packet_protocol:f.packet_protocol,acquisition_config_sha256:f.acquisition_config_sha256,sequence:f.packet_sequence,frame_start_s:(tick-this.firstTick)/1000,device_sequence:'unknown',device_capture_time:'unknown',callback_tick_ms:f.callback_tick_ms,firmware_packet_sequence:f.packet_sequence,reported_queue_drops:f.queue_drops,packet_sequence_discontinuity:f.packet_sequence_discontinuity,crc_errors_before_frame:this.parser.crcErrors,unframed_bytes_before_frame:this.parser.skippedBytes,physical_frame_origin_uncertainty_s:'unknown',original_packet_base64:f.wire_packet.toString('base64'),payload_base64:f.payload.toString('base64'),payload_sha256:hash(f.payload)};
   const text=JSON.stringify(frame),size=Buffer.byteLength(text);if(this.queue.length>=RAW_LIMITS.queue||this.bytes+size>16*1024*1024){this.discarded++;throw new Error('Raw UART saving/processing queue overflow; stopping');}
   this.bytes+=size;this.last=performance.now();this.queue.push({text,size,pc_receive_unix_ms:Date.now(),pc_receive_monotonic_ns:process.hrtime.bigint().toString()});
  }catch(e){this.failure??=e;}});
  this.child=this.launch(r.python,['-u',path.join(root,'src','csk-raw-reader.py'),...((r.serialLib??r.vendorLib)?['--vendor-lib',r.serialLib??r.vendorLib]:[]),'--port',this.port,'--wire',path.join(this.dir,'uart-wire.bin'),'--profile-sha256',this.settings.profile_header_sha256,...(this.settings.acquisition_profile?['--profile-id',this.settings.id,'--catalog-sha256',this.settings.catalog_sha256,'--config-sha256',this.settings.config_sha256]:[])],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONUTF8:'1'}});
  const child=this.child;child.stdin.on('error',()=>{});child.stdout.on('data',b=>{try{this.parser.push(b);}catch(e){this.failure??=e;}});this.lines=readline.createInterface({input:child.stderr});
  this.exited=new Promise(resolve=>child.once('exit',code=>{this.exitCode=code;if(!this.stopping)this.failure??=new AppError('RAW_CSK_DISCONNECTED',`raw受信プロセスが終了しました (${code})`);resolve();}));
  await new Promise((resolve,reject)=>{let settled=false;const finish=e=>{if(settled)return;settled=true;clearTimeout(timer);e?reject(e):resolve();},timer=setTimeout(()=>finish(new AppError('RAW_CSK_CONNECT_TIMEOUT','実機rawの識別・設定読戻しがタイムアウトしました')),25000);
   child.once('error',finish);child.once('exit',()=>finish(this.failure??new Error('Raw reader exited before ready')));
   this.lines.on('line',line=>{let m;try{m=JSON.parse(line);}catch{return;}if(m.kind==='progress'){try{this.onProgress(m.phase);}catch(e){this.failure=e;finish(e);return;}}if(m.kind==='error'){this.failure=new AppError('RAW_CSK_CONNECTION_FAILED',m.message);finish(this.failure);}if(m.kind==='configured'||m.kind==='ready'){
    const p=this.settings.acquisition_profile,legacy=!!m.legacy_profile_fixed,info=m.applied_configuration??m.firmware_info,b=Buffer.from(m.register_readback_base64??'','base64');this.observedConfiguration=m;
    try{
     const settings=legacy&&p?this.settings.legacy_settings:this.settings;
     if(!settings)throw new AppError('RAW_CONFIG_UNSUPPORTED','旧FWでは標準profileのみ使用できます');
     if(info?.chirps!==c.chirps_per_frame||info?.rx!==c.rx_count||info?.samples!==c.samples_per_chirp||hash(b)!==m.register_readback_sha256)throw new AppError('RAW_CSK_READBACK_INVALID','実機rawのshape・読戻しhashが一致しません');
     if(p&&!legacy&&(m.firmware_info?.config_protocol!=='RADC_CONFIG_1'||m.firmware_info.catalog_sha256!==this.settings.catalog_sha256||info.profile_id!==p.id||info.config_sha256!==p.config_sha256||info.profile_sha256!==p.profile_sha256||!info.configured))throw new AppError('RAW_CONFIG_MISMATCH','適用profile/hashが要求と一致しません。STARTしません');
     this.metadata={...m,register_readback_validation:validateDeploymentReadback(settings,b,info),parameter_verification:{declared_values:'offline SDK getter roundtrip',confirmation:'matched non-calibration register contents only; excluded calibration values retained with unknown semantics',not_established:'complete field dependency coverage, physical RF/clock accuracy, new-profile ADC coding and averaging amplitude scale'},acquisition_config_sha256:p&&!legacy?p.config_sha256:'unknown',legacy_profile_fixed:legacy};
     if(m.kind==='configured'){
      if(this.stopping)throw new AppError('RAW_CONFIG_CANCELLED','停止要求後はSTARTしません');
      this.parser.expectedConfigSha256=p.config_sha256;this.onApplied(this.metadata);child.stdin.write('accept:'+p.config_sha256+'\n');
     }else finish();
    }catch(e){this.failure=e;try{this.onApplied({...m,validation_error:{code:e.code,message:e.message}});}catch{}finish(e);return;}
   }if(m.kind==='stopped')this.stopMetadata=m;});
  }).catch(async e=>{await this.stop();throw e;});
 }
 read(){const item=this.queue.shift();if(item){this.bytes-=item.size;return item;}if(this.failure&&!this.stopping)throw this.failure;if(!this.stopping&&performance.now()-this.last>8000)throw new AppError('RAW_CSK_IDLE_TIMEOUT','実機ADC frameを8秒受信できません。元wireを保存して停止します');return null;}
 async stop(){if(this.stopJob)return this.stopJob;this.stopping=true;return this.stopJob=(async()=>{if(!this.child)return;this.child.stdin.end('stop\n');let timer;await Promise.race([this.exited,new Promise(resolve=>{timer=setTimeout(()=>{this.child.kill();this.forcedStop=true;resolve();},3000);})]);clearTimeout(timer);this.lines?.close();})();}
 diagnostics(){const tail=this.parser?.buffer??Buffer.alloc(0);return{crc_errors:this.parser?.crcErrors??0,unframed_bytes:this.parser?.skippedBytes??0,unframed_includes_identity_readback_status:true,partial_packet_bytes:tail.subarray(0,4).equals(Buffer.from('RADC'))?tail.length:0,unframed_tail_bytes:tail.length,port_closed:this.stopMetadata?.port_closed??'unknown',forced_stop:this.forcedStop??false,commands:this.stopMetadata?.commands??this.metadata?.commands??[],start_sent:this.stopMetadata?.start_sent??'unknown',stop_acknowledged:this.stopMetadata?.stop_acknowledged??'unknown',device_loss:'unknown'};}
}

export async function probeCsk({port,dir,runtime=rawCskRuntime(),execute=promisify(execFile)}){
 if(!/^COM\d{1,3}$/i.test(port))throw new AppError('INVALID_COM_PORT','COM番号が不正です');
 const catalog=acquisitionCatalog();
 const args=['-u',path.join(root,'src','csk-raw-reader.py'),'--operation','probe','--port',port,'--wire',path.join(dir,'identity-wire.bin'),...((runtime.serialLib??runtime.vendorLib)?['--vendor-lib',runtime.serialLib??runtime.vendorLib]:[])];
 const {stderr}=await execute(runtime.python,args,{windowsHide:true,timeout:10000,maxBuffer:65536,env:{...process.env,PYTHONUTF8:'1'}});
 const messages=stderr.split(/\r?\n/).flatMap(s=>{try{return[JSON.parse(s)];}catch{return[];}}),m=messages.find(m=>m.kind==='probe');
 if(!m)throw new AppError('RAW_DEVICE_PROBE_FAILED','FW機能を確認できませんでした');
 return {...m,port,configuration_supported:m.firmware_info?.firmware==='radc-0.3.0'&&m.firmware_info.catalog_sha256===catalog.catalog_sha256,observed_at:new Date().toISOString(),port_closed:messages.some(m=>m.kind==='stopped'&&m.port_closed),configuration_written:false,acquisition_started:false};
}
