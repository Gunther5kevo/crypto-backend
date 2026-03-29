import { Queue } from 'bullmq';
import IORedis from 'ioredis';

// ── Redis Connection ─────────────────────────────────────────
export const redisConnection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null, // required by BullMQ
});

redisConnection.on('connect', () => console.log('[redis] ✅ Connected'));
redisConnection.on('error', (err) => console.error('[redis] ❌ Error:', err));

// ── Queues ───────────────────────────────────────────────────
export const ingestQueue = new Queue('ingest_message', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,                  // retry failed jobs 3 times
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: true,       // clean up completed jobs
    removeOnFail: false,          // keep failed jobs for debugging
  },
});

export const processQueue = new Queue('process_content', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

export const storeQueue = new Queue('store_post', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: true,
    removeOnFail: false,
  },
});

console.log('[queue] ✅ Queues initialized');