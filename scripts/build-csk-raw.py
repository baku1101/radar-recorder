"""Cross-compile the independent experimental producer, never program a device.

Inputs are official source checkouts in .runtime; the official generated CSK
BSP v2.3.0 supplies clock/startup sources. All third-party sources stay private.
The generated HEX is a build candidate, NOT proof of safe programming/boot.
"""
import argparse,concurrent.futures,hashlib,json,os,pathlib,shutil,subprocess,sys
root=pathlib.Path(__file__).resolve().parents[1];rt=root/'.runtime'
parser=argparse.ArgumentParser();parser.add_argument('--profile',type=pathlib.Path);parser.add_argument('--catalog',type=pathlib.Path);parser.add_argument('--dependency-root',type=pathlib.Path);parser.add_argument('--variant',default='csk-raw-build');args=parser.parse_args()
if not args.variant or any(ch not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for ch in args.variant):raise SystemExit('variant must be a simple private runtime directory name')
out=rt/args.variant;out.mkdir(parents=True,exist_ok=True)
deps=args.dependency_root.resolve() if args.dependency_root else rt
gcc=next((deps/'gcc-arm').glob('*/bin/arm-none-eabi-gcc.exe'));objcopy=gcc.with_name('arm-none-eabi-objcopy.exe');size=gcc.with_name('arm-none-eabi-size.exe')
bsp=deps/'csk-bsp';generated=deps/'csk-bsp-v2/COMPONENT_BSP_DESIGN_MODUS/GeneratedSource';pdl=deps/'csk-pdl';hal=deps/'csk-hal';core=deps/'csk-core-lib';cmsis=deps/'csk-cmsis';driver=deps/'csk-sensor-driver'
profile=args.catalog.resolve() if args.catalog else args.profile.resolve() if args.profile else deps/'csk-raw-reference/src/radar_config/presence_detection_tracking_japan.h'
if not any(base.resolve() in profile.resolve().parents for base in [rt,deps]):raise SystemExit('Use a private profile inside .runtime')
shutil.copyfile(profile,out/('radc_private_catalog.h' if args.catalog else 'radc_private_profile.h'))
(out/'radc_build_info.h').write_text('#define RADC_PROFILE_SHA256 "'+hashlib.sha256(profile.read_bytes()).hexdigest()+'"\n',encoding='ascii')
incs=[out,root/'firmware/csk-raw',bsp,generated,bsp/'COMPONENT_CM4',pdl/'drivers/include',pdl/'devices/COMPONENT_CAT1A/include',pdl/'devices/COMPONENT_CAT1A/source',hal/'include',hal/'include_pvt',hal/'COMPONENT_CAT1A/include',hal/'COMPONENT_CAT1A/include_pvt',core/'include',cmsis/'Core/Include',driver,driver/'platform/mtb',driver/'register_hal']
defs=['CY8C624AFNI_S2D43','COMPONENT_CAT1','COMPONENT_CAT1A','COMPONENT_CM4','COMPONENT_PSOC6HAL','COMPONENT_BSP_DESIGN_MODUS','COMPONENT_CM0P_SLEEP','CY_USING_HAL']
flags=['-mcpu=cortex-m4','-mthumb','-mfpu=fpv4-sp-d16','-mfloat-abi=hard','-Os','-g3','-ffunction-sections','-fdata-sections','-fno-common','-Wall','-Wextra','-Wno-unused-parameter']+['-D'+d for d in defs]+['-I'+str(p) for p in incs]
sources=[root/('firmware/csk-raw/main-config.c' if args.catalog else 'firmware/csk-raw/main.c'),root/'firmware/csk-raw/radc_packet.c',deps/'csk-bsp-v2/cybsp.c',bsp/'COMPONENT_CM4/system_psoc6_cm4.c',bsp/'COMPONENT_CM4/TOOLCHAIN_GCC_ARM/startup_psoc6_02_cm4.S',deps/'csk-cm0p/COMPONENT_CAT1A/COMPONENT_CM0P_SLEEP/psoc6_02_cm0p_sleep.c',driver/'xensiv_bgt60cutrxx.c',driver/'platform/mtb/xensiv_bgt60cutrxx_mtb.c']
if args.catalog:sources.append(root/'firmware/csk-raw/radc_config.c')
sources+=list(generated.glob('*.c'))+list((pdl/'drivers/source').glob('*.c'))+list((pdl/'devices/COMPONENT_CAT1A/source').glob('*.c'))+list((hal/'source').glob('*.c'))+list((hal/'COMPONENT_CAT1A/source').rglob('*.c'))
sources+=list((pdl/'drivers/source/TOOLCHAIN_GCC_ARM').glob('*.S'))
def compile(p):
 o=out/(p.stem+'-'+hashlib.sha256(str(p).encode()).hexdigest()[:8]+'.o')
 r=subprocess.run([str(gcc),*flags,'-c',str(p),'-o',str(o)],capture_output=True,text=True)
 return p,o,r
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:results=list(ex.map(compile,sources))
log='\n'.join(str(p)+'\n'+r.stdout+r.stderr for p,o,r in results if r.stdout or r.stderr);(out/'compile.log').write_text(log,encoding='utf8')
failed=[(p,r) for p,o,r in results if r.returncode]
print(json.dumps({'compiled':len(results)-len(failed),'failed':len(failed),'total':len(results)}),flush=True)
if failed:
 for p,r in failed[:5]:print(p.name+'\n'+r.stderr[:1800])
 sys.exit(1)
elf=out/'csk-raw.elf';ld=bsp/'COMPONENT_CM4/TOOLCHAIN_GCC_ARM/linker.ld'
cmd=[str(gcc),*flags,'--specs=nano.specs','--specs=nosys.specs','-Wl,--gc-sections','-Wl,-Map='+str(out/'csk-raw.map'),'-T'+str(ld),*[str(o) for p,o,r in results],'-lm','-o',str(elf)]
r=subprocess.run(cmd,capture_output=True,text=True);(out/'link.log').write_text(r.stdout+r.stderr,encoding='utf8')
if r.returncode: print(r.stderr[-6000:]);sys.exit(r.returncode)
# Deliberately exclude supervisory flash, eFuse and metadata pseudo-regions.
hexfile=out/'csk-raw-main-flash-only.hex'
allhex=out/'csk-raw-all-sections.private.hex'
subprocess.run([str(objcopy),'-O','ihex',str(elf),str(allhex)],check=True)
base=0;kept=[];main_bytes=0;excluded=[]
for line in allhex.read_text().splitlines():
 b=bytes.fromhex(line[1:]);n=b[0];addr=int.from_bytes(b[1:3],'big');kind=b[3];data=b[4:4+n]
 if sum(b)&255:raise RuntimeError('Invalid generated Intel HEX checksum')
 if kind==4:base=int.from_bytes(data,'big')<<16;kept.append(line)
 elif kind==0:
  if 0x10000000<=base+addr and base+addr+n<=0x10200000:kept.append(line);main_bytes+=n
  else:excluded.append({'address':hex(base+addr),'bytes':n})
 elif kind in [1,5]:kept.append(line)
hexfile.write_text('\n'.join(kept)+'\n')
print(subprocess.check_output([str(size),str(elf)],text=True))
git=shutil.which('git') or r'C:\Program Files\Git\cmd\git.exe'
report={'target_mcu':'CY8C624AFNI-S2D43','kit':'KITCSKBGT60CUTR13TOBO1','bsp':'CYSBSYSKIT-DEV-01 release-v4.3.2 startup/system plus release-v2.3.0 existing generated clock/pin sources; manual HAL radar/UART setup','compiler':subprocess.check_output([str(gcc),'--version'],text=True).splitlines()[0],'dependencies':{p.name:subprocess.check_output([git,'-C',str(p),'rev-parse','HEAD'],text=True).strip() for p in [bsp,deps/'csk-bsp-v2',pdl,hal,core,cmsis,driver,deps/'csk-cm0p']},'profile_sha256':hashlib.sha256(profile.read_bytes()).hexdigest(),'outputs':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in [elf,hexfile]},'firmware_written':False,'hardware_boot_verified':False,'actual_raw_frames':0,'candidate_only':True,'hex_main_flash_bytes':main_bytes,'excluded_non_main_flash_records':excluded,'postprocess':'objcopy and Intel HEX address/checksum audit; only 0x10000000..0x101fffff main flash data retained; not boot/programming verified'}
(out/'build-report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
