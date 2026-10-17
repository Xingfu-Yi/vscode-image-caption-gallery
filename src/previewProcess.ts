import { processPreview } from './previewProcessor';
import type { PreviewInput } from './previewExecutor';
// The same packaged Node/Electron runtime works locally and on Remote SSH.
process.on('disconnect', () => process.exit(0));
process.on('message', async (message: PreviewInput) => {
  try {
    const result = await processPreview(message.bytes, message.resolution, message.filename, message.thumbnail);
    process.send?.({ result, pid: process.pid });
  } catch (error) {
    process.send?.({ error: error instanceof Error ? error.message : String(error) });
  }
});
process.send?.({ ready: true });
