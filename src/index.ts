import express from 'express';
import dotenv from 'dotenv';
import { botRouter } from './bot/webhook';
import { startUserbot } from './userbot/monitor';
import './queue/queues';
import './workers/aiEnrichWorker';   
import './workers/storeWorker';
import './workers/telegramNotifier'; 

dotenv.config();

const app = express();
app.use(express.json());

app.use('/', botRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[server] Running on port ${PORT}`);
  startUserbot().catch(console.error);
});