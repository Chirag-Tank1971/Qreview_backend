import { Router, Response } from 'express';
import { AuthenticatedRequest, authenticateToken, requireRoles } from '../auth.js';
import { sendNotificationEmail, getRecentEmailLogs, verifyEmailConfig } from '../services/emailService.js';
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
 * Verify Resend API Key validity and HTTPS connectivity over port 443.
 */
emailRouter.get('/health', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await verifyEmailConfig();
    const configPresent = {
      RESEND_API_KEY: Boolean(process.env.RESEND_API_KEY),
      RESEND_FROM: result.from,
      NODE_ENV: process.env.NODE_ENV || 'development',
      provider: 'Resend (HTTPS / Port 443)',
    };

    if (!result.ok) {
      return res.status(200).json({
        status: result.status === 'UNCONFIGURED' ? 'UNCONFIGURED' : 'UNHEALTHY',
        message: result.message,
        config: configPresent,
        hint: 'Add RESEND_API_KEY to your environment variables in Render Dashboard or .env file.',
      });
    }

    return res.json({
      status: 'HEALTHY',
      message: result.message,
      config: configPresent,
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to check email health.', detail: error.message });
  }
});

/**
 * POST /api/emails/test
 * Send a test email using Resend HTTPS API to verify end-to-end delivery
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
      message: result.status === 'SENT' ? 'Test email dispatched successfully via Resend.' : 'Test email dispatch failed or was skipped.',
      log: result,
    });
  } catch (error: any) {
    console.error('Failed to send test email:', error);
    res.status(500).json({ error: 'Internal server error while sending test email.' });
  }
});
