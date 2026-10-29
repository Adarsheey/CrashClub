import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import cookieParser from 'cookie-parser';
import type { PrismaClient } from './generated/prisma/client.js';
import { avatarUploadDirectory, createAuthRouter, createPublicProfileRouter, type Mailer } from './auth.js';
import { createSocialRouter, type Notify } from './social.js';

export type DatabaseHealthCheck = {
  $queryRawUnsafe: (query: string) => Promise<unknown>;
};

export function createApp(database: DatabaseHealthCheck, authDatabase?: PrismaClient, mailer?: Mailer, notify?: Notify) {
  const app = express();
  app.disable('x-powered-by');
  app.use('/uploads/avatars', express.static(resolve(avatarUploadDirectory()), { dotfiles: 'deny', index: false, fallthrough: true, maxAge: '1y', immutable: true, setHeaders: (response) => response.setHeader('X-Content-Type-Options', 'nosniff') }));
  const proxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
  if (Number.isInteger(proxyHops) && proxyHops >= 0 && proxyHops <= 10) app.set('trust proxy', proxyHops);
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.get('/api/health', async (_request: Request, response: Response) => {
    try {
      await database.$queryRawUnsafe('SELECT 1');
      response.status(200).json({ status: 'ok', database: 'ok' });
    } catch {
      response.status(503).json({ status: 'error', database: 'unavailable' });
    }
  });

  if (authDatabase) {
    app.use('/api/auth', createAuthRouter(authDatabase, mailer));
    app.use('/api/users', createPublicProfileRouter(authDatabase));
    app.use('/api/social', createSocialRouter(authDatabase, notify));
  }

  if (process.env.NODE_ENV === 'production') {
    const frontendDist = resolve(process.env.FRONTEND_DIST_DIR?.trim() || 'frontend/dist');
    const frontendIndex = join(frontendDist, 'index.html');
    if (!existsSync(frontendIndex)) {
      throw new Error(`Built frontend not found at ${frontendIndex}. Run the frontend production build before starting the server.`);
    }
    app.use(express.static(frontendDist, { index: false, dotfiles: 'deny', fallthrough: true, maxAge: '1h' }));
    app.get(/.*/, (request, response, next) => {
      if (request.path.startsWith('/api') || request.path.startsWith('/socket.io') || request.path.startsWith('/uploads')) return next();
      if (!request.accepts('html')) return next();
      response.sendFile(frontendIndex, (error) => { if (error) next(error); });
    });
  }

  app.use((_request, response) => {
    response.status(404).json({ error: 'Not found' });
  });

  const errors: ErrorRequestHandler = (error: unknown, request, response, _next) => {
    // Keep diagnostics useful without logging request bodies, cookies, credentials, or error messages.
    const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
    const status = typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
    if (status === 413) return response.status(413).json({ error: 'Choose a smaller file and try again.' });
    console.error('Unhandled request error', {
      name: error instanceof Error ? error.name : 'unknown',
      ...(code ? { code } : {}),
      method: request.method,
      path: request.path,
    });
    response.status(500).json({ error: 'Internal server error' });
  };
  app.use(errors);
  return app;
}
