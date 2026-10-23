"""Local ARM-emulated regression. Official compiler/standard free Python libraries.
Does not discover, connect to or program any hardware.
"""
import argparse,pathlib,subprocess,sys,struct,zlib,json
sys.dont_write_bytecode=True
p=argparse.ArgumentParser();p.add_argument('--dependency-root',required=True,type=pathlib.Path);a=p.parse_args();root=pathlib.Path(__file__).resolve().parents[1];out=root/'.runtime/config-arm-test';out.mkdir(parents=True,exist_ok=True)
sys.path.insert(0,str(a.dependency_root/'fw-test-libs'))
from elftools.elf.elffile import ELFFile
from unicorn import Uc,UC_ARCH_ARM,UC_MODE_THUMB,UC_MODE_MCLASS,UC_HOOK_CODE
from unicorn.arm_const import UC_ARM_REG_SP,UC_ARM_REG_LR
gcc=next((a.dependency_root/'gcc-arm').glob('*/bin/arm-none-eabi-gcc.exe'));elf=out/'config-test.elf'
subprocess.run([str(gcc),'-mcpu=cortex-m4','-mthumb','-Os','-fno-builtin','-nostdlib','-Wl,-e,radc_test','-Wl,-Ttext=0x10000000','-Wl,-Tdata=0x20000000','-I'+str(root/'firmware/csk-raw'),str(root/'test/config-arm.c'),str(root/'firmware/csk-raw/radc_packet.c'),str(root/'firmware/csk-raw/radc_config.c'),'-o',str(elf)],check=True)
with elf.open('rb') as f:
 e=ELFFile(f);u=Uc(UC_ARCH_ARM,UC_MODE_THUMB|UC_MODE_MCLASS);u.mem_map(0x0ff00000,0x300000);u.mem_map(0x20000000,0x100000)
 for s in e.iter_segments():
  if s['p_type']=='PT_LOAD':u.mem_write(s['p_vaddr'],s.data())
 symbols={s.name:s['st_value'] for s in e.get_section_by_name('.symtab').iter_symbols()};stop=0x101ff000;u.reg_write(UC_ARM_REG_SP,0x200ff000);u.reg_write(UC_ARM_REG_LR,stop|1);u.hook_add(UC_HOOK_CODE,lambda cpu,addr,size,data:cpu.emu_stop() if addr==stop else None);u.emu_start(symbols['radc_test']|1,stop,count=2000000)
 checks=struct.unpack('<I',u.mem_read(symbols['radc_test_checks'],4))[0];assert checks==10,checks
 n=struct.unpack('<I',u.mem_read(symbols['radc_test_length'],4))[0];actual=bytes(u.mem_read(symbols['radc_test_wire'],n));payload=struct.pack('<4H',0,65535,32768,1);h=b'RADC0002'+struct.pack('<4I',8,7,1000,0)+bytes.fromhex('aa'*32)+struct.pack('<I',0);expected=h+struct.pack('<I',zlib.crc32(h+payload))+payload;assert actual==expected,(actual.hex(),expected.hex())
 report={'passed':True,'state_assertions':checks,'encoder_exact_bytes_crc_sha':True,'hardware_used':False,'programmed':False};(root/'evidence/config-arm-results.json').write_text(json.dumps(report,indent=2),encoding='utf8');print(json.dumps(report))
