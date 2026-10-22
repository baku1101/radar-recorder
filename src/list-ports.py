"""OS serial-port enumeration only; never constructs or opens serial.Serial."""
import argparse,json,sys
p=argparse.ArgumentParser();p.add_argument('--serial-lib');a=p.parse_args()
if a.serial_lib:sys.path.insert(0,a.serial_lib)
from serial.tools import list_ports
print(json.dumps([{'port':p.device,'description':p.description,'vid':p.vid,'pid':p.pid} for p in list_ports.comports()],ensure_ascii=True))
