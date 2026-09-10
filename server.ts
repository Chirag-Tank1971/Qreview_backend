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
import { emailRouter } from './server/routes/emailRoutes.js';

// In production, silence non-critical development logs (console.log, console.info, console.warn)
// to optimize performance and protect data privacy. Errors (console.error) remain fully active.
// In development, all logs display normally. Override via ENABLE_PROD_LOGS=true if debugging in production.
const isProd = process.env.NODE_ENV === 'production' && process.env.ENABLE_PROD_LOGS !== 'true';
const bootLog = console.log;

if (isProd) {
  const noop = () => {};
  console.log = noop;
  console.info = noop;
  console.warn = noop;
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // Middleware
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim())
    : ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173', 'http://127.0.0.1:3000'];

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (
          process.env.NODE_ENV !== 'production' ||
          allowedOrigins.includes(origin) ||
          allowedOrigins.includes('*')
        ) {
          return callback(null, true);
        }
        return callback(new Error(`CORS policy does not allow access from origin: ${origin}`));
      },
      credentials: true,
    })
  );

  // Essential HTTP security headers
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
  });

  // Trust reverse proxy headers (e.g. X-Forwarded-For) in production environments (Render, Cloudflare, AWS, Nginx)
  app.set('trust proxy', 1);

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Structured HTTP Request/Response logger (active only in development or when ENABLE_PROD_LOGS=true)
  if (!isProd) {
    app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const duration = Date.now() - start;
        const status = res.statusCode;
        const logLevel = status >= 500 ? 'ERROR' : status >= 400 ? 'WARN' : 'INFO';
        const logMsg = `[HTTP] ${req.method} ${req.originalUrl} ${status} - ${duration}ms`;
        if (logLevel === 'ERROR') {
          console.error(logMsg);
        } else if (logLevel === 'WARN') {
          console.warn(logMsg);
        } else {
          console.log(logMsg);
        }
      });
      next();
    });
  }

  // Error middleware for malformed JSON payloads
  app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err instanceof SyntaxError && 'body' in err) {
      return res.status(400).json({ error: 'Malformed JSON payload provided.' });
    }
    next(err);
  });

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
  app.use('/api/emails', emailRouter);

  // Always return standard JSON 404 for any unmatched /api routes
  app.all('/api/*', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

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

  // Global unhandled error handler ensures JSON error response rather than HTML stack trace
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[Unhandled Server Error]', err);
    res.status(500).json({ error: 'An unexpected server error occurred.' });
  });

  app.listen(PORT, '0.0.0.0', () => {
    bootLog(`[Applet] Server running on http://0.0.0.0:${PORT} [mode: ${process.env.NODE_ENV || 'development'}]`);
  });
}

startServer().catch((err) => {
  console.error('[Applet] Fatal error starting server:', err);
});
