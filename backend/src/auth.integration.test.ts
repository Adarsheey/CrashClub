import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import request from 'supertest';
import { avatarUploadDirectory } from './auth.js';
import { createApp } from './app.js';
import { prisma } from './database.js';

test('Phase 2 account lifecycle is enforced against PostgreSQL', { timeout: 90_000 }, async () => {
  process.env.AUTH_RATE_LIMIT_OVERRIDE = '100';
  process.env.DEV_AUTO_VERIFY_EMAIL = 'false';
  const suffix = `${Date.now()}_${randomBytes(3).toString('hex')}`;
  const email = `crash_${suffix}@example.test`;
  const username = `crash_${suffix}`.slice(0, 30);
  const blockedEmail = `blocked_${suffix}@example.test`;
  const blockedUsername = `blocked_${suffix}`.slice(0, 30);
  const mail: Array<{ to: string; subject: string; url: string }> = [];
  const app = createApp(prisma, prisma, async (to, subject, url) => { mail.push({ to, subject, url }); });
  const agent = request.agent(app);
  const secondAgent = request.agent(app);
  try {
    const registration = await request(app).post('/api/auth/register').send({ email, username, displayName: 'Snack Scout', password: 'snackcat' });
    assert.equal(registration.status, 201, JSON.stringify(registration.body));
    assert.equal(JSON.stringify(registration.body).toLowerCase().includes('token'), false);
    assert.equal(mail.length, 1);
    const pending = await prisma.user.findUniqueOrThrow({ where: { email } });
    assert.equal(pending.status, 'PENDING_EMAIL');
    assert.notEqual(pending.passwordHash, 'snackcat');
    assert.match(pending.passwordHash, /^\$argon2id\$/);

    assert.equal((await request(app).post('/api/auth/register').send({ email, username: `other_${suffix}`, displayName: 'Duplicate', password: 'snackcat' })).status, 409);
    assert.equal((await request(app).post('/api/auth/register').send({ email: `other_${suffix}@example.test`, username, displayName: 'Duplicate', password: 'snackcat' })).status, 409);
    assert.equal((await request(app).post('/api/auth/register').send({ email: 'not-an-email', username: 'x', displayName: '', password: 'tiny' })).status, 400);
    assert.equal((await request(app).post('/api/auth/login').send({ email, password: 'wrong password' })).status, 401);
    assert.equal((await request(app).post('/api/auth/login').send({ email, password: 'snackcat' })).status, 403);

    assert.equal((await request(app).post('/api/auth/verify-email').send({ token: 'invalid-token-value-that-is-long-enough' })).status, 400);
    const expiredVerification = randomBytes(32).toString('base64url');
    await prisma.emailActionToken.create({ data: { userId: pending.id, purpose: 'VERIFY_EMAIL', tokenHash: createHash('sha256').update(expiredVerification).digest('hex'), expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await request(app).post('/api/auth/verify-email').send({ token: expiredVerification })).status, 400);
    const verifyToken = new URL(mail[0].url).searchParams.get('token');
    assert.ok(verifyToken);
    const verificationHash = createHash('sha256').update(verifyToken).digest('hex');
    const verificationRow = await prisma.emailActionToken.findUniqueOrThrow({ where: { tokenHash: verificationHash } });
    assert.equal(verificationRow.userId, pending.id, 'only a digest of the email token is stored');
    assert.equal((await request(app).post('/api/auth/verify-email').send({ token: verifyToken })).status, 200);
    assert.equal((await request(app).post('/api/auth/verify-email').send({ token: verifyToken })).status, 400, 'verification token is single-use');

    assert.equal((await request(app).get('/api/auth/me')).status, 401, 'unauthorized session requests are rejected');
    assert.equal((await request(app).patch('/api/auth/me').send({ displayName: 'No session' })).status, 401, 'profile edits require a session');
    assert.equal((await request(app).post('/api/auth/me/avatar').set('Content-Type', 'image/png').send(Buffer.from('not an image'))).status, 401, 'avatar uploads require a session');
    const login = await agent.post('/api/auth/login').send({ email, password: 'snackcat' });
    assert.equal(login.status, 200);
    const cookie = String(login.headers['set-cookie']?.[0] ?? '');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    const sessionToken = cookie.split(';', 1)[0].split('=').slice(1).join('=');
    const sessionRow = await prisma.session.findFirstOrThrow({ where: { userId: pending.id, revokedAt: null } });
    assert.equal(sessionRow.tokenHash, createHash('sha256').update(sessionToken).digest('hex'), 'only a digest of the session token is stored');
    const me = await agent.get('/api/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.user.username, username);
    assert.equal('email' in me.body.user, false);
    assert.equal('passwordHash' in me.body.user, false);
    const profileUpdate = await agent.patch('/api/auth/me').send({ displayName: 'The Snack Scout', bio: 'Investigative crumbs.', avatarUrl: '' });
    assert.equal(profileUpdate.status, 200, JSON.stringify(profileUpdate.body));
    assert.equal(profileUpdate.body.user.bio, 'Investigative crumbs.');
    assert.equal(profileUpdate.body.user.avatarUrl, null, 'an empty optional picture URL clears the picture safely');
    const invalidAvatar = await agent.post('/api/auth/me/avatar').set('Content-Type', 'image/png').send(Buffer.from('not an image'));
    assert.equal(invalidAvatar.status, 400, 'image contents are checked against their declared MIME type');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6g0AAAAASUVORK5CYII=', 'base64');
    const uploadedAvatar = await agent.post('/api/auth/me/avatar').set('Content-Type', 'image/png').send(png);
    assert.equal(uploadedAvatar.status, 200, JSON.stringify(uploadedAvatar.body));
    assert.match(uploadedAvatar.body.user.avatarUrl, /^\/uploads\/avatars\/[0-9a-f-]+\.png$/i);
    const publicProfile = await request(app).get(`/api/users/${username}`);
    assert.equal(publicProfile.body.user.displayName, 'The Snack Scout');
    assert.equal(publicProfile.body.user.avatarUrl, uploadedAvatar.body.user.avatarUrl, 'other members receive the uploaded profile photo path');
    const imageResponse = await request(app).get(uploadedAvatar.body.user.avatarUrl);
    assert.equal(imageResponse.status, 200, 'the public profile photo URL serves the uploaded image');
    assert.equal(imageResponse.headers['content-type'].startsWith('image/png'), true);
    await unlink(join(avatarUploadDirectory(), basename(uploadedAvatar.body.user.avatarUrl)));
    assert.equal('email' in (await request(app).get(`/api/users/${username}`)).body.user, false);
    const blockedMember = await prisma.user.create({ data: { email: blockedEmail, username: blockedUsername, displayName: 'Blocked Member', passwordHash: pending.passwordHash, status: 'ACTIVE', emailVerifiedAt: new Date() } });
    await prisma.block.create({ data: { blockerId: blockedMember.id, blockedId: pending.id } });
    const blockedAgent = request.agent(app);
    assert.equal((await blockedAgent.post('/api/auth/login').send({ email: blockedEmail, password: 'snackcat' })).status, 200);
    assert.equal((await blockedAgent.get(`/api/users/${username}`)).status, 404, 'a blocked account cannot view the blocker profile');
    assert.equal((await agent.get(`/api/users/${blockedUsername}`)).status, 404, 'blocker and blocked profiles are hidden from one another');
    assert.equal((await agent.patch('/api/auth/me').set('Origin', 'https://not-crash-club.example').send({ displayName: 'Nope' })).status, 403);
    assert.equal((await request(app).post('/api/auth/register').set('Origin', 'http://localhost:5175').send({})).status, 400, 'Vite fallback ports are accepted during local development');
    assert.equal((await secondAgent.post('/api/auth/login').send({ email, password: 'snackcat' })).status, 200);

    const resetRequest = await request(app).post('/api/auth/password-reset/request').send({ email });
    assert.equal(resetRequest.status, 200);
    assert.equal(JSON.stringify(resetRequest.body).toLowerCase().includes('token'), false);
    assert.equal((await request(app).post('/api/auth/password-reset/request').send({ email: `missing_${suffix}@example.test` })).body.message, resetRequest.body.message);
    const resetMail = mail.find((item) => item.subject.includes('Reset'));
    assert.ok(resetMail);
    const resetToken = new URL(resetMail.url).searchParams.get('token');
    assert.ok(resetToken);
    assert.equal((await request(app).post('/api/auth/password-reset/confirm').send({ token: 'invalid-reset-token-long-enough', password: 'another sufficiently long password' })).status, 400);
    const expiredReset = randomBytes(32).toString('base64url');
    await prisma.emailActionToken.create({ data: { userId: pending.id, purpose: 'RESET_PASSWORD', tokenHash: createHash('sha256').update(expiredReset).digest('hex'), expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await request(app).post('/api/auth/password-reset/confirm').send({ token: expiredReset, password: 'another sufficiently long password' })).status, 400);
    assert.equal((await request(app).post('/api/auth/password-reset/confirm').send({ token: resetToken, password: 'another sufficiently long password' })).status, 200);
    assert.equal((await agent.get('/api/auth/me')).status, 401, 'password reset revokes existing sessions');
    assert.equal((await secondAgent.get('/api/auth/me')).status, 401, 'password reset revokes every existing session');
    assert.equal((await request(app).post('/api/auth/login').send({ email, password: 'snackcat' })).status, 401);
    assert.equal((await agent.post('/api/auth/login').send({ email, password: 'another sufficiently long password' })).status, 200);
    assert.equal((await agent.post('/api/auth/logout')).status, 200);
    assert.equal((await agent.get('/api/auth/me')).status, 401, 'logout revokes the session');

    process.env.AUTH_RATE_LIMIT_OVERRIDE = '2';
    const throttledApp = createApp(prisma, prisma, async () => {});
    assert.equal((await request(throttledApp).post('/api/auth/password-reset/request').send({ email: `throttle_${suffix}@example.test` })).status, 200);
    assert.equal((await request(throttledApp).post('/api/auth/password-reset/request').send({ email: `throttle_${suffix}@example.test` })).status, 200);
    assert.equal((await request(throttledApp).post('/api/auth/password-reset/request').send({ email: `throttle_${suffix}@example.test` })).status, 429, 'auth endpoints enforce an IP rate limit');
  } finally {
    await prisma.user.deleteMany({ where: { email: { in: [email, `other_${suffix}@example.test`, blockedEmail] } } });
    await prisma.$disconnect();
  }
});

test('local development registration lets users sign in without an inbox', { timeout: 30_000 }, async () => {
  process.env.NODE_ENV = 'development';
  process.env.DEV_AUTO_VERIFY_EMAIL = 'true';
  process.env.AUTH_RATE_LIMIT_OVERRIDE = '100';
  const suffix = `${Date.now()}_${randomBytes(3).toString('hex')}`;
  const email = `local_${suffix}@example.test`;
  const username = `local_${suffix}`.slice(0, 30);
  const pendingEmail = `pending_${suffix}@example.test`;
  const pendingUsername = `pending_${suffix}`.slice(0, 30);
  const sentMail: string[] = [];
  const app = createApp(prisma, prisma, async (_to, subject) => { sentMail.push(subject); });
  const agent = request.agent(app);
  try {
    const registered = await request(app).post('/api/auth/register').send({ email, username, displayName: 'Local Member', password: 'snackcat' });
    assert.equal(registered.status, 201);
    assert.match(registered.body.message, /sign in now/i);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    assert.equal(user.status, 'ACTIVE');
    assert.ok(user.emailVerifiedAt);
    assert.equal(await prisma.emailActionToken.count({ where: { userId: user.id, purpose: 'VERIFY_EMAIL' } }), 0);
    assert.equal(sentMail.length, 0);
    assert.equal((await agent.post('/api/auth/login').send({ email, password: 'snackcat' })).status, 200);
    await prisma.user.create({ data: { email: pendingEmail, username: pendingUsername, displayName: 'Earlier Local Signup', passwordHash: user.passwordHash, status: 'PENDING_EMAIL' } });
    const oldSignupAgent = request.agent(app);
    assert.equal((await oldSignupAgent.post('/api/auth/login').send({ email: pendingEmail, password: 'snackcat' })).status, 200, 'existing local pending accounts can sign in too');
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { email: pendingEmail } })).status, 'ACTIVE');
  } finally {
    await prisma.user.deleteMany({ where: { email: { in: [email, pendingEmail] } } });
    await prisma.$disconnect();
  }
});
