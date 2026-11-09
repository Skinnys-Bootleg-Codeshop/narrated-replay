import path from 'node:path';
import { createFileStore } from 'narrated-replay/server';

// Where recordings go. Override with NR_STORE.
export const store = createFileStore(process.env.NR_STORE ?? path.join(process.cwd(), '.nr-store'));
