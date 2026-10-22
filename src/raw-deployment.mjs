// Portable deployment facts and fingerprints; no vendor register array is shipped.
import {hash} from './raw-dsp.mjs';
import {AppError} from './adapters.mjs';
export const calibrationLocation = a => a>=0x2014&&a<=0x2324&&((a-0x2014)%0x100)<=0x10&&a%4===0;
export function readbackFingerprints(bytes) {
 if(bytes.length%8)throw new AppError('RAW_CSK_READBACK_INVALID','設定読戻しの長さが不正です');
 const addresses=[],values=[],excluded=[];
 for(let i=0;i<bytes.length;i+=8){const a=bytes.readUInt32LE(i);addresses.push(bytes.subarray(i,i+4));if(calibrationLocation(a))excluded.push({address:a,readback:bytes.readUInt32LE(i+4),meaning:'unknown'});else values.push(bytes.subarray(i,i+8));}
 return {register_count:bytes.length/8,address_order_sha256:hash(Buffer.concat(addresses)),non_calibration_sha256:hash(Buffer.concat(values)),non_calibration_count:values.length,excluded_calibration_values:excluded};
}
export function validateDeploymentReadback(settings, bytes, info) {
 const requested=settings.requested_registers,expected=settings.readback_fingerprint;
 const count=requested?.length??expected?.register_count;
 if(info?.register_count!==count||bytes.length!==count*8)throw new AppError('RAW_CSK_READBACK_INVALID','設定読戻しの件数が一致しません');
 if(requested){
  if(requested.some((r,i)=>r[0]!==bytes.readUInt32LE(i*8)))throw new AppError('RAW_CSK_READBACK_INVALID','設定読戻しの順序が一致しません');
  const differences=requested.flatMap(([address,value],i)=>{const actual=bytes.readUInt32LE(i*8+4);return actual===value?[]:[{address,requested:value,readback:actual}];});
  if(differences.some(d=>!calibrationLocation(d.address)))throw new AppError('RAW_CSK_REGISTER_MISMATCH','実機の設定読戻しが一致しません。元bytesを保持して停止します');
  return {requested_count:count,exact_value_matches:count-differences.length,differences,exception_scope:'ADC calibration configuration locations; readback semantics unknown; not proof of calibration accuracy',other_requested_values_match:true};
 }
 const actual=readbackFingerprints(bytes);
 if(actual.address_order_sha256!==expected?.address_order_sha256||actual.non_calibration_sha256!==expected?.non_calibration_sha256||actual.non_calibration_count!==expected?.non_calibration_count)throw new AppError('RAW_CSK_REGISTER_MISMATCH','実機の設定fingerprintが対応profileと一致しません。別FWでの取得は開始できません');
 return {method:'profile_fingerprint_without_distributed_register_values',profile_register_count:count,matched_non_calibration_count:actual.non_calibration_count,address_order_matches:true,non_calibration_profile_matches:true,excluded_calibration_values:actual.excluded_calibration_values,exception_scope:'ADC calibration configuration locations excluded; meaning and calibration accuracy unknown; no expected individual calibration values distributed',pc_wrote_registers:false};
}
