import { config } from 'dotenv';
config()
import express from 'express';
import http from 'http';
import { join } from 'path';


export const app = express();

const formatDuration = (durationNs: bigint) => {
  if (durationNs < 1_000n) {
    return `${Number(durationNs)}ns`;
  }

  const durationMs = Number(durationNs) / 1_000_000;
  if (durationMs < 1000) {
    return `${durationMs.toFixed(3)}ms`;
  }

  return `${(durationMs / 1000).toFixed(3)}s`;
};

const formatGinTimestamp = (date: Date) => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');

  return `${year}/${month}/${day} - ${hours}:${minutes}:${seconds}`;
};

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const duration = formatDuration(process.hrtime.bigint() - start);
    const forwardedFor = req.headers['x-forwarded-for'];
    const clientIp = Array.isArray(forwardedFor)
      ? forwardedFor[0]
      : (forwardedFor?.split(',')[0]?.trim() || req.ip || req.socket.remoteAddress || '-');
    const timestamp = formatGinTimestamp(new Date());
    const method = req.method.padEnd(7);
    const path = req.originalUrl || req.url;

    console.log(`[EXPRESS] ${timestamp} | ${res.statusCode} | ${duration.padStart(12)} | ${clientIp.padStart(15)} | ${method} "${path}"`);
  });

  next();
});

app.use(express.static(join('public')));

export const server = http.createServer(app);
const whitelist = [process.env.ALLOWED_URL, process.env.ALLOWED_URL_1, process.env.ALLOWED_URL_2];

export const corsOptions = {
  origin: function (origin: any, callback: (arg0: Error | null, arg1: boolean | undefined) => void) {
    console.log('Request Origin:', origin);
    if (whitelist.indexOf(origin || '') !== -1 || !origin) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'), false);
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true,
};
