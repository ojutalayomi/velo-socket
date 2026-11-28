import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL?.trim();
const host = process.env.REDIS_HOST?.trim();

if (!redisUrl) {
  throw new Error(
    'REDIS_URL is required. Set it to the complete Redis connection string, including the password and TLS scheme when required.'
  );
}

export const redis = new Redis(redisUrl, {
  tls: {
    servername: host,
  },
  connectTimeout: 10_000,
  maxRetriesPerRequest: 1,
  retryStrategy: (attempt) => Math.min(attempt * 1_000, 10_000),
});

redis.on('error', (error) => {
  console.error(`[Redis] Connection error: ${error.message}`);
});


