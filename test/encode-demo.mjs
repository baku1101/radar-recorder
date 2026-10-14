import fs from 'node:fs';
import { launchHeadless } from './headless.mjs';
const browser = await launchHeadless('test-output');
try {
  const base64 = await browser.evaluate(`(async () => {
    const canvas=document.createElement('canvas'); canvas.width=640; canvas.height=360; document.body.append(canvas);
    const ctx=canvas.getContext('2d'), stream=canvas.captureStream(20), chunks=[];
    const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});
    recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
    const done=new Promise(resolve=>recorder.onstop=resolve), begin=performance.now(); recorder.start();
    const timer=setInterval(()=>{const t=Math.min(12,(performance.now()-begin)/1000);ctx.fillStyle='#182c37';ctx.fillRect(0,0,640,360);ctx.strokeStyle='#2f4852';for(let i=0;i<8;i++){ctx.beginPath();ctx.moveTo(i*80,0);ctx.lineTo(i*80,360);ctx.stroke()}ctx.fillStyle='#efb162';ctx.beginPath();ctx.arc(55+t/12*525,145,26,0,Math.PI*2);ctx.fill();ctx.fillStyle='#a2c9c5';ctx.font='22px sans-serif';ctx.fillText('DEMO / SYNTHETIC · NO SENSOR / NO CAMERA',25,35);ctx.font='20px monospace';ctx.fillText(t.toFixed(2)+' s',25,270);ctx.fillStyle='#2ca397';ctx.fillRect(25,300,t/12*590,12)},50);
    await new Promise(resolve=>setTimeout(resolve,12000));clearInterval(timer);recorder.stop();await done;stream.getTracks().forEach(t=>t.stop());
    const bytes=new Uint8Array(await new Blob(chunks,{type:'video/webm'}).arrayBuffer());let text='';for(const byte of bytes)text+=String.fromCharCode(byte);return btoa(text);
  })()`);
  fs.writeFileSync('fixtures/demo.webm', Buffer.from(base64, 'base64'));
  console.log('Synthetic canvas WebM encoded in isolated headless browser; no sensor/camera.');
} finally { await browser.close(); }
