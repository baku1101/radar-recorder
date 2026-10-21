import { parentPort } from 'node:worker_threads';
import { microDoppler } from './raw-dsp.mjs';
parentPort.on('message', ({ id, bytes, config, processing, start }) => { try { parentPort.postMessage({ id, result:microDoppler(Buffer.from(bytes),config,processing,start) }); } catch(error){parentPort.postMessage({id,error:{code:error.code??'RAW_DSP_FAILED',message:error.message}});} });
