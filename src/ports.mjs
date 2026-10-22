import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {fileURLToPath} from 'node:url';import {rawCskRuntime} from './csk-raw.mjs';import {AppError} from './adapters.mjs';
export async function enumeratePorts({runtime=rawCskRuntime(),execute=promisify(execFile)}={}){
 try{
  const args=['-I',fileURLToPath(new URL('./list-ports.py',import.meta.url)),...((runtime.serialLib??runtime.vendorLib)?['--serial-lib',runtime.serialLib??runtime.vendorLib]:[])];
  const {stdout}=await execute(runtime.python,args,{windowsHide:true,timeout:5000,maxBuffer:65536,env:{...process.env,PYTHONUTF8:'1'}});
  const ports=JSON.parse(stdout);if(!Array.isArray(ports)||ports.some(p=>!/^COM\d{1,3}$/i.test(p.port)))throw new Error('Invalid COM list');
  return {ports,port_opened:false,firmware_checked:false,driver_status:ports.length?'OS serial devices enumerated; raw firmware not checked':'unknown: disconnected, cable or driver may be missing'};
 }catch(e){throw new AppError('PORT_ENUMERATION_FAILED','COM一覧を取得できません。setup/doctorとWindowsデバイスマネージャーを確認してください: '+e.message,409);}
}
