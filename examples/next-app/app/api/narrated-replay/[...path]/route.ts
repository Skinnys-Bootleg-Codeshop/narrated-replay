import { createIngestHandler, toNextRouteHandlers } from 'narrated-replay/server';
import { store } from '../../../../lib-store';

// The example is for local use: allow everything outside production. In a real app,
// check your own session here (cookie, bearer token) and return false for strangers.
const handler = createIngestHandler({ store, authorize: () => process.env.NODE_ENV !== 'production' });

export const { POST } = toNextRouteHandlers(handler);
