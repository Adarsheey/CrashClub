import { useEffect, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { io } from 'socket.io-client';

type Profile = { id: string; username: string; displayName: string; bio: string; avatarUrl: string | null; createdAt: string };
type Screen = 'login' | 'register' | 'forgot' | 'verify' | 'reset' | 'profile';
type Member = { id: string; username: string; displayName: string; avatarUrl: string | null };
type EventItem = { id: string; creatorId: string; title: string; description: string; location: string | null; startsAt: string; endsAt: string | null; visibility: 'PUBLIC' | 'INVITE_ONLY'; creator: Member; invitations: Array<{ rsvp: string }> };
type Conversation = { id: string; friend: Member; lastMessage: { body: string; createdAt: string } | null; unread: number };
type Message = { id: string; senderId: string; body: string; createdAt: string; sender: Member };
type Notification = { id: string; type: string; entityType: string | null; entityId: string | null; readAt: string | null; createdAt: string };

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    intel: 'M12 3c5.2 0 9 3.8 9 9s-3.8 9-9 9-9-3.8-9-9 3.8-9 9-9Zm0 3a6 6 0 1 0 0 12 6 6 0 0 0 0-12Zm0 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z',
    friends: 'M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2m6-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm10 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
    events: 'M8 2v4m8-4v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2Zm2 10h4v4H7z',
    messages: 'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z',
    hall: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Zm-7 18h14',
    notifications: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-8 12a2 2 0 0 0 4 0',
    profile: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2m8-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
    moderation: 'M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Zm-3-11 2 2 4-4',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name] ?? paths.intel}/></svg>;
}

function Dashboard({ profile, onLogout, onProfileUpdate }: { profile: Profile; onLogout: () => void; onProfileUpdate: (next: Profile) => void }) {
  const [tab, setTab] = useState('events');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [friends, setFriends] = useState<Member[]>([]);
  const [incoming, setIncoming] = useState<any[]>([]);
  const [outgoing, setOutgoing] = useState<any[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [search, setSearch] = useState('');
  const [events, setEvents] = useState<EventItem[]>([]);
  const [leaderboard, setLeaderboard] = useState<Array<{ user: Member; posts: number }>>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [role, setRole] = useState('MEMBER');
  const [reports, setReports] = useState<any[]>([]);
  const [viewedProfile, setViewedProfile] = useState<Profile | null>(null);
  const [viewedEvent, setViewedEvent] = useState<EventItem | null>(null);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);

  useEffect(() => {
    api<{ friends: Member[] }>('/api/social/friends').then((r) => setFriends(r.friends)).catch(() => {});
    api<{ role: string }>('/api/social/me').then((r) => setRole(r.role)).catch(() => {});
    api<{ notifications: Notification[] }>('/api/social/notifications').then((r) => setNotifications(r.notifications)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!avatarFile) { setAvatarPreview(null); return; }
    const preview = URL.createObjectURL(avatarFile);
    setAvatarPreview(preview);
    return () => URL.revokeObjectURL(preview);
  }, [avatarFile]);

  const refresh = () => { setError(''); setNotice(''); setReload((n) => n + 1); };
  const perform = async (action: () => Promise<unknown>, success?: string) => {
    setBusy(true); setError(''); setNotice('');
    try { await action(); if (success) setNotice(success); setReload((n) => n + 1); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The kitchen hit a snag.'); }
    finally { setBusy(false); }
  };
  const selectAvatar = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0] ?? null;
    setError('');
    if (file && !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { setAvatarFile(null); setError('Choose a JPEG, PNG or WebP image.'); return; }
    if (file && file.size > 1_500_000) { setAvatarFile(null); setError('Choose an image smaller than 1.5 MB.'); return; }
    setAvatarFile(file);
  };
  const uploadAvatar = () => {
    if (!avatarFile) return;
    void perform(async () => {
      const response = await fetch('/api/auth/me/avatar', { method: 'POST', credentials: 'include', headers: { 'Content-Type': avatarFile.type }, body: avatarFile });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? 'The photo could not be uploaded.');
      onProfileUpdate(result.user as Profile);
      setAvatarFile(null);
    }, 'Profile photo updated. Looking dangerously recognizable.');
  };

  useEffect(() => {
    const socket = io(window.location.origin, { path: '/socket.io', withCredentials: true });
    socket.on('notification', () => { setReload((n) => n + 1); if (activeConversation) setReload((n) => n + 1); });
    return () => { socket.disconnect(); };
  }, [activeConversation]);

  useEffect(() => {
    let active = true;
    const jobs: Promise<unknown>[] = [];
    const observe = (job: Promise<unknown>) => jobs.push(job.catch((e) => setError(e.message)));
    setError('');
    if (tab === 'friends') {
      observe(api<{ friends: Member[] }>('/api/social/friends').then((r) => setFriends(r.friends)));
      observe(api<{ incoming: any[]; outgoing: any[] }>('/api/social/friend-requests').then((r) => { setIncoming(r.incoming); setOutgoing(r.outgoing); }));
      observe(api<{ users: Member[] }>(`/api/social/users?q=${encodeURIComponent(search)}`).then((r) => setMembers(r.users)));
    }
    if (tab === 'events') observe(api<{ events: EventItem[] }>(`/api/social/events?q=${encodeURIComponent(search)}`).then((r) => setEvents(r.events)));
    if (tab === 'hall') observe(api<{ leaderboard: Array<{ user: Member; posts: number }> }>('/api/social/leaderboard').then((r) => setLeaderboard(r.leaderboard)));
    if (tab === 'messages') observe(api<{ conversations: Conversation[] }>('/api/social/conversations').then((r) => setConversations(r.conversations)));
    if (tab === 'notifications') {
      observe(api<{ notifications: Notification[] }>('/api/social/notifications').then((r) => setNotifications(r.notifications)));
      observe(api<{ incoming: any[]; outgoing: any[] }>('/api/social/friend-requests').then((r) => { setIncoming(r.incoming); setOutgoing(r.outgoing); }));
    }
    if (tab === 'moderation') {
      observe(api<{ reports: any[] }>('/api/social/moderation/reports').then((r) => setReports(r.reports)));
    }
    if (tab === 'friends') observe(api<{ role: string }>('/api/social/me').then((r) => setRole(r.role)));
    setLoading(jobs.length > 0);
    void Promise.all(jobs).then(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [tab, reload]);

  useEffect(() => {
    if (tab !== 'friends') return;
    const timer = window.setTimeout(() => api<{ users: Member[] }>(`/api/social/users?q=${encodeURIComponent(search)}`).then((r) => setMembers(r.users)).catch((e) => setError(e.message)), 200);
    return () => window.clearTimeout(timer);
  }, [search, tab]);

  useEffect(() => {
    if (tab !== 'events' && !(tab === 'friends' && search)) return;
    const timer = window.setTimeout(() => setReload((n) => n + 1), 250);
    return () => window.clearTimeout(timer);
  }, [search, tab]);

  useEffect(() => {
    if (tab !== 'messages' || !activeConversation) return;
    setLoading(true);
    api<{ messages: Message[] }>(`/api/social/conversations/${activeConversation.id}/messages`).then((r) => { setMessages(r.messages); setConversations((current) => current.map((c) => c.id === activeConversation.id ? { ...c, unread: 0 } : c)); }).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, [tab, activeConversation, reload]);

  useEffect(() => {
    if (!viewedEvent) return;
    const latest = events.find((event) => event.id === viewedEvent.id);
    if (latest && latest !== viewedEvent) setViewedEvent(latest);
  }, [events, viewedEvent]);

  const friendAction = (path: string, method = 'POST', body?: unknown, done = 'Guest list updated.') => perform(() => api(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), done);
  const respondToFriendNotification = (notification: Notification, action: 'accept' | 'decline') => perform(async () => {
    if (!notification.entityId) throw new Error('This request is no longer available.');
    await api(`/api/social/friend-requests/${notification.entityId}/${action}`, { method: 'POST' });
    await api('/api/social/notifications/read', { method: 'POST', body: JSON.stringify({ ids: [notification.id] }) });
  }, action === 'accept' ? 'Friend request accepted. You’re officially on the same guest list.' : 'Friend request declined. No hard feelings, just fewer chairs.');
  const submitEvent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget; const formData = new FormData(form);
    const inviteeIds = formData.getAll('inviteeIds').map(String);
    await perform(async () => { await api('/api/social/events', { method: 'POST', body: JSON.stringify({ title: formData.get('title'), description: formData.get('description'), location: formData.get('location'), startsAt: new Date(String(formData.get('startsAt'))).toISOString(), visibility: formData.get('visibility'), inviteeIds }) }); form.reset(); setTab('events'); }, 'Event published. It is now on the guest list.');
  };
  const startConversation = async (userId: string) => {
    await perform(async () => { const r = await api<{ conversation: { id: string } }>(`/api/social/conversations/${userId}`, { method: 'POST' }); setActiveConversation({ id: r.conversation.id, friend: friends.find((f) => f.id === userId)!, lastMessage: null, unread: 0 }); setTab('messages'); }, '');
  };

  const sendMessage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!activeConversation) return; const form = event.currentTarget; const body = new FormData(form).get('body');
    await perform(async () => { await api(`/api/social/conversations/${activeConversation.id}/messages`, { method: 'POST', body: JSON.stringify({ body }) }); form.reset(); }, '');
  };
  const report = (target: { reportedUserId?: string; postId?: string; eventId?: string }) => {
    const reason = window.prompt('What happened? Moderators need a reason, not just a dramatic gasp.');
    if (reason) void friendAction('/api/social/reports', 'POST', { ...target, reason }, 'Report sent to the moderation table.');
  };
  const openProfile = async (username: string) => {
    try { const result = await api<{ user: Profile }>(`/api/users/${encodeURIComponent(username)}`); setViewedProfile(result.user); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Profile unavailable.'); }
  };

  const nav: Array<[string, string]> = [['events', 'Events'], ['friends', 'Friends'], ['messages', 'Messages'], ['hall', 'Hall of Hunger'], ['notifications', 'Notifications'], ...(role !== 'MEMBER' ? [['moderation', 'Moderation'] as [string, string]] : [])];
  const primaryMobileNav = nav.filter(([key]) => ['events', 'friends', 'messages', 'notifications'].includes(key));
  const extraMobileNav = nav.filter(([key]) => !primaryMobileNav.some(([primary]) => primary === key));
  const pageCopy: Record<string, [string, string]> = {
    friends: ['The Guest List', 'Find your people. A shared love of snacks is a perfectly valid start.'],
    events: ['Upcoming Feasts', 'Find a public table, check your invitations, or host the next suspiciously generous meal.'],
    messages: ['Whisper Network', 'Private notes between friends. The group chat is not invited.'],
    hall: ['Hall of Hunger', 'A leaderboard powered by published intel and questionable dedication.'],
    notifications: ['Your Crumb Trail', 'Requests, invitations and other developments from the snack desk.'],
    profile: ['Membership Card', 'Update how the club sees you. Keep it short; the bio is not a memoir.'],
    moderation: ['Moderation Desk', 'A human review queue for reports that need a closer look.'],
  };
  return <main className="app-shell">
    <header className="app-header"><a className="wordmark" href="/"><span className="wordmark-icon"><Icon name="intel" size={20}/></span><span>CRASH CLUB<small>FOOD INTEL, NO BADGE REQUIRED</small></span></a><div className="header-tools"><button className="header-icon-button" aria-label="Notifications" onClick={() => setTab('notifications')}><Icon name="notifications"/>{notifications.filter((n) => !n.readAt).length > 0 && <b className="header-count">{notifications.filter((n) => !n.readAt).length}</b>}</button><details className="profile-menu"><summary><span className="avatar-small"><Avatar member={profile}/></span><span className="profile-menu-label">{profile.displayName}<small>@{profile.username}</small></span><span className="chevron">⌄</span></summary><div className="profile-menu-popover"><button onClick={() => setTab('profile')}><Icon name="profile" size={16}/> My profile & settings</button>{role !== 'MEMBER' && <button onClick={() => setTab('moderation')}><Icon name="moderation" size={16}/> Moderation desk</button>}<button className="signout-menu" onClick={onLogout}>Sign out</button></div></details></div></header>
    <nav className="app-nav" aria-label="Main navigation">{nav.map(([key, label]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => { setTab(key); setError(''); setNotice(''); }}><Icon name={key} size={17}/><span>{label}</span>{key === 'notifications' && notifications.filter((n) => !n.readAt).length ? <b className="nav-badge">{notifications.filter((n) => !n.readAt).length}</b> : null}{key === 'messages' && conversations.some((conversation) => conversation.unread > 0) && <b className="nav-badge">{conversations.reduce((sum, conversation) => sum + conversation.unread, 0)}</b>}</button>)}</nav>
    <section className="dashboard-content">
      <div className="dashboard-heading"><div><p className="form-kicker">THE HUNGER EDITION · NO. 01</p><h1>{pageCopy[tab]?.[0] ?? 'Crash Club'}</h1><p className="page-description">{pageCopy[tab]?.[1]}</p></div><span className="eyebrow"><span className="status-dot"/> LOUD ABOUT FOOD. CAREFUL WITH PEOPLE.</span></div>
      {error && <p className="feedback error" role="alert">{error}</p>}{notice && <p className="feedback" role="status">{notice}</p>}
      {loading && <p className="loading-state" role="status">Checking the guest list and warming the plates…</p>}


      {tab === 'profile' && <section className="panel profile-editor"><p className="form-kicker">MEMBER FILE · {profile.username}</p><div className="profile-head"><Avatar member={profile} large/><div><h2>{profile.displayName}</h2><span>@{profile.username}</span></div></div><div className="avatar-upload-card"><div className="avatar-preview">{avatarPreview ? <img src={avatarPreview} alt="Preview of your selected profile photo"/> : <Avatar member={profile} large/>}</div><div className="avatar-upload-copy"><strong>Profile photo</strong><span>JPEG, PNG or WebP · max 1.5 MB</span><label className="avatar-file-label"><input type="file" accept="image/jpeg,image/png,image/webp" onChange={selectAvatar}/>Choose a photo</label></div><button type="button" className="primary-button" onClick={uploadAvatar} disabled={!avatarFile || busy}>{busy ? 'Uploading…' : 'Upload photo'}</button></div><form className="form-grid" onSubmit={async (event)=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget).entries());await perform(async()=>{const result=await api<{user:Profile}>('/api/auth/me',{method:'PATCH',body:JSON.stringify(values)});onProfileUpdate(result.user);},'Profile saved. Your membership card has been polished.');}}><label>Display name<input name="displayName" defaultValue={profile.displayName} maxLength={60} required/></label><label className="wide-field">Bio<textarea name="bio" defaultValue={profile.bio} maxLength={280} rows={3}/></label><button className="primary-button" disabled={busy}>Save profile</button></form></section>}

      {tab === 'friends' && <><section className="panel discovery-panel"><div className="section-heading"><div><p className="form-kicker">MEMBERS, NOT MENU ITEMS</p><h2>Find your people</h2></div><label className="search-control"><span className="sr-only">Search members</span><input className="wide-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search names or usernames"/></label></div><div className="member-grid">{members.map((member) => <article className="member-card" key={member.id}><Avatar member={member}/><div><strong>{member.displayName}</strong><small>@{member.username}</small></div><div className="member-actions"><button className="secondary-button" onClick={() => void friendAction('/api/social/friend-requests','POST',{userId:member.id},'Friend request sent. The anticipation is seasoned.')}>Add friend</button><button className="profile-view-button" onClick={() => void openProfile(member.username)}>View profile</button></div></article>)}</div>{!members.length && <div className="empty-state compact-empty"><h3>No members found.</h3><p>Try a name, username, or a less mysterious spelling.</p></div>}</section><div className="two-column"><section className="panel social-list-panel"><p className="form-kicker">PENDING ON YOUR SIDE</p><h2>Incoming requests <span className="count-pill">{incoming.length}</span></h2>{incoming.map((r) => <div className="list-row" key={r.id}><span className="member-name-with-avatar"><Avatar member={r.requester}/><span>{r.requester.displayName}<small>@{r.requester.username}</small></span></span><button className="secondary-button" onClick={() => void friendAction(`/api/social/friend-requests/${r.id}/accept`)}>Accept</button><button className="text-button" onClick={() => void friendAction(`/api/social/friend-requests/${r.id}/decline`)}>Decline</button></div>)}{!incoming.length && <p className="muted">Nobody’s slid into the guest list. Yet.</p>}<h3 className="subheading">Sent requests <span className="count-pill">{outgoing.length}</span></h3>{outgoing.map((r) => <div className="list-row" key={r.id}><span>{r.recipient.displayName}</span><button className="text-button" onClick={() => void friendAction(`/api/social/friend-requests/${r.id}/cancel`)}>Cancel</button></div>)}</section><section className="panel social-list-panel"><p className="form-kicker">YOUR PEOPLE</p><h2>Friends <span className="count-pill">{friends.length}</span></h2>{friends.map((friend) => <div className="list-row friend-row" key={friend.id}><span><Avatar member={friend}/><span>{friend.displayName}<small>@{friend.username}</small></span></span><button className="secondary-button" onClick={() => void startConversation(friend.id)}>Message</button><button className="text-button" onClick={() => void friendAction(`/api/social/friends/${friend.id}`,'DELETE',undefined,'Friendship ended; shared access revoked.')}>Unfriend</button><button className="text-button" onClick={() => void friendAction(`/api/social/blocks/${friend.id}`,'POST',undefined,'Member blocked.')}>Block</button></div>)}{!friends.length && <p className="muted">A table for one is still a table.</p>}</section></div></>}

      {tab === 'events' && <><EventForm friends={friends} busy={busy} onSubmit={submitEvent}/><div className="feed-tools"><div><p className="form-kicker">OPEN TABLE · YOUR INVITATIONS</p><h2>Event list <span className="count-pill">{events.length}</span></h2></div><div className="filter-row"><label className="search-control"><span className="sr-only">Search events</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search events or venues…"/></label><button className="secondary-button refresh-button" onClick={refresh} aria-label="Refresh events">↻</button></div></div><div className="event-grid">{events.map((event) => <article className="panel event-card" key={event.id}><div className="event-card-top"><span className={`event-visibility ${event.visibility === 'PUBLIC' ? 'public' : 'invite'}`}>{event.visibility === 'PUBLIC' ? 'Public event' : 'Invite only'}</span><span className="event-host"><Avatar member={event.creator}/>Hosted by {event.creator.displayName}</span></div><h2>{event.title}</h2><p>{event.description.length > 140 ? `${event.description.slice(0,140)}…` : event.description}</p><div className="event-facts"><span><Icon name="events" size={16}/>{new Date(event.startsAt).toLocaleString()}</span>{event.location && <span><span className="venue-pin">⌖</span>{event.location}</span>}</div><div className="event-card-actions"><button className="secondary-button" onClick={() => setViewedEvent(event)}>View details</button>{event.creatorId === profile.id && <button className="text-button" onClick={() => { const title = window.prompt('Update event title:', event.title); if (title?.trim()) void friendAction(`/api/social/events/${event.id}`, 'PATCH', { title }, 'Event updated. Guests notified.'); }}>Edit event</button>}</div></article>)}</div>{!events.length && <div className="empty-state"><span className="empty-mark">✳</span><h3>No upcoming feasts.</h3><p>Host one below. The calendar is currently fasting.</p></div>}</>}

      {tab === 'messages' && <div className="messages-layout"><aside className="panel conversation-list"><h2>Conversations</h2>{conversations.map((c)=><button className={`conversation-item ${activeConversation?.id===c.id?'selected':''}`} key={c.id} onClick={()=>setActiveConversation(c)}><span className="conversation-friend"><Avatar member={c.friend}/><strong>{c.friend.displayName}</strong></span><small>{c.lastMessage?.body ?? 'The first crumb is yours to send.'}</small>{c.unread>0&&<b className="nav-badge">{c.unread}</b>}</button>)}{!conversations.length&&<p className="muted">Friend first; whisper later. Head to Friends to start.</p>}</aside><section className="panel chat-panel">{activeConversation?<><div className="conversation-heading"><Avatar member={activeConversation.friend}/><h2>{activeConversation.friend.displayName}</h2></div><div className="message-list">{messages.map((m)=><p className={m.senderId===profile.id?'message mine':'message'} key={m.id}><span>{m.body}</span><time>{new Date(m.createdAt).toLocaleString()}</time></p>)}{!messages.length&&<p className="muted">No messages yet. Someone has to break the bread.</p>}</div><form className="message-form" onSubmit={sendMessage}><input name="body" maxLength={5000} placeholder="Send a private message…" required/><button className="primary-button">Send</button></form></>:<div className="empty-state">Choose a conversation. No eavesdropping, please.</div>}</section></div>}

      {tab === 'hall' && <section className="panel"><h2>All published intel counts equally. The kitchen keeps receipts.</h2>{leaderboard.map((row,index)=><div className="leader-row" key={row.user.id}><b>#{index+1}</b><span className="leader-member"><Avatar member={row.user}/><span>{row.user.displayName}<small>@{row.user.username}</small></span></span><strong>{row.posts} {row.posts===1?'post':'posts'}</strong></div>)}{!leaderboard.length&&<div className="empty-state">No published posts yet. The title is up for grabs.</div>}</section>}

      {tab === 'notifications' && <section className="panel"><div className="section-title"><h2>Recent notifications</h2><button className="secondary-button" onClick={()=>void friendAction('/api/social/notifications/read','POST',{all:true},'All caught up. The crumbs have been swept.')}>Mark all read</button></div>{notifications.map((n)=>{const friendRequest=incoming.find((r)=>r.id===n.entityId);return <div className={`list-row notification-row ${n.readAt?'':'unread'}`} key={n.id}><span>{n.type==='FRIEND_REQUEST'&&friendRequest?`${friendRequest.requester.displayName} sent you a friend request.`:notificationCopy(n.type)} <small>{new Date(n.createdAt).toLocaleString()}</small></span>{n.type==='FRIEND_REQUEST'&&n.entityId&&<div className="notification-actions">{friendRequest?<><button className="secondary-button" onClick={()=>void respondToFriendNotification(n,'accept')}>Accept</button><button className="text-button" onClick={()=>void respondToFriendNotification(n,'decline')}>Decline</button></>:<button className="text-button" onClick={()=>setTab('friends')}>View requests</button>}</div>}{n.entityType==='conversation'&&<button className="text-button" onClick={()=>setTab('messages')}>Open messages</button>}</div>;})}{!notifications.length&&<div className="empty-state">It’s quiet. suspiciously quiet.</div>}</section>}

      {tab === 'moderation' && <section className="panel"><h2>Reports awaiting a careful human</h2>{reports.map((r)=><article className="list-row report-row" key={r.id}><span><strong>{r.reason}</strong><small>{r.details} · filed by {r.reporter.displayName} · {r.status}</small></span><button className="secondary-button" onClick={()=>void friendAction(`/api/social/moderation/reports/${r.id}`,'PATCH',{status:'UNDER_REVIEW',moderatorNotes:'Review started'},'Report moved to review.')}>Review</button><button className="text-button" onClick={()=>void friendAction(`/api/social/moderation/reports/${r.id}`,'PATCH',{status:'RESOLVED',moderatorNotes:'Resolved by moderator'},'Report resolved.')}>Resolve</button></article>)}{!reports.length&&<div className="empty-state">No reports to review. {error.includes('Moderator')?'Your apron is currently decorative.':''}</div>}</section>}
    </section>
    {viewedProfile && <div className="modal-backdrop" role="presentation" onClick={() => setViewedProfile(null)}><section className="panel member-modal" role="dialog" aria-modal="true" aria-label="Member profile" onClick={(event)=>event.stopPropagation()}><button className="modal-close" onClick={()=>setViewedProfile(null)} aria-label="Close profile">×</button><div className="profile-head"><Avatar member={viewedProfile} large/><div><h2>{viewedProfile.displayName}</h2><span>@{viewedProfile.username}</span></div></div><p>{viewedProfile.bio || 'This member is letting their snack opinions speak for themselves.'}</p><button className="text-button" onClick={()=>{report({reportedUserId:viewedProfile.id});setViewedProfile(null);}}>Report member</button></section></div>}
    {viewedEvent && <div className="modal-backdrop" role="presentation" onClick={() => setViewedEvent(null)}><section className="panel member-modal event-detail" role="dialog" aria-modal="true" aria-label="Event details" onClick={(event)=>event.stopPropagation()}><button className="modal-close" onClick={()=>setViewedEvent(null)} aria-label="Close event details">×</button><p className="form-kicker">{viewedEvent.visibility==='PUBLIC'?'PUBLIC EVENT':'INVITE ONLY'} · HOSTED BY {viewedEvent.creator.displayName}</p><h2>{viewedEvent.title}</h2><p><strong>When:</strong> {new Date(viewedEvent.startsAt).toLocaleString()}{viewedEvent.endsAt?` – ${new Date(viewedEvent.endsAt).toLocaleString()}`:''}</p><p><strong>Where:</strong> {viewedEvent.location || 'The host is keeping the venue under wraps.'}</p><p>{viewedEvent.description || 'No extra details yet. Ask the host before bringing a fog machine.'}</p>{viewedEvent.invitations[0]&&<div className="rsvp-actions"><span>Current RSVP: {viewedEvent.invitations[0].rsvp}</span>{(['GOING','MAYBE','DECLINED'] as const).map((rsvp)=><button className="secondary-button" key={rsvp} onClick={()=>void friendAction(`/api/social/events/${viewedEvent.id}/rsvp`,'PATCH',{rsvp},`RSVP: ${rsvp.toLowerCase()}.`)}>{rsvp}</button>)}</div>}{viewedEvent.creatorId===profile.id&&<button className="text-button" onClick={()=>{const title=window.prompt('Update event title:',viewedEvent.title);if(title?.trim())void friendAction(`/api/social/events/${viewedEvent.id}`,'PATCH',{title},'Event updated. Guests notified.');}}>Edit event title</button>}</section></div>}
    {mobileMoreOpen && <div className="mobile-more-backdrop" role="presentation" onClick={() => setMobileMoreOpen(false)}><div className="mobile-more-menu" role="menu" onClick={(event) => event.stopPropagation()}><p className="form-kicker">MORE OF THE CLUB</p>{extraMobileNav.map(([key, label]) => <button role="menuitem" key={key} onClick={() => { setTab(key); setMobileMoreOpen(false); }}><Icon name={key}/>{label}</button>)}<button role="menuitem" onClick={() => { setTab('profile'); setMobileMoreOpen(false); }}><Icon name="profile"/>My profile & settings</button><button role="menuitem" onClick={onLogout}>Sign out</button></div></div>}
    <nav className="mobile-bottom-nav" aria-label="Mobile navigation">{primaryMobileNav.map(([key, label]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => { setTab(key); setMobileMoreOpen(false); }}><span className="mobile-nav-icon"><Icon name={key} size={19}/>{key === 'messages' && conversations.some((conversation) => conversation.unread > 0) && <i/>}</span><small>{label === 'Notifications' ? 'Alerts' : label}</small></button>)}<button className={mobileMoreOpen || extraMobileNav.some(([key]) => key === tab) ? 'active' : ''} onClick={() => setMobileMoreOpen((open) => !open)}><span className="mobile-nav-icon"><Icon name="more" size={20}/></span><small>More</small></button></nav>  </main>;
}

function notificationCopy(type: string) {
  return ({ FRIEND_REQUEST: 'Someone requested a seat at your table.', FRIEND_REQUEST_ACCEPTED: 'Your friend request was accepted. Friendship tastes good.', MESSAGE: 'A new private message arrived.', EVENT_INVITATION: 'You have an event invitation.', EVENT_UPDATED: 'An event you were invited to has changed.', RSVP_UPDATED: 'Someone changed their RSVP.', MODERATION_UPDATE: 'There is an update from the moderation desk.' } as Record<string,string>)[type] ?? 'A little something happened in the club.';
}

function Avatar({ member, large = false }: { member: Member; large?: boolean }) {
  return member.avatarUrl ? <img className={`avatar ${large ? 'avatar-large' : ''}`} src={member.avatarUrl} alt=""/> : <span className={`avatar avatar-placeholder ${large ? 'avatar-large' : ''}`} aria-hidden="true">{member.displayName.slice(0, 1).toUpperCase()}</span>;
}

function EventForm({ friends, busy, onSubmit }: { friends: Member[]; busy: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <details className="panel composer event-intel-form">
    <summary className="composer-summary"><div><p className="form-kicker">MAKE A PLAN · INVITE YOUR PEOPLE</p><h2>Host an event</h2><span>Add the when, where and deliciously important details.</span></div><span className="composer-expand" aria-hidden="true">+</span></summary>
    <form onSubmit={onSubmit} className="form-grid event-form-fields">
      <label>Event name<input name="title" maxLength={120} required placeholder="Soup Summit"/></label>
      <label>Date and time<input type="datetime-local" name="startsAt" required/></label>
      <label>Venue<input name="location" maxLength={200} placeholder="The suspiciously generous café"/></label>
      <label>Event visibility<select name="visibility"><option value="PUBLIC">Public and searchable</option><option value="INVITE_ONLY">Invite-only event</option></select></label>
      <label className="wide-field">What’s happening?<textarea name="description" maxLength={4000} rows={3} placeholder="Bring an appetite and a working theory…"/></label>
      <label>Invite friends to the event <span className="field-note">They’ll get a notification and can RSVP.</span><select name="inviteeIds" multiple size={Math.min(4,Math.max(2,friends.length))}>{friends.map((friend)=><option key={friend.id} value={friend.id}>{friend.displayName}</option>)}</select></label>
      <button className="primary-button" disabled={busy}>{busy?'Publishing…':'Publish event'}</button>
    </form>
  </details>;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'include', headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? 'The kitchen hit a snag. Try again.');
  return body as T;
}

function PasswordField({ label, autoComplete, minLength, helper }: { label: string; autoComplete: string; minLength?: number; helper?: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="password-field">
      <label htmlFor={`password-${autoComplete}`}>{label}</label>
      <div className="password-entry">
        <input id={`password-${autoComplete}`} name="password" type={visible ? 'text' : 'password'} autoComplete={autoComplete} minLength={minLength} maxLength={128} required />
        <button className="password-toggle" type="button" aria-label={visible ? 'Hide password' : 'Show password'} onClick={() => setVisible(!visible)}>{visible ? 'Hide' : 'Show'}</button>
      </div>
      {helper && <span className="field-note">{helper}</span>}
    </div>
  );
}

export default function App() {
  const [screen, setScreen] = useState<Screen>(window.location.pathname === '/verify' ? 'verify' : window.location.pathname === '/reset-password' ? 'reset' : 'login');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [emailForVerification, setEmailForVerification] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ user: Profile }>('/api/auth/me').then(({ user }) => { setProfile(user); setScreen('profile'); }).catch(() => {});
    if (window.location.pathname === '/verify') {
      const token = new URLSearchParams(window.location.search).get('token');
      if (token) api('/api/auth/verify-email', { method: 'POST', body: JSON.stringify({ token }) })
        .then(() => { setNotice('Email verified. You may now sign in.'); window.history.replaceState({}, '', '/'); setScreen('login'); })
        .catch((reason: Error) => setError(reason.message));
    }
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(''); setNotice(''); setBusy(true);
    const data = Object.fromEntries(new FormData(event.currentTarget).entries());
    try {
      if (screen === 'login') {
        setEmailForVerification(String(data.email ?? ''));
        const result = await api<{ user: Profile }>('/api/auth/login', { method: 'POST', body: JSON.stringify(data) });
        setProfile(result.user); setScreen('profile');
      } else if (screen === 'register') {
        setEmailForVerification(String(data.email ?? ''));
        const result = await api<{ message: string }>('/api/auth/register', { method: 'POST', body: JSON.stringify(data) });
        setNotice(result.message);
        setScreen('login');
      } else if (screen === 'forgot') {
        await api('/api/auth/password-reset/request', { method: 'POST', body: JSON.stringify(data) });
        setNotice('If that email belongs to an active account, a reset link is on its way.');
      } else if (screen === 'reset') {
        const token = new URLSearchParams(window.location.search).get('token');
        await api('/api/auth/password-reset/confirm', { method: 'POST', body: JSON.stringify({ ...data, token }) });
        setNotice('Password updated. The account is back on the menu. Sign in below.');
        window.history.replaceState({}, '', '/'); setScreen('login');
      } else if (screen === 'profile' && profile) {
        const result = await api<{ user: Profile }>('/api/auth/me', { method: 'PATCH', body: JSON.stringify(data) });
        setProfile(result.user); setNotice('Profile saved. Your bio has been returned to the public eye.');
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'The kitchen hit a snag. Try again.'); }
    finally { setBusy(false); }
  };

  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setProfile(null); setScreen('login'); setNotice('Signed out. The leftovers are all yours.');
  };

  const activeProfile = profile as Profile | null;
  if (activeProfile) return <Dashboard profile={activeProfile} onLogout={logout} onProfileUpdate={setProfile} />;

  const title = screen === 'register' ? 'Join the club.' : screen === 'forgot' ? 'Lost your password?' : screen === 'reset' ? 'New password. New plate.' : screen === 'profile' ? 'Your membership card.' : 'Get the intel.';
  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="wordmark" href="/" aria-label="Crash Club home"><span className="wordmark-icon" aria-hidden="true">CC</span><span>CRASH CLUB</span></a>
        <span className="edition">THE HUNGER EDITION · NO. 01</span>
      </header>
      <section className="auth-layout" aria-labelledby="auth-title">
        <div className="auth-copy">
          <p className="eyebrow"><span className="status-dot" /> YOUR NEIGHBORHOOD FOOD DESK</p>
          <h1 id="auth-title">{title}</h1>
          <p className="intro">Big plans. Small plates. Excellent intel. We’re assembling the guest list one hungry human at a time.</p>
          <div className="coming-soon"><span aria-hidden="true">✳</span> No secret handshake. A strong snack opinion helps.</div>
        </div>
        <section className="auth-card" aria-label="Account access">
          {screen === 'profile' && profile ? <>
            <p className="form-kicker">MEMBER FILE · {profile.username}</p>
            <div className="profile-head">{profile.avatarUrl ? <img src={profile.avatarUrl} alt="" /> : <div className="avatar-placeholder" aria-hidden="true">{profile.displayName.slice(0, 1).toUpperCase()}</div>}<div><h2>{profile.displayName}</h2><span>@{profile.username}</span></div></div>
            <form onSubmit={submit} className="auth-form">
              <label>Display name<input name="displayName" maxLength={60} defaultValue={profile.displayName} required /></label>
              <label>Bio <span className="field-note">280 chars, including snack lore</span><textarea name="bio" maxLength={280} rows={3} defaultValue={profile.bio} /></label>
              <label>Profile picture URL <span className="field-note">Optional; use an https image link</span><input name="avatarUrl" type="url" defaultValue={profile.avatarUrl ?? ''} placeholder="https://…" /></label>
              <button className="primary-button" disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</button>
            </form>
            {error && <p className="feedback error" role="alert">{error}</p>}
            {notice && <p className="feedback" role="status">{notice}</p>}
            <button className="text-button signout" onClick={logout}>Sign out</button>
          </> : <>
            <p className="form-kicker">{screen === 'register' ? 'APPLICATION FOR MEMBERSHIP' : screen === 'forgot' ? 'PASSWORD RESCUE SERVICE' : screen === 'reset' ? 'ACCOUNT RESCUE SERVICE' : 'MEMBER ACCESS'}</p>
            <h2>{screen === 'register' ? 'Pull up a chair.' : screen === 'forgot' ? 'We’ll send a fresh link.' : screen === 'reset' ? 'Choose your new password.' : 'Welcome back, hungry.'}</h2>
            <form className="auth-form" onSubmit={submit}>
              {screen === 'register' && <>
                <label>Email<input name="email" type="email" autoComplete="email" maxLength={254} required /></label>
                <label>Username<input name="username" autoComplete="username" minLength={3} maxLength={30} pattern="[A-Za-z0-9_]+" required /><span className="field-note">Letters, numbers, and underscores. No crumbs.</span></label>
                <label>Display name<input name="displayName" autoComplete="name" maxLength={60} required /></label>
                <PasswordField label="Password" autoComplete="new-password" minLength={8} helper="At least 8 characters. No symbol scavenger hunt." />
              </>}
              {screen === 'login' && <>
                <label>Email<input name="email" type="email" autoComplete="email" required /></label>
                <PasswordField label="Password" autoComplete="current-password" />
              </>}
              {screen === 'forgot' && <label>Email<input name="email" type="email" autoComplete="email" required /></label>}
              {screen === 'reset' && <PasswordField label="New password" autoComplete="new-password" minLength={8} helper="At least 8 characters." />}
              <button className="primary-button" disabled={busy}>{busy ? 'One moment…' : screen === 'register' ? 'Create my account' : screen === 'forgot' ? 'Send reset link' : screen === 'reset' ? 'Set new password' : 'Sign in'}</button>
            </form>
            {error && <p className="feedback error" role="alert">{error}</p>}
            {notice && <p className="feedback" role="status">{notice}</p>}
            <div className="form-links">
              {screen === 'login' && <><button className="text-button" onClick={() => { setScreen('forgot'); setError(''); setNotice(''); }}>Forgot password?</button><span>New around here? <button className="text-button" onClick={() => { setScreen('register'); setError(''); setNotice(''); }}>Join the club</button></span></>}
              {screen === 'register' && <span>Already on the list? <button className="text-button" onClick={() => setScreen('login')}>Sign in</button></span>}
              {(screen === 'forgot' || screen === 'reset') && <button className="text-button" onClick={() => setScreen('login')}>Back to sign in</button>}
            </div>
            {screen === 'login' && !import.meta.env.DEV && <button className="text-button resend" onClick={async () => { if (!emailForVerification) { setError('Enter your email above first, then request another link.'); return; } try { const result = await api<{ message: string }>('/api/auth/resend-verification', { method: 'POST', body: JSON.stringify({ email: emailForVerification }) }); setNotice(result.message); setError(''); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Try again.'); } }}>Need another verification email?</button>}
          </>}
        </section>
      </section>
      <section className="status-panel"><div><span className="status-dot" /><strong>Account security: properly seasoned</strong></div><span>VERIFIED MEMBERS · REAL FOOD INTEL</span></section>
      <footer className="site-footer"><span>MADE FOR THE HUNGRY, THE CURIOUS, AND THE “ON MY WAY” CROWD.</span><span>CRASH CLUB © 2026</span></footer>
    </main>
  );
}

