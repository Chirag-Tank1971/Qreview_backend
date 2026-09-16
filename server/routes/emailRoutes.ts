import { Router, Response } from 'express';
import { AuthenticatedRequest, authenticateToken, requireRoles } from '../auth.js';
import { sendNotificationEmail, getRecentEmailLogs, getTransporter } from '../services/emailService.js';
import { renderTestEmail } from '../services/emailTemplates.js';

export const emailRouter = Router();

// Protect all email administrative endpoints
emailRouter.use(authenticateToken);
emailRouter.use(requireRoles('SUPER_ADMIN', 'HR', 'MANAGEMENT'));

/**
 * GET /api/emails/logs
 * Retrieve recent email transmission logs and statuses
 */
emailRouter.get('/logs', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const limit = req.query.limit ? Math.min(Number(req.query.limit), 100) : 50;
    const logs = await getRecentEmailLogs(limit);
    res.json({ logs });
  } catch (error: any) {
    console.error('Failed to fetch email logs:', error);
    res.status(500).json({ error: 'Failed to retrieve email logs.' });
  }
});

/**
 * GET /api/emails/health
 * Verify SMTP transporter connectivity without sending an email.
 * Returns config summary (no credentials) and live verify result.
 */
emailRouter.get('/health', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const host = process.env.SMTP_HOST;
    const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const from = process.env.SMTP_FROM;
    const nodeEnv = process.env.NODE_ENV || 'development';

    const configPresent = {
      SMTP_HOST: Boolean(host),
      SMTP_PORT: Boolean(process.env.SMTP_PORT),
      SMTP_USER: Boolean(user),
      SMTP_PASS: Boolean(pass),
      SMTP_FROM: Boolean(from),
      SMTP_SECURE: process.env.SMTP_SECURE || '(not set)',
      NODE_ENV: nodeEnv,
      configured_host: host ? `${host}:${port}` : '(none)',
    };

    if (!host || !user || !pass) {
      return res.status(200).json({
        status: 'UNCONFIGURED',
        message: 'SMTP credentials are missing. Email will fall back to Ethereal/mock transport.',
        config: configPresent,
      });
    }

    // Live connection check
    try {
      const mailer = await getTransporter();
      await (mailer as any).verify();
      return res.json({
        status: 'HEALTHY',
        message: `SMTP connection verified successfully: ${host}:${port}`,
        config: configPresent,
      });
    } catch (verifyErr: any) {
      return res.status(200).json({
        status: 'UNHEALTHY',
        message: `SMTP connection verification failed: ${verifyErr.message}`,
        config: configPresent,
        hint: 'Check firewall rules, app password validity, and that SMTP_SECURE matches the port (465=true, 587=false).',
      });
    }
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to check email health.', detail: error.message });
  }
});

/**
 * POST /api/emails/test
 * Send a test email to verify SMTP transporter delivery
 */
emailRouter.post('/test', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const targetEmail = req.body.email || req.user?.email || 'admin@example.com';
    const targetName = req.body.name || req.user?.name || 'Administrator';

    const { subject, html } = renderTestEmail({
      recipientName: targetName,
      timestamp: new Date().toLocaleString(),
    });

    const result = await sendNotificationEmail({
      recipientId: req.user?.id || 'usr_test',
      recipientEmail: targetEmail,
      recipientName: targetName,
      subject,
      html,
      templateType: 'SYSTEM_TEST',
      metadata: { initiatedBy: req.user?.id, role: req.user?.role },
    });

    res.json({
      message: result.status === 'SENT' ? 'Test email dispatched successfully.' : 'Test email dispatch failed or was skipped.',
      log: result,
    });
  } catch (error: any) {
    console.error('Failed to send test email:', error);
    res.status(500).json({ error: 'Internal server error while sending test email.' });
  }
});
