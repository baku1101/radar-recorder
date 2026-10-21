// Independent FFT/STFT implementation; no manufacturer code or model assets.
import { createHash } from 'node:crypto';
const C = 299792458;
export const RAW_LIMITS = Object.freeze({ frame_bytes: 1024 * 1024, capture_bytes: 256 * 1024 * 1024, frames: 4096, columns: 4000, queue: 8 });
const fail = (code, message) => { throw Object.assign(new Error(message), { code, status: 400 }); };
const positive = x => typeof x === 'number' && Number.isFinite(x) && x > 0;
const pow2 = x => Number.isSafeInteger(x) && x > 0 && (x & (x - 1)) === 0;
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function validateRawConfig(config) {
  const c = structuredClone(config ?? {}), formats = { int16_le: 2, uint16_le: 2, float32_le: 4, complex64_le: 8 };
  if (!['real_adc', 'complex_iq'].includes(c.data_kind) || !formats[c.sample_format] || (c.data_kind === 'complex_iq') !== (c.sample_format === 'complex64_le')) fail('NOT_RAW_ADC', '実ADCまたは複素IQのsample_formatが必要です。検出点やFFTはraw ADC入力にできません');
  if (c.layout !== 'chirp_rx_sample') fail('RAW_LAYOUT_REQUIRED', '配列順序chirp_rx_sampleを明示してください');
  if (!pow2(c.samples_per_chirp) || c.samples_per_chirp < 16 || c.samples_per_chirp > 1024 || !Number.isSafeInteger(c.chirps_per_frame) || c.chirps_per_frame < 16 || c.chirps_per_frame > 512 || !Number.isSafeInteger(c.rx_count) || c.rx_count < 1 || c.rx_count > 3) fail('RAW_SHAPE_INVALID', 'shapeはsample 16〜1024の2の冪、chirp 16〜512、RX 1〜3です');
  for (const name of ['sample_rate_hz', 'chirp_interval_s', 'carrier_hz', 'chirp_slope_hz_per_s', 'adc_full_scale']) if (!positive(c[name])) fail('RAW_TIMING_UNKNOWN', `${name}の実値・単位が必要です。unknownから軸を推定しません`);
  if (c.samples_per_chirp / c.sample_rate_hz > c.chirp_interval_s || !Number.isFinite(c.sample_scale) || !Number.isFinite(c.sample_offset)) fail('RAW_TIMING_INVALID', 'chirp時間・sample scale/offsetが不正です');
  if (!['synthetic_sample_clock', 'device_sample_clock', 'producer_declared_sample_clock', 'device_fifo_callback_clock_with_configured_chirp_spacing'].includes(c.time_basis) || !c.timing_source || typeof c.timing_source.reference !== 'string' || !c.timing_source.reference) fail('RAW_TIMING_UNKNOWN', 'サンプル時計のbasisと設定/timingの出典を明示してください');
  if (!['synthetic', 'real'].includes(c.provenance) || (c.provenance === 'synthetic') !== (c.time_basis === 'synthetic_sample_clock')) fail('RAW_PROVENANCE_INVALID', '実データと合成データの由来・時計を区別してください');
  if (c.rx_order?.length !== c.rx_count || new Set(c.rx_order).size !== c.rx_count) fail('RAW_RX_ORDER_REQUIRED', 'RXの順序を明示してください');
  c.frame_bytes = c.samples_per_chirp * c.chirps_per_frame * c.rx_count * formats[c.sample_format];
  if (c.frame_bytes > RAW_LIMITS.frame_bytes) fail('RAW_FRAME_TOO_LARGE', 'raw frameは1 MiB以下です');
  return c;
}
export function validateProcessing(c, processing = {}) {
  const defaultWindow=Math.min(128,2**Math.floor(Math.log2(c.chirps_per_frame)));
  const p = { window_chirps: defaultWindow, hop_chirps: Math.max(1,defaultWindow/4), range_min_m: 0, range_max_m: C * c.sample_rate_hz / (4 * c.chirp_slope_hz_per_s), remove_static: false, ...processing };
  if (Object.keys(p).some(k => !['window_chirps', 'hop_chirps', 'range_min_m', 'range_max_m', 'remove_static'].includes(k)) || !pow2(p.window_chirps) || p.window_chirps < 16 || p.window_chirps > c.chirps_per_frame || !Number.isSafeInteger(p.hop_chirps) || p.hop_chirps < 1 || p.hop_chirps > p.window_chirps || typeof p.remove_static !== 'boolean' || !Number.isFinite(p.range_min_m) || !Number.isFinite(p.range_max_m) || p.range_min_m < 0 || p.range_max_m <= p.range_min_m) fail('RAW_PROCESSING_INVALID', 'STFT窓・hop・距離範囲・静止成分除去の指定が不正です');
  const dr = C * c.sample_rate_hz / (2 * c.chirp_slope_hz_per_s * c.samples_per_chirp);
  p.range_bins = Array.from({ length: c.samples_per_chirp / 2 - 1 }, (_, k) => k + 1).filter(k => k * dr >= p.range_min_m && k * dr <= p.range_max_m);
  if (!p.range_bins.length) fail('RAW_RANGE_EMPTY', '距離範囲にrange FFTのbinがありません');
  return p;
}
export function fft(re, im) {
  const n = re.length; if (!pow2(n) || im.length !== n) fail('FFT_SIZE', 'FFT長が不正です');
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let length = 2; length <= n; length *= 2) {
    const angle = -2 * Math.PI / length, cr = Math.cos(angle), ci = Math.sin(angle);
    for (let i = 0; i < n; i += length) { let wr = 1, wi = 0; for (let j = 0; j < length / 2; j++) {
      const a = i + j, b = a + length / 2, tr = wr * re[b] - wi * im[b], ti = wr * im[b] + wi * re[b];
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      [wr, wi] = [wr * cr - wi * ci, wr * ci + wi * cr];
    } }
  }
}
const hann = n => Float64Array.from({ length: n }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / (n - 1)));
export function decodeRaw(bytes, c) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length !== c.frame_bytes) fail('RAW_BYTE_COUNT', `raw bytes ${bytes.length}がshapeの${c.frame_bytes}と一致しません`);
  const count = c.samples_per_chirp * c.chirps_per_frame * c.rx_count, re = new Float64Array(count), im = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    let a, b = 0;
    if (c.sample_format === 'complex64_le') { a = bytes.readFloatLE(i * 8); b = bytes.readFloatLE(i * 8 + 4); }
    else if (c.sample_format === 'float32_le') a = bytes.readFloatLE(i * 4);
    else a = c.sample_format === 'int16_le' ? bytes.readInt16LE(i * 2) : bytes.readUInt16LE(i * 2);
    if (!Number.isFinite(a) || !Number.isFinite(b)) fail('RAW_NONFINITE_SAMPLE', 'ADC/IQに非有限値があります');
    re[i] = (a - c.sample_offset) * c.sample_scale / c.adc_full_scale; im[i] = b * c.sample_scale / c.adc_full_scale;
  }
  return { re, im };
}
export function rawBytes(frame, c) {
  if (frame?.kind !== 'raw_adc_frame' || typeof frame.payload_base64 !== 'string' || !frame.payload_base64.length || frame.payload_base64.length > Math.ceil(c.frame_bytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.payload_base64) || !Number.isSafeInteger(frame.sequence) || frame.sequence < 0 || !Number.isFinite(frame.frame_start_s) || frame.frame_start_s < 0) fail('RAW_FRAME_INVALID', 'raw frame・連番・sample時計上のframe_start_sが必要です');
  const bytes = Buffer.from(frame.payload_base64, 'base64'); if (bytes.toString('base64') !== frame.payload_base64 || bytes.length !== c.frame_bytes) fail('RAW_BYTE_COUNT', 'base64の長さがraw shapeと一致しません');
  if (frame.payload_sha256 && frame.payload_sha256 !== hash(bytes)) fail('RAW_HASH_MISMATCH', '入力rawハッシュが一致しません');
  return bytes;
}
export function microDoppler(bytes, c, p, frameStartS) {
  const input = decodeRaw(bytes, c), ns = c.samples_per_chirp, nc = c.chirps_per_frame, nr = c.rx_count, bins = p.range_bins, fastWindow = hann(ns), fastGain = fastWindow.reduce((a,b) => a+b,0), slowWindow = hann(p.window_chirps), slowGain = slowWindow.reduce((a,b)=>a+b,0);
  const channels = bins.length * nr, rangeRe = Array.from({ length: channels }, () => new Float64Array(nc)), rangeIm = Array.from({ length: channels }, () => new Float64Array(nc));
  for (let chirp = 0; chirp < nc; chirp++) for (let rx = 0; rx < nr; rx++) {
    const offset = (chirp * nr + rx) * ns, re = input.re.slice(offset, offset + ns), im = input.im.slice(offset, offset + ns), meanRe = re.reduce((a,b)=>a+b,0)/ns, meanIm = im.reduce((a,b)=>a+b,0)/ns;
    for (let s = 0; s < ns; s++) { re[s] = (re[s]-meanRe)*fastWindow[s]; im[s] = (im[s]-meanIm)*fastWindow[s]; } fft(re, im);
    bins.forEach((bin, index) => { const scale = (c.data_kind === 'real_adc' ? 2 : 1) / fastGain; rangeRe[rx*bins.length+index][chirp] = re[bin]*scale; rangeIm[rx*bins.length+index][chirp] = im[bin]*scale; });
  }
  if (p.remove_static) for (let channel = 0; channel < channels; channel++) { const ar = rangeRe[channel].reduce((a,b)=>a+b,0)/nc, ai = rangeIm[channel].reduce((a,b)=>a+b,0)/nc; for (let i = 0; i < nc; i++) { rangeRe[channel][i] -= ar; rangeIm[channel][i] -= ai; } }
  const n = p.window_chirps, frequencies_hz = Array.from({ length:n },(_,i)=>(i-n/2)/(n*c.chirp_interval_s)), velocities_mps = frequencies_hz.map(f => C*f/(2*c.carrier_hz)), columns=[];
  for (let start = 0; start+n <= nc; start += p.hop_chirps) {
    const power = new Float64Array(n);
    for (let channel = 0; channel < channels; channel++) { const re = rangeRe[channel].slice(start,start+n), im = rangeIm[channel].slice(start,start+n); for(let i=0;i<n;i++){re[i]*=slowWindow[i];im[i]*=slowWindow[i];} fft(re,im);
      for(let i=0;i<n;i++){const j=(i+n/2)%n;power[i]+=(re[j]**2+im[j]**2)/(slowGain**2*channels);} }
    columns.push({ time_s: frameStartS+(start+(n-1)/2)*c.chirp_interval_s, window_start_s:frameStartS+start*c.chirp_interval_s, window_end_s:frameStartS+(start+n)*c.chirp_interval_s, power_db: Array.from(power,x=>10*Math.log10(Math.max(x,1e-16))) });
  }
  return { frequencies_hz, velocities_mps, columns, frequency_bin_spacing_hz:1/(n*c.chirp_interval_s), window_duration_s:n*c.chirp_interval_s, hop_duration_s:p.hop_chirps*c.chirp_interval_s, range_bin_spacing_m:C*c.sample_rate_hz/(2*c.chirp_slope_hz_per_s*ns), selected_range_bins:bins, sign:'positive_phase_rotation_in_positive_range_fft_bin; physical approach/recession not calibrated', intensity:'10log10(mean noncoherent range/RX power / configured ADC full-scale squared); Hann coherent-gain normalized', processing:'per-frame STFT; no coherent stitching across missing frames; DC/Nyquist range bins excluded; fast-time mean removed', static_removal:p.remove_static };
}
export function syntheticRaw({ frames = 12, toneHz = null } = {}) {
  const config = validateRawConfig({ data_kind:'real_adc', sample_format:'int16_le', layout:'chirp_rx_sample', samples_per_chirp:128, chirps_per_frame:256, rx_count:1, rx_order:['synthetic_rx1'], sample_rate_hz:1e6, chirp_interval_s:.001, carrier_hz:60e9, chirp_slope_hz_per_s:1e13, sample_scale:1, sample_offset:0, adc_full_scale:32768, provenance:'synthetic', time_basis:'synthetic_sample_clock', timing_source:{kind:'synthetic_definition',reference:'independent analytic chirp/slow-time fixture; no hardware'}, device:'synthetic_no_sensor' });
  const output=[];for(let f=0;f<frames;f++){const bytes=Buffer.alloc(config.frame_bytes);for(let chirp=0;chirp<256;chirp++){const t=(f*256+chirp)*.001, limbPhase=2*Math.PI*(20*t+100/(2*Math.PI*2)*Math.sin(2*Math.PI*2*t));for(let s=0;s<128;s++){const fast=2*Math.PI*16*s/128;const value=toneHz===null?11000*Math.cos(fast+2*Math.PI*20*t)+7000*Math.cos(fast+limbPhase):16000*Math.cos(fast+2*Math.PI*toneHz*t);bytes.writeInt16LE(Math.round(value),(chirp*128+s)*2);}}
    output.push({kind:'raw_adc_frame',sequence:f,frame_start_s:f*.256,device_sequence:'unknown',payload_base64:bytes.toString('base64'),payload_sha256:hash(bytes)});}
  return {header:{kind:'raw_adc_header',schema_version:1,config},frames:output};
}
