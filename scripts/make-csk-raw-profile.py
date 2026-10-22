"""Offline candidate generation using the user's installed manufacturer API.
Writes only private .runtime data; never opens/configures a sensor.
"""
import argparse,pathlib,sys,json,hashlib,math,re
sys.dont_write_bytecode=True
root=pathlib.Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument('--vendor-lib',type=pathlib.Path,default=pathlib.Path.home()/'Infineon/Tools/XENSIV-CMOS-Radar-Visualization-Tool/1.1.0/lib');a=parser.parse_args();sys.path.insert(0,str(a.vendor_lib))
from ifx_smartar_hal.smartar_parameters import SmartarChirpParameters
src=root/'.runtime/csk-raw-reference/src/radar_config/presence_detection_tracking_japan.txt'
if hashlib.sha256(src.read_bytes()).hexdigest()!='9e05ff9161a1d3c1bd35c6730ab546f52dcb052ea6e767a6ebce5d00ed46e490':raise SystemExit('Pinned reference profile differs')
p=SmartarChirpParameters(str(src),0,'B')
p.set_active_rx_antennas([1,0,0]);p.set_number_chirps(128);p.set_frame_rate_Hz(10)
p.reg_write(next(f for f in p.regs.registers['FIFO_CTRL'].fields if f.name=='THRESHOLD'),4095)
dest=root/'.runtime/csk-profiles';dest.mkdir(exist_ok=True);txt=dest/'candidate-japan-128x1x64.txt';hdr=txt.with_suffix('.h');p.export_registers_file(str(txt))
registers=[]
for line in txt.read_text().splitlines():
 values=re.findall(r'0x[0-9a-fA-F]+',line)
 if len(values)==2:registers.append(tuple(int(x,16) for x in values))
if not registers:raise SystemExit('No generated registers')
hdr.write_text('/* PRIVATE candidate register data, generated offline; not applied. */\n#include <stdint.h>\n#define SEQ0_NUMBER_OF_CHIRPS 128\n#define SEQ0_RX_ANTENNAS 1\n#define SEQ0_SAMPLES_PER_CHIRP 64\n#define FIFO_THRESHOLD 4095\nstatic const uint32_t register_list[][2]={\n'+''.join('{0x%04x,0x%08x},\n'%r for r in registers)+'};\n',encoding='utf8')
reload=SmartarChirpParameters(str(txt),0,'B');v=reload.get_main_parameters()
if not(v['NumberOfChirps']==128 and v['NumberRxAntennas']==1 and v['NumberOfSamples']==64 and abs(v['FrameDuration']-.1)<.0001):raise SystemExit('Generated profile shape/timing differs')
v={k:x if not isinstance(x,float) or math.isfinite(x) else str(x) for k,x in v.items()}
r={'source_profile_sha256':hashlib.sha256(src.read_bytes()).hexdigest(),'design_step':'B; actual chip not yet read','parameters':v,'averaging_factor':reload.get_number_averages(),'profile_sha256':hashlib.sha256(txt.read_bytes()).hexdigest(),'header_sha256':hashlib.sha256(hdr.read_bytes()).hexdigest(),'no_device_io':True,'applied_to_sensor':False,'hardware_stream_verified':False}
(dest/'candidate-profile-report.json').write_text(json.dumps(r,indent=2))
config={'data_kind':'real_adc','sample_format':'uint16_le','layout':'chirp_rx_sample','samples_per_chirp':64,'chirps_per_frame':128,'rx_count':1,'rx_order':['rx1'],'sample_rate_hz':v['SampleRate'],'chirp_interval_s':v['ChirpRepetitionTime'],'carrier_hz':(v['FrequencySamplingStart']+v['FrequencySamplingStop'])/2,'chirp_slope_hz_per_s':v['FrequencyChirpSlope'],'sample_scale':1,'sample_offset':0,'adc_full_scale':65535,'provenance':'real','time_basis':'device_fifo_callback_clock_with_configured_chirp_spacing','timing_source':{'reference':'offline installed HAL profile analysis; not a sensor readback','profile_sha256':r['profile_sha256']},'averaging_factor':r['averaging_factor'],'device':'KITCSKBGT60CUTR13TOBO1; identity checked at start','storage_bits':16,'adc_full_scale_reference':'uint16 storage span; analog full-scale calibration unknown','physical_frame_origin_uncertainty_s':'unknown'}
(dest/'candidate.raw-header.json').write_text(json.dumps({'kind':'raw_adc_header','schema_version':1,'config':config},indent=2))
deployment={'firmware':'radc-0.2.0','profile_header_sha256':r['header_sha256'],'header':{'kind':'raw_adc_header','schema_version':1,'config':config},'requested_registers':registers}
(dest/'raw-deployment.json').write_text(json.dumps(deployment,indent=2))
print(json.dumps(r,indent=2))
