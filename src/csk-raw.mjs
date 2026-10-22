// Independent UART producer adapter; official driver assets remain private.
import fs from 'node:fs';import path from 'node:path';import readline from 'node:readline';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';import {performance} from 'node:perf_hooks';
import {validateDeploymentReadback} from './raw-deployment.mjs';import {portableRuntime} from './portable-runtime.mjs';import {cskRuntime} from './live.mjs';import {AppError} from './adapters.mjs';import {RawPacketParser} from './raw-packet.mjs';import {hash,validateRawConfig,RAW_LIMITS} from './raw-dsp.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function rawCskSettings(){
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
 constructor({port='COM10',settings,dir,launch=spawn,runtime=rawCskRuntime(),onProgress=()=>{}}={}){if(!/^COM\d{1,3}$/i.test(port))throw new AppError('INVALID_COM_PORT','COM番号を指定してください');Object.assign(this,{port,settings,dir,launch,runtime,onProgress});this.queue=[];this.bytes=0;this.discarded=0;this.stopping=false;this.firstTick=null;this.lastTick=null;this.wrap=0;this.last=performance.now();}
 async open(){
  const r=this.runtime;if(!fs.existsSync(r.python))throw new AppError('RAW_CSK_RUNTIME_REQUIRED','専用Pythonがありません。setup.cmdを実行し、doctor.cmdで確認してください');
  const c=validateRawConfig(this.settings.header.config);this.parser=new RawPacketParser({frameBytes:c.frame_bytes});
  this.parser.on('frame',f=>{try{if(this.lastTick!==null&&f.callback_tick_ms<this.lastTick){if(this.lastTick-f.callback_tick_ms>0x80000000)this.wrap+=2**32;else throw new Error('MCU callback clock moved backwards');}this.lastTick=f.callback_tick_ms;const tick=this.wrap+this.lastTick;if(this.firstTick===null)this.firstTick=tick;
   const frame={kind:'raw_adc_frame',sequence:f.packet_sequence,frame_start_s:(tick-this.firstTick)/1000,device_sequence:'unknown',device_capture_time:'unknown',callback_tick_ms:f.callback_tick_ms,firmware_packet_sequence:f.packet_sequence,reported_queue_drops:f.queue_drops,packet_sequence_discontinuity:f.packet_sequence_discontinuity,crc_errors_before_frame:this.parser.crcErrors,unframed_bytes_before_frame:this.parser.skippedBytes,physical_frame_origin_uncertainty_s:'unknown',original_packet_base64:f.wire_packet.toString('base64'),payload_base64:f.payload.toString('base64'),payload_sha256:hash(f.payload)};
   const text=JSON.stringify(frame),size=Buffer.byteLength(text);if(this.queue.length>=RAW_LIMITS.queue||this.bytes+size>16*1024*1024){this.discarded++;throw new Error('Raw UART saving/processing queue overflow; stopping');}
   this.bytes+=size;this.last=performance.now();this.queue.push({text,size,pc_receive_unix_ms:Date.now(),pc_receive_monotonic_ns:process.hrtime.bigint().toString()});
  }catch(e){this.failure??=e;}});
  this.child=this.launch(r.python,['-u',path.join(root,'src','csk-raw-reader.py'),...((r.serialLib??r.vendorLib)?['--vendor-lib',r.serialLib??r.vendorLib]:[]),'--port',this.port,'--wire',path.join(this.dir,'uart-wire.bin'),'--profile-sha256',this.settings.profile_header_sha256],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONUTF8:'1'}});
  const child=this.child;child.stdin.on('error',()=>{});child.stdout.on('data',b=>{try{this.parser.push(b);}catch(e){this.failure??=e;}});this.lines=readline.createInterface({input:child.stderr});
  this.exited=new Promise(resolve=>child.once('exit',code=>{this.exitCode=code;if(!this.stopping)this.failure??=new AppError('RAW_CSK_DISCONNECTED',`raw受信プロセスが終了しました (${code})`);resolve();}));
  await new Promise((resolve,reject)=>{let settled=false;const finish=e=>{if(settled)return;settled=true;clearTimeout(timer);e?reject(e):resolve();},timer=setTimeout(()=>finish(new AppError('RAW_CSK_CONNECT_TIMEOUT','実機rawの識別・設定読戻しがタイムアウトしました')),15000);
   child.once('error',finish);child.once('exit',()=>finish(this.failure??new Error('Raw reader exited before ready')));
   this.lines.on('line',line=>{let m;try{m=JSON.parse(line);}catch{return;}if(m.kind==='progress'){try{this.onProgress(m.phase);}catch(e){this.failure=e;finish(e);return;}}if(m.kind==='error'){this.failure=new AppError('RAW_CSK_CONNECTION_FAILED',m.message);finish(this.failure);}if(m.kind==='ready'){
    const info=m.firmware_info,b=Buffer.from(m.register_readback_base64??'','base64');
    try{
     if(info?.chirps!==c.chirps_per_frame||info?.rx!==c.rx_count||info?.samples!==c.samples_per_chirp||hash(b)!==m.register_readback_sha256)throw new AppError('RAW_CSK_READBACK_INVALID','実機rawのshape・読戻しhashが一致しません');
     this.metadata={...m,register_readback_validation:validateDeploymentReadback(this.settings,b,info)};
    }catch(e){this.failure=e;finish(e);return;}
    finish();}if(m.kind==='stopped')this.stopMetadata=m;});
  }).catch(async e=>{await this.stop();throw e;});
 }
 read(){const item=this.queue.shift();if(item){this.bytes-=item.size;return item;}if(this.failure&&!this.stopping)throw this.failure;if(!this.stopping&&performance.now()-this.last>8000)throw new AppError('RAW_CSK_IDLE_TIMEOUT','実機ADC frameを8秒受信できません。元wireを保存して停止します');return null;}
 async stop(){if(this.stopJob)return this.stopJob;this.stopping=true;return this.stopJob=(async()=>{if(!this.child)return;this.child.stdin.end('stop\n');let timer;await Promise.race([this.exited,new Promise(resolve=>{timer=setTimeout(()=>{this.child.kill();this.forcedStop=true;resolve();},3000);})]);clearTimeout(timer);this.lines?.close();})();}
 diagnostics(){const tail=this.parser?.buffer??Buffer.alloc(0);return{crc_errors:this.parser?.crcErrors??0,unframed_bytes:this.parser?.skippedBytes??0,unframed_includes_identity_readback_status:true,partial_packet_bytes:tail.subarray(0,8).equals(Buffer.from('RADC0001'))?tail.length:0,unframed_tail_bytes:tail.length,port_closed:this.stopMetadata?.port_closed??'unknown',forced_stop:this.forcedStop??false,commands:this.stopMetadata?.commands??this.metadata?.commands??[],device_loss:'unknown'};}
}
