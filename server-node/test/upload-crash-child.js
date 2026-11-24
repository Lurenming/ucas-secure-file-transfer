import { UploadStore } from '../src/upload-store.js';
import { randomUUID, createHash } from 'node:crypto';
const [directory, phase] = process.argv.slice(2);
const crash = () => process.exit(72); // This test child only: deliberately bypass normal shutdown.
const store = new UploadStore(directory, {}, {
  afterPreparing: phase === 'preparing' ? crash : undefined,
  beforeCommit: phase === 'published' ? crash : undefined,
  afterCommit: phase === 'committed' ? crash : undefined,
});
const bytes = Buffer.from('crash-content');
const item = store.reserve(randomUUID(), randomUUID(), 1, 'crash.txt', bytes.length);
process.stdout.write(item.id + '\n');
await store.create(item); await store.write(item, bytes); await item.handle.sync();
if (phase === 'receiving') crash();
await store.publish(item, createHash('sha256').update(bytes).digest('hex'), () => {});
crash();
