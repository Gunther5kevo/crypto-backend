import { Worker, Job } from 'bullmq';
import { redisConnection } from '../queue/queues';
import { Post } from '../supabase/client';
import { insertPost } from '../supabase/insertPost';

export const storeWorker = new Worker(
  'store_post',
  async (job: Job) => {
    const post: Post = job.data;
    console.log(`[storeWorker] 💾 Saving: "${post.title}"`);
    await insertPost(post);
  },
  { connection: redisConnection }
);

storeWorker.on('completed', job => {
  console.log(`[storeWorker] ✅ Job ${job.id} saved to Supabase`);
});

storeWorker.on('failed', (job, err) => {
  console.error(`[storeWorker] ❌ Job ${job?.id} failed:`, err.message);
});