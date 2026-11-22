import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Tokens are issued by the web app (GET /api/socket-token) after it has checked the user's
 * session: an HS256 JWT whose subject is the user id, signed with SOCKET_AUTH_SECRET.
 */
const AUDIENCE = 'velo-socket';

const decode = (part: string) => Buffer.from(part, 'base64url');

/** The user id a valid, unexpired token was issued for; null for anything else. */
export function verifySocketToken(token: unknown, secret: string | undefined, now = Date.now()): string | null {
  if (typeof token !== 'string' || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;

  try {
    if (JSON.parse(decode(header).toString()).alg !== 'HS256') return null;

    const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest();
    const given = decode(signature);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

    const claims = JSON.parse(decode(payload).toString()) as { sub?: unknown; aud?: unknown; exp?: unknown };
    if (typeof claims.sub !== 'string' || !claims.sub) return null;
    if (claims.aud !== AUDIENCE) return null;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return null;
    return claims.sub;
  } catch {
    return null;
  }
}

/** Whether the socket server refuses connections that carry no token. Off until clients send one. */
export const socketAuthEnforced = () => process.env.SOCKET_AUTH_ENFORCE === 'true';

/** The user id from an `Authorization: Bearer <token>` header. */
export function userIdFromBearer(header: string | undefined): string | null {
  const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
  return verifySocketToken(token, process.env.SOCKET_AUTH_SECRET);
}
