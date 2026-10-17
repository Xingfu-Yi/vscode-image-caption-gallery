import { parentPort } from 'node:worker_threads';
import { processPreview } from './previewProcessor';

parentPort?.on('message', async (message: { bytes: Uint8Array; resolution: number; filename: string; thumbnail?: boolean }) => {
  try {
    const result = await processPreview(message.bytes, message.resolution, message.filename, message.thumbnail);
    parentPort?.postMessage({ result, pid: process.pid }, result.bytes ? [result.bytes.buffer] : []);
  } catch (error) {
    parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});

parentPort?.postMessage({ ready: true });
