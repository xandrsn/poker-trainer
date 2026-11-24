// Vercel Function: the whole server (API and WebSocket) as one http.Server. Vercel runs it, so it never listens.
import app from '../server.js';

export default app.createServer({ diagFile: false });
