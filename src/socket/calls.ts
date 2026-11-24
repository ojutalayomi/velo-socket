import { ObjectId } from 'mongodb';
import { io, UserSocket } from '../socket.js';
import { redis } from '../app.js';
import { MongoDBClient } from '../mongodb.js';
import { selectRecipients } from '../notifications/eligibility.js';
import { loadNotificationPreferences } from '../notifications/settings.js';
import { filterOnlineUsers } from '../presence.js';
import { deliverPush, sendSilentClose } from '../push.js';
import { isChatParticipant } from '../utils.js';
import { canSendMessage } from '../lib/chatPermissions.js';
import { buildCallRecord } from '../lib/callRecord.js';
import { chatSocketHandler } from '../lib/chatSocketHandler.js';

const CALL_RING_TIMEOUT_MS = 30_000;
/** Group calls ring longer, since many people may be rung. */
const GROUP_RING_TIMEOUT_MS = 45_000;
/** Every participant connects to every other one, so the call size is capped. */
const MAX_GROUP_PARTICIPANTS = 6;

type CallStatus = 'ringing' | 'connected' | 'ended' | 'declined';

interface ActiveCall {
  callId: string;
  roomId: string;
  callerId: string;
  callerName: string;
  callerAvatar: string;
  calleeId?: string;
  /** Users currently in the call (joined, not just rung). */
  participants: string[];
  profiles: Record<string, { name: string; avatar: string }>;
  callType: 'audio' | 'video';
  chatType: 'DM' | 'Group';
  status: CallStatus;
  startTime: number;
  /** When a second person first joined; unset if nobody ever picked up. */
  connectedAt?: number;
  /** Most people in the call at once, for the history card. */
  peakParticipants: number;
  endTime?: number;
  timer?: ReturnType<typeof setTimeout>;
  closeSent: boolean;
  missedSent: boolean;
}

async function loadCaller(userId: string): Promise<{ name: string; avatar: string }> {
  const fallback = { name: 'Someone', avatar: '' };
  if (!ObjectId.isValid(userId)) return fallback;

  try {
    const db = await new MongoDBClient().init();
    const user = await db.users().findOne(
      { _id: new ObjectId(userId) },
      { projection: { firstname: 1, lastname: 1, username: 1, displayPicture: 1 } }
    );
    if (!user) return fallback;
    return {
      name:
        [user.firstname, user.lastname].filter(Boolean).join(' ').trim() ||
        user.username ||
        fallback.name,
      avatar: user.displayPicture ?? '',
    };
  } catch (error) {
    console.error('Error loading call display name:', error);
    return fallback;
  }
}

/** Applies call preferences, block state, and the offline requirement. */
async function callRecipients(call: ActiveCall): Promise<string[]> {
  if (!call.calleeId) return [];

  const db = await new MongoDBClient().init();
  const candidateIds = [call.calleeId];
  const participantIds = new Set([call.callerId, ...call.participants, call.calleeId]);

  const [preferences, onlineIds, blockedRows] = await Promise.all([
    loadNotificationPreferences(db, candidateIds),
    filterOnlineUsers(redis, candidateIds),
    db
      .blockedUsers()
      .find(
        { blockerId: call.calleeId, blockedId: call.callerId },
        { projection: { blockerId: 1, _id: 0 } }
      )
      .toArray(),
  ]);

  return selectRecipients({
    candidates: candidateIds,
    senderId: call.callerId,
    kind: 'call',
    participants: participantIds,
    blocked: new Set(blockedRows.map((row) => row.blockerId)),
    preferences,
    muted: new Set(),
    online: new Set(onlineIds),
    requireOffline: false,
  });
}

async function sendIncomingCallPush(call: ActiveCall): Promise<void> {
  const recipients = await callRecipients(call);
  if (recipients.length === 0) return;

  await deliverPush({
    kind: 'call-incoming',
    sourceId: call.callId,
    userIds: recipients,
    payload: {
      title: `Incoming ${call.callType} call`,
      body: `${call.callerName} is calling you`,
      url: '/chats',
      tag: `call:${call.callId}`,
    },
    requireOffline: false,
    redis,
  });
}

async function dismissCallNotification(call: ActiveCall): Promise<void> {
  if (call.closeSent) return;
  call.closeSent = true;

  const targets = Array.from(
    new Set([...(call.calleeId ? [call.calleeId] : []), ...call.participants])
  );
  await sendSilentClose(targets, `call:${call.callId}`);
}

async function sendMissedCallPush(call: ActiveCall): Promise<void> {
  if (call.missedSent || !call.calleeId) return;
  call.missedSent = true;

  const recipients = await callRecipients(call);
  if (recipients.length === 0) return;

  await deliverPush({
    kind: 'call-missed',
    sourceId: call.callId,
    userIds: recipients,
    payload: {
      title: 'Missed call',
      body: `${call.callerName} tried to call you`,
      url: '/chats',
      tag: `call:${call.callId}`,
    },
    requireOffline: false,
    redis,
  });
}

function clearRingTimer(call: ActiveCall): void {
  if (call.timer) {
    clearTimeout(call.timer);
    call.timer = undefined;
  }
}

// Store active calls and their participants
const activeCalls = new Map<string, ActiveCall>();
/** userId -> the call they are ringing for or talking in (one at a time). */
const userCalls = new Map<string, string>();

const callRoom = (callId: string) => `call:${callId}`;
/** Per-participant room, so signalling can be addressed to one person (all of their devices). */
const callUserRoom = (callId: string, userId: string) => `callu:${callId}:${userId}`;

/**
 * Leaves a "Call" card in the chat, like WhatsApp's call history. Sent as the caller, so it sits
 * on their side of the conversation. Best-effort: a failure here never affects the call itself.
 */
async function recordCall(call: ActiveCall, content: string, endTime: number): Promise<void> {
  try {
    if (!ObjectId.isValid(call.roomId) || !ObjectId.isValid(call.callerId)) return;
    const db = await new MongoDBClient().init();
    const caller = await db.users().findOne(
      { _id: new ObjectId(call.callerId) },
      { projection: { name: 1, firstname: 1, lastname: 1, username: 1, displayPicture: 1, verified: 1 } }
    );
    if (!caller) return;

    await chatSocketHandler(
      {
        _id: '',
        chatId: call.roomId,
        // A DM is addressed to the other person, a group to the chat itself.
        receiverId: call.chatType === 'DM' ? (call.calleeId as string) : call.roomId,
        content,
        messageType: 'Call',
        isRead: {},
        sender: {
          id: call.callerId,
          name: caller.name || [caller.firstname, caller.lastname].filter(Boolean).join(' ') || call.callerName,
          displayPicture: caller.displayPicture ?? '',
          username: caller.username ?? '',
          verified: Boolean(caller.verified),
        },
        reactions: [],
        attachments: [],
        quotedMessageId: '',
        status: 'sent',
        chatType: call.chatType,
        timestamp: new Date(endTime).toISOString(),
      } as never,
      db,
      call.callerId,
      { trustedSender: true }
    );
  } catch (error) {
    console.error('Error recording call in chat:', error);
  }
}

function deleteCall(call: ActiveCall): void {
  clearRingTimer(call);
  const endTime = Date.now();
  // The outcome is read now, before the status is overwritten below.
  void recordCall(call, JSON.stringify(buildCallRecord(call, endTime)), endTime);
  call.status = 'ended';
  call.endTime = endTime;
  activeCalls.delete(call.callId);
  for (const [userId, callId] of userCalls) {
    if (callId === call.callId) userCalls.delete(userId);
  }
  emitGroupState(call, false);
}

/** Everyone who might hold a UI for this call: its room, the caller, and whoever was rung. */
function emitToCallAudience(call: ActiveCall, event: string, payload: Record<string, unknown>): void {
  const rooms = [callRoom(call.callId), `user:${call.callerId}`];
  if (call.chatType === 'DM' && call.calleeId) rooms.push(`user:${call.calleeId}`);
  if (call.chatType === 'Group') rooms.push(`group:${call.roomId}`);
  io.to(rooms).emit(event, payload);
}

/** Lets group members show a "call in progress: join" banner. */
function groupStatePayload(call: ActiveCall | undefined, roomId: string, active: boolean) {
  return {
    roomId,
    callId: active && call ? call.callId : null,
    callType: call?.callType,
    count: active && call ? call.participants.length : 0,
    max: MAX_GROUP_PARTICIPANTS,
  };
}

function emitGroupState(call: ActiveCall, active = true): void {
  if (call.chatType !== 'Group') return;
  io.to(`group:${call.roomId}`).emit('call:group-state', groupStatePayload(call, call.roomId, active));
}

async function handleRingTimeout(callId: string): Promise<void> {
  const call = activeCalls.get(callId);
  // A call that someone joined is no longer ringing.
  if (!call || call.status !== 'ringing') return;

  call.timer = undefined;
  try {
    await dismissCallNotification(call);
    await sendMissedCallPush(call);
  } catch (error) {
    console.error('Error settling timed-out call:', error);
  }

  emitToCallAudience(call, 'call:ended', { callId, reason: 'timeout' });
  deleteCall(call);
  console.log(`Call ${callId} timed out`);
}

// Handle call invitations
export const handleCallInvite = async (
  socket: UserSocket,
  data: {
    roomId: string;
    targetUserId?: string;
    callType: 'audio' | 'video';
    chatType: 'DM' | 'Group';
  }
) => {
  const { roomId, targetUserId, callType, chatType } = data;
  const callerId = socket.handshake.query.userId as string;

  if (!callerId || !roomId) return;
  if (callType !== 'audio' && callType !== 'video') return;

  if (chatType === 'DM' && (!targetUserId || targetUserId === callerId)) return;

  const targets = chatType === 'DM' ? [callerId, targetUserId as string] : [callerId];
  const membership = await Promise.all(targets.map((id) => isChatParticipant(roomId, id)));
  if (membership.some((isMember) => !isMember)) {
    console.warn(`call:invite rejected; ${targets.join(' or ')} is not in chat ${roomId}`);
    socket.emit('chatError', { error: 'You are not a participant of this chat' });
    return;
  }

  // In an admin-only group, members cannot start calls either (they can still join a live one).
  if (chatType === 'Group' && ObjectId.isValid(roomId)) {
    const db = await new MongoDBClient().init();
    const group = await db.chats().findOne(
      { _id: new ObjectId(roomId) },
      { projection: { chatType: 1, adminIds: 1, onlyAdminsCanSend: 1 } }
    );
    const live = Array.from(activeCalls.values()).some((c) => c.chatType === 'Group' && c.roomId === roomId);
    if (group && !live && !canSendMessage({ ...group, userId: callerId })) {
      socket.emit('chatError', { error: 'Only admins can start calls in this group' });
      return;
    }
  }

  // One call at a time per person, on either end.
  if (userCalls.has(callerId)) {
    socket.emit('call:ended', { callId: userCalls.get(callerId), reason: 'already-in-call', local: true });
    return;
  }
  if (chatType === 'DM' && userCalls.has(targetUserId as string)) {
    socket.emit('call:ended', { callId: null, reason: 'busy', local: true });
    return;
  }
  // A group has one call at a time: starting another one joins nobody, so point at the live one.
  if (chatType === 'Group') {
    for (const existing of activeCalls.values()) {
      if (existing.chatType === 'Group' && existing.roomId === roomId) {
        socket.emit('call:group-state', groupStatePayload(existing, roomId, true));
        socket.emit('call:ended', { callId: null, reason: 'group-call-active', local: true });
        return;
      }
    }
  }

  const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  const caller = await loadCaller(callerId);
  const call: ActiveCall = {
    callId,
    roomId,
    callerId,
    callerName: caller.name,
    callerAvatar: caller.avatar,
    calleeId: chatType === 'DM' ? targetUserId : undefined,
    participants: [callerId],
    profiles: { [callerId]: caller },
    callType,
    chatType,
    status: 'ringing',
    startTime: Date.now(),
    peakParticipants: 1,
    closeSent: false,
    missedSent: false,
  };
  activeCalls.set(callId, call);
  userCalls.set(callerId, callId);

  // The caller listens on the call room (and its own address within it) for signalling.
  socket.join(callRoom(callId));
  socket.join(callUserRoom(callId, callerId));

  console.log(`Call invitation: ${callerId} -> ${roomId} (${callType}, ${chatType})`);

  const invite = {
    callId,
    roomId,
    callerId,
    callerName: caller.name,
    callerAvatar: caller.avatar,
    callType,
    chatType,
  };

  if (chatType === 'Group') {
    socket.to(`group:${roomId}`).emit('call:invite', invite);
    emitGroupState(call);
  } else {
    io.to(`user:${targetUserId}`).emit('call:invite', invite);

    sendIncomingCallPush(call).catch((error) =>
      console.error('Error sending incoming call push:', error)
    );
  }

  // Nobody joined in time: end it and, for a DM, report a missed call.
  call.timer = setTimeout(
    () => {
      handleRingTimeout(callId).catch((error) =>
        console.error('Error handling call ring timeout:', error)
      );
    },
    chatType === 'Group' ? GROUP_RING_TIMEOUT_MS : CALL_RING_TIMEOUT_MS
  );
  call.timer.unref?.();

  // Confirm call initiated to caller
  socket.emit('call:initiated', { callId, roomId, callType, chatType });
};

/** Adds `userId` to the call and tells everyone: the joiner gets the roster, the others a heads-up. */
async function joinCall(socket: UserSocket, call: ActiveCall, userId: string): Promise<void> {
  const profile = await loadCaller(userId);
  // The call may have ended while the profile loaded.
  if (!activeCalls.has(call.callId)) return;

  clearRingTimer(call);
  call.status = 'connected';
  if (call.chatType === 'DM') call.calleeId = userId;
  call.profiles[userId] = profile;
  const existing = call.participants.filter((id) => id !== userId);
  if (!call.participants.includes(userId)) call.participants.push(userId);
  call.peakParticipants = Math.max(call.peakParticipants, call.participants.length);
  if (!call.connectedAt && call.participants.length >= 2) call.connectedAt = Date.now();
  userCalls.set(userId, call.callId);

  socket.join(callRoom(call.callId));
  socket.join(callUserRoom(call.callId, userId));

  // The joiner creates a WebRTC offer for each person already in the call.
  socket.emit('call:joined', {
    callId: call.callId,
    callType: call.callType,
    participants: existing.map((id) => ({ userId: id, ...call.profiles[id] })),
  });
  socket.to(callRoom(call.callId)).emit('call:peer-joined', {
    callId: call.callId,
    user: { userId, ...profile },
  });

  // Everyone else who was ringing (other devices, other group members) can dismiss the dialog,
  // except in a group where the call stays open to join.
  if (call.chatType === 'DM') {
    socket.to(`user:${userId}`).emit('call:handled', { callId: call.callId, by: userId });
  }

  emitGroupState(call);
  await dismissCallNotification(call);
  console.log(`Call ${call.callId} joined by ${userId}`);
}

// Handle call answers
export const handleCallAnswer = async (
  socket: UserSocket,
  data: {
    callId: string;
    accepted: boolean;
  }
) => {
  const { callId, accepted } = data;
  const userId = socket.handshake.query.userId as string;
  const call = activeCalls.get(callId);

  if (!call || !userId) return;
  if (userId === call.callerId || call.participants.includes(userId)) return;

  if (call.chatType === 'DM') {
    if (call.status !== 'ringing' || userId !== call.calleeId) return;
  } else {
    if (!(await isChatParticipant(call.roomId, userId))) return;
    if (call.participants.length >= MAX_GROUP_PARTICIPANTS) {
      socket.emit('call:ended', { callId, reason: 'full', local: true });
      return;
    }
  }

  if (accepted) {
    if (userCalls.has(userId)) {
      socket.emit('call:ended', { callId, reason: 'already-in-call', local: true });
      return;
    }
    await joinCall(socket, call, userId);
  } else if (call.chatType === 'DM') {
    clearRingTimer(call);
    call.status = 'declined';
    call.endTime = Date.now();

    io.to(`user:${call.callerId}`).emit('call:declined', { callId });
    socket.to(`user:${userId}`).emit('call:handled', { callId, by: userId });

    await dismissCallNotification(call);
    deleteCall(call);
    console.log(`Call ${callId} declined`);
  }
  // In a group, one member declining does not affect anyone else.
};

// WebRTC signalling is addressed to one participant (`to`), and only accepted from sockets
// that actually joined the call room.
function relaySignal(
  socket: UserSocket,
  callId: string,
  to: unknown,
  event: string,
  payload: Record<string, unknown>
) {
  const from = socket.handshake.query.userId as string;
  const call = activeCalls.get(callId);
  if (!call || typeof to !== 'string' || !from) return;
  if (!socket.rooms.has(callRoom(callId)) || !call.participants.includes(to)) return;
  io.to(callUserRoom(callId, to)).emit(event, { callId, from, ...payload });
}

export const handleWebRTCOffer = (socket: UserSocket, data: { callId: string; to: string; offer: unknown }) => {
  relaySignal(socket, data.callId, data.to, 'webrtc:offer', { offer: data.offer });
};

export const handleWebRTCAnswer = (socket: UserSocket, data: { callId: string; to: string; answer: unknown }) => {
  relaySignal(socket, data.callId, data.to, 'webrtc:answer', { answer: data.answer });
};

export const handleWebRTCCandidate = (socket: UserSocket, data: { callId: string; to: string; candidate: unknown }) => {
  relaySignal(socket, data.callId, data.to, 'webrtc:candidate', { candidate: data.candidate });
};

// Handle call end (in a connected group call this means "leave")
export const handleCallEnd = async (
  socket: UserSocket,
  data: {
    callId: string;
  }
) => {
  const { callId } = data;
  const userId = socket.handshake.query.userId as string;
  const call = activeCalls.get(callId);

  if (!call || !userId) return;

  // Only the caller, callee, or a joined participant may end the call.
  const isParticipant =
    userId === call.callerId ||
    userId === call.calleeId ||
    call.participants.includes(userId);
  if (!isParticipant) return;

  if (call.status === 'ringing') {
    clearRingTimer(call);

    if (call.chatType === 'DM' && userId === call.calleeId) {
      // Callee hung up before answering: declined, no missed-call push
      call.status = 'declined';
      io.to(`user:${call.callerId}`).emit('call:declined', { callId });
      await dismissCallNotification(call);
      deleteCall(call);
      console.log(`Call ${callId} declined by callee hangup`);
      return;
    }

    // Caller cancelled while ringing: dismiss, then report a missed call
    try {
      await dismissCallNotification(call);
      await sendMissedCallPush(call);
    } catch (error) {
      console.error('Error settling cancelled call:', error);
    }
    emitToCallAudience(call, 'call:ended', { callId, reason: 'hangup', by: userId });
    deleteCall(call);
    return;
  }

  if (call.chatType === 'Group') {
    // Leave: the rest of the group carries on until only one person is left.
    call.participants = call.participants.filter((id) => id !== userId);
    userCalls.delete(userId);
    socket.leave(callRoom(callId));
    socket.leave(callUserRoom(callId, userId));
    io.to(callRoom(callId)).emit('call:peer-left', { callId, userId });
    console.log(`${userId} left call ${callId}; ${call.participants.length} remain`);

    if (call.participants.length <= 1) {
      emitToCallAudience(call, 'call:ended', { callId, reason: 'hangup', by: userId });
      deleteCall(call);
    } else {
      emitGroupState(call);
    }
    return;
  }

  emitToCallAudience(call, 'call:ended', { callId, reason: 'hangup', by: userId });
  deleteCall(call);
  console.log(`Call ${callId} ended by ${userId}`);
};

// Handle call hangup (legacy compatibility)
export const handleCallHangup = async (
  socket: UserSocket,
  data: {
    roomId: string;
  }
) => {
  const { roomId } = data;
  const userId = socket.handshake.query.userId as string;

  // Find and end any active calls for this room
  for (const [callId, call] of activeCalls.entries()) {
    if (call.roomId === roomId && call.participants.includes(userId)) {
      await handleCallEnd(socket, { callId });
      break;
    }
  }

  // Legacy event for compatibility
  io.to(`group:${roomId}`).emit('remote-hangup', roomId);
};

/** A dropped connection hangs up the calls that socket had joined (not other devices' calls). */
export const handleCallSocketDisconnecting = async (socket: UserSocket) => {
  for (const room of socket.rooms) {
    if (!room.startsWith('call:')) continue;
    await handleCallEnd(socket, { callId: room.slice('call:'.length) });
  }
};

/** Answers "is there a call going on in this group?" for someone opening the chat. */
export const handleCallActive = async (socket: UserSocket, data: { roomId?: string }) => {
  const userId = socket.handshake.query.userId as string;
  const roomId = data?.roomId;
  if (!userId || !roomId || !(await isChatParticipant(roomId, userId))) return;
  const live = Array.from(activeCalls.values()).find(
    (call) => call.chatType === 'Group' && call.roomId === roomId
  );
  socket.emit('call:group-state', groupStatePayload(live, roomId, Boolean(live)));
};

// Get call information
export const getCallInfo = (callId: string) => {
  return activeCalls.get(callId);
};

// Get active calls for a user
export const getUserActiveCalls = (userId: string) => {
  return Array.from(activeCalls.values()).filter(call => 
    call.participants.includes(userId) && call.status !== 'ended'
  );
};

// Get all active calls (for admin/monitoring)
export const getAllActiveCalls = () => {
  return Array.from(activeCalls.values());
};
