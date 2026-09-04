import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { initDatabase } from './server/db.js';
import { authRouter } from './server/routes/authRoutes.js';
import { mastersRouter } from './server/routes/mastersRoutes.js';
import { kraRouter } from './server/routes/kraRoutes.js';
import { reviewRouter } from './server/routes/reviewRoutes.js';
import { appraisalRouter } from './server/routes/appraisalRoutes.js';
import { essRouter } from './server/routes/essRoutes.js';
import { reportRouter } from './server/routes/reportRoutes.js';
import { bulkRouter } from './server/routes/bulkRoutes.js';
import { auditRouter } from './server/routes/auditRoutes.js';
import { aiAndFeedbackRouter } from './server/routes/aiAndFeedbackRoutes.js';

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Middleware
  app.use(cors());
  app.use(express.json());

  // Initialize Database (MongoDB / Document Collections Engine)
  await initDatabase();

  // Health check FIRST (unauthenticated)
  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'Employee Quarterly Review & Appraisal Management System',
      timestamp: new Date().toISOString(),
    });
  });

  // API Routes
  app.use('/api/auth', authRouter);
  app.use('/api', mastersRouter);
  app.use('/api', kraRouter);
  app.use('/api', reviewRouter);
  app.use('/api', appraisalRouter);
  app.use('/api', essRouter);
  app.use('/api', reportRouter);
  app.use('/api/bulk', bulkRouter);
  app.use('/api/audit', auditRouter);
  app.use('/api', aiAndFeedbackRouter);
  app.use('/api', authRouter); // Also maps /api/system/db-status

  // Vite Middleware for development vs Static dist for production
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Applet] Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[Applet] Fatal error starting server:', err);
});
