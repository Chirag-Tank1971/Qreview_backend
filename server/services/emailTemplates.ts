/**
 * Responsive, branded HTML email templates for Appraisal Management System
 */

export interface BaseTemplateOptions {
  headerTitle?: string;
  badge?: string;
  badgeColor?: string;
  preheader?: string;
  contentHtml: string;
  ctaText?: string;
  ctaUrl?: string;
}

export function renderBaseEmailLayout(options: BaseTemplateOptions): string {
  const {
    headerTitle = 'Enterprise Performance & Appraisal System',
    badge = 'HR Notification',
    badgeColor = '#4f46e5',
    preheader = 'Action notification from your appraisal management portal',
    contentHtml,
    ctaText,
    ctaUrl,
  } = options;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${headerTitle}</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #1e293b;
      -webkit-font-smoothing: antialiased;
    }
    .wrapper {
      width: 100%;
      table-layout: fixed;
      background-color: #f8fafc;
      padding: 32px 0;
    }
    .main {
      background-color: #ffffff;
      margin: 0 auto;
      max-width: 580px;
      border-radius: 16px;
      border: 1px solid #e2e8f0;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -2px rgba(0, 0, 0, 0.05);
      overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #4338ca 100%);
      padding: 32px 32px 28px 32px;
      text-align: left;
    }
    .logo-text {
      color: #ffffff;
      font-size: 18px;
      font-weight: 800;
      letter-spacing: -0.025em;
      margin: 0 0 6px 0;
    }
    .subtitle {
      color: #c7d2fe;
      font-size: 13px;
      margin: 0;
    }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border-radius: 9999px;
      background-color: ${badgeColor};
      color: #ffffff;
      margin-bottom: 12px;
    }
    .content {
      padding: 32px;
      font-size: 14px;
      line-height: 1.6;
      color: #334155;
    }
    .btn-container {
      margin: 28px 0 16px 0;
      text-align: center;
    }
    .button {
      display: inline-block;
      background: #4f46e5;
      color: #ffffff !important;
      text-decoration: none;
      font-weight: 600;
      font-size: 14px;
      padding: 12px 28px;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(79, 70, 229, 0.25);
    }
    .info-card {
      background-color: #f1f5f9;
      border-left: 4px solid #4f46e5;
      padding: 14px 16px;
      border-radius: 0 8px 8px 0;
      margin: 18px 0;
    }
    .info-row {
      margin: 4px 0;
      font-size: 13px;
    }
    .info-label {
      font-weight: 600;
      color: #475569;
    }
    .footer {
      background-color: #f8fafc;
      padding: 24px 32px;
      border-top: 1px solid #e2e8f0;
      font-size: 12px;
      color: #64748b;
      text-align: center;
    }
    .footer a {
      color: #4f46e5;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div style="display:none;font-size:1px;color:#333333;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
    ${preheader}
  </div>
  <center class="wrapper">
    <table class="main" width="100%">
      <tr>
        <td class="header">
          <div class="badge">${badge}</div>
          <h1 class="logo-text">${headerTitle}</h1>
          <p class="subtitle">Performance & Appraisal Notification Service</p>
        </td>
      </tr>
      <tr>
        <td class="content">
          ${contentHtml}

          ${ctaText && ctaUrl ? `
          <div class="btn-container">
            <a href="${ctaUrl}" class="button" target="_blank">${ctaText} &rarr;</a>
          </div>` : ''}
        </td>
      </tr>
      <tr>
        <td class="footer">
          <p style="margin:0 0 6px 0;">This is an automated operational notification from the Appraisal Management System.</p>
          <p style="margin:0;">Please do not reply directly to this message. For support, contact your HR People Operations team.</p>
        </td>
      </tr>
    </table>
  </center>
</body>
</html>
  `.trim();
}

/**
 * 1. Self-Assessment Submitted -> Notify Manager
 */
export function renderSelfAssessmentSubmittedEmail(data: {
  employeeName: string;
  managerName: string;
  reviewPeriodName: string;
  selfScore: number;
  reviewUrl: string;
}): { subject: string; html: string } {
  const subject = `Review Ready: ${data.employeeName} submitted Self-Assessment for ${data.reviewPeriodName}`;
  const html = renderBaseEmailLayout({
    headerTitle: 'Self-Assessment Submitted',
    badge: 'Evaluation Pending',
    badgeColor: '#0284c7', // Sky blue
    preheader: `${data.employeeName} completed self-assessment for ${data.reviewPeriodName}.`,
    contentHtml: `
      <p>Hello <strong>${data.managerName}</strong>,</p>
      <p>Your team member <strong>${data.employeeName}</strong> has completed and officially submitted their quarterly self-evaluation for <strong>${data.reviewPeriodName}</strong>.</p>
      
      <div class="info-card">
        <div class="info-row"><span class="info-label">Employee:</span> ${data.employeeName}</div>
        <div class="info-row"><span class="info-label">Evaluation Cycle:</span> ${data.reviewPeriodName}</div>
        <div class="info-row"><span class="info-label">Self-Assessment Score:</span> <strong>${data.selfScore.toFixed(2)} / 5.00</strong></div>
        <div class="info-row"><span class="info-label">Status:</span> Ready for Manager Review</div>
      </div>

      <p>Please log in to your reviewer workspace to review the achievement notes, rate the individual KRA objectives, and provide your developmental feedback.</p>
    `,
    ctaText: 'Evaluate Team Member',
    ctaUrl: data.reviewUrl,
  });

  return { subject, html };
}

/**
 * 2. Manager Review Completed -> Notify Employee & Skip-Level
 */
export function renderManagerReviewSubmittedEmail(data: {
  employeeName: string;
  managerName: string;
  reviewPeriodName: string;
  managerScore: number;
  reviewUrl: string;
}): { subject: string; html: string } {
  const subject = `Quarterly Review Completed: ${data.reviewPeriodName} by ${data.managerName}`;
  const html = renderBaseEmailLayout({
    headerTitle: 'Manager Review Completed',
    badge: 'Evaluation Finished',
    badgeColor: '#10b981', // Emerald
    preheader: `Manager evaluation complete for ${data.reviewPeriodName}.`,
    contentHtml: `
      <p>Hello <strong>${data.employeeName}</strong>,</p>
      <p>Your reporting manager <strong>${data.managerName}</strong> has completed evaluating your performance objectives for <strong>${data.reviewPeriodName}</strong>.</p>

      <div class="info-card">
        <div class="info-row"><span class="info-label">Review Period:</span> ${data.reviewPeriodName}</div>
        <div class="info-row"><span class="info-label">Evaluator:</span> ${data.managerName}</div>
        <div class="info-row"><span class="info-label">Manager Score:</span> <strong>${data.managerScore.toFixed(2)} / 5.00</strong></div>
      </div>

      <p>You can view your detailed ratings, manager commentary, and action plan directly in your employee portal.</p>
    `,
    ctaText: 'View Evaluation Details',
    ctaUrl: data.reviewUrl,
  });

  return { subject, html };
}

/**
 * 3. Annual Appraisal Letter Released -> Notify Employee
 */
export function renderAppraisalLetterReleasedEmail(data: {
  employeeName: string;
  cycleName: string;
  appraisalUrl: string;
  effectiveDate?: string;
}): { subject: string; html: string } {
  const subject = `🎉 Annual Appraisal & Compensation Letter Released: ${data.cycleName}`;
  const html = renderBaseEmailLayout({
    headerTitle: 'Appraisal Letter Released',
    badge: 'Letter Published',
    badgeColor: '#6366f1', // Indigo
    preheader: `Your annual appraisal letter for ${data.cycleName} is now available.`,
    contentHtml: `
      <p>Dear <strong>${data.employeeName}</strong>,</p>
      <p>We are delighted to inform you that your annual performance appraisal and compensation review for <strong>${data.cycleName}</strong> has been finalized, approved by management, and officially released.</p>

      <div class="info-card">
        <div class="info-row"><span class="info-label">Appraisal Cycle:</span> ${data.cycleName}</div>
        ${data.effectiveDate ? `<div class="info-row"><span class="info-label">Effective Date:</span> ${data.effectiveDate}</div>` : ''}
        <div class="info-row"><span class="info-label">Document:</span> Digital Appraisal Letter & Salary Revision Notice</div>
      </div>

      <p>You may now securely access, view, and download your personalized signed appraisal letter in the employee workspace.</p>
    `,
    ctaText: 'View Appraisal Letter',
    ctaUrl: data.appraisalUrl,
  });

  return { subject, html };
}

/**
 * 4. Performance Improvement Plan (PIP) Alert
 */
export function renderPipAlertEmail(data: {
  employeeName: string;
  pipTitle: string;
  targetEndDate: string;
  planUrl: string;
}): { subject: string; html: string } {
  const subject = `Performance Action Plan Initiated: ${data.pipTitle}`;
  const html = renderBaseEmailLayout({
    headerTitle: 'Performance Action Plan',
    badge: 'Confidential HR Notice',
    badgeColor: '#f43f5e', // Rose
    preheader: `Performance improvement action plan initiated.`,
    contentHtml: `
      <p>Dear <strong>${data.employeeName}</strong>,</p>
      <p>A structured developmental performance action plan (<strong>${data.pipTitle}</strong>) has been initiated to support your performance targets and career alignment.</p>

      <div class="info-card" style="border-left-color: #f43f5e;">
        <div class="info-row"><span class="info-label">Action Plan:</span> ${data.pipTitle}</div>
        <div class="info-row"><span class="info-label">Target Review Date:</span> ${data.targetEndDate}</div>
      </div>

      <p>Please review the milestones and support guidelines in the portal and coordinate closely with your manager.</p>
    `,
    ctaText: 'Open Action Plan',
    ctaUrl: data.planUrl,
  });

  return { subject, html };
}

/**
 * 5. System Test Email
 */
export function renderTestEmail(data: {
  recipientName: string;
  timestamp: string;
}): { subject: string; html: string } {
  const subject = `✅ Verification Test: Appraisal Notification Service`;
  const html = renderBaseEmailLayout({
    headerTitle: 'System Notification Test',
    badge: 'SMTP Verification',
    badgeColor: '#10b981',
    preheader: 'Verification email to test mail transport configuration.',
    contentHtml: `
      <p>Hello <strong>${data.recipientName}</strong>,</p>
      <p>This is a verification test message from the <strong>Appraisal Management System</strong> email notification service.</p>

      <div class="info-card">
        <div class="info-row"><span class="info-label">Status:</span> Transporter Operational & Active</div>
        <div class="info-row"><span class="info-label">Timestamp:</span> ${data.timestamp}</div>
      </div>

      <p>If you are receiving this message, your mail transport settings are properly configured and operational.</p>
    `,
  });

  return { subject, html };
}
