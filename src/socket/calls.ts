import { ObjectId } from 'mongodb';
import { io, UserSocket } from '../socket.js';
import { redis } from '../app.js';
import { MongoDBClient } from '../mongodb.js';
import { selectRecipients } from '../notifications/eligibility.js';
import { loadNotificationPreferences } from '../notifications/settings.js';
import { filterOnlineUsers } from '../presence.js';
import { deliverPush, sendSilentClose } from '../push.js';
import { isChatParticipant } from '../utils.js';

const CALL_RING_TIMEOUT_MS = 30_000;

type CallStatus = 'ringing' | 'connected' | 'ended' | 'declined';

interface ActiveCall {
  callId: string;
  roomId: string;
  callerId: string;
  callerName: string;
  callerAvatar: string;
  calleeId?: string;
  participants: string[];
  callType: 'audio' | 'video';
  chatType: 'DM' | 'Group';
  status: CallStatus;
  startTime: number;
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

function deleteCall(call: ActiveCall): void {
  clearRingTimer(call);
  call.status = 'ended';
  call.endTime = Date.now();
  activeCalls.delete(call.callId);
  for (const [userId, callId] of userCalls) {
    if (callId === call.callId) userCalls.delete(userId);
  }
}

/** Everyone who might hold a UI for this call: its room, the caller, and whoever was rung. */
function emitToCallAudience(call: ActiveCall, event: string, payload: Record<string, unknown>): void {
  const rooms = [`call:${call.callId}`, `user:${call.callerId}`];
  if (call.chatType === 'DM' && call.calleeId) rooms.push(`user:${call.calleeId}`);
  if (call.chatType === 'Group') rooms.push(`group:${call.roomId}`);
  io.to(rooms).emit(event, payload);
}

async function handleRingTimeout(callId: string): Promise<void> {
  const call = activeCalls.get(callId);
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

// Store active calls and their participants
const activeCalls = new Map<string, ActiveCall>();
/** userId -> the call they are ringing for or talking in (one at a time). */
const userCalls = new Map<string, string>();

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

  if (chatType === 'DM' && (!targetUserId || targetUserId === callerId)) return;

  const targets = chatType === 'DM' ? [callerId, targetUserId as string] : [callerId];
  const membership = await Promise.all(targets.map((id) => isChatParticipant(roomId, id)));
  if (membership.some((isMember) => !isMember)) {
    console.warn(`call:invite rejected; ${targets.join(' or ')} is not in chat ${roomId}`);
    socket.emit('chatError', { error: 'You are not a participant of this chat' });
    return;
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
    callType,
    chatType,
    status: 'ringing',
    startTime: Date.now(),
    closeSent: false,
    missedSent: false,
  };
  activeCalls.set(callId, call);
  userCalls.set(callerId, callId);

  // The caller listens on the call room for signalling from the person who answers.
  socket.join(`call:${callId}`);

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
    // Group calls are signal-only: no push, no ring timeout, no missed-call push.
    socket.to(`group:${roomId}`).emit('call:invite', invite);
  } else {
    io.to(`user:${targetUserId}`).emit('call:invite', invite);

    sendIncomingCallPush(call).catch((error) =>
      console.error('Error sending incoming call push:', error)
    );

    call.timer = setTimeout(() => {
      handleRingTimeout(callId).catch((error) =>
        console.error('Error handling call ring timeout:', error)
      );
    }, CALL_RING_TIMEOUT_MS);
    call.timer.unref?.();
  }

  // Confirm call initiated to caller
  socket.emit('call:initiated', { callId, roomId, callType, chatType });
};

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
  if (call.status !== 'ringing') return;
  if (userId === call.callerId) return;
  if (call.chatType === 'DM' && userId !== call.calleeId) return;
  if (call.chatType === 'Group' && !(await isChatParticipant(call.roomId, userId))) return;

  if (accepted) {
    if (userCalls.has(userId)) {
      socket.emit('call:ended', { callId, reason: 'already-in-call', local: true });
      return;
    }
    clearRingTimer(call);
    call.status = 'connected';
    call.calleeId = userId;
    if (!call.participants.includes(userId)) call.participants.push(userId);
    userCalls.set(userId, callId);

    socket.join(`call:${callId}`);

    // The caller creates the WebRTC offer once someone has answered.
    socket.to(`call:${callId}`).emit('call:answered', { callId, userId });

    // Everyone else who was ringing (other devices, other group members) can dismiss it.
    const others = call.chatType === 'DM' ? `user:${userId}` : `group:${call.roomId}`;
    socket.to(others).emit('call:handled', { callId, by: userId });

    await dismissCallNotification(call);
    console.log(`Call ${callId} answered by ${userId}`);
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
  // In a group, one member declining does not end the call for everyone else.
};

// WebRTC signalling is relayed to the other side of the call only, and only from
// sockets that actually joined the call room.
function relaySignal(socket: UserSocket, callId: string, event: string, payload: Record<string, unknown>) {
  const room = `call:${callId}`;
  if (!activeCalls.has(callId) || !socket.rooms.has(room)) return;
  socket.to(room).emit(event, { callId, ...payload });
}

export const handleWebRTCOffer = (socket: UserSocket, data: { callId: string; offer: unknown }) => {
  relaySignal(socket, data.callId, 'webrtc:offer', { offer: data.offer });
};

export const handleWebRTCAnswer = (socket: UserSocket, data: { callId: string; answer: unknown }) => {
  relaySignal(socket, data.callId, 'webrtc:answer', { answer: data.answer });
};

export const handleWebRTCCandidate = (socket: UserSocket, data: { callId: string; candidate: unknown }) => {
  relaySignal(socket, data.callId, 'webrtc:candidate', { candidate: data.candidate });
};

// Handle call end
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

    if (userId === call.calleeId) {
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
