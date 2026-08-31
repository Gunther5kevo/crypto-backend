import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { botRouter } from './bot/webhook';
import { newsletterRouter } from './routes/newsletter';
import { startUserbot } from './userbot/monitor';
import './queue/queues';
import './workers/aiEnrichWorker';
import './workers/storeWorker';
import './workers/telegramNotifier';
import './workers/weeklyDigestWorker';

dotenv.config();

const app = express();
app.use(express.json());

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Allow both prod frontend and local dev simultaneously

const allowedOrigins = [
  (process.env.FRONTEND_URL ?? 'http://localhost:8080').replace(/\/$/, ''),
  'http://localhost:8080',
  'http://localhost:5173',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin ${origin} not allowed`));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization','ngrok-skip-browser-warning'],
  credentials: true,
}));

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/', botRouter);
app.use('/api/newsletter', newsletterRouter);



app.get('/api/posts/published', async (_req, res) => {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
  );

  const { data, error } = await supabase
    .from('posts')
    .select('id, slug, title, excerpt, category, created_at')
    .eq('is_published', true)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[posts/published] Supabase error:', error);
    return res.status(500).json({ error: 'Failed to fetch published posts.' });
  }

  return res.json(data ?? []);
});

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[server] Running on port ${PORT}`);
  startUserbot().catch(console.error);
});