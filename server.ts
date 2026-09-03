import express from 'express';
import cors from 'cors';
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
  const PORT = process.env.PORT || 3000;

  // Middleware
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Initialize Database (MongoDB / Document Collections Engine)
  await initDatabase();

  // Root endpoint
  app.get('/', (_req, res) => {
    res.json({
      message: 'Employee Quarterly Review & Appraisal Management System API is running!',
      timestamp: new Date().toISOString(),
    });
  });

  // Health check FIRST (unauthenticated)
  app.get('/api/health', (_req, res) => {
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

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Backend API running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[Applet] Fatal error starting server:', err);
});