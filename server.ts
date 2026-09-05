import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import rateLimit from 'express-rate-limit';
import { initDatabase, getDatabaseStatus } from './server/db.js';
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
  const PORT = Number(process.env.PORT) || 3000;

  // Middleware
  app.use(cors());
  app.use(express.json());

  // Rate limiter: max 10 login attempts per IP per 15 minutes
  const loginRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: 'Too many login attempts from this IP. Please wait 15 minutes and try again.',
    },
    // Only count failed requests (skip successful logins from the limit)
    skipSuccessfulRequests: true,
  });
  // Apply rate limiter only to the login endpoint
  app.use('/api/auth/login', loginRateLimiter);

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

  // Dedicated system endpoint for db status
  app.get('/api/system/db-status', async (_req, res) => {
    try {
      const status = await getDatabaseStatus();
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to retrieve database status' });
    }
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

  // Serve compiled frontend assets if available
  const possibleDistPaths = [
    path.resolve(process.cwd(), '../frontend/dist'),
    path.resolve(process.cwd(), 'dist/public'),
    path.resolve(process.cwd(), 'dist'),
  ];
  const frontendDist = possibleDistPaths.find(
    (p) => fs.existsSync(path.join(p, 'index.html'))
  );

  if (frontendDist) {
    app.use(express.static(frontendDist));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(frontendDist, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Applet] Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[Applet] Fatal error starting server:', err);
});
