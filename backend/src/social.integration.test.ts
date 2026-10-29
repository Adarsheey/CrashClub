import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { Server } from 'socket.io';
import { io as connectSocket, type Socket } from 'socket.io-client';
import request from 'supertest';
import { createApp } from './app.js';
import { prisma } from './database.js';
import { socketUserId } from './social.js';

test('social platform protects audiences and preserves histories', { timeout: 180_000 }, async () => {
  const suffix = `${Date.now()}_${randomBytes(3).toString('hex')}`;
  const users = [
    { email: `alice_${suffix}@example.test`, username: `alice_${suffix}`.slice(0,30), displayName: 'Alice Crumb' },
    { email: `bob_${suffix}@example.test`, username: `bob_${suffix}`.slice(0,30), displayName: 'Bob Biscuit' },
    { email: `cara_${suffix}@example.test`, username: `cara_${suffix}`.slice(0,30), displayName: 'Cara Cake' },
    { email: `dana_${suffix}@example.test`, username: `dana_${suffix}`.slice(0,30), displayName: 'Dana Dough', role: 'MODERATOR' },
  ];
  let socketServer: Server | undefined;
  let socketClient: Socket | undefined;
  let created: any[] = [];
  try {
    created = await Promise.all(users.map((u) => prisma.user.create({ data: { ...u, role: (u as any).role ?? 'MEMBER', passwordHash: 'test-hash', status: 'ACTIVE', emailVerifiedAt: new Date() } })));
    const tokens = created.map(() => randomBytes(32).toString('base64url'));
    await Promise.all(created.map((u: any, i: number) => prisma.session.create({ data: { userId: u.id, tokenHash: createHash('sha256').update(tokens[i]!).digest('hex'), expiresAt: new Date(Date.now() + 15 * 60_000) } })));
    let liveSocketServer: Server | undefined;
    const app = createApp(prisma, prisma, undefined, (userId, notification) => liveSocketServer?.to(`user:${userId}`).emit('notification', notification));
    const httpServer = createServer(app);
    socketServer = new Server(httpServer);
    liveSocketServer = socketServer;
    socketServer.use(async (socket, next) => {
      const userId = await socketUserId(prisma, socket.handshake.headers.cookie);
      if (!userId) return next(new Error('unauthorized'));
      socket.data.userId = userId;
      return next();
    });
    socketServer.on('connection', (socket) => socket.join(`user:${socket.data.userId}`));
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const port = (httpServer.address() as { port: number }).port;
    const socketNotification = new Promise<any>((resolve, reject) => {
      socketClient = connectSocket(`http://127.0.0.1:${port}`, { transports: ['websocket'], extraHeaders: { cookie: `crash_club_session=${tokens[1]}` }, timeout: 5000 });
      socketClient.once('notification', resolve);
      socketClient.once('connect_error', reject);
      windowlessTimeout(reject, 6000);
    });
    await new Promise<void>((resolve, reject) => { socketClient!.once('connect', () => resolve()); socketClient!.once('connect_error', reject); });
    const client = (i: number) => ({ get: (path: string) => request(app).get(path).set('Cookie', `crash_club_session=${tokens[i]}`), post: (path: string) => request(app).post(path).set('Cookie', `crash_club_session=${tokens[i]}`), patch: (path: string) => request(app).patch(path).set('Cookie', `crash_club_session=${tokens[i]}`), delete: (path: string) => request(app).delete(path).set('Cookie', `crash_club_session=${tokens[i]}`) });
    const [alice, bob, cara, staff] = [client(0), client(1), client(2), client(3)];
    const requestBob = await alice.post('/api/social/friend-requests').send({ userId: created[1]!.id });
    assert.equal(requestBob.status, 201);
    const realtime = await socketNotification;
    assert.equal(realtime.type, 'FRIEND_REQUEST', 'authorized users receive real-time notifications');
    const accepted = await bob.post(`/api/social/friend-requests/${requestBob.body.request.id}/accept`);
    assert.equal(accepted.status, 200);

    const privatePost = await alice.post('/api/social/posts').send({ body: 'The secret dumpling location.', visibility: 'FRIENDS', recipientIds: [created[1]!.id], category: 'POP-UP' });
    assert.equal(privatePost.status, 201, JSON.stringify(privatePost.body));
    const draft = await alice.post('/api/social/posts').send({ body: 'Still in the notebook.', status: 'DRAFT' });
    assert.equal(draft.status, 201);
    assert.equal((await bob.get('/api/social/posts')).body.posts.some((p: any) => p.id === privatePost.body.post.id), true);
    assert.equal((await cara.get('/api/social/posts')).body.posts.some((p: any) => p.id === privatePost.body.post.id), false);
    assert.equal((await alice.get('/api/social/posts?q=definitely-not-in-this-post')).body.posts.length, 0, 'search filters are combined with audience checks');
    assert.equal((await alice.get('/api/social/leaderboard')).body.leaderboard.find((entry: any) => entry.user.id === created[0]!.id).posts, 1);
    const edited = await alice.patch(`/api/social/posts/${privatePost.body.post.id}`).send({ body: 'The same secret dumpling location, edited.' });
    assert.equal(edited.status, 200);
    assert.equal((await alice.get('/api/social/leaderboard')).body.leaderboard.find((entry: any) => entry.user.id === created[0]!.id).posts, 1);

    const conversation = await alice.post(`/api/social/conversations/${created[1]!.id}`).send({});
    assert.equal(conversation.status, 200);
    const sent = await alice.post(`/api/social/conversations/${conversation.body.conversation.id}/messages`).send({ body: 'Bring napkins.' });
    assert.equal(sent.status, 201);
    assert.equal((await bob.get('/api/social/conversations')).body.conversations[0].unread, 1);
    assert.equal((await bob.get(`/api/social/conversations/${conversation.body.conversation.id}/messages`)).body.messages[0].body, 'Bring napkins.');
    assert.equal((await bob.get('/api/social/conversations')).body.conversations[0].unread, 0, 'opening a conversation marks unread messages read');

    await alice.delete(`/api/social/friends/${created[1]!.id}`);
    assert.equal((await bob.get('/api/social/posts')).body.posts.some((p: any) => p.id === privatePost.body.post.id), false, 'unfriending revokes existing private-post access');
    assert.equal((await bob.get(`/api/social/conversations/${conversation.body.conversation.id}/messages`)).body.messages.length, 1, 'historical messages remain visible');
    assert.equal((await alice.post(`/api/social/conversations/${conversation.body.conversation.id}/messages`).send({ body: 'Follow-up' })).status, 403, 'new messages require a current friendship');
    const renewed = await bob.post('/api/social/friend-requests').send({ userId: created[0]!.id });
    assert.equal(renewed.status, 201);
    assert.equal((await alice.post(`/api/social/friend-requests/${renewed.body.request.id}/accept`)).status, 200);
    assert.equal((await bob.get('/api/social/posts')).body.posts.some((p: any) => p.id === privatePost.body.post.id), false, 're-friending does not restore a revoked audience grant');
    await alice.post(`/api/social/blocks/${created[1]!.id}`);
    assert.equal((await alice.get(`/api/users/${created[1]!.username}`)).status, 404, 'blocked member profiles are hidden');
    assert.equal((await bob.post('/api/social/friend-requests').send({ userId: created[0]!.id })).status, 404, 'blocks prevent new contact');
    assert.equal((await bob.get(`/api/social/conversations/${conversation.body.conversation.id}/messages`)).body.messages.length, 1, 'blocking preserves private message history');
    assert.equal((await alice.post(`/api/social/conversations/${conversation.body.conversation.id}/messages`).send({ body: 'Blocked follow-up' })).status, 403, 'blocks prevent new messages');
    const publicPost = await bob.post('/api/social/posts').send({ body: 'Public pie report.', visibility: 'PUBLIC' });
    assert.equal(publicPost.status, 201);
    assert.equal((await alice.get('/api/social/posts')).body.posts.some((p: any) => p.id === publicPost.body.post.id), true, 'public posts remain public across blocks');

    const requestCara = await alice.post('/api/social/friend-requests').send({ userId: created[2]!.id });
    assert.equal(requestCara.status, 201);
    await cara.post(`/api/social/friend-requests/${requestCara.body.request.id}/accept`);
    assert.equal((await cara.get('/api/social/posts')).body.posts.some((p: any) => p.id === privatePost.body.post.id), false, 'new friends do not gain access to earlier friends-only posts');
    const event = await alice.post('/api/social/events').send({ title: 'Midnight Soup Council', description: 'Bring opinions.', startsAt: new Date(Date.now() + 86_400_000).toISOString(), visibility: 'INVITE_ONLY', inviteeIds: [created[2]!.id] });
    assert.equal(event.status, 201, JSON.stringify(event.body));
    assert.equal(event.body.post.event.id, event.body.event.id, 'one event submission also publishes a linked intel post');
    const bobPosts = await bob.get('/api/social/posts');
    assert.equal(bobPosts.body.posts.some((p: any) => p.id === event.body.post.id), false, 'events are listed in Events, not duplicated in Intel');
    assert.equal((await bob.get('/api/social/posts?q=Midnight%20Soup')).body.posts.some((p: any) => p.id === event.body.post.id), false, 'event titles are searched in Events, not Intel');
    assert.equal((await cara.get('/api/social/posts')).body.posts.some((p: any) => p.id === event.body.post.id), false, 'invitees see the event in Events only');
    const bobEvents = await bob.get('/api/social/events');
    assert.equal(bobEvents.status, 200, JSON.stringify(bobEvents.body));
    assert.equal(bobEvents.body.events.some((e: any) => e.id === event.body.event.id), false, 'invite-only events stay private');
    const caraEvents = await cara.get('/api/social/events');
    assert.equal(caraEvents.status, 200, JSON.stringify(caraEvents.body));
    assert.equal(caraEvents.body.events.some((e: any) => e.id === event.body.event.id), true, 'invitees can see invite-only events');
    assert.equal((await bob.post('/api/social/reports').send({ eventId: event.body.event.id, reason: 'Guessing' })).status, 404, 'reports cannot target hidden events');
    assert.equal((await cara.patch(`/api/social/events/${event.body.event.id}/rsvp`).send({ rsvp: 'MAYBE' })).status, 200);
    assert.ok((await alice.get('/api/social/notifications')).body.notifications.some((n: any) => n.type === 'RSVP_UPDATED'));
    assert.ok((await cara.get('/api/social/notifications')).body.notifications.some((n: any) => n.type === 'EVENT_INVITATION'));
    assert.equal((await alice.patch(`/api/social/events/${event.body.event.id}`).send({ title: 'Midnight Soup Council, revised' })).status, 200);
    assert.ok((await cara.get('/api/social/notifications')).body.notifications.some((n: any) => n.type === 'EVENT_UPDATED'));
    const report = await cara.post('/api/social/reports').send({ eventId: event.body.event.id, reason: 'Suspicious soup' });
    assert.equal(report.status, 201);
    assert.equal((await cara.get('/api/social/moderation/reports')).status, 403);
    assert.equal((await staff.get('/api/social/moderation/reports')).status, 200);
    assert.equal((await staff.patch(`/api/social/moderation/reports/${report.body.reportId}`).send({ status: 'RESOLVED', moderatorNotes: 'Reviewed.' })).status, 200);
    const publicEvent = await alice.post('/api/social/events').send({ title: 'Public Pie Census', startsAt: new Date(Date.now() + 172_800_000).toISOString(), visibility: 'PUBLIC', postVisibility: 'FRIENDS', postRecipientIds: [created[2]!.id] });
    assert.equal(publicEvent.status, 201);
    assert.equal((await bob.get('/api/social/events?q=Public%20Pie')).body.events.some((e: any) => e.id === publicEvent.body.event.id), true, 'event search returns matching public events even across blocks');
    assert.equal((await bob.get('/api/social/posts')).body.posts.some((p: any) => p.id === publicEvent.body.post.id), false, 'public event visibility does not make its friends-only post public');
    assert.equal((await cara.get('/api/social/posts')).body.posts.some((p: any) => p.id === publicEvent.body.post.id), false, 'events do not duplicate as feed posts regardless of post audience');
    assert.equal((await staff.post(`/api/social/moderation/posts/${publicPost.body.post.id}/remove`).send({ reason: 'Test removal' })).status, 200);

    await alice.delete(`/api/social/posts/${privatePost.body.post.id}`);
    assert.equal((await alice.get('/api/social/leaderboard')).body.leaderboard.find((entry: any) => entry.user.id === created[0]!.id).posts, 2, 'deleted posts no longer count but both event intel posts remain counted');
  } finally {
    socketClient?.disconnect();
    if (socketServer) await new Promise<void>((resolve) => socketServer!.close(() => resolve()));
    if (created.length) await prisma.moderationAction.deleteMany({ where: { moderatorId: { in: created.map((user: any) => user.id) } } });
    await prisma.user.deleteMany({ where: { email: { in: users.map((u) => u.email) } } });
  }
});

function windowlessTimeout(reject: (reason?: unknown) => void, ms: number) {
  const timer = setTimeout(() => reject(new Error('Timed out waiting for a Socket.IO notification.')), ms);
  timer.unref();
}
