import { Router } from 'express';
import type { RequestHandler } from 'express';
import { getCallInfo, getUserActiveCalls, getAllActiveCalls } from '../socket/calls.js';

const router = Router();

// Get call information by call ID
const getCallInfoHandler: RequestHandler<{ callId: string }> = (req, res) => {
  const { callId } = req.params;
  const callInfo = getCallInfo(callId);
  
  if (!callInfo) {
    res.status(404).json({ error: 'Call not found' });
    return;
  }
  
  res.json(callInfo);
};

router.get('/:callId', getCallInfoHandler);

// Get active calls for a specific user
const getUserActiveCallsHandler: RequestHandler<{ userId: string }> = (req, res) => {
  const { userId } = req.params;
  const activeCalls = getUserActiveCalls(userId);
  
  res.json({ userId, activeCalls });
};

router.get('/user/:userId/active', getUserActiveCallsHandler);

const DEFAULT_ADMIN_PAGE = 50;
const ADMIN_MAX_LIMIT = 200;

// Get all active calls (admin endpoint)
const getAllActiveCallsHandler: RequestHandler = (req, res) => {
  const activeCalls = getAllActiveCalls();

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

router.get('/admin/active', getAllActiveCallsHandler);

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

router.get('/stats/overview', getStatsOverviewHandler);

export default router;
