import Redis from 'ioredis';

const host = process.env.REDIS_HOST?.trim();
const port = Number(process.env.REDIS_PORT) || 6379;
const password = process.env.REDIS_PASSWORD;

if (!host) {
  throw new Error(
    'REDIS_HOST is required.'
  )
}

if (!port) {
  throw new Error(
    'REDIS_PORT is required.'
  )
}

if (!password) {
  throw new Error(
    'REDIS_PASSWORD is required.'
  )
}
export const redis = new Redis({
  host,
  password,
  port,
  connectTimeout: 10_000,
  maxRetriesPerRequest: 1,
  tls: {
    servername: host,
  },
  retryStrategy: (attempt) => Math.min(attempt * 1_000, 10_000),
});

redis.on('error', (error) => {
  console.error(`[Redis] Connection error: ${error.message}`);
});


