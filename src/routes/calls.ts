import { Router } from 'express';
import type { RequestHandler } from 'express';
import { getCallInfo, getUserActiveCalls, getAllActiveCalls } from '../socket/calls.js';
import { isServiceRequest, requestUserId } from '../lib/serviceAuth.js';

const router = Router();

/** What a caller may see of a call: no timers or bookkeeping flags. */
const publicCall = (call: NonNullable<ReturnType<typeof getCallInfo>>) => ({
  callId: call.callId,
  roomId: call.roomId,
  callerId: call.callerId,
  calleeId: call.calleeId,
  participants: call.participants,
  callType: call.callType,
  chatType: call.chatType,
  status: call.status,
  startTime: call.startTime,
  connectedAt: call.connectedAt,
  endTime: call.endTime,
});

// Everything here reveals who is talking to whom, so nothing is public. A signed-in user sees
// only their own calls; the monitoring routes are for trusted servers (SOCKET_BROADCAST_SECRET).
const requireService: RequestHandler = (req, res, next) => {
  if (isServiceRequest(req)) return next();
  res.status(401).json({ error: 'Unauthorized' });
};

// Get call information by call ID
const getCallInfoHandler: RequestHandler<{ callId: string }> = (req, res) => {
  const service = isServiceRequest(req);
  const userId = service ? null : requestUserId(req);
  if (!service && !userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const callInfo = getCallInfo(req.params.callId);
  // Someone who is not in the call is told the same as for a call that does not exist.
  const involved =
    service || (userId && (callInfo?.participants.includes(userId) || callInfo?.callerId === userId || callInfo?.calleeId === userId));
  if (!callInfo || !involved) {
    res.status(404).json({ error: 'Call not found' });
    return;
  }

  res.json(publicCall(callInfo));
};

router.get('/:callId', getCallInfoHandler);

// Get active calls for a specific user
const getUserActiveCallsHandler: RequestHandler<{ userId: string }> = (req, res) => {
  const { userId } = req.params;
  if (!isServiceRequest(req) && requestUserId(req) !== userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  res.json({ userId, activeCalls: getUserActiveCalls(userId).map(publicCall) });
};

router.get('/user/:userId/active', getUserActiveCallsHandler);

const DEFAULT_ADMIN_PAGE = 50;
const ADMIN_MAX_LIMIT = 200;

// Get all active calls (admin endpoint)
const getAllActiveCallsHandler: RequestHandler = (req, res) => {
  const activeCalls = getAllActiveCalls().map(publicCall);

  let limit = DEFAULT_ADMIN_PAGE;
  const limitParam = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN;
  if (!Number.isNaN(limitParam) && limitParam > 0) limit = Math.min(limitParam, ADMIN_MAX_LIMIT);

  let skip = 0;
  const skipParam = typeof req.query.skip === 'string' ? parseInt(req.query.skip, 10) : NaN;
  if (!Number.isNaN(skipParam) && skipParam >= 0) skip = skipParam;

  const slice = activeCalls.slice(skip, skip + limit + 1);
  const hasMore = slice.length > limit;
  const data = slice.slice(0, limit);

  res.json({
    data,
    pagination: {
      skip,
      limit,
      hasMore,
    },
    count: activeCalls.length,
    activeCalls: data,
  });
};

router.get('/admin/active', requireService, getAllActiveCallsHandler);

// Get call statistics
const getStatsOverviewHandler: RequestHandler = (_req, res) => {
  const activeCalls = getAllActiveCalls();
  
  const stats = {
    totalActive: activeCalls.length,
    audioCalls: activeCalls.filter(call => call.callType === 'audio').length,
    videoCalls: activeCalls.filter(call => call.callType === 'video').length,
    ringing: activeCalls.filter(call => call.status === 'ringing').length,
    connected: activeCalls.filter(call => call.status === 'connected').length
  };
  
  res.json(stats);
};

router.get('/stats/overview', requireService, getStatsOverviewHandler);

export default router;
