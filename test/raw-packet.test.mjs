import test from 'node:test';import assert from 'node:assert/strict';
import {crc32,RawPacketParser,RADC_MAGIC} from '../src/raw-packet.mjs';
function packet(payload,{sequence=7,tick=1000,drops=0}={}){const h=Buffer.alloc(32);RADC_MAGIC.copy(h);h.writeUInt32LE(payload.length,8);h.writeUInt32LE(sequence,12);h.writeUInt32LE(tick,16);h.writeUInt32LE(drops,20);h.writeUInt32LE(crc32([h.subarray(0,28),payload]),28);return Buffer.concat([h,payload]);}
test('experimental raw packet CRC matches standard CRC32 test vector',()=>{assert.equal(crc32([Buffer.from('123456789')]),0xcbf43926);});
test('raw packet parser preserves fragmented uint16 bytes, callback ticks and reported drops without inventing device clocks',()=>{
 const payload=Buffer.from([0,0,255,255,0,128,1,0]),wire=packet(payload,{drops:2}),p=new RawPacketParser({frameBytes:8}),frames=[];p.on('frame',f=>frames.push(f));for(const byte of wire)p.push(Buffer.from([byte]));p.finish();assert.equal(frames.length,1);assert.deepEqual(frames[0].payload,payload);assert.equal(frames[0].callback_tick_ms,1000);assert.equal(frames[0].queue_drops,2);assert.equal(frames[0].hardware_sequence,'unknown');assert.equal(frames[0].hardware_loss,'unknown');
});
test('packet CRC, invalid size, noise, multiple packets and sequence gaps are handled independently of sample processing',()=>{
 const p=new RawPacketParser({frameBytes:8}),frames=[];p.on('frame',f=>frames.push(f));const bad=packet(Buffer.alloc(8));bad[34]^=1;p.push(Buffer.concat([Buffer.from('boot log\r\n'),bad,packet(Buffer.alloc(8),{sequence:8}),packet(Buffer.alloc(8,3),{sequence:10})]));assert.equal(frames.length,2);assert.equal(p.crcErrors,1);assert.equal(frames[1].packet_sequence_discontinuity,true);assert.ok(p.skippedBytes>0);p.finish();
 const badSize=packet(Buffer.alloc(8));badSize.writeUInt32LE(0x7fffffff,8);p.push(badSize);assert.throws(()=>p.finish(),/trailing/);assert.throws(()=>new RawPacketParser({frameBytes:0}));
});
