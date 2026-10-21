// Independent RADC0001 experimental producer protocol. Current stock FW does not emit it.
import { EventEmitter } from 'node:events';
export const RADC_MAGIC=Buffer.from('RADC0001');
export function crc32(parts){let c=0xffffffff;for(const bytes of parts)for(const byte of bytes){c^=byte;for(let i=0;i<8;i++)c=(c>>>1)^((0-(c&1))&0xedb88320);}return(c^0xffffffff)>>>0;}
export class RawPacketParser extends EventEmitter {
 constructor({frameBytes,maxBuffer=2*1024*1024}={}){super();if(!Number.isSafeInteger(frameBytes)||frameBytes<1||frameBytes>1024*1024)throw new Error('frameBytes required');this.frameBytes=frameBytes;this.maxBuffer=maxBuffer;this.buffer=Buffer.alloc(0);this.skippedBytes=0;this.crcErrors=0;this.previous=null;}
 push(chunk){this.buffer=Buffer.concat([this.buffer,chunk]);if(this.buffer.length>this.maxBuffer)throw new Error('RADC receive buffer overflow');
  for(;;){const pos=this.buffer.indexOf(RADC_MAGIC);if(pos<0){const keep=Math.min(7,this.buffer.length);this.skippedBytes+=this.buffer.length-keep;this.buffer=this.buffer.subarray(this.buffer.length-keep);return;}if(pos){this.skippedBytes+=pos;this.buffer=this.buffer.subarray(pos);}if(this.buffer.length<32)return;
   const h=this.buffer.subarray(0,32),n=h.readUInt32LE(8);if(n!==this.frameBytes||h.readUInt32LE(24)!==0){this.skippedBytes++;this.buffer=this.buffer.subarray(1);continue;}if(this.buffer.length<32+n)return;
   const payload=this.buffer.subarray(32,32+n),expected=h.readUInt32LE(28);if(crc32([h.subarray(0,28),payload])!==expected){this.crcErrors++;this.skippedBytes++;this.buffer=this.buffer.subarray(1);continue;}
   const sequence=h.readUInt32LE(12),tick=h.readUInt32LE(16),queueDrops=h.readUInt32LE(20);
   const discontinuity=this.previous!==null&&sequence!==((this.previous+1)>>>0);this.previous=sequence;
   const wire=Buffer.from(this.buffer.subarray(0,32+n));this.buffer=this.buffer.subarray(32+n);this.emit('frame',{packet_sequence:sequence,callback_tick_ms:tick,queue_drops:queueDrops,packet_sequence_discontinuity:discontinuity,payload:Buffer.from(payload),wire_packet:wire,payload_crc32:expected,hardware_sequence:'unknown',hardware_loss:'unknown'});
  }
 }
 finish(){if(this.buffer.length)throw new Error(`RADC stream has ${this.buffer.length} trailing/unframed bytes`);}
}
