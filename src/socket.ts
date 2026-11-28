import { ObjectId } from 'mongodb';
import { Server, Socket } from 'socket.io';
import { corsOptions } from './server.js';
import { server } from './server.js';
import { getMongoDb } from './mongodb.js';
import { socketAuthEnforced, verifySocketToken } from './lib/socketAuth.js';


export const io = new Server(server, {
  maxHttpBufferSize: 6e7,
  path: '/wxyrt',
  pingTimeout: 60000,
  cors: corsOptions,
  cookie: true,
  perMessageDeflate: {
    threshold: 1024, // Compress messages larger than 1 KB
  }
});

export type UserSocket = Socket & { userId?: string; };

io.use(async (socket: UserSocket, next) => {
  const token = socket.handshake.query.userId;
  if (!token) {
    return next(new Error('Authentication error'));
  }
  // The query's userId is only a claim. A signed token from the web app proves it; once clients
  // send one, SOCKET_AUTH_ENFORCE=true makes it mandatory.
  const proof = socket.handshake.auth?.token;
  if (proof) {
    if (verifySocketToken(proof, process.env.SOCKET_AUTH_SECRET) !== token.toString()) {
      return next(new Error('Authentication error'));
    }
  } else if (socketAuthEnforced()) {
    return next(new Error('Authentication error'));
  }
  try {
    const db = await getMongoDb();
    const user = await db.collection('Users').findOne({ _id: new ObjectId(token.toString()) });
    if (user?._id && user.suspended === true) {
      // Told apart from a bad login so the app can show why, instead of retrying forever.
      const suspended = new Error('Account suspended');
      (suspended as Error & { data?: unknown }).data = { code: 'suspended' };
      next(suspended);
    } else if (user?._id) {
      next();
    } else {
      next(new Error('Authentication error'));
    }
  } catch (error) {
    next(new Error('Authentication error'));
  }
});
// Set max listeners to avoid memory leak warnings
io.setMaxListeners(20);
