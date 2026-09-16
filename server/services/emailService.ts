import { getDbCollection } from '../db.js';
import { EmailLog } from '../../src/types/index.js';

export interface SendEmailOptions {
  recipientId: string;
  recipientEmail: string;
  recipientName?: string;
  subject: string;
  html: string;
  templateType: EmailLog['templateType'];
  metadata?: Record<string, any>;
}

/**
 * Check connectivity and API key validity against Resend HTTPS API.
 */
export async function verifyEmailConfig(): Promise<{
  ok: boolean;
  status: 'CONFIGURED' | 'UNCONFIGURED' | 'INVALID_KEY' | 'ERROR';
  message: string;
  from: string;
}> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM || 'Appraisal System <onboarding@resend.dev>';

  if (!apiKey) {
    return {
      ok: false,
      status: 'UNCONFIGURED',
      message: 'RESEND_API_KEY is not configured in environment variables.',
      from,
    };
  }

  try {
    // Resend /api-keys endpoint checks if the API key is authentic without sending an email
    const res = await fetch('https://api.resend.com/api-keys', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (res.ok) {
      return {
        ok: true,
        status: 'CONFIGURED',
        message: 'Resend HTTPS API connection verified successfully.',
        from,
      };
    }

    const err = (await res.json().catch(() => ({}))) as any;
    return {
      ok: false,
      status: 'INVALID_KEY',
      message: `Resend authentication failed (${res.status}): ${err.message || res.statusText}`,
      from,
    };
  } catch (error: any) {
    return {
      ok: false,
      status: 'ERROR',
      message: `Failed to connect to Resend API: ${error.message}`,
      from,
    };
  }
}

/**
 * Send an email notification via Resend HTTPS REST API (port 443).
 * Records every dispatch (SENT / FAILED / SKIPPED) to the emailLogs database.
 * Never throws unhandled errors to protect callers.
 */
export async function sendNotificationEmail(options: SendEmailOptions): Promise<EmailLog> {
  const { recipientId, recipientEmail, recipientName, subject, html, templateType, metadata } = options;
  const logId = `eml_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const now = new Date().toISOString();

  // Validate recipient email
  if (!recipientEmail || !recipientEmail.includes('@')) {
    const skippedLog: EmailLog = {
      id: logId,
      recipientId,
      recipientEmail: recipientEmail || 'unknown@invalid',
      recipientName: recipientName || 'Unknown',
      subject,
      templateType,
      status: 'SKIPPED',
      errorMessage: 'Invalid or missing recipient email address',
      metadata,
      createdAt: now,
    };
    await recordEmailLog(skippedLog);
    return skippedLog;
  }

  const apiKey = process.env.RESEND_API_KEY?.trim();
  const fromAddress = process.env.RESEND_FROM || 'Appraisal System <onboarding@resend.dev>';

  // If no API key is provided, log mock and return SKIPPED so dev environments run safely
  if (!apiKey) {
    console.warn(`[EmailService] ⚠️ RESEND_API_KEY not configured. Email to ${recipientEmail} simulated: "${subject}"`);
    const mockLog: EmailLog = {
      id: logId,
      recipientId,
      recipientEmail,
      recipientName: recipientName || 'Unknown',
      subject,
      templateType,
      status: 'SKIPPED',
      errorMessage: 'RESEND_API_KEY not configured. Simulated dispatch.',
      metadata,
      createdAt: now,
    };
    await recordEmailLog(mockLog);
    return mockLog;
  }

  try {
    const formattedTo = recipientName ? `"${recipientName}" <${recipientEmail}>` : recipientEmail;

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddress,
        to: [formattedTo],
        subject,
        html,
      }),
    });

    const data = (await response.json().catch(() => ({}))) as any;

    if (!response.ok) {
      const errMsg = data.message || `Resend error (${response.status}): ${response.statusText}`;
      console.error(`[EmailService] ❌ Failed to send email to ${recipientEmail}:`, errMsg);

      const failedLog: EmailLog = {
        id: logId,
        recipientId,
        recipientEmail,
        recipientName: recipientName || 'Unknown',
        subject,
        templateType,
        status: 'FAILED',
        errorMessage: errMsg,
        metadata,
        createdAt: now,
      };
      await recordEmailLog(failedLog);
      return failedLog;
    }

    console.log(`[EmailService] ✅ Sent email to ${recipientEmail} via Resend HTTPS (ID: ${data.id})`);

    const sentLog: EmailLog = {
      id: logId,
      recipientId,
      recipientEmail,
      recipientName: recipientName || 'Unknown',
      subject,
      templateType,
      status: 'SENT',
      messageId: data.id,
      metadata,
      createdAt: now,
    };

    await recordEmailLog(sentLog);
    return sentLog;
  } catch (error: any) {
    console.error(`[EmailService] ❌ Exception dispatching email to ${recipientEmail}:`, error.message);

    const errorLog: EmailLog = {
      id: logId,
      recipientId,
      recipientEmail,
      recipientName: recipientName || 'Unknown',
      subject,
      templateType,
      status: 'FAILED',
      errorMessage: error.message || 'Unknown network error',
      metadata,
      createdAt: now,
    };

    await recordEmailLog(errorLog);
    return errorLog;
  }
}

/**
 * Persist email log into database
 */
async function recordEmailLog(log: EmailLog): Promise<void> {
  try {
    const emailLogsCol = getDbCollection('emailLogs');
    await emailLogsCol.insertOne(log);
  } catch (err: any) {
    console.error('[EmailService] Failed to record email log to database:', err.message);
  }
}

/**
 * Helper to resolve email and name from either a userId or an employeeId
 */
export async function resolveRecipient(id: string): Promise<{ email: string; name: string } | null> {
  try {
    const usersCol = getDbCollection('users');
    const user = await usersCol.findOne({ $or: [{ id }, { employeeId: id }] });
    if (user && user.email) {
      return { email: user.email, name: user.name || 'User' };
    }
    const empCol = getDbCollection('employees');
    const emp = await empCol.findOne({ id });
    if (emp && emp.email) {
      return { email: emp.email, name: emp.name || 'Employee' };
    }
  } catch (err) {
    console.warn(`[EmailService] Failed to resolve recipient for ID "${id}":`, err);
  }
  return null;
}

/**
 * Retrieve recent email logs from database
 */
export async function getRecentEmailLogs(limit: number = 50): Promise<EmailLog[]> {
  try {
    const emailLogsCol = getDbCollection('emailLogs');
    const logs: EmailLog[] = await (await emailLogsCol.find({})).toArray();
    return logs.sort((a, b) => new Date(b.createdAt || '').getTime() - new Date(a.createdAt || '').getTime()).slice(0, limit);
  } catch (err) {
    console.error('[EmailService] Failed to retrieve email logs:', err);
    return [];
  }
}
