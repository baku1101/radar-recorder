"""Hardware-free transport/state regression; standard library only, no serial import."""
import importlib.util,pathlib,tempfile,unittest,threading,queue,types,io,json,base64,hashlib
spec=importlib.util.spec_from_file_location('bridge',pathlib.Path(__file__).resolve().parents[1]/'src/csk-raw-reader.py');bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)
SHA='a'*64;CAT='b'*64;RAW=b'\x00\x01\x00\x00\x01\x00\x00\x00'
class Port:
 def __init__(self,scenario):self.scenario=scenario;self.is_open=False;self.commands=[];self.pending=bytearray()
 def open(self):self.is_open=True
 def close(self):self.is_open=False
 def flush(self):pass
 @property
 def in_waiting(self):return len(self.pending)
 def write(self,b):
  self.commands.append(b);sc=self.scenario
  info={'firmware':'radc-0.2.0' if sc.startswith('legacy') else 'radc-0.3.0','protocol':'RADC0001','sensor_id_hw':0x98185,'sensor_id_status':0,'running':sc=='busy','catalog_sha256':CAT,'config_protocol':'RADC_CONFIG_1','profile_header_sha256':SHA,'chirps':128,'rx':1,'samples':64,'register_count':1}
  applied={'configured':True,'profile_id':'japan-default','config_sha256':SHA,'profile_sha256':'c'*64,'chirps':128,'rx':1,'samples':64,'register_count':1}
  if b==b'RADC_INFO\n':
   if sc=='wrong-silicon':info['sensor_id_hw']=123
   if sc=='wrong-catalog':info['catalog_sha256']='f'*64
   self.pending.extend(b'RADC_INFO '+json.dumps(info).encode()+b'\n')
  elif b.startswith(b'RADC_SETCONFIG '):
   if sc=='apply-error':self.pending.extend(b'RADC_ERROR_CONFIG_APPLY\n');return
   if sc=='bad-applied':applied['config_sha256']='f'*64
   self.pending.extend(b'RADC_CONFIGURED '+json.dumps(applied).encode()+b'\n')
  elif b==b'RADC_GETCONFIG\n':
   if sc=='get-differs':applied['samples']=32
   self.pending.extend(b'RADC_CONFIG '+json.dumps(applied).encode()+b'\nRADC_PROFILE_READBACK_BEGIN\n'+(RAW[:2] if sc=='partial-readback' else RAW)+b'\nRADC_PROFILE_READBACK_END\n')
   if sc=='partial-readback':self.pending=self.pending[:-len(b'\nRADC_PROFILE_READBACK_END\n')]
  elif b==b'RADC_START\n':
   if sc=='disconnect':raise OSError('mock disconnected')
   if sc.startswith('legacy'):self.pending.extend(b'RADC_PROFILE_READBACK_BEGIN\n'+RAW+b'\nRADC_PROFILE_READBACK_END\n')
   self.pending.extend(b'RADC_RUNNING\n')
  elif b==b'RADC_STOP\n':self.pending.extend(b'RADC_STOPPED\n')
 def read(self,n):
  if self.scenario=='partial-readback' and not self.pending:raise TimeoutError('mock incomplete readback')
  data=bytes(self.pending[:min(n,31)]);del self.pending[:len(data)];return data
class Cases(unittest.TestCase):
 def run_case(self,scenario,operation='capture',profile='japan-default'):
  port=Port(scenario);stop=threading.Event();controls=queue.Queue();events=[];a=types.SimpleNamespace(operation=operation,profile_id=profile,profile_sha256=SHA,catalog_sha256=CAT,config_sha256=SHA)
  def emit(m):
   events.append(m)
   if m['kind']=='configured':
    self.assertNotIn(b'RADC_START\n',port.commands)
    if scenario=='stop-before-start':stop.set()
    else:controls.put('reject' if scenario=='host-reject' else 'accept:'+SHA)
   if m['kind']=='ready':stop.set()
  error=None
  with tempfile.TemporaryFile() as wire:
   try:bridge.run_bridge(port,a,wire,io.BytesIO(),emit,stop,controls)
   except Exception as e:error=e
   wire.seek(0);saved=wire.read()
  self.assertFalse(port.is_open);self.assertEqual(events[-1]['kind'],'stopped');self.assertTrue(events[-1]['port_closed']);return port,events,error,saved
 def test_valid_new(self):
  p,e,error,saved=self.run_case('valid');self.assertIsNone(error);self.assertEqual(p.commands,[b'RADC_INFO\n',b'RADC_SETCONFIG japan-default\n',b'RADC_GETCONFIG\n',b'RADC_START\n',b'RADC_STOP\n']);self.assertEqual(base64.b64decode(next(v for v in e if v['kind']=='configured')['register_readback_base64']),RAW);self.assertIn(RAW,saved);self.assertTrue(e[-1]['stop_acknowledged'])
 def test_probe_is_info_only(self):
  p,e,error,_=self.run_case('valid','probe');self.assertIsNone(error);self.assertEqual(p.commands,[b'RADC_INFO\n']);self.assertFalse(next(v for v in e if v['kind']=='probe')['configuration_written'])
 def test_legacy_default(self):
  p,e,error,_=self.run_case('legacy');self.assertIsNone(error);self.assertEqual(p.commands,[b'RADC_INFO\n',b'RADC_START\n',b'RADC_STOP\n']);self.assertTrue(next(v for v in e if v['kind']=='ready')['legacy_profile_fixed'])
 def test_legacy_profile_unsupported(self):
  p,e,error,_=self.run_case('legacy','capture','three-rx');self.assertIsNotNone(error);self.assertEqual(p.commands,[b'RADC_INFO\n'])
 def test_all_prestart_failures_never_start(self):
  for scenario in ['busy','wrong-silicon','wrong-catalog','apply-error','bad-applied','get-differs','partial-readback','host-reject','stop-before-start']:
   with self.subTest(scenario=scenario):
    p,e,error,_=self.run_case(scenario);self.assertIsNotNone(error,scenario);self.assertNotIn(b'RADC_START\n',p.commands);self.assertNotIn(b'RADC_STOP\n',p.commands)
 def test_disconnect_closes(self):
  p,e,error,_=self.run_case('disconnect');self.assertIsNotNone(error);self.assertFalse(p.is_open)
if __name__=='__main__':unittest.main()
