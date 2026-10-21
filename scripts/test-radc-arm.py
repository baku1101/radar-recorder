"""Run the independently written C encoder in ARM emulation (no sensor/FW I/O).
Requires pyelftools and unicorn in the selected Python environment.
Usage: python scripts/test-radc-arm.py path/to/cross-linked-harness.elf
"""
import sys,struct,zlib,pathlib
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'.runtime/fw-test-libs'))
from elftools.elf.elffile import ELFFile
from unicorn import Uc,UC_ARCH_ARM,UC_MODE_THUMB,UC_MODE_MCLASS,UC_HOOK_CODE
from unicorn.arm_const import UC_ARM_REG_SP,UC_ARM_REG_LR
with open(sys.argv[1],'rb') as f:
 e=ELFFile(f);u=Uc(UC_ARCH_ARM,UC_MODE_THUMB|UC_MODE_MCLASS)
 u.mem_map(0x0ff00000,0x300000);u.mem_map(0x20000000,0x100000)
 for s in e.iter_segments():
  if s['p_type']=='PT_LOAD':u.mem_write(s['p_vaddr'],s.data())
 symbols={s.name:s['st_value'] for s in e.get_section_by_name('.symtab').iter_symbols()}
 stop=0x101ff000;u.reg_write(UC_ARM_REG_SP,0x200ff000);u.reg_write(UC_ARM_REG_LR,stop|1)
 u.hook_add(UC_HOOK_CODE,lambda cpu,addr,size,data:cpu.emu_stop() if addr==stop else None)
 u.emu_start(symbols['radc_test']|1,stop,count=200000)
 n=struct.unpack('<I',u.mem_read(symbols['radc_test_length'],4))[0]
 actual=bytes(u.mem_read(symbols['radc_test_wire'],n))
 payload=struct.pack('<4H',0,65535,32768,1);h=b'RADC0001'+struct.pack('<5I',8,7,1000,2,0)
 expected=h+struct.pack('<I',zlib.crc32(h+payload))+payload
 assert actual==expected,(actual.hex(),expected.hex())
 print('PASS Cortex-M4 C encoder executes in ARM emulation and matches independent Python CRC/bytes/tick/sequence/drop vector; no hardware used')
