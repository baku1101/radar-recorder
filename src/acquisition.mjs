import fs from 'node:fs';import {fileURLToPath} from 'node:url';import {hash,validateRawConfig} from './raw-dsp.mjs';import {AppError} from './adapters.mjs';
const fail=message=>{throw new AppError('RAW_PROFILE_INVALID',message);};
function stable(v){if(Array.isArray(v))return v.map(stable);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])]));return v;}
export function configDigest(value){return hash(JSON.stringify(stable(value)).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')));}
export function validateProfile(p){
 if(!p||!/^[a-z][a-z0-9-]{0,31}$/.test(p.id))fail('取得profile IDが不正です');
 const {config_sha256,...unsigned}=p;if(configDigest(unsigned)!==config_sha256)fail('取得profileのmetadata hashが一致しません');
 const c=validateRawConfig(p.header?.config),n=c.chirps_per_frame*c.rx_count*c.samples_per_chirp;
 if(n>8192||n%2||p.limits.samples_total!==n||p.limits.fifo_words!==n/2||c.frame_period_s<c.chirps_per_frame*c.chirp_interval_s||(c.frame_bytes+64)/c.frame_period_s>170000)fail('FIFO・観測時間・UART帯域の対応範囲を超えています');
 if(!/^[a-f0-9]{64}$/.test(p.profile_sha256)||p.readback_fingerprint.register_count!==433)fail('読戻し照合情報が不正です');
 return structuredClone(p);
}
export function acquisitionCatalog(){
 const c=JSON.parse(fs.readFileSync(fileURLToPath(new URL('../profiles/acquisition-presets.json',import.meta.url)),'utf8'));
 const {catalog_sha256,...unsigned}=c;if(configDigest(unsigned)!==catalog_sha256)fail('取得profile一覧のhashが一致しません');
 c.profiles=c.profiles.map(validateProfile);return c;
}
export function acquisitionProfile(id){const c=acquisitionCatalog(),p=c.profiles.find(p=>p.id===id);if(!p)throw new AppError('RAW_PROFILE_UNSUPPORTED','対応する取得profileを選択してください');return {...p,catalog_sha256:c.catalog_sha256};}
