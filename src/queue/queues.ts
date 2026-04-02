import { Queue } from 'bullmq';
import IORedis from 'ioredis';

// ── Redis Connection ─────────────────────────────────────────
export const redisConnection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null, // required by BullMQ
});

redisConnection.on('connect', () => console.log('[redis] ✅ Connected'));
redisConnection.on('error', (err) => console.error('[redis] ❌ Error:', err));

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: true,
  removeOnFail: false,
};

// ── Queues ───────────────────────────────────────────────────
export const ingestQueue = new Queue('ingest_message', {
  connection: redisConnection,
  defaultJobOptions,
});

export const processQueue = new Queue('process_content', {
  connection: redisConnection,
  defaultJobOptions,
});

// Published posts → stored to DB + Telegram notification sent
export const storeQueue = new Queue('store_post', {
  connection: redisConnection,
  defaultJobOptions,
});

// Draft posts → stored to DB only, no Telegram notification
export const draftQueue = new Queue('draft_post', {
  connection: redisConnection,
  defaultJobOptions,
});

console.log('[queue] ✅ Queues initialized');