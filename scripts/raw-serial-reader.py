"""Experimental firmware UART reader, exact wire archival, optional own start/stop.
No stock firmware support, flashing, or debug/reset operations.
"""
import argparse,sys,time,threading,os
def main():
 p=argparse.ArgumentParser();p.add_argument('--port',required=True);p.add_argument('--baud',type=int,default=2000000);p.add_argument('--raw-wire-file',required=True);p.add_argument('--start-stop',action='store_true');a=p.parse_args()
 import serial
 port=serial.Serial(port=None,baudrate=a.baud,timeout=.2,write_timeout=1)
 port.dtr=False;port.rts=False;port.port=a.port
 stop=threading.Event();threading.Thread(target=lambda:(sys.stdin.buffer.read(1),stop.set()),daemon=True).start()
 started=False
 with open(a.raw_wire_file,'xb') as wire:
  try:
   port.open();print('UART open; original wire archive active',file=sys.stderr,flush=True)
   if stop.is_set():return
   if a.start_stop:port.write(b'RADC_START\n');port.flush();started=True
   while not stop.is_set():
    data=port.read(min(max(port.in_waiting,1),65536))
    if data:wire.write(data);wire.flush();sys.stdout.buffer.write(data);sys.stdout.buffer.flush()
  except KeyboardInterrupt:pass
  finally:
   if port.is_open and started:
    port.write(b'RADC_STOP\n');port.flush()
    end=time.monotonic()+.5
    while time.monotonic()<end:
     data=port.read(min(max(port.in_waiting,1),65536))
     if data:wire.write(data)
   wire.flush();os.fsync(wire.fileno());port.close()
if __name__=='__main__': main()
