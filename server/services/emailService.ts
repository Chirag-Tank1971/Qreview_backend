import nodemailer, { Transporter } from 'nodemailer';
import { getDbCollection } from '../db.js';
import { EmailLog } from '../../src/types.js';

let transporter: Transporter | null = null;
let isEthereal = false;

/**
 * Lazily initialize and return the Nodemailer transporter.
 * If SMTP credentials exist in process.env, connects to real SMTP server.
 * Otherwise, creates an Ethereal virtual test account for development.
 */
export async function getTransporter(): Promise<Transporter> {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (host && user && pass) {
    // Configured with custom SMTP
    transporter = nodemailer.createTransport({
      host,
      port,
      secure: process.env.SMTP_SECURE === 'true' || port === 465,
      auth: { user, pass },
      tls: {
        rejectUnauthorized: process.env.NODE_ENV === 'production',
      },
    });
    isEthereal = false;
    console.log(`[EmailService] Configured custom SMTP transporter for host: ${host}:${port}`);
  } else {
    // Development fallback: automatic Ethereal test inbox
    try {
      const testAccount = await nodemailer.createTestAccount();
      transporter = nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: {
          user: testAccount.user,
          pass: testAccount.pass,
        },
      });
      isEthereal = true;
      console.log(`[EmailService] Initialized Ethereal test account: ${testAccount.user}`);
    } catch (err: any) {
      console.warn(`[EmailService] Failed to create Ethereal test account (${err.message}). Using mock transport.`);
      // Mock transporter fallback if offline
      transporter = nodemailer.createTransport({
        jsonTransport: true,
      });
      isEthereal = false;
    }
  }

  return transporter;
}

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
 * Send an email notification and record the action into the emailLogs database.
 * Never throws an unhandled error so it won't crash callers.
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
      recipientName,
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

  const fromAddress = process.env.SMTP_FROM || '"Appraisal Management System" <no-reply@appraisal-system.internal>';

  try {
    const mailer = await getTransporter();
    const info = await mailer.sendMail({
      from: fromAddress,
      to: recipientName ? `"${recipientName}" <${recipientEmail}>` : recipientEmail,
      subject,
      html,
    });

    let previewUrl: string | undefined;
    if (isEthereal) {
      previewUrl = nodemailer.getTestMessageUrl(info) || undefined;
      if (previewUrl) {
        console.log(`\n📧 [Email Preview] To: ${recipientEmail} | Subject: "${subject}"`);
        console.log(`   🔗 Web View URL: ${previewUrl}\n`);
      }
    } else {
      console.log(`[EmailService] Sent email to ${recipientEmail} (ID: ${info.messageId})`);
    }

    const sentLog: EmailLog = {
      id: logId,
      recipientId,
      recipientEmail,
      recipientName,
      subject,
      templateType,
      status: 'SENT',
      messageId: info.messageId,
      previewUrl,
      metadata,
      createdAt: now,
    };

    await recordEmailLog(sentLog);
    return sentLog;
  } catch (error: any) {
    console.error(`[EmailService] Failed to send email to ${recipientEmail}:`, error.message);

    const failedLog: EmailLog = {
      id: logId,
      recipientId,
      recipientEmail,
      recipientName,
      subject,
      templateType,
      status: 'FAILED',
      errorMessage: error.message || 'Unknown SMTP dispatch error',
      metadata,
      createdAt: now,
    };

    await recordEmailLog(failedLog);
    return failedLog;
  }
}

/**
 * Persist log into MongoDB / memoryDb
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
    return logs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, limit);
  } catch (err) {
    console.error('[EmailService] Failed to retrieve email logs:', err);
    return [];
  }
}
