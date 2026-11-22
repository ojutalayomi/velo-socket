import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';

import { userIdFromBearer } from './socketAuth.js';

function bearer(header: string | undefined): string {
  return header?.startsWith('Bearer ') ? header.slice(7) : '';
}

/** Constant-time comparison of a presented secret with the configured one. */
export function secretMatches(presented: string, secret: string | undefined): boolean {
  if (!secret) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A trusted server (the web app, an operator's tooling) presenting SOCKET_BROADCAST_SECRET. */
export const isServiceRequest = (req: Pick<Request, 'headers'>) =>
  secretMatches(bearer(req.headers.authorization), process.env.SOCKET_BROADCAST_SECRET);

/** The signed-in user behind a request, from the token the web app issues. */
export const requestUserId = (req: Pick<Request, 'headers'>) => userIdFromBearer(req.headers.authorization);
