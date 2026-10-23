"""Independent RADC bridge; no flashing, discovery or manufacturer SDK."""
import argparse,json,os,sys,time,threading,hashlib,base64,queue

def run_bridge(port,a,wire,output,emit,stop,controls):
 pending=bytearray();tx=[];started=False;stop_ack=False
 def receive():
  data=port.read(min(max(port.in_waiting,1),65536))
  if data:wire.write(data);wire.flush();output.write(data);output.flush()
  return data
 def command(b):
  tx.append({'bytes_base64':base64.b64encode(b).decode(),'pc_unix_ms':time.time_ns()/1e6});port.write(b);port.flush()
 def until(marker,seconds=6):
  end=time.monotonic()+seconds
  while marker not in pending:
   if stop.is_set():raise RuntimeError('Stopped before acquisition was ready')
   if b'RADC_ERROR_' in pending:raise RuntimeError('Firmware rejected operation: '+pending[pending.index(b'RADC_ERROR_'):].split(b'\n')[0].decode('ascii',errors='replace'))
   if time.monotonic()>end:raise RuntimeError('RADC response timeout; no retry or fallback')
   pending.extend(receive())
   if len(pending)>1048576:raise RuntimeError('Unexpected response size')
  i=pending.index(marker);before=bytes(pending[:i]);del pending[:i+len(marker)];return before
 def readback(count):
  if not isinstance(count,int) or count<1 or count>4096:raise RuntimeError('Invalid register count')
  until(b'RADC_PROFILE_READBACK_BEGIN\n');end=time.monotonic()+6
  while len(pending)<count*8:
   if stop.is_set() or time.monotonic()>end:raise RuntimeError('Incomplete configuration readback')
   pending.extend(receive())
  data=bytes(pending[:count*8]);del pending[:count*8];until(b'RADC_PROFILE_READBACK_END\n');return data
 try:
  emit({'kind':'progress','phase':'connecting'});port.open();emit({'kind':'progress','phase':'firmware_identity'});command(b'RADC_INFO\n');until(b'RADC_INFO ');raw_info=until(b'\n');info=json.loads(raw_info)
  if info.get('firmware') not in ['radc-0.2.0','radc-0.3.0'] or info.get('sensor_id_hw')!=0x98185 or info.get('sensor_id_status')!=0 or info.get('startup_status',0)!=0 or info.get('running'):raise RuntimeError('Firmware/silicon/idle mismatch; no configuration or START sent')
  if a.operation=='probe':emit({'kind':'probe','firmware_info':info,'identity_response_base64':base64.b64encode(raw_info).decode(),'commands':tx,'configuration_written':False,'acquisition_started':False});return
  metadata={'firmware_info':info,'identity_response_base64':base64.b64encode(raw_info).decode(),'device_capture_time':'unknown'}
  if info['firmware']=='radc-0.2.0':
   if a.profile_id not in [None,'japan-default'] or info.get('protocol')!='RADC0001' or info.get('profile_header_sha256')!=a.profile_sha256:raise RuntimeError('RAW_CONFIG_UNSUPPORTED: radc-0.2.0 supports the default profile only; no START sent')
   emit({'kind':'progress','phase':'configuration_readback'});started=True;command(b'RADC_START\n');raw=readback(info.get('register_count'));until(b'RADC_RUNNING\n');metadata['legacy_profile_fixed']=True
  else:
   if info.get('config_protocol')!='RADC_CONFIG_1' or info.get('catalog_sha256')!=a.catalog_sha256 or not a.profile_id or not a.config_sha256:raise RuntimeError('Configuration catalog/protocol mismatch; no SETCONFIG sent')
   emit({'kind':'progress','phase':'configuration_apply'});command(('RADC_SETCONFIG '+a.profile_id+'\n').encode('ascii'));until(b'RADC_CONFIGURED ');applied=json.loads(until(b'\n'))
   if not applied.get('configured') or applied.get('profile_id')!=a.profile_id or applied.get('config_sha256')!=a.config_sha256:raise RuntimeError('Applied configuration mismatch; no START sent')
   emit({'kind':'progress','phase':'configuration_readback'});command(b'RADC_GETCONFIG\n');until(b'RADC_CONFIG ');actual=json.loads(until(b'\n'))
   if actual!=applied:raise RuntimeError('GETCONFIG differs from SETCONFIG; no START sent')
   raw=readback(actual.get('register_count'));metadata['applied_configuration']=actual
   emit({'kind':'configured',**metadata,'register_readback_base64':base64.b64encode(raw).decode(),'register_readback_sha256':hashlib.sha256(raw).hexdigest(),'commands':list(tx)})
   end=time.monotonic()+5;accepted=False
   while not stop.is_set() and time.monotonic()<end:
    try:
     line=controls.get(timeout=.05)
     if line=='accept:'+a.config_sha256:accepted=True;break
     raise RuntimeError('Host rejected configuration; no START sent')
    except queue.Empty:pass
   if not accepted:raise RuntimeError('Host did not accept readback; no START sent')
   started=True;command(b'RADC_START\n');until(b'RADC_RUNNING\n')
  emit({'kind':'ready',**metadata,'register_readback_base64':base64.b64encode(raw).decode(),'register_readback_sha256':hashlib.sha256(raw).hexdigest(),'commands':tx})
  while not stop.is_set():receive()
 finally:
  try:
   if port.is_open and started:
    command(b'RADC_STOP\n');end=time.monotonic()+.4;tail=bytearray()
    while time.monotonic()<end:tail.extend(receive())
    stop_ack=b'RADC_STOPPED\n' in tail
  finally:
   wire.flush();os.fsync(wire.fileno());port.close();emit({'kind':'stopped','commands':tx,'port_closed':True,'stop_acknowledged':stop_ack,'start_sent':started})

def main():
 p=argparse.ArgumentParser();p.add_argument('--port',required=True);p.add_argument('--vendor-lib');p.add_argument('--wire',required=True);p.add_argument('--profile-sha256');p.add_argument('--profile-id');p.add_argument('--catalog-sha256');p.add_argument('--config-sha256');p.add_argument('--operation',choices=['capture','probe'],default='capture');a=p.parse_args()
 if a.vendor_lib:sys.path.insert(0,a.vendor_lib)
 import serial
 stop=threading.Event();controls=queue.Queue()
 def control():
  for line in sys.stdin:
   line=line.strip()
   if line=='stop':stop.set();return
   controls.put(line)
  stop.set()
 threading.Thread(target=control,daemon=True).start()
 port=serial.Serial(port=None,baudrate=2000000,timeout=.05,write_timeout=1);port.dtr=False;port.rts=False;port.port=a.port
 with open(a.wire,'xb') as wire:run_bridge(port,a,wire,sys.stdout.buffer,lambda v:print(json.dumps(v),file=sys.stderr,flush=True),stop,controls)

if __name__=='__main__':
 try:main()
 except Exception as e:print(json.dumps({'kind':'error','message':str(e),'error_type':type(e).__name__}),file=sys.stderr,flush=True);sys.exit(1)
