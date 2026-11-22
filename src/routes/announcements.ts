import { timingSafeEqual } from 'crypto';
import { Router } from 'express';
import type { RequestHandler } from 'express';
import { broadcastAnnouncement, broadcastRetirement } from '../socket/announcements.js';

const router = Router();

function secretMatches(header: string | undefined, secret: string): boolean {
  const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Called server-to-server by the web app after an admin changes an announcement.
 * POST /api/announcements/broadcast  { event: "publish" | "retire", id: string }
 * Authorization: Bearer <SOCKET_BROADCAST_SECRET>
 */
const broadcastHandler: RequestHandler = async (req, res) => {
  const secret = process.env.SOCKET_BROADCAST_SECRET;
  if (!secret) {
    // Fail closed: without a configured secret nobody may broadcast.
    res.status(503).json({ error: 'Broadcast endpoint not configured' });
    return;
  }
  if (!secretMatches(req.headers.authorization, secret)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { event, id } = req.body ?? {};
  if ((event !== 'publish' && event !== 'retire') || typeof id !== 'string') {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }

  try {
    const sent = event === 'publish' ? await broadcastAnnouncement(id) : await broadcastRetirement(id);
    // 200 either way: "nothing to broadcast" (e.g. already expired) is not a transport failure.
    res.status(200).json({ sent });
  } catch (error) {
    console.error('Announcement broadcast failed:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

router.post('/broadcast', broadcastHandler);

export default router;
