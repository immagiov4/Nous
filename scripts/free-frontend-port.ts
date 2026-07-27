const FRONTEND_PORT = 5173;

const { freeListeningPort } = await import('./free-listening-port.ts');

freeListeningPort(FRONTEND_PORT);
