import { Router, type Request, type Response, type NextFunction, raw } from 'express';
import { rateLimit } from 'express-rate-limit';
import argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import type { PrismaClient, User } from './generated/prisma/client.js';

const SESSION_COOKIE = 'crash_club_session';
const SESSION_DAYS = 30;
const VERIFY_HOURS = 24;
const RESET_MINUTES = 30;
const MAX_AVATAR_BYTES = 1_500_000;
const AVATAR_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const;
export const avatarUploadDirectory = () => resolve(process.env.AVATAR_UPLOAD_DIR?.trim() || 'uploads/avatars');
const PASSWORD_HASH_OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;
const DUMMY_PASSWORD_HASH = argon2.hash(randomBytes(24).toString('hex'), PASSWORD_HASH_OPTIONS);
const developmentAutoVerification = () => process.env.NODE_ENV === 'development' && process.env.DEV_AUTO_VERIFY_EMAIL !== 'false';
const passwordSchema = z.string().min(8).max(128);
const usernameSchema = z.string().trim().toLowerCase().min(3).max(30).regex(/^[a-z0-9_]+$/, 'Use letters, numbers, and underscores.');
const emailSchema = z.email().max(254).transform((value) => value.trim().toLowerCase());
const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  bio: z.string().trim().max(280).optional(),
  avatarUrl: z.union([z.url().max(2048).refine((value) => URL.canParse(value) && ['http:', 'https:'].includes(new URL(value).protocol)), z.literal('')]).nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0);

export type Mailer = (to: string, subject: string, url: string) => Promise<void>;

const publicAppOrigin = () => process.env.APP_ORIGIN ?? process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:5173';

export function configuredMailer(): Mailer {
  const origin = publicAppOrigin();
  if (process.env.NODE_ENV !== 'production') {
    return async (_to, subject, url) => console.info(`[Crash Club development email] ${subject}: ${url}`);
  }
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  const from = process.env.EMAIL_FROM;
  if (!host || !user || !pass || !from || (!process.env.APP_ORIGIN && !process.env.RENDER_EXTERNAL_URL)) {
    throw new Error('Production email requires SMTP_HOST, SMTP_USER, SMTP_PASSWORD, EMAIL_FROM, and APP_ORIGIN.');
  }
  const transport = nodemailer.createTransport({ host, port: Number(process.env.SMTP_PORT ?? 587), secure: process.env.SMTP_SECURE === 'true', auth: { user, pass } });
  return async (to, subject, url) => {
    await transport.sendMail({ from, to, subject, text: `Use this one-time link within its expiry window: ${url}` });
  };
}

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const safeProfile = (user: User) => ({
  id: user.id,
  username: user.username,
  displayName: user.displayName,
  bio: user.bio,
  avatarUrl: user.avatarUrl,
  createdAt: user.createdAt,
});
const isPrismaUniqueError = (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002');
function matchesImageSignature(bytes: Buffer, mimeType: string) {
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return mimeType === 'image/webp' && bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}

async function issueEmailToken(prisma: PrismaClient, user: User, purpose: 'VERIFY_EMAIL' | 'RESET_PASSWORD') {
  const token = newToken();
  const expiresAt = new Date(Date.now() + (purpose === 'VERIFY_EMAIL' ? VERIFY_HOURS * 60 : RESET_MINUTES) * 60_000);
  await prisma.emailActionToken.create({ data: { userId: user.id, purpose, tokenHash: digest(token), expiresAt } });
  return token;
}

export function createAuthRouter(prisma: PrismaClient, suppliedMailer?: Mailer) {
  const router = Router();
  const mailer = suppliedMailer ?? configuredMailer();
  const appOrigin = publicAppOrigin();
  const makeRateLimit = (productionLimit: number, windowMs = 15 * 60_000) => rateLimit({
    windowMs,
    limit: Number(process.env.AUTH_RATE_LIMIT_OVERRIDE ?? (process.env.NODE_ENV === 'production' ? process.env.AUTH_RATE_LIMIT ?? productionLimit : 100)),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many attempts. Let the kitchen cool down and try later.' },
  });
  const registrationLimit = makeRateLimit(5, 60 * 60_000);
  const emailActionLimit = makeRateLimit(10);
  const loginLimit = makeRateLimit(10);
  const passwordResetLimit = makeRateLimit(5, 60 * 60_000);
  const avatarUploadLimit = makeRateLimit(12, 60 * 60_000);
  router.use((req, res, next) => {
    const origin = req.get('origin');
    const localDevOrigin = (() => {
      if (process.env.NODE_ENV === 'production' || !origin) return false;
      try {
        const parsedOrigin = new URL(origin);
        return parsedOrigin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsedOrigin.hostname) && parsedOrigin.port.length > 0;
      } catch {
        return false;
      }
    })();
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && origin && origin !== appOrigin && !localDevOrigin) {
      return res.status(403).json({ error: 'This request did not come from the Crash Club kitchen.' });
    }
    return next();
  });

  router.post('/register', registrationLimit, async (req, res) => {
    const parsed = z.object({ email: emailSchema, username: usernameSchema, displayName: z.string().trim().min(1).max(60), password: passwordSchema }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Check your email, username, display name, and password.' });
    const { email, username, displayName, password } = parsed.data;
    try {
      const autoVerify = developmentAutoVerification();
      const user = await prisma.user.create({ data: {
        email,
        username,
        displayName,
        passwordHash: await argon2.hash(password, PASSWORD_HASH_OPTIONS),
        status: autoVerify ? 'ACTIVE' : 'PENDING_EMAIL',
        emailVerifiedAt: autoVerify ? new Date() : null,
      } });
      if (!autoVerify) {
        const token = await issueEmailToken(prisma, user, 'VERIFY_EMAIL');
        await mailer(email, 'Verify your Crash Club account', `${appOrigin}/verify?token=${encodeURIComponent(token)}`);
      }
      const message = autoVerify
        ? 'Account created. Local development skips inbox verification, so you can sign in now.'
        : 'Account created. Check your email to verify it before signing in.';
      return res.status(201).json({ message });
    } catch (error) {
      if (isPrismaUniqueError(error)) return res.status(409).json({ error: 'That email or username is already on the guest list.' });
      throw error;
    }
  });

  router.post('/verify-email', emailActionLimit, async (req, res) => {
    const parsed = z.object({ token: z.string().min(20).max(200) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'That verification link is invalid or expired.' });
    const now = new Date();
    const result = await prisma.$transaction(async (transactionClient) => {
      // Prisma 7's generated transaction-client type omits model delegates in this ESM build;
      // the runtime transaction client exposes the same delegates as the root client.
      const tx = transactionClient as unknown as PrismaClient;
      const token = await tx.emailActionToken.findFirst({ where: { tokenHash: digest(parsed.data.token), purpose: 'VERIFY_EMAIL', usedAt: null, expiresAt: { gt: now } } });
      if (!token) return false;
      const claimed = await tx.emailActionToken.updateMany({ where: { id: token.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
      if (claimed.count !== 1) return false;
      await tx.user.update({ where: { id: token.userId }, data: { status: 'ACTIVE', emailVerifiedAt: now } });
      return true;
    });
    return result ? res.json({ message: 'Email verified. You may now sign in.' }) : res.status(400).json({ error: 'That verification link is invalid or expired.' });
  });

  router.post('/resend-verification', emailActionLimit, async (req, res) => {
    if (developmentAutoVerification()) return res.json({ message: 'Local development skips email verification. You can sign in now.' });
    const parsed = z.object({ email: emailSchema }).safeParse(req.body);
    if (!parsed.success) return res.status(200).json({ message: 'If that account needs verification, a link is on its way.' });
    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    if (user?.status === 'PENDING_EMAIL') {
      const token = await issueEmailToken(prisma, user, 'VERIFY_EMAIL');
      await mailer(user.email, 'Verify your Crash Club account', `${appOrigin}/verify?token=${encodeURIComponent(token)}`);
    }
    return res.json({ message: 'If that account needs verification, a link is on its way.' });
  });

  router.post('/login', loginLimit, async (req, res) => {
    const parsed = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Enter a valid email and password.' });
    let user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    const hash = user?.passwordHash ?? await DUMMY_PASSWORD_HASH;
    const valid = await argon2.verify(hash, parsed.data.password).catch(() => false);
    if (!user || !valid) return res.status(401).json({ error: 'Email or password is incorrect.' });
    if (user.status === 'PENDING_EMAIL' && developmentAutoVerification()) {
      user = await prisma.user.update({ where: { id: user.id }, data: { status: 'ACTIVE', emailVerifiedAt: new Date() } });
    }
    if (user.status !== 'ACTIVE') return res.status(403).json({ error: 'Verify your email before signing in.' });
    const sessionToken = newToken();
    await prisma.session.create({ data: { userId: user.id, tokenHash: digest(sessionToken), expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000) } });
    res.cookie(SESSION_COOKIE, sessionToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: SESSION_DAYS * 86_400_000 });
    return res.json({ user: safeProfile(user) });
  });

  const requireSession = async (req: Request, res: Response, next: NextFunction) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== 'string' || token.length > 200) return res.status(401).json({ error: 'Sign in to continue.' });
    const session = await prisma.session.findFirst({ where: { tokenHash: digest(token), revokedAt: null, expiresAt: { gt: new Date() }, user: { status: 'ACTIVE' } }, include: { user: true } });
    if (!session) return res.status(401).json({ error: 'Sign in to continue.' });
    res.locals.user = session.user as User;
    res.locals.sessionId = session.id as string;
    return next();
  };

  router.post('/logout', requireSession, async (_req, res) => {
    await prisma.session.update({ where: { id: res.locals.sessionId as string }, data: { revokedAt: new Date() } });
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' });
    return res.json({ message: 'Signed out. The leftovers are all yours.' });
  });

  router.get('/me', requireSession, (_req, res) => res.json({ user: safeProfile(res.locals.user as User) }));

  router.post('/me/avatar', requireSession, avatarUploadLimit, raw({ type: '*/*', limit: MAX_AVATAR_BYTES }), async (req, res) => {
    const mimeType = req.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!(mimeType in AVATAR_TYPES) || bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES || !matchesImageSignature(bytes, mimeType)) {
      return res.status(400).json({ error: 'Choose a valid PNG, JPEG or WebP image no larger than 1.5 MB.' });
    }
    const extension = AVATAR_TYPES[mimeType as keyof typeof AVATAR_TYPES];
    const filename = `${randomUUID()}.${extension}`;
    const directory = avatarUploadDirectory();
    const filePath = join(directory, filename);
    await mkdir(directory, { recursive: true });
    await writeFile(filePath, bytes, { flag: 'wx' });
    try {
      const user = await prisma.user.update({ where: { id: (res.locals.user as User).id }, data: { avatarUrl: `/uploads/avatars/${filename}` } });
      return res.json({ user: safeProfile(user) });
    } catch (error) {
      await unlink(filePath).catch(() => {});
      throw error;
    }
  });

  router.patch('/me', requireSession, async (req, res) => {
    const parsed = profileSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Check those profile details and try again.' });
    const updates = { ...parsed.data };
    if (updates.avatarUrl === '') updates.avatarUrl = null;
    const user = await prisma.user.update({ where: { id: (res.locals.user as User).id }, data: updates });
    return res.json({ user: safeProfile(user) });
  });

  router.post('/password-reset/request', passwordResetLimit, async (req, res) => {
    const parsed = z.object({ email: emailSchema }).safeParse(req.body);
    if (parsed.success) {
      const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
      if (user?.status === 'ACTIVE') {
        const token = await issueEmailToken(prisma, user, 'RESET_PASSWORD');
        await mailer(user.email, 'Reset your Crash Club password', `${appOrigin}/reset-password?token=${encodeURIComponent(token)}`);
      }
    }
    return res.json({ message: 'If that email belongs to an active account, a reset link is on its way.' });
  });

  router.post('/password-reset/confirm', passwordResetLimit, async (req, res) => {
    const parsed = z.object({ token: z.string().min(20).max(200), password: passwordSchema }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'That reset link is invalid or expired, or the password is too short.' });
    const now = new Date();
    const passwordHash = await argon2.hash(parsed.data.password, PASSWORD_HASH_OPTIONS);
    const changed = await prisma.$transaction(async (transactionClient) => {
      const tx = transactionClient as unknown as PrismaClient;
      const token = await tx.emailActionToken.findFirst({ where: { tokenHash: digest(parsed.data.token), purpose: 'RESET_PASSWORD', usedAt: null, expiresAt: { gt: now } } });
      if (!token) return false;
      const claimed = await tx.emailActionToken.updateMany({ where: { id: token.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
      if (claimed.count !== 1) return false;
      await tx.user.update({ where: { id: token.userId }, data: { passwordHash } });
      await tx.session.updateMany({ where: { userId: token.userId, revokedAt: null }, data: { revokedAt: now } });
      return true;
    });
    return changed ? res.json({ message: 'Password reset. Sign in with your new password.' }) : res.status(400).json({ error: 'That reset link is invalid or expired, or the password is too short.' });
  });

  return router;
}

export function createPublicProfileRouter(prisma: PrismaClient) {
  const router = Router();
  router.get('/:username', async (req, res) => {
    const parsed = usernameSchema.safeParse(req.params.username);
    if (!parsed.success) return res.status(404).json({ error: 'No member by that username.' });
    const user = await prisma.user.findFirst({ where: { username: parsed.data, status: 'ACTIVE' } });
    const sessionToken = req.cookies?.[SESSION_COOKIE];
    if (user && typeof sessionToken === 'string') {
      const viewerSession = await prisma.session.findFirst({ where: { tokenHash: digest(sessionToken), revokedAt: null, expiresAt: { gt: new Date() }, user: { status: 'ACTIVE' } }, select: { userId: true } });
      if (viewerSession?.userId && viewerSession.userId !== user.id) {
        const block = await prisma.block.findFirst({ where: { OR: [{ blockerId: viewerSession.userId, blockedId: user.id }, { blockerId: user.id, blockedId: viewerSession.userId }] }, select: { id: true } });
        if (block) return res.status(404).json({ error: 'No member by that username.' });
      }
    }
    return user ? res.json({ user: safeProfile(user) }) : res.status(404).json({ error: 'No member by that username.' });
  });
  return router;
}
