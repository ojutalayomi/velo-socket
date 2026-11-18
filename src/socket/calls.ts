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

async function loadDisplayName(userId: string): Promise<string> {
  if (!ObjectId.isValid(userId)) return 'Someone';

  try {
    const db = await new MongoDBClient().init();
    const user = await db.users().findOne(
      { _id: new ObjectId(userId) },
      { projection: { firstname: 1, lastname: 1, username: 1 } }
    );
    if (!user) return 'Someone';
    return (
      [user.firstname, user.lastname].filter(Boolean).join(' ').trim() ||
      user.username ||
      'Someone'
    );
  } catch (error) {
    console.error('Error loading call display name:', error);
    return 'Someone';
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

  io.to(`call:${callId}`).emit('call:ended', { callId, reason: 'timeout' });
  io.to(`user:${call.callerId}`).emit('call:ended', { callId, reason: 'timeout' });
  deleteCall(call);
  console.log(`Call ${callId} timed out`);
}

// Store active calls and their participants
const activeCalls = new Map<string, ActiveCall>();

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

  const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const call: ActiveCall = {
    callId,
    roomId,
    callerId,
    callerName: await loadDisplayName(callerId),
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

  console.log(`Call invitation: ${callerId} -> ${roomId} (${callType}, ${chatType})`);

  if (chatType === 'Group') {
    // Group calls are signal-only: no push, no ring timeout, no missed-call push.
    io.to(`group:${roomId}`).emit('call:invite', {
      callId,
      roomId,
      callerId,
      callType,
      chatType,
    });
  } else {
    io.to(`user:${targetUserId}`).emit('call:invite', {
      callId,
      roomId,
      callerId,
      callType,
      chatType,
    });

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
  socket.emit('call:initiated', { callId, roomId });
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
  if (call.chatType === 'DM' && userId !== call.calleeId) return;

  if (accepted) {
    clearRingTimer(call);
    call.status = 'connected';
    if (!call.participants.includes(userId)) call.participants.push(userId);

    // Join the receiver to the call room for WebRTC signaling
    socket.join(`call:${callId}`);

    // Dismiss the ringing notification on the callee's other devices
    await dismissCallNotification(call);

    // Notify caller that call was answered
    io.to(`user:${call.callerId}`).emit('call:answered', { callId });

    // Notify all participants in the call room
    io.to(`call:${callId}`).emit('call:connected', {
      callId,
      participants: call.participants,
    });

    // Also notify the caller directly to ensure they receive the connected event
    io.to(`user:${call.callerId}`).emit('call:connected', {
      callId,
      participants: call.participants,
    });

    console.log(`Call ${callId} connected with participants:`, call.participants);
  } else {
    clearRingTimer(call);
    call.status = 'declined';
    call.endTime = Date.now();

    // Notify caller that call was declined
    io.to(`user:${call.callerId}`).emit('call:declined', { callId });

    await dismissCallNotification(call);
    activeCalls.delete(callId);
    console.log(`Call ${callId} declined`);
  }
};

// Handle WebRTC signaling
export const handleWebRTCOffer = (socket: UserSocket, data: {
  callId: string;
  offer: any;
}) => {
  const { callId, offer } = data;
  io.to(`call:${callId}`).emit('webrtc:offer', { callId, offer });
};

export const handleWebRTCAnswer = (socket: UserSocket, data: {
  callId: string;
  answer: any;
}) => {
  const { callId, answer } = data;
  io.to(`call:${callId}`).emit('webrtc:answer', { callId, answer });
};

export const handleWebRTCCandidate = (socket: UserSocket, data: {
  callId: string;
  candidate: any;
}) => {
  const { callId, candidate } = data;
  io.to(`call:${callId}`).emit('webrtc:candidate', { callId, candidate });
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

  io.to(`call:${callId}`).emit('call:ended', { callId });
  io.to(`user:${call.callerId}`).emit('call:ended', { callId });
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
