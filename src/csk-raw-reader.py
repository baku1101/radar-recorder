"""Independent RADC firmware reader. No flashing, debug, or stock-FW commands."""
import argparse, json, os, sys, time, threading, hashlib, base64

def main():
 p=argparse.ArgumentParser();p.add_argument('--port',required=True);p.add_argument('--vendor-lib');p.add_argument('--wire',required=True);p.add_argument('--profile-sha256',required=True);a=p.parse_args()
 if a.vendor_lib:sys.path.insert(0,a.vendor_lib)
 import serial
 stop=threading.Event();threading.Thread(target=lambda:(sys.stdin.buffer.read(1),stop.set()),daemon=True).start()
 def emit(v):print(json.dumps(v),file=sys.stderr,flush=True)
 port=serial.Serial(port=None,baudrate=2000000,timeout=.05,write_timeout=1);port.dtr=False;port.rts=False;port.port=a.port
 started=False;pending=bytearray();tx=[]
 with open(a.wire,'xb') as wire:
  def receive():
   data=port.read(min(max(port.in_waiting,1),65536))
   if data:wire.write(data);wire.flush();sys.stdout.buffer.write(data);sys.stdout.buffer.flush()
   return data
  def command(b):
   tx.append({'bytes_base64':base64.b64encode(b).decode(),'pc_unix_ms':time.time_ns()/1e6});port.write(b);port.flush()
  def until(marker,seconds=6):
   end=time.monotonic()+seconds
   while marker not in pending:
    if stop.is_set():raise RuntimeError('Stopped during initialization')
    if time.monotonic()>end:raise RuntimeError('Candidate firmware response timeout; no retry or stock firmware fallback')
    pending.extend(receive())
    if len(pending)>1048576:raise RuntimeError('Unexpected initialization response size')
   i=pending.index(marker);before=bytes(pending[:i]);del pending[:i+len(marker)];return before
  try:
   emit({'kind':'progress','phase':'connecting'});port.open();emit({'kind':'progress','phase':'firmware_identity'});command(b'RADC_INFO\n');until(b'RADC_INFO ');raw_info=until(b'\n');info=json.loads(raw_info)
   if info.get('firmware')!='radc-0.2.0' or info.get('protocol')!='RADC0001' or info.get('profile_header_sha256')!=a.profile_sha256 or info.get('sensor_id_hw')!=0x98185 or info.get('sensor_id_status')!=0 or info.get('running'):
    raise RuntimeError('Raw firmware/profile/idle/silicon identity mismatch; START was not sent; '+json.dumps(info))
   count=info.get('register_count')
   if not isinstance(count,int) or count<1 or count>4096:raise RuntimeError('Invalid readback register count')
   emit({'kind':'progress','phase':'configuration_readback'});command(b'RADC_START\n');started=True;until(b'RADC_PROFILE_READBACK_BEGIN\n')
   end=time.monotonic()+6
   while len(pending)<count*8:
    if stop.is_set() or time.monotonic()>end:raise RuntimeError('Incomplete sensor configuration readback')
    pending.extend(receive())
   raw_readback=bytes(pending[:count*8]);del pending[:count*8];until(b'RADC_PROFILE_READBACK_END\n');until(b'RADC_RUNNING\n')
   emit({'kind':'ready','firmware_info':info,'identity_response_base64':base64.b64encode(raw_info).decode(),'register_readback_base64':base64.b64encode(raw_readback).decode(),'register_readback_sha256':hashlib.sha256(raw_readback).hexdigest(),'commands':tx,'device_capture_time':'unknown'})
   while not stop.is_set():receive()
  finally:
   if port.is_open and started:
    command(b'RADC_STOP\n');end=time.monotonic()+.4
    while time.monotonic()<end:receive()
   wire.flush();os.fsync(wire.fileno());port.close();emit({'kind':'stopped','commands':tx,'port_closed':True})

if __name__=='__main__':
 try:main()
 except Exception as e:
  print(json.dumps({'kind':'error','message':str(e),'error_type':type(e).__name__}),file=sys.stderr,flush=True);sys.exit(1)
