import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { createApp } from './app.js';
import { prisma } from './database.js';
import { socketUserId } from './social.js';

dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

const port = Number(process.env.PORT ?? 3000);
// Mount the authenticated routes on the real API server, not just in tests.
let io: Server;
const app = createApp(prisma, prisma, undefined, (userId, notification) => {
  const userRoom = io?.to(`user:${userId}`);
  if (notification.type === 'REALTIME_MESSAGE' && notification.message) userRoom?.emit('message', notification.message);
  else userRoom?.emit('notification', notification);
});
const server = createServer(app);
io = new Server(server);
io.use(async (socket, next) => {
  try {
    const userId = await socketUserId(prisma, socket.handshake.headers.cookie);
    if (!userId) return next(new Error('Sign in to use real-time updates.'));
    socket.data.userId = userId;
    return next();
  } catch { return next(new Error('Could not verify this session.')); }
});
io.on('connection', (socket) => { socket.join(`user:${socket.data.userId}`); });
server.listen(port, () => {
  console.log(`Crash Club API listening on http://localhost:${port}`);
});

async function shutdown() {
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
