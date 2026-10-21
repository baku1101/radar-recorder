import test from 'node:test';import assert from 'node:assert/strict';
import {crc32,RawPacketParser,RADC_MAGIC} from '../src/raw-packet.mjs';
function packet(payload,{sequence=7,tick=1000,drops=0}={}){const h=Buffer.alloc(32);RADC_MAGIC.copy(h);h.writeUInt32LE(payload.length,8);h.writeUInt32LE(sequence,12);h.writeUInt32LE(tick,16);h.writeUInt32LE(drops,20);h.writeUInt32LE(crc32([h.subarray(0,28),payload]),28);return Buffer.concat([h,payload]);}
test('experimental raw packet CRC matches standard CRC32 test vector',()=>{assert.equal(crc32([Buffer.from('123456789')]),0xcbf43926);});
test('raw packet parser preserves fragmented uint16 bytes, callback ticks and reported drops without inventing device clocks',()=>{
 const payload=Buffer.from([0,0,255,255,0,128,1,0]),wire=packet(payload,{drops:2}),p=new RawPacketParser({frameBytes:8}),frames=[];p.on('frame',f=>frames.push(f));for(const byte of wire)p.push(Buffer.from([byte]));p.finish();assert.equal(frames.length,1);assert.deepEqual(frames[0].payload,payload);assert.equal(frames[0].callback_tick_ms,1000);assert.equal(frames[0].queue_drops,2);assert.equal(frames[0].hardware_sequence,'unknown');assert.equal(frames[0].hardware_loss,'unknown');
});
test('CRC-only corruption rejects the damaged packet and recovers a same-sequence retransmission without a sequence gap',()=>{
 const p=new RawPacketParser({frameBytes:8}),frames=[];p.on('frame',f=>frames.push(f));
 const first=packet(Buffer.alloc(8),{sequence:7,tick:1000}),next=packet(Buffer.alloc(8,3),{sequence:8,tick:1100}),bad=Buffer.from(next);bad[34]^=1;
 p.push(Buffer.concat([first,bad,next]));p.finish();
 assert.equal(p.crcErrors,1);assert.equal(p.skippedBytes,bad.length);assert.equal(frames.length,2);assert.deepEqual(frames.map(f=>f.packet_sequence),[7,8]);assert.ok(frames.every(f=>!f.packet_sequence_discontinuity));assert.deepEqual(frames[1].wire_packet,next);assert.deepEqual(frames[1].payload,Buffer.alloc(8,3));
});
test('sequence-only gap with regular callback ticks is reported without CRC errors or skipped bytes',()=>{
 const p=new RawPacketParser({frameBytes:8}),frames=[];p.on('frame',f=>frames.push(f));
 p.push(Buffer.concat([packet(Buffer.alloc(8),{sequence:7,tick:1000}),packet(Buffer.alloc(8),{sequence:9,tick:1100})]));p.finish();
 assert.equal(p.crcErrors,0);assert.equal(p.skippedBytes,0);assert.deepEqual(frames.map(f=>f.packet_sequence_discontinuity),[false,true]);assert.deepEqual(frames.map(f=>f.callback_tick_ms),[1000,1100]);assert.ok(frames.every(f=>f.hardware_loss==='unknown'));
});
test('external noise and multiple valid packets do not masquerade as CRC corruption or a sequence gap',()=>{
 const p=new RawPacketParser({frameBytes:8}),frames=[];p.on('frame',f=>frames.push(f));const noise=Buffer.from('boot log\r\n');
 p.push(Buffer.concat([noise,packet(Buffer.alloc(8),{sequence:7}),packet(Buffer.alloc(8),{sequence:8})]));p.finish();
 assert.equal(frames.length,2);assert.equal(p.crcErrors,0);assert.equal(p.skippedBytes,noise.length);assert.ok(frames.every(f=>!f.packet_sequence_discontinuity));
});
test('invalid packet size and incomplete trailing frame are rejected without fabricating a valid raw frame',()=>{
 const p=new RawPacketParser({frameBytes:8}),frames=[];p.on('frame',f=>frames.push(f));const badSize=packet(Buffer.alloc(8));badSize.writeUInt32LE(0x7fffffff,8);p.push(badSize);assert.throws(()=>p.finish(),/trailing/);assert.equal(frames.length,0);assert.equal(p.crcErrors,0);assert.throws(()=>new RawPacketParser({frameBytes:0}));
 const truncated=new RawPacketParser({frameBytes:8});truncated.push(packet(Buffer.alloc(8)).subarray(0,39));assert.throws(()=>truncated.finish(),/trailing/);assert.equal(truncated.crcErrors,0);assert.equal(truncated.skippedBytes,0);
});
