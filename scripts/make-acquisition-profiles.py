"""Offline preset generation. No device API, discovery or I/O is used.

Vendor register arrays remain in private .runtime. Public output contains only
independent acquisition facts and cryptographic hashes, never register values.
"""
import argparse,base64,hashlib,json,math,pathlib,re,struct,sys
sys.dont_write_bytecode=True
ROOT=pathlib.Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('--vendor-lib',type=pathlib.Path,required=True);p.add_argument('--baseline',type=pathlib.Path,required=True);a=p.parse_args()
if hashlib.sha256(a.baseline.read_bytes()).hexdigest()!='9e05ff9161a1d3c1bd35c6730ab546f52dcb052ea6e767a6ebce5d00ed46e490':raise SystemExit('The pinned B-step Japan reference differs')
sys.path.insert(0,str(a.vendor_lib))
from ifx_smartar_hal.smartar_parameters import SmartarChirpParameters
out=ROOT/'.runtime/acquisition-profiles';out.mkdir(parents=True,exist_ok=True)
specs=[
 ('japan-default','標準 / 128 chirp・64 sample',{}),
 ('short-frame','短い観測 / 64 chirp',{'nc':64}),
 ('long-window','長い観測 / 256 chirp・32 sample',{'nc':256,'ns':32,'start':60.6e9,'bw':300e6}),
 ('more-samples','サンプル数128 / 32 chirp',{'ns':128,'nc':32}),
 ('fewer-samples','サンプル数32',{'ns':32,'start':60.6e9,'bw':300e6}),
 ('lower-sample-rate','ADC 2.5 MHz',{'fs':2.5e6}),
 ('three-rx','3 RX / 16 chirp',{'rx':[1,1,1],'nc':16}),
 ('shorter-tc','短いchirp間隔 / 平均化8',{'avg':8,'nc':64}),
 ('lower-gain','受信gain 36 dB',{'gain':36}),
 ('narrow-sweep','狭いsweep / 300 MHz',{'start':60.6e9,'bw':300e6}),
]
def cal(x):return 0x2014<=x<=0x2324 and (x-0x2014)%0x100<=0x10 and x%4==0
def sha(b):return hashlib.sha256(b).hexdigest()
def normalize(v):
 if isinstance(v,float) and v.is_integer():return int(v)
 if isinstance(v,dict):return {k:normalize(x) for k,x in v.items()}
 if isinstance(v,list):return [normalize(x) for x in v]
 return v
entries=[];tables=[]
base=SmartarChirpParameters(str(a.baseline),0,'B');base.set_active_rx_antennas([1,0,0]);base.set_number_chirps(128);base.set_frame_rate_Hz(10)
basefile=out/'baseline.txt';base.export_registers_file(str(basefile))
for idx,(id,label,options) in enumerate(specs):
 q=SmartarChirpParameters(str(basefile),0,'B')
 q.set_active_rx_antennas(options.get('rx',[1,0,0]));q.set_number_chirps(options.get('nc',128))
 if 'ns' in options:q.set_number_samples(options['ns'])
 if 'fs' in options:q.set_sample_rate_Hz(options['fs'],compensate_frequency=True)
 if 'avg' in options:q.set_number_averages(options['avg'])
 if 'gain' in options:q.set_abb_gain_dB(options['gain'])
 if 'start' in options:q.set_start_frequency_Hz(options['start'])
 if 'bw' in options:q.set_bandwidth_Hz(options['bw'])
 v=q.get_main_parameters();ns=int(v['NumberOfSamples']);nc=int(v['NumberOfChirps']);nr=int(v['NumberRxAntennas']);count=ns*nc*nr
 if count>8192 or count%2:raise SystemExit(id+': exceeds bounded one-frame FIFO readout')
 # configureAcquisition's documented threshold is sampleCount / 2 - 1.
 q.reg_write(next(f for f in q.regs.registers['FIFO_CTRL'].fields if f.name=='THRESHOLD'),count//2-1)
 txt=out/(id+'.txt');q.export_registers_file(str(txt));r=SmartarChirpParameters(str(txt),0,'B');v=r.get_main_parameters()
 rows=[]
 for line in txt.read_text().splitlines():
  pair=re.findall(r'0x[0-9a-fA-F]+',line)
  if len(pair)==2:rows.append(tuple(int(x,16) for x in pair))
 if len(rows)!=433:raise SystemExit(id+': register count differs')
 frame=float(v['FrameDuration']);tc=float(v['ChirpRepetitionTime']);rate=(count*2+64)/frame
 if not(nc*tc<=frame and rate<=170000):raise SystemExit(id+': time or UART budget exceeded')
 if not(60.476e9<=v['FrequencyMinimum']<=v['StartFrequency']<v['EndFrequency']<=60.990e9):raise SystemExit(id+': outside baseline RF envelope')
 config={'data_kind':'real_adc','sample_format':'uint16_le','layout':'chirp_sample_rx','samples_per_chirp':ns,'chirps_per_frame':nc,'rx_count':nr,'rx_order':['rx'+str(i+1) for i,x in enumerate(options.get('rx',[1,0,0])) if x],
  'sample_rate_hz':v['SampleRate'],'chirp_interval_s':tc,'carrier_hz':(v['FrequencySamplingStart']+v['FrequencySamplingStop'])/2,'chirp_slope_hz_per_s':v['FrequencyChirpSlope'],'sample_scale':1,'sample_offset':0,'adc_full_scale':65535,'provenance':'real','time_basis':'device_fifo_callback_clock_with_configured_chirp_spacing','averaging_factor':r.get_number_averages(),'frame_period_s':frame,'if_gain_db':r.get_abb_gain_dB(),'sweep_start_hz':v['StartFrequency'],'sweep_end_hz':v['EndFrequency'],'sampling_start_hz':v['FrequencySamplingStart'],'sampling_stop_hz':v['FrequencySamplingStop'],'storage_bits':16,'adc_full_scale_reference':'uint16 storage span; analog and averaging scale not calibrated','physical_frame_origin_uncertainty_s':'unknown','device':'KITCSKBGT60CUTR13TOBO1 / B-step only','timing_source':{'reference':'offline official B-step parameter API; device readback required before START'}}
 raw=b''.join(struct.pack('<II',*row) for row in rows)
 fp={'register_count':len(rows),'address_order_sha256':sha(b''.join(struct.pack('<I',x) for x,y in rows)),'non_calibration_sha256':sha(b''.join(struct.pack('<II',x,y) for x,y in rows if not cal(x))),'non_calibration_count':sum(not cal(x) for x,y in rows)}
 entry={'id':id,'label':label,'profile_sha256':sha(raw),'header':{'kind':'raw_adc_header','schema_version':1,'config':config},'readback_fingerprint':fp,'limits':{'samples_total':count,'fifo_words':count//2,'packet_header_bytes':64,'uart_bytes_per_second':rate,'uart_budget_bytes_per_second':170000,'sample_observation_s':nc*tc,'sample_gap_s':frame-nc*tc},'hardware_verified':False}
 for key,wanted in [('NumberOfSamples',options.get('ns',64)),('NumberOfChirps',options.get('nc',128)),('NumberRxAntennas',sum(options.get('rx',[1,0,0]))),('SampleRate',options.get('fs',5e6))]:
  if v[key]!=wanted:raise SystemExit(id+': SDK roundtrip does not match requested '+key)
 if r.get_number_averages()!=options.get('avg',16) or r.get_abb_gain_dB()!=options.get('gain',42):raise SystemExit(id+': averaging or gain roundtrip differs')
 config['sample_fractional_bits']='unknown_for_changed_averaging' if options.get('avg',16)!=16 else 'datasheet_12_plus_4_not_analog_calibration'
 entry['requested_parameters']=options
 entry=normalize(entry)
 entry['config_sha256']=sha(json.dumps(entry,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode())
 entries.append(entry)
 tables.append('static const uint32_t radc_registers_'+str(idx)+'[][2]={\n'+''.join('{0x%04x,0x%08x},\n'%row for row in rows)+'};\n')
 print(id,json.dumps({'shape':[nc,nr,ns],'fs':v['SampleRate'],'tc':tc,'frame_s':frame,'avg':r.get_number_averages(),'gain':r.get_abb_gain_dB(),'bytes_s':rate}),flush=True)
catalog={'schema_version':1,'protocol':'RADC_CONFIG_1','firmware':'radc-0.3.0','default_profile_id':'japan-default','profiles':entries,'unsupported':['arbitrary independent parameter values','independent frame period / Tc; profile-coupled derived values only','TX power changes','cross-frame coherent STFT'],'candidate_only':True}
catalog['catalog_sha256']=sha(json.dumps(catalog,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode())
public=ROOT/'profiles/acquisition-presets.json';public.write_text(json.dumps(catalog,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
header='/* PRIVATE generated register tables. Never publish this file. */\n#include "radc_config.h"\n'+''.join(tables)+'static const radc_profile_t radc_profiles[]={\n'
for i,e in enumerate(entries):
 c=e['header']['config'];header+='{"%s","%s","%s",%d,%d,%d,%d,radc_registers_%d,433},\n'%(e['id'],e['config_sha256'],e['profile_sha256'],c['chirps_per_frame'],c['rx_count'],c['samples_per_chirp'],e['limits']['fifo_words']-1,i)
header+='};\n#define RADC_PROFILE_COUNT '+str(len(entries))+'\n#define RADC_CATALOG_SHA256 "'+catalog['catalog_sha256']+'"\n'
(out/'radc_private_catalog.h').write_text(header,encoding='ascii')
(out/'generation-report.json').write_text(json.dumps({'no_device_io':True,'baseline_sha256':sha(a.baseline.read_bytes()),'catalog_sha256':catalog['catalog_sha256'],'profiles':len(entries),'firmware_written':False,'hardware_tested':False},indent=2),encoding='utf8')
