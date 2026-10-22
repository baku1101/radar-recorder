import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {rawCskSettings} from '../src/csk-raw.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if(Number(process.versions.node.split('.')[0])<22)throw new Error('Node 22+ required');
const s=rawCskSettings();if(s.firmware!=='radc-0.2.0')throw new Error('Unexpected deployment descriptor');
const probe=path.join(root,'.doctor-write-'+process.pid);try{fs.writeFileSync(probe,'ok',{flag:'wx'});}finally{if(fs.existsSync(probe))fs.unlinkSync(probe);}
console.log('OK Node '+process.versions.node+' / 書込権限 / raw deployment descriptor');
console.log('FW '+s.firmware+' / '+s.header.config.chirps_per_frame+' chirps / '+s.header.config.samples_per_chirp+' samples / '+s.header.config.rx_count+' RX');
console.log('センサーへの接続・設定変更・取得開始は行っていません。');
