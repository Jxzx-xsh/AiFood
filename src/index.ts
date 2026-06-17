import express from 'express';
import cors from 'cors';
import { config } from './config';
import { authMiddleware } from './middleware/auth';
import { ingestRouter } from './routes/ingest';
import { inventoryRouter } from './routes/inventory';
import { recipeRouter } from './routes/recipe';
import { familyRouter } from './routes/family';
import { startExpiryChecker } from './jobs/expiry-checker';

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '15mb' })); // 支持大图片 Base64
app.use(authMiddleware);

// Routes
app.use('/api/v1/ingest', ingestRouter);
app.use('/api/v1/inventory', inventoryRouter);
app.use('/api/v1/recipes', recipeRouter);
app.use('/api/v1/families', familyRouter);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(config.server.port, () => {
  console.log(`🍎 AI Food server running on port ${config.server.port}`);
  console.log(`   Environment: ${config.server.nodeEnv}`);
  console.log(`   LMStudio: ${config.lmstudio.host}`);
});

// Start background jobs
startExpiryChecker();

export default app;
