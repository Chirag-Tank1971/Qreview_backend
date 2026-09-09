import { Router, Response } from 'express';
import { AuthenticatedRequest, authenticateToken, requireRoles } from '../auth.js';
import { sendNotificationEmail, getRecentEmailLogs } from '../services/emailService.js';
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
