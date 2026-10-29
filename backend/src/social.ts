import { Router, type Request, type Response, type NextFunction } from 'express';
import { rateLimit } from 'express-rate-limit';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PrismaClient, User } from './generated/prisma/client.js';

const cookieName = 'crash_club_session';
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const publicUserSelect = { id: true, username: true, displayName: true, avatarUrl: true } as const;
type RealtimeMessage = { id: string; conversationId: string; senderId: string; body: string; createdAt: Date; sender: { id: string; username: string; displayName: string; avatarUrl: string | null } };
export type Notify = (userId: string, notification: { id: string; type: string; entityType: string | null; entityId: string | null; createdAt: Date; message?: RealtimeMessage }) => void;
const idSchema = z.uuid();
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalUrl = z.union([z.url().max(2048).refine((value) => URL.canParse(value) && ['http:', 'https:'].includes(new URL(value).protocol)), z.literal('')]).nullable().optional();
const googleMapsUrl = z.union([z.url().max(2048).refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && (url.hostname === 'maps.app.goo.gl' || url.hostname === 'goo.gl' && url.pathname.startsWith('/maps') || url.hostname === 'maps.google.com' || url.hostname === 'google.com' || url.hostname.endsWith('.google.com'));
}, 'Enter a Google Maps link.'), z.literal('')]).nullable().optional();
const pair = (a: string, b: string) => [a, b].sort() as [string, string];

export function createSocialRouter(prisma: PrismaClient, notify: Notify = () => {}) {
  const router = Router();
  const actionLimit = rateLimit({ windowMs: 15 * 60_000, limit: Number(process.env.SOCIAL_RATE_LIMIT ?? (process.env.NODE_ENV === 'production' ? 45 : 200)), standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Easy there, buffet captain. Try again in a few minutes.' } });
  router.use(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = req.cookies?.[cookieName];
      if (typeof token !== 'string' || token.length > 200) return res.status(401).json({ error: 'Sign in to join the table.' });
      const session = await prisma.session.findFirst({ where: { tokenHash: digest(token), revokedAt: null, expiresAt: { gt: new Date() }, user: { status: 'ACTIVE' } }, include: { user: true } });
      if (!session) return res.status(401).json({ error: 'Sign in to join the table.' });
      res.locals.user = session.user as User;
      return next();
    } catch (error) { return next(error); }
  });
  const me = (res: Response) => res.locals.user as User;
  const blocked = async (a: string, b: string) => Boolean(await prisma.block.findFirst({ where: { OR: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] }, select: { id: true } }));
  const areFriends = async (a: string, b: string) => { const [low, high] = pair(a, b); return Boolean(await prisma.friendship.findUnique({ where: { pairLowId_pairHighId: { pairLowId: low, pairHighId: high } }, select: { id: true } })); };
  const sendNotification = async (recipientId: string, type: 'FRIEND_REQUEST' | 'FRIEND_REQUEST_ACCEPTED' | 'MESSAGE' | 'EVENT_INVITATION' | 'EVENT_UPDATED' | 'RSVP_UPDATED' | 'POST_COMMENT' | 'POST_REACTION' | 'MODERATION_UPDATE', entityType: string, entityId: string) => {
    const item = await prisma.notification.create({ data: { recipientId, type, entityType, entityId }, select: { id: true, type: true, entityType: true, entityId: true, createdAt: true } });
    notify(recipientId, item);
  };
  const visiblePost = async (postId: string, viewerId: string) => {
    const post = await prisma.post.findFirst({ where: { id: postId, status: 'PUBLISHED' }, include: { recipients: { where: { recipientId: viewerId, revokedAt: null }, select: { recipientId: true } } } });
    if (!post) return null;
    if (post.visibility === 'PUBLIC' || post.authorId === viewerId) return post;
    if (!post.recipients.length || await blocked(viewerId, post.authorId) || !await areFriends(viewerId, post.authorId)) return null;
    return post;
  };
  const canInteractWithPost = async (post: { authorId: string }, viewerId: string) => !await blocked(viewerId, post.authorId);

  router.get('/me', (_req, res) => res.json({ role: me(res).role }));

  router.get('/users', async (req, res) => {
    const parsed = z.object({ q: z.string().trim().max(80).default('') }).safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Try a shorter search.' });
    const q = parsed.data.q;
    const exclusions = await prisma.block.findMany({ where: { OR: [{ blockerId: me(res).id }, { blockedId: me(res).id }] }, select: { blockerId: true, blockedId: true } });
    const hiddenIds = exclusions.map((item: { blockerId: string; blockedId: string }) => item.blockerId === me(res).id ? item.blockedId : item.blockerId);
    const users = await prisma.user.findMany({ where: { id: { notIn: [me(res).id, ...hiddenIds] }, status: 'ACTIVE', ...(q ? { OR: [{ username: { contains: q.toLowerCase(), mode: 'insensitive' as const } }, { displayName: { contains: q, mode: 'insensitive' as const } }] } : {}) }, select: publicUserSelect, orderBy: { username: 'asc' }, take: 30 });
    return res.json({ users });
  });

  router.get('/friends', async (_req, res) => {
    const relations = await prisma.friendship.findMany({ where: { OR: [{ pairLowId: me(res).id }, { pairHighId: me(res).id }] }, include: { lowUser: { select: publicUserSelect }, highUser: { select: publicUserSelect } }, orderBy: { createdAt: 'desc' } });
    return res.json({ friends: relations.map(({ lowUser, highUser }: any) => lowUser.id === me(res).id ? highUser : lowUser) });
  });
  router.get('/friend-requests', async (_req, res) => {
    const rows = await prisma.friendRequest.findMany({ where: { status: 'PENDING', OR: [{ requesterId: me(res).id }, { recipientId: me(res).id }] }, include: { requester: { select: publicUserSelect }, recipient: { select: publicUserSelect } }, orderBy: { createdAt: 'desc' } });
    return res.json({ incoming: rows.filter((r: any) => r.recipientId === me(res).id), outgoing: rows.filter((r: any) => r.requesterId === me(res).id) });
  });
  router.post('/friend-requests', actionLimit, async (req, res) => {
    const parsed = z.object({ userId: idSchema }).strict().safeParse(req.body);
    if (!parsed.success || parsed.data.userId === me(res).id) return res.status(400).json({ error: 'Pick another member from the guest list.' });
    const other = await prisma.user.findFirst({ where: { id: parsed.data.userId, status: 'ACTIVE' }, select: { id: true } });
    if (!other || await blocked(me(res).id, other.id)) return res.status(404).json({ error: 'No member by that name.' });
    if (await areFriends(me(res).id, other.id)) return res.status(409).json({ error: 'You are already snack-compatible.' });
    const [low, high] = pair(me(res).id, other.id);
    const existing = await prisma.friendRequest.findUnique({ where: { pairLowId_pairHighId: { pairLowId: low, pairHighId: high } } });
    if (existing?.status === 'PENDING') return res.status(409).json({ error: existing.recipientId === me(res).id ? 'Accept their waiting request below.' : 'Your request is already on its way.' });
    if (existing?.status === 'ACCEPTED') return res.status(409).json({ error: 'You are already snack-compatible.' });
    const data = { requesterId: me(res).id, recipientId: other.id, status: 'PENDING' as const };
    const friendRequest = existing
      ? await prisma.friendRequest.update({ where: { id: existing.id }, data })
      : await prisma.friendRequest.create({ data: { pairLowId: low, pairHighId: high, ...data } });
    await sendNotification(other.id, 'FRIEND_REQUEST', 'friendRequest', friendRequest.id);
    return res.status(201).json({ request: friendRequest });
  });
  router.post('/friend-requests/:id/:action', actionLimit, async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    const action = z.enum(['accept', 'decline', 'cancel']).safeParse(req.params.action);
    if (!id.success || !action.success) return res.status(400).json({ error: 'That request card is invalid.' });
    const request = await prisma.friendRequest.findUnique({ where: { id: id.data } });
    if (!request || request.status !== 'PENDING') return res.status(404).json({ error: 'That request is no longer waiting.' });
    if (action.data === 'cancel') {
      if (request.requesterId !== me(res).id) return res.status(403).json({ error: 'Only the sender can cancel this request.' });
      await prisma.friendRequest.update({ where: { id: request.id }, data: { status: 'CANCELLED' } });
      return res.json({ message: 'Request cancelled. The imaginary cake is returned.' });
    }
    if (request.recipientId !== me(res).id) return res.status(403).json({ error: 'Only the recipient can answer this request.' });
    if (action.data === 'decline') {
      await prisma.friendRequest.update({ where: { id: request.id }, data: { status: 'DECLINED' } });
      return res.json({ message: 'Request declined. No hard feelings, just less cake.' });
    }
    if (await blocked(request.requesterId, request.recipientId)) return res.status(403).json({ error: 'This connection is blocked.' });
    await prisma.$transaction(async (transactionClient) => {
      const tx = transactionClient as unknown as PrismaClient;
      await tx.friendRequest.update({ where: { id: request.id }, data: { status: 'ACCEPTED' } });
      await tx.friendship.upsert({ where: { pairLowId_pairHighId: { pairLowId: request.pairLowId, pairHighId: request.pairHighId } }, create: { pairLowId: request.pairLowId, pairHighId: request.pairHighId }, update: {} });
    });
    await sendNotification(request.requesterId, 'FRIEND_REQUEST_ACCEPTED', 'friendRequest', request.id);
    return res.json({ message: 'Friendship accepted. The buffet recognizes you both.' });
  });
  router.delete('/friends/:userId', actionLimit, async (req, res) => {
    const otherId = idSchema.safeParse(req.params.userId);
    if (!otherId.success || otherId.data === me(res).id) return res.status(400).json({ error: 'That friendship cannot be removed.' });
    const [low, high] = pair(me(res).id, otherId.data);
    await prisma.$transaction(async (transactionClient) => {
      const tx = transactionClient as unknown as PrismaClient;
      await tx.friendship.deleteMany({ where: { pairLowId: low, pairHighId: high } });
      await tx.friendRequest.updateMany({ where: { pairLowId: low, pairHighId: high, status: { in: ['PENDING', 'ACCEPTED'] } }, data: { status: 'CLOSED' } });
      await tx.postRecipient.updateMany({ where: { recipientId: otherId.data, revokedAt: null, post: { authorId: me(res).id, status: 'PUBLISHED', visibility: 'FRIENDS' } }, data: { revokedAt: new Date() } });
      await tx.postRecipient.updateMany({ where: { recipientId: me(res).id, revokedAt: null, post: { authorId: otherId.data, status: 'PUBLISHED', visibility: 'FRIENDS' } }, data: { revokedAt: new Date() } });
    });
    return res.json({ message: 'Friendship ended. Shared posts are no longer shared.' });
  });
  router.get('/blocks', async (_req, res) => {
    const rows = await prisma.block.findMany({ where: { blockerId: me(res).id }, include: { blocked: { select: publicUserSelect } }, orderBy: { createdAt: 'desc' } });
    return res.json({ blocks: rows.map((row: any) => row.blocked) });
  });
  router.post('/blocks/:userId', actionLimit, async (req, res) => {
    const otherId = idSchema.safeParse(req.params.userId);
    if (!otherId.success || otherId.data === me(res).id) return res.status(400).json({ error: 'You cannot block yourself. Try a mirror.' });
    const other = await prisma.user.findFirst({ where: { id: otherId.data, status: 'ACTIVE' }, select: { id: true } });
    if (!other) return res.status(404).json({ error: 'No member by that name.' });
    const [low, high] = pair(me(res).id, other.id);
    await prisma.$transaction(async (transactionClient) => {
      const tx = transactionClient as unknown as PrismaClient;
      await tx.block.upsert({ where: { blockerId_blockedId: { blockerId: me(res).id, blockedId: other.id } }, create: { blockerId: me(res).id, blockedId: other.id }, update: {} });
      await tx.friendship.deleteMany({ where: { pairLowId: low, pairHighId: high } });
      await tx.friendRequest.updateMany({ where: { pairLowId: low, pairHighId: high, status: { in: ['PENDING', 'ACCEPTED'] } }, data: { status: 'CLOSED' } });
      await tx.postRecipient.updateMany({ where: { recipientId: other.id, revokedAt: null, post: { authorId: me(res).id, status: 'PUBLISHED', visibility: 'FRIENDS' } }, data: { revokedAt: new Date() } });
      await tx.postRecipient.updateMany({ where: { recipientId: me(res).id, revokedAt: null, post: { authorId: other.id, status: 'PUBLISHED', visibility: 'FRIENDS' } }, data: { revokedAt: new Date() } });
    });
    return res.json({ message: 'Blocked. Their direct routes to your snack kingdom are closed.' });
  });
  router.delete('/blocks/:userId', actionLimit, async (req, res) => {
    const otherId = idSchema.safeParse(req.params.userId);
    if (!otherId.success) return res.status(400).json({ error: 'That member ID is invalid.' });
    await prisma.block.deleteMany({ where: { blockerId: me(res).id, blockedId: otherId.data } });
    return res.json({ message: 'Block removed. Friendship still requires a fresh request.' });
  });

  const postBody = z.object({ body: text(5000), imageUrl: optionalUrl, category: z.string().trim().min(1).max(40).default('GENERAL'), visibility: z.enum(['PUBLIC', 'FRIENDS']).default('PUBLIC'), recipientIds: z.array(idSchema).max(100).default([]), status: z.enum(['DRAFT', 'PUBLISHED']).default('PUBLISHED') }).strict();
  router.get('/posts', async (req, res) => {
    const parsed = z.object({ q: z.string().trim().max(100).default(''), category: z.string().trim().max(40).optional(), authorId: idSchema.optional(), limit: z.coerce.number().int().min(1).max(50).default(30) }).safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Those feed filters are too spicy.' });
    const viewer = me(res);
    const friends = await prisma.friendship.findMany({ where: { OR: [{ pairLowId: viewer.id }, { pairHighId: viewer.id }] }, select: { pairLowId: true, pairHighId: true } });
    const friendIds = friends.map((f: any) => f.pairLowId === viewer.id ? f.pairHighId : f.pairLowId);
    const blocks = await prisma.block.findMany({ where: { OR: [{ blockerId: viewer.id }, { blockedId: viewer.id }] }, select: { blockerId: true, blockedId: true } });
    const blockedIds = blocks.map((b: any) => b.blockerId === viewer.id ? b.blockedId : b.blockerId);
    const posts = await prisma.post.findMany({ where: { status: 'PUBLISHED', eventId: null, AND: [ ...(parsed.data.authorId ? [{ authorId: parsed.data.authorId }] : []), ...(parsed.data.category ? [{ category: parsed.data.category }] : []), ...(parsed.data.q ? [{ OR: [{ body: { contains: parsed.data.q, mode: 'insensitive' as const } }, { category: { contains: parsed.data.q, mode: 'insensitive' as const } }] }] : []), { OR: [{ visibility: 'PUBLIC' }, { authorId: viewer.id }, { visibility: 'FRIENDS', recipients: { some: { recipientId: viewer.id, revokedAt: null } }, authorId: { in: friendIds } }] } ] }, include: { author: { select: publicUserSelect }, event: { select: { id: true, title: true, location: true, startsAt: true, endsAt: true, visibility: true, creatorId: true, invitations: { where: { inviteeId: viewer.id }, select: { id: true } } } }, recipients: { where: { recipientId: viewer.id, revokedAt: null }, select: { recipientId: true } } }, orderBy: { publishedAt: 'desc' }, take: parsed.data.limit });
    const visiblePosts = posts.filter((post: any) => post.visibility === 'PUBLIC' || !blockedIds.includes(post.authorId)).map((post: any) => {
      if (!post.event) return post;
      const { invitations, ...event } = post.event;
      const canSeeEvent = event.visibility === 'PUBLIC' || event.creatorId === viewer.id || invitations.length > 0;
      return { ...post, event: canSeeEvent ? event : null };
    });
    return res.json({ posts: visiblePosts });
  });
  router.get('/posts/:id/interactions', async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    if (!id.success) return res.status(404).json({ error: 'That intel is not available.' });
    const post = await visiblePost(id.data, me(res).id);
    if (!post) return res.status(404).json({ error: 'That intel is not available.' });
    const [comments, reactions, myReaction] = await Promise.all([
      prisma.postComment.findMany({ where: { postId: post.id }, include: { author: { select: publicUserSelect } }, orderBy: { createdAt: 'asc' }, take: 200 }),
      prisma.postReaction.groupBy({ by: ['emoji'], where: { postId: post.id }, _count: { _all: true } }),
      prisma.postReaction.findUnique({ where: { postId_userId: { postId: post.id, userId: me(res).id } }, select: { emoji: true } }),
    ]);
    return res.json({ comments, reactions: reactions.map((reaction: any) => ({ emoji: reaction.emoji, count: reaction._count._all })), myReaction: myReaction?.emoji ?? null });
  });
  router.post('/posts/:id/comments', actionLimit, async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    const parsed = z.object({ body: text(2000) }).strict().safeParse(req.body);
    if (!id.success || !parsed.success) return res.status(400).json({ error: 'Comments need a little text, up to 2,000 characters.' });
    const post = await visiblePost(id.data, me(res).id);
    if (!post) return res.status(404).json({ error: 'That intel is not available.' });
    if (!await canInteractWithPost(post, me(res).id)) return res.status(403).json({ error: 'You cannot interact with this member’s intel.' });
    const comment = await prisma.postComment.create({ data: { postId: post.id, authorId: me(res).id, body: parsed.data.body }, include: { author: { select: publicUserSelect } } });
    if (post.authorId !== me(res).id) await sendNotification(post.authorId, 'POST_COMMENT', 'post', post.id);
    return res.status(201).json({ comment });
  });
  router.patch('/posts/:id/comments/:commentId', actionLimit, async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    const commentId = idSchema.safeParse(req.params.commentId);
    const parsed = z.object({ body: text(2000) }).strict().safeParse(req.body);
    if (!id.success || !commentId.success || !parsed.success) return res.status(400).json({ error: 'Check the comment and try again.' });
    const post = await visiblePost(id.data, me(res).id);
    if (!post) return res.status(404).json({ error: 'That intel is not available.' });
    if (!await canInteractWithPost(post, me(res).id)) return res.status(403).json({ error: 'You cannot interact with this member’s intel.' });
    const comment = await prisma.postComment.updateMany({ where: { id: commentId.data, postId: post.id, authorId: me(res).id }, data: { body: parsed.data.body } });
    if (!comment.count) return res.status(404).json({ error: 'That comment is not yours to edit.' });
    return res.json({ message: 'Comment tidied up.' });
  });
  router.delete('/posts/:id/comments/:commentId', actionLimit, async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    const commentId = idSchema.safeParse(req.params.commentId);
    if (!id.success || !commentId.success) return res.status(400).json({ error: 'That comment is invalid.' });
    const post = await visiblePost(id.data, me(res).id);
    if (!post) return res.status(404).json({ error: 'That intel is not available.' });
    const deleted = await prisma.postComment.deleteMany({ where: { id: commentId.data, postId: post.id, authorId: me(res).id } });
    return deleted.count ? res.json({ message: 'Your comment has been removed.' }) : res.status(404).json({ error: 'That comment is not yours to remove.' });
  });
  router.post('/posts/:id/reactions', actionLimit, async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    const parsed = z.object({ emoji: z.enum(['😂', '🍗', '👀', '🔥']) }).strict().safeParse(req.body);
    if (!id.success || !parsed.success) return res.status(400).json({ error: 'Choose one of the club’s approved reactions.' });
    const post = await visiblePost(id.data, me(res).id);
    if (!post) return res.status(404).json({ error: 'That intel is not available.' });
    if (!await canInteractWithPost(post, me(res).id)) return res.status(403).json({ error: 'You cannot interact with this member’s intel.' });
    const previous = await prisma.postReaction.findUnique({ where: { postId_userId: { postId: post.id, userId: me(res).id } }, select: { emoji: true } });
    if (previous?.emoji !== parsed.data.emoji) {
      await prisma.postReaction.upsert({ where: { postId_userId: { postId: post.id, userId: me(res).id } }, create: { postId: post.id, userId: me(res).id, emoji: parsed.data.emoji }, update: { emoji: parsed.data.emoji } });
      if (post.authorId !== me(res).id) await sendNotification(post.authorId, 'POST_REACTION', 'post', post.id);
    }
    return res.json({ myReaction: parsed.data.emoji });
  });
  router.post('/posts', actionLimit, async (req, res) => {
    const parsed = postBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Check the post details and try again.' });
    const { recipientIds, ...data } = parsed.data;
    if (data.visibility === 'FRIENDS' && data.status === 'PUBLISHED' && recipientIds.length === 0) return res.status(400).json({ error: 'Choose at least one friend for this friends-only post.' });
    if (data.visibility === 'FRIENDS' && data.status === 'PUBLISHED') {
      const accepted = await prisma.friendship.findMany({ where: { OR: [{ pairLowId: me(res).id, pairHighId: { in: recipientIds } }, { pairHighId: me(res).id, pairLowId: { in: recipientIds } }] }, select: { pairLowId: true, pairHighId: true } });
      const acceptedIds = new Set(accepted.map((f: any) => f.pairLowId === me(res).id ? f.pairHighId : f.pairLowId));
      if (acceptedIds.size !== new Set(recipientIds).size || recipientIds.includes(me(res).id)) return res.status(400).json({ error: 'Only current friends can be selected.' });
    }
    const post = await prisma.post.create({ data: { authorId: me(res).id, body: data.body, imageUrl: data.imageUrl || null, category: data.category, visibility: data.visibility, status: data.status, publishedAt: data.status === 'PUBLISHED' ? new Date() : null, recipients: data.visibility === 'FRIENDS' && data.status === 'PUBLISHED' ? { create: [...new Set(recipientIds)].map((recipientId) => ({ recipientId })) } : undefined }, include: { author: { select: publicUserSelect } } });
    return res.status(201).json({ post });
  });
  router.patch('/posts/:id', actionLimit, async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: 'That post card is invalid.' });
    const existing = await prisma.post.findFirst({ where: { id: id.data, authorId: me(res).id, status: { not: 'DELETED' } } });
    if (!existing) return res.status(404).json({ error: 'That post is not on your plate.' });
    const parsed = z.object({ body: text(5000).optional(), imageUrl: optionalUrl, category: z.string().trim().min(1).max(40).optional(), status: z.enum(['DRAFT', 'PUBLISHED']).optional(), visibility: z.enum(['PUBLIC', 'FRIENDS']).optional(), recipientIds: z.array(idSchema).max(100).optional() }).strict().refine((v) => Object.keys(v).length > 0).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Check the edit and try again.' });
    const isPublished = existing.status === 'PUBLISHED';
    if (isPublished && (parsed.data.visibility !== undefined || parsed.data.recipientIds !== undefined || parsed.data.status === 'DRAFT')) return res.status(400).json({ error: 'Published audience is locked to the guest list chosen at serving time.' });
    const data: Record<string, unknown> = { ...parsed.data };
    delete data.recipientIds;
    if (parsed.data.imageUrl === '') data.imageUrl = null;
    if (parsed.data.status === 'PUBLISHED' && existing.status === 'DRAFT') data.publishedAt = new Date();
    if (parsed.data.status === 'DRAFT') data.publishedAt = null;
    const recipients = parsed.data.recipientIds;
    const resultingVisibility = parsed.data.visibility ?? existing.visibility;
    if (existing.status === 'DRAFT' && resultingVisibility === 'FRIENDS' && parsed.data.status === 'PUBLISHED') {
      const selected = recipients ?? [];
      const current = await prisma.friendship.findMany({ where: { OR: [{ pairLowId: me(res).id, pairHighId: { in: selected } }, { pairHighId: me(res).id, pairLowId: { in: selected } }] } });
      if (!selected.length || new Set(selected).size !== current.length || selected.includes(me(res).id)) return res.status(400).json({ error: 'Choose current friends before publishing this private post.' });
      data.recipients = { create: [...new Set(selected)].map((recipientId) => ({ recipientId })) };
    } else if (existing.status === 'DRAFT' && recipients) {
      if (resultingVisibility === 'FRIENDS') {
        const current = await prisma.friendship.findMany({ where: { OR: [{ pairLowId: me(res).id, pairHighId: { in: recipients } }, { pairHighId: me(res).id, pairLowId: { in: recipients } }] } });
        if (new Set(recipients).size !== current.length || recipients.includes(me(res).id)) return res.status(400).json({ error: 'Only current friends can be selected.' });
      }
      data.recipients = { deleteMany: {}, ...(resultingVisibility === 'FRIENDS' ? { create: [...new Set(recipients)].map((recipientId) => ({ recipientId })) } : {}) };
    }
    const post = await prisma.post.update({ where: { id: id.data }, data: data as never, include: { author: { select: publicUserSelect } } });
    return res.json({ post });
  });
  router.delete('/posts/:id', actionLimit, async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: 'That post card is invalid.' });
    const changed = await prisma.post.updateMany({ where: { id: id.data, authorId: me(res).id, status: { not: 'DELETED' } }, data: { status: 'DELETED' } });
    return changed.count ? res.json({ message: 'Post removed. The leaderboard has been notified.' }) : res.status(404).json({ error: 'That post is not on your plate.' });
  });
  router.get('/leaderboard', async (_req, res) => {
    const scores = await prisma.post.groupBy({ by: ['authorId'], where: { status: 'PUBLISHED' }, _count: { id: true }, orderBy: { _count: { id: 'desc' } }, take: 50 });
    const users = await prisma.user.findMany({ where: { id: { in: scores.map((s: any) => s.authorId) }, status: 'ACTIVE' }, select: publicUserSelect });
    const byId = new Map(users.map((user: any) => [user.id, user]));
    return res.json({ leaderboard: scores.map((s: any) => ({ user: byId.get(s.authorId), posts: s._count.id })).filter((s: any) => s.user) });
  });

  router.get('/events', async (req, res) => {
    const parsed = z.object({ q: z.string().trim().max(100).default(''), from: z.string().datetime().optional() }).safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Those event filters are invalid.' });
    const viewerId = me(res).id;
    const events = await prisma.event.findMany({ where: { startsAt: { gte: parsed.data.from ? new Date(parsed.data.from) : new Date(Date.now() - 86_400_000) }, AND: [ ...(parsed.data.q ? [{ OR: [{ title: { contains: parsed.data.q, mode: 'insensitive' as const } }, { description: { contains: parsed.data.q, mode: 'insensitive' as const } }, { location: { contains: parsed.data.q, mode: 'insensitive' as const } }] }] : []), { OR: [{ visibility: 'PUBLIC' }, { creatorId: viewerId }, { invitations: { some: { inviteeId: viewerId } } }] } ] }, include: { creator: { select: publicUserSelect }, invitations: { where: { inviteeId: viewerId }, select: { rsvp: true } } }, orderBy: { startsAt: 'asc' }, take: 50 });
    const eventIds = events.map((event: any) => event.id);
    if (!eventIds.length) return res.json({ events: [] });
    const [friendships, blocks] = await Promise.all([
      prisma.friendship.findMany({ where: { OR: [{ pairLowId: viewerId }, { pairHighId: viewerId }] }, select: { pairLowId: true, pairHighId: true } }),
      prisma.block.findMany({ where: { OR: [{ blockerId: viewerId }, { blockedId: viewerId }] }, select: { blockerId: true, blockedId: true } }),
    ]);
    const friendIds = friendships.map((friendship: any) => friendship.pairLowId === viewerId ? friendship.pairHighId : friendship.pairLowId);
    const blockedIds = blocks.map((block: any) => block.blockerId === viewerId ? block.blockedId : block.blockerId);
    const intelPosts = await prisma.post.findMany({ where: { eventId: { in: eventIds }, status: 'PUBLISHED', AND: [
      { OR: [{ visibility: 'PUBLIC' }, { authorId: viewerId }, { visibility: 'FRIENDS', authorId: { in: friendIds }, recipients: { some: { recipientId: viewerId, revokedAt: null } } }] },
      { OR: [{ visibility: 'PUBLIC' }, { authorId: { notIn: blockedIds } }] },
    ] }, select: { id: true, eventId: true } });
    const postIdsByEvent = new Map<string, string[]>();
    for (const post of intelPosts) if (post.eventId) postIdsByEvent.set(post.eventId, [...(postIdsByEvent.get(post.eventId) ?? []), post.id]);
    return res.json({ events: events.map((event: any) => ({ ...event, intelPostIds: postIdsByEvent.get(event.id) ?? [] })) });
  });
  router.post('/events', actionLimit, async (req, res) => {
    const parsed = z.object({ title: text(120), description: z.string().trim().max(4000).default(''), intelNote: z.string().trim().max(2000).default(''), location: z.string().trim().max(200).optional(), mapUrl: googleMapsUrl, startsAt: z.iso.datetime(), endsAt: z.iso.datetime().optional(), visibility: z.enum(['PUBLIC', 'INVITE_ONLY']).default('INVITE_ONLY'), inviteeIds: z.array(idSchema).max(100).default([]), postVisibility: z.enum(['PUBLIC', 'FRIENDS']).default('PUBLIC'), postRecipientIds: z.array(idSchema).max(100).default([]) }).strict().safeParse(req.body);
    if (!parsed.success || (parsed.success && parsed.data.endsAt && new Date(parsed.data.endsAt) < new Date(parsed.data.startsAt))) return res.status(400).json({ error: 'Check the event details and date.' });
    const data = parsed.data;
    if (data.visibility === 'INVITE_ONLY' && data.inviteeIds.length === 0) return res.status(400).json({ error: 'Choose at least one friend for an invite-only event.' });
    const audienceIds = [...new Set([...data.inviteeIds, ...data.postRecipientIds])];
    const accepted = audienceIds.length ? await prisma.friendship.findMany({ where: { OR: [{ pairLowId: me(res).id, pairHighId: { in: audienceIds } }, { pairHighId: me(res).id, pairLowId: { in: audienceIds } }] } }) : [];
    if (new Set(data.inviteeIds).size !== data.inviteeIds.length || new Set(data.postRecipientIds).size !== data.postRecipientIds.length || new Set(audienceIds).size !== accepted.length || audienceIds.includes(me(res).id) || (data.postVisibility === 'FRIENDS' && !data.postRecipientIds.length) || (await prisma.block.count({ where: { OR: [{ blockerId: me(res).id, blockedId: { in: audienceIds } }, { blockedId: me(res).id, blockerId: { in: audienceIds } }] } }))) return res.status(400).json({ error: 'Choose current friends for the invitation or friends-only intel audience.' });
    const eventAndPost = await prisma.$transaction(async (transactionClient) => {
      const tx = transactionClient as unknown as PrismaClient;
      const event = await tx.event.create({ data: { creatorId: me(res).id, title: data.title, description: data.description, location: data.location || null, mapUrl: data.mapUrl || null, startsAt: new Date(data.startsAt), endsAt: data.endsAt ? new Date(data.endsAt) : null, visibility: data.visibility, invitations: { create: [...new Set(data.inviteeIds)].map((inviteeId) => ({ inviteeId, inviterId: me(res).id })) } }, include: { creator: { select: publicUserSelect } } });
      const post = await tx.post.create({ data: { authorId: me(res).id, eventId: event.id, body: data.intelNote || 'New food event intel. Check the Events page if you have access.', category: 'EVENT', status: 'PUBLISHED', visibility: data.postVisibility, publishedAt: new Date(), recipients: data.postVisibility === 'FRIENDS' ? { create: [...new Set(data.postRecipientIds)].map((recipientId) => ({ recipientId })) } : undefined }, include: { author: { select: publicUserSelect }, event: { select: { id: true, title: true, location: true, startsAt: true, endsAt: true, visibility: true, creatorId: true } } } });
      return { event, post };
    });
    for (const inviteeId of new Set(data.inviteeIds)) await sendNotification(inviteeId, 'EVENT_INVITATION', 'event', eventAndPost.event.id);
    return res.status(201).json(eventAndPost);
  });
  router.patch('/events/:id', actionLimit, async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    const parsed = z.object({ title: text(120).optional(), description: z.string().trim().max(4000).optional(), location: z.string().trim().max(200).nullable().optional(), mapUrl: googleMapsUrl, startsAt: z.iso.datetime().optional(), endsAt: z.iso.datetime().nullable().optional(), visibility: z.enum(['PUBLIC', 'INVITE_ONLY']).optional() }).strict().refine((v) => Object.keys(v).length > 0).safeParse(req.body);
    if (!id.success || !parsed.success) return res.status(400).json({ error: 'Check the event edit.' });
    const event = await prisma.event.findFirst({ where: { id: id.data, creatorId: me(res).id } });
    if (!event) return res.status(404).json({ error: 'That event is not yours to rearrange.' });
    const nextStart = parsed.data.startsAt ? new Date(parsed.data.startsAt) : event.startsAt;
    const nextEnd = parsed.data.endsAt === undefined ? event.endsAt : parsed.data.endsAt ? new Date(parsed.data.endsAt) : null;
    if (nextEnd && nextEnd < nextStart) return res.status(400).json({ error: 'The event needs to end after it starts.' });
    const updated = await prisma.event.update({ where: { id: event.id }, data: { ...parsed.data, ...(parsed.data.mapUrl !== undefined ? { mapUrl: parsed.data.mapUrl || null } : {}) } });
    const invitees = await prisma.eventInvitation.findMany({ where: { eventId: event.id }, select: { inviteeId: true } });
    for (const invitation of invitees) if (!await blocked(me(res).id, invitation.inviteeId)) await sendNotification(invitation.inviteeId, 'EVENT_UPDATED', 'event', event.id);
    return res.json({ event: updated });
  });
  router.post('/events/:id/invitations', actionLimit, async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    const parsed = z.object({ userIds: z.array(idSchema).min(1).max(100) }).strict().safeParse(req.body);
    if (!id.success || !parsed.success) return res.status(400).json({ error: 'Choose people from your friend list.' });
    const event = await prisma.event.findUnique({ where: { id: id.data } });
    if (!event) return res.status(404).json({ error: 'Event not found.' });
    if (event.creatorId !== me(res).id) return res.status(403).json({ error: 'Only the host can add guests.' });
    const invitees = [...new Set(parsed.data.userIds)];
    const friendships = await prisma.friendship.findMany({ where: { OR: [{ pairLowId: me(res).id, pairHighId: { in: invitees } }, { pairHighId: me(res).id, pairLowId: { in: invitees } }] } });
    if (friendships.length !== invitees.length || invitees.includes(me(res).id)) return res.status(400).json({ error: 'Invite current friends only.' });
    const created = await prisma.eventInvitation.createMany({ data: invitees.map((inviteeId) => ({ eventId: event.id, inviteeId, inviterId: me(res).id })), skipDuplicates: true });
    for (const userId of invitees) await sendNotification(userId, 'EVENT_INVITATION', 'event', event.id);
    return res.status(201).json({ invited: created.count });
  });
  router.patch('/events/:id/rsvp', actionLimit, async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    const parsed = z.object({ rsvp: z.enum(['GOING', 'MAYBE', 'DECLINED']) }).strict().safeParse(req.body);
    if (!id.success || !parsed.success) return res.status(400).json({ error: 'Choose Going, Maybe, or Declined.' });
    const invitation = await prisma.eventInvitation.findUnique({ where: { eventId_inviteeId: { eventId: id.data, inviteeId: me(res).id } }, include: { event: true } });
    if (!invitation) return res.status(404).json({ error: 'That invitation is not addressed to you.' });
    if (await blocked(invitation.event.creatorId, me(res).id)) return res.status(403).json({ error: 'This event connection is blocked.' });
    await prisma.eventInvitation.update({ where: { id: invitation.id }, data: { rsvp: parsed.data.rsvp } });
    await sendNotification(invitation.event.creatorId, 'RSVP_UPDATED', 'event', invitation.event.id);
    return res.json({ message: 'RSVP filed. The host has the headcount.', rsvp: parsed.data.rsvp });
  });

  router.get('/conversations', async (_req, res) => {
    const rows = await prisma.conversation.findMany({ where: { OR: [{ pairLowId: me(res).id }, { pairHighId: me(res).id }] }, include: { lowUser: { select: publicUserSelect }, highUser: { select: publicUserSelect }, messages: { orderBy: { createdAt: 'desc' }, take: 1 }, _count: { select: { messages: { where: { senderId: { not: me(res).id }, readAt: null } } } } }, orderBy: { createdAt: 'desc' } });
    return res.json({ conversations: rows.map((row: any) => ({ id: row.id, friend: row.lowUser.id === me(res).id ? row.highUser : row.lowUser, lastMessage: row.messages[0] ?? null, unread: row._count.messages })) });
  });
  router.post('/conversations/:userId', actionLimit, async (req, res) => {
    const other = idSchema.safeParse(req.params.userId);
    if (!other.success || other.data === me(res).id) return res.status(400).json({ error: 'Choose a friend for this conversation.' });
    if (await blocked(me(res).id, other.data) || !await areFriends(me(res).id, other.data)) return res.status(403).json({ error: 'Private messages are for current, unblocked friends.' });
    const [low, high] = pair(me(res).id, other.data);
    const conversation = await prisma.conversation.upsert({ where: { pairLowId_pairHighId: { pairLowId: low, pairHighId: high } }, create: { pairLowId: low, pairHighId: high }, update: {} });
    return res.status(200).json({ conversation });
  });
  router.get('/conversations/:id/messages', async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: 'That conversation is invalid.' });
    const conversation = await prisma.conversation.findFirst({ where: { id: id.data, OR: [{ pairLowId: me(res).id }, { pairHighId: me(res).id }] } });
    if (!conversation) return res.status(404).json({ error: 'That conversation is not in your history.' });
    await prisma.message.updateMany({ where: { conversationId: conversation.id, senderId: { not: me(res).id }, readAt: null }, data: { readAt: new Date() } });
    const messages = await prisma.message.findMany({ where: { conversationId: conversation.id }, include: { sender: { select: publicUserSelect } }, orderBy: { createdAt: 'asc' }, take: 500 });
    return res.json({ messages });
  });
  router.post('/conversations/:id/messages', actionLimit, async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    const parsed = z.object({ body: text(5000) }).strict().safeParse(req.body);
    if (!id.success || !parsed.success) return res.status(400).json({ error: 'Messages need a little text, up to 5,000 characters.' });
    const conversation = await prisma.conversation.findFirst({ where: { id: id.data, OR: [{ pairLowId: me(res).id }, { pairHighId: me(res).id }] } });
    if (!conversation) return res.status(404).json({ error: 'That conversation is not in your history.' });
    const otherId = conversation.pairLowId === me(res).id ? conversation.pairHighId : conversation.pairLowId;
    if (await blocked(me(res).id, otherId) || !await areFriends(me(res).id, otherId)) return res.status(403).json({ error: 'You need an active, unblocked friendship to send a new message.' });
    const message = await prisma.message.create({ data: { conversationId: conversation.id, senderId: me(res).id, body: parsed.data.body }, include: { sender: { select: publicUserSelect } } });
    await sendNotification(otherId, 'MESSAGE', 'conversation', conversation.id);
    notify(otherId, { id: message.id, type: 'REALTIME_MESSAGE', entityType: 'conversation', entityId: conversation.id, createdAt: message.createdAt, message });
    return res.status(201).json({ message });
  });

  router.get('/notifications', async (_req, res) => {
    const notifications = await prisma.notification.findMany({ where: { recipientId: me(res).id }, orderBy: { createdAt: 'desc' }, take: 100 });
    return res.json({ notifications, unread: notifications.filter((n: any) => !n.readAt).length });
  });
  router.post('/notifications/read', async (req, res) => {
    const parsed = z.object({ ids: z.array(idSchema).max(100).optional(), all: z.boolean().optional() }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Those notification slips are invalid.' });
    const where = parsed.data.all ? { recipientId: me(res).id, readAt: null } : { recipientId: me(res).id, id: { in: parsed.data.ids ?? [] }, readAt: null };
    const result = await prisma.notification.updateMany({ where, data: { readAt: new Date() } });
    return res.json({ markedRead: result.count });
  });

  router.post('/reports', actionLimit, async (req, res) => {
    const parsed = z.object({ reportedUserId: idSchema.optional(), postId: idSchema.optional(), eventId: idSchema.optional(), reason: text(120), details: z.string().trim().max(2000).default('') }).strict().safeParse(req.body);
    if (!parsed.success || (parsed.success && [parsed.data.reportedUserId, parsed.data.postId, parsed.data.eventId].filter(Boolean).length !== 1)) return res.status(400).json({ error: 'Choose one thing to report and tell us why.' });
    if (parsed.data.reportedUserId && !await prisma.user.findFirst({ where: { id: parsed.data.reportedUserId, status: 'ACTIVE' }, select: { id: true } })) return res.status(404).json({ error: 'Member not found.' });
    if (parsed.data.postId) {
      const post = await prisma.post.findFirst({ where: { id: parsed.data.postId, status: 'PUBLISHED', OR: [{ visibility: 'PUBLIC' }, { authorId: me(res).id }, { visibility: 'FRIENDS', recipients: { some: { recipientId: me(res).id, revokedAt: null } } }] }, select: { id: true } });
      if (!post) return res.status(404).json({ error: 'That post is not available to report.' });
    }
    if (parsed.data.eventId) {
      const event = await prisma.event.findFirst({ where: { id: parsed.data.eventId, OR: [{ visibility: 'PUBLIC' }, { creatorId: me(res).id }, { invitations: { some: { inviteeId: me(res).id } } }] }, select: { id: true } });
      if (!event) return res.status(404).json({ error: 'That event is not available to report.' });
    }
    const report = await prisma.report.create({ data: { reporterId: me(res).id, ...parsed.data } });
    return res.status(201).json({ message: 'Report sent to the moderation table.', reportId: report.id });
  });
  const moderatorOnly: import('express').RequestHandler = (_req, res, next) => me(res).role === 'MEMBER' ? res.status(403).json({ error: 'Moderator apron required.' }) : next();
  router.get('/moderation/reports', moderatorOnly, async (_req, res) => {
    const reports = await prisma.report.findMany({ include: { reporter: { select: publicUserSelect }, reportedUser: { select: publicUserSelect } }, orderBy: { createdAt: 'asc' }, take: 100 });
    return res.json({ reports });
  });
  router.patch('/moderation/reports/:id', moderatorOnly, async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    const parsed = z.object({ status: z.enum(['UNDER_REVIEW', 'RESOLVED', 'DISMISSED']), moderatorNotes: z.string().trim().max(2000).default('') }).strict().safeParse(req.body);
    if (!id.success || !parsed.success) return res.status(400).json({ error: 'Check the moderation update.' });
    const report = await prisma.report.update({ where: { id: id.data }, data: parsed.data });
    await prisma.moderationAction.create({ data: { moderatorId: me(res).id, action: `REPORT_${parsed.data.status}`, entityType: 'report', entityId: report.id, reason: parsed.data.moderatorNotes || 'Report status updated' } });
    return res.json({ report });
  });
  router.post('/moderation/posts/:id/remove', moderatorOnly, async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    const parsed = z.object({ reason: text(500) }).strict().safeParse(req.body);
    if (!id.success || !parsed.success) return res.status(400).json({ error: 'A reason is required for removal.' });
    const post = await prisma.post.update({ where: { id: id.data }, data: { status: 'DELETED' } });
    await prisma.moderationAction.create({ data: { moderatorId: me(res).id, action: 'REMOVE_POST', entityType: 'post', entityId: post.id, reason: parsed.data.reason } });
    await sendNotification(post.authorId, 'MODERATION_UPDATE', 'post', post.id);
    return res.json({ message: 'Post removed and action recorded.' });
  });
  router.post('/moderation/users/:id/suspend', moderatorOnly, async (req, res) => {
    const id = idSchema.safeParse(req.params.id);
    const parsed = z.object({ reason: text(500) }).strict().safeParse(req.body);
    if (!id.success || !parsed.success || id.data === me(res).id) return res.status(400).json({ error: 'That moderation action is invalid.' });
    const user = await prisma.user.update({ where: { id: id.data }, data: { status: 'SUSPENDED' } });
    await prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await prisma.moderationAction.create({ data: { moderatorId: me(res).id, action: 'SUSPEND_USER', entityType: 'user', entityId: user.id, reason: parsed.data.reason } });
    await sendNotification(user.id, 'MODERATION_UPDATE', 'user', user.id);
    return res.json({ message: 'Member suspended and active sessions revoked.' });
  });

  return router;
}

export async function socketUserId(prisma: PrismaClient, cookieHeader: string | undefined) {
  if (!cookieHeader) return null;
  const tokenPart = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`));
  if (!tokenPart) return null;
  let token = '';
  try { token = decodeURIComponent(tokenPart.slice(cookieName.length + 1)); } catch { return null; }
  if (token.length > 200) return null;
  const session = await prisma.session.findFirst({ where: { tokenHash: digest(token), revokedAt: null, expiresAt: { gt: new Date() }, user: { status: 'ACTIVE' } }, select: { userId: true } });
  return session?.userId ?? null;
}
