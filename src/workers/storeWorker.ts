import { Worker, Job } from 'bullmq';
import { redisConnection, notifyQueue } from '../queue/queues';
import { Post } from '../supabase/client';
import { insertPost } from '../supabase/insertPost';

// ─────────────────────────────────────────────────────────────
// STORE WORKER
//
// FIX: After inserting the post, we capture the resolved slug
// returned by insertPost (which may have a uniqueness suffix
// appended on a 23505 conflict), patch the post with it, then
// enqueue a notify_post job with the corrected slug.
//
// Previously both storeWorker and telegramNotifier consumed the
// same store_post queue. The notifier raced the store worker
// and built its Telegram URL from the original post.slug —
// which didn't match the suffixed slug saved in the DB,
// causing 404s for any post that hit a slug collision.
// ─────────────────────────────────────────────────────────────
export const storeWorker = new Worker(
  'store_post',
  async (job: Job) => {
    const post: Post = job.data;
    console.log(`[storeWorker] 💾 Saving: "${post.title}"`);

    
    const resolvedSlug = await insertPost(post);

    
    if (post.is_published) {
      const savedPost: Post = { ...post, slug: resolvedSlug };
      await notifyQueue.add('notify_post', savedPost);
      console.log(`[storeWorker] 📤 → notify queue: ${resolvedSlug}`);
    }
  },
  { connection: redisConnection },
);

storeWorker.on('completed', job => {
  console.log(`[storeWorker] ✅ Job ${job.id} saved to Supabase`);
});

storeWorker.on('failed', (job, err) => {
  console.error(`[storeWorker] ❌ Job ${job?.id} failed:`, err.message);
});