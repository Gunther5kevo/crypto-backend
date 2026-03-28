import dotenv from 'dotenv';
dotenv.config();

import { insertPost } from './insertPost';

async function test() {
  await insertPost({
    title: 'Test Post from Backend',
    slug: 'test-post-from-backend',
    content: 'This is a test to confirm Supabase connection works.',
    excerpt: 'This is a test to confirm Supabase connection works.',
    author: 'system',
    tags: ['test'],
    category: 'news',
    meta_title: 'Test Post from Backend',
    meta_description: 'Confirming the backend pipeline writes to Supabase correctly.',
    focus_keyword: 'test',
  });
}

test().catch(console.error);