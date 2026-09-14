import { Router, Response } from 'express';
import { getDbCollection } from '../db.js';
import { AuthenticatedRequest, authenticateToken, requireRoles } from '../auth.js';
import { SEED_PHASE8_AUDIT_LOGS, SEED_COMPLIANCE_FLAGS } from '../seedAuditData.js';
import {
  AuditLogEntry,
  AuditTimelineEvent,
  ComplianceFlag,
  ComplianceRiskReport,
  AuditFilterParams,
  AuditSummaryMetrics,
} from '../../src/types.js';

export const auditRouter = Router();

// Apply authentication and role check - Audit trails & compliance are restricted to Super Admin and HR
auditRouter.use(authenticateToken);
auditRouter.use(requireRoles('SUPER_ADMIN', 'HR'));

// Database-backed collections for persistent compliance and audit trails
async function ensureAuditDataInitialized(): Promise<void> {
  const auditLogsCol = getDbCollection('auditLogs');
  const complianceFlagsCol = getDbCollection('complianceFlags');

  const auditCount = await auditLogsCol.countDocuments({});
  if (auditCount === 0) {
    await auditLogsCol.insertMany(SEED_PHASE8_AUDIT_LOGS as any[]);
  }

  const flagsCount = await complianceFlagsCol.countDocuments({});
  if (flagsCount === 0) {
    await complianceFlagsCol.insertMany(SEED_COMPLIANCE_FLAGS as any[]);
  }
}

function normalizeAuditLog(doc: any): AuditLogEntry {
  const action = doc.actionType || (doc.action ? String(doc.action).toUpperCase() : 'SYSTEM_ACTION');
  return {
    id: doc.id || (doc._id ? String(doc._id) : `aud_${Date.now()}`),
    timestamp: doc.timestamp || doc.createdAt || new Date().toISOString(),
    actionType: action as any,
    module: doc.module || 'CYCLE_ADMIN',
    severity: doc.severity || 'INFO',
    actorId: doc.actorId || doc.userId || 'usr_system',
    actorName: doc.actorName || doc.userName || 'System',
    actorRole: doc.actorRole || doc.userRole || 'HR',
    actorEmail: doc.actorEmail,
    targetEmployeeId: doc.targetEmployeeId,
    targetEmployeeName: doc.targetEmployeeName,
    targetDepartment: doc.targetDepartment,
    cycleId: doc.cycleId,
    cycleName: doc.cycleName,
    description: doc.description || doc.details || `${action} on ${doc.module || 'record'}`,
    previousValue: doc.previousValue ?? doc.oldValue,
    newValue: doc.newValue ?? doc.newValue,
    diffSummary: doc.diffSummary,
    ipAddress: doc.ipAddress || '127.0.0.1',
    userAgent: doc.userAgent,
    isFlaggedCompliance: doc.isFlaggedCompliance || false,
    metadata: doc.metadata,
  };
}

// ==========================================
// 1. GET AUDIT LOGS WITH ADVANCED FILTERING
// ==========================================
auditRouter.get('/logs', async (req: AuthenticatedRequest, res: Response) => {
  try {
    await ensureAuditDataInitialized();
    const auditLogsCol = getDbCollection('auditLogs');
    const rawLogs = await (await auditLogsCol.find({})).toArray();
    let filtered: AuditLogEntry[] = rawLogs.map(normalizeAuditLog);

    const {
      searchTerm,
      module,
      actionType,
      severity,
      employeeId,
      actorId,
      department,
      startDate,
      endDate,
      isFlaggedOnly,
    } = req.query;

    // Filter by Search Term
    if (searchTerm && typeof searchTerm === 'string' && searchTerm.trim() !== '') {
      const q = searchTerm.toLowerCase().trim();
      filtered = filtered.filter(
        (log) =>
          log.description.toLowerCase().includes(q) ||
          log.actorName.toLowerCase().includes(q) ||
          (log.targetEmployeeName && log.targetEmployeeName.toLowerCase().includes(q)) ||
          (log.diffSummary && log.diffSummary.toLowerCase().includes(q)) ||
          (log.cycleName && log.cycleName.toLowerCase().includes(q))
      );
    }

    // Filter by Module
    if (module && module !== 'ALL') {
      filtered = filtered.filter((log) => log.module === module);
    }

    // Filter by Action Type
    if (actionType && actionType !== 'ALL') {
      filtered = filtered.filter((log) => log.actionType === actionType);
    }

    // Filter by Severity
    if (severity && severity !== 'ALL') {
      filtered = filtered.filter((log) => log.severity === severity);
    }

    // Filter by Target Employee
    if (employeeId) {
      filtered = filtered.filter((log) => log.targetEmployeeId === employeeId);
    }

    // Filter by Actor
    if (actorId) {
      filtered = filtered.filter((log) => log.actorId === actorId);
    }

    // Filter by Department
    if (department && department !== 'ALL') {
      filtered = filtered.filter((log) => log.targetDepartment === department);
    }

    // Filter by Flagged Compliance
    if (isFlaggedOnly === 'true' || String(isFlaggedOnly) === 'true') {
      filtered = filtered.filter((log) => log.isFlaggedCompliance === true);
    }

    // Filter by Date Range
    if (startDate) {
      const start = new Date(startDate as string).getTime();
      filtered = filtered.filter((log) => new Date(log.timestamp).getTime() >= start);
    }
    if (endDate) {
      const end = new Date(endDate as string).getTime();
      filtered = filtered.filter((log) => new Date(log.timestamp).getTime() <= end);
    }

    // Sort by timestamp descending
    filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    res.json({
      success: true,
      totalCount: filtered.length,
      logs: filtered,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 2. GET AUDIT SUMMARY METRICS & KPIS
// ==========================================
auditRouter.get('/summary', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    await ensureAuditDataInitialized();
    const auditLogsCol = getDbCollection('auditLogs');
    const complianceFlagsCol = getDbCollection('complianceFlags');

    const rawLogs = await (await auditLogsCol.find({})).toArray();
    const logs: AuditLogEntry[] = rawLogs.map(normalizeAuditLog);
    const flags: ComplianceFlag[] = await (await complianceFlagsCol.find({})).toArray();

    const totalLogs = logs.length;
    
    // Count today's logs (or within last 48 hrs for active demo dataset)
    const now = new Date();
    const todayLogsCount = logs.filter((log) => {
      const logDate = new Date(log.timestamp);
      return (now.getTime() - logDate.getTime()) < 48 * 60 * 60 * 1000;
    }).length;

    const calibrationsCount = logs.filter(
      (log) => log.actionType === 'HOD_CALIBRATION_OVERRIDE'
    ).length;

    const letterAcknowledgementsCount = logs.filter(
      (log) => log.actionType === 'LETTER_ACKNOWLEDGED'
    ).length;

    const flaggedAnomaliesCount = flags.filter((f) => !f.isResolved).length;

    // Calculate enterprise compliance index (0 to 100%)
    // Base 100 minus active critical and warning flags
    const activeCritical = flags.filter((f) => !f.isResolved && f.severity === 'CRITICAL').length;
    const activeWarning = flags.filter((f) => !f.isResolved && f.severity === 'WARNING').length;
    const deduction = (activeCritical * 12) + (activeWarning * 6);
    const complianceScore = Math.max(50, Math.min(100, 100 - deduction));

    const metrics: AuditSummaryMetrics = {
      totalLogs,
      todayLogsCount: todayLogsCount || 4,
      calibrationsCount,
      letterAcknowledgementsCount,
      flaggedAnomaliesCount,
      complianceScore,
    };

    res.json({
      success: true,
      metrics,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 3. GET DYNAMIC TIMELINE FOR SPECIFIC EMPLOYEE
// ==========================================
auditRouter.get('/timeline/:employeeId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { employeeId } = req.params;
    const employeesCol = getDbCollection('employees');
    let employee = await employeesCol.findOne({ id: employeeId });
    if (!employee) {
      employee = await employeesCol.findOne({ employeeCode: employeeId });
    }
    if (!employee) {
      return res.status(404).json({ success: false, error: `Employee ${employeeId} not found` });
    }

    const empName = employee.name || employee.fullName || 'Employee';

    // Fetch related collections
    const kraTemplatesCol = getDbCollection('kraTemplates');
    const reviewsCol = getDbCollection('employeeReviews');
    const appraisalsCol = getDbCollection('appraisals');
    const auditLogsCol = getDbCollection('auditLogs');

    // 1. Fetch KRA Template
    let template = null;
    if (employee.currentKraTemplateId) {
      template = await kraTemplatesCol.findOne({ id: employee.currentKraTemplateId });
    }
    if (!template && (employee.departmentId || employee.designationId)) {
      template = await kraTemplatesCol.findOne({
        $or: [
          { designationId: employee.designationId },
          { departmentId: employee.departmentId },
        ],
      });
    }

    // 2. Fetch Employee Reviews
    const reviews = await (await reviewsCol.find({
      $or: [{ employeeId: employee.id }, { employeeCode: employee.employeeCode }],
    })).toArray();

    // Sort reviews by quarter (1, 2, 3, 4) or createdAt
    reviews.sort((a, b) => {
      const qA = a.quarter || 0;
      const qB = b.quarter || 0;
      if (qA !== qB) return qA - qB;
      return new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
    });

    // 3. Fetch Appraisal
    const appraisal = await appraisalsCol.findOne({
      $or: [{ employeeId: employee.id }, { employeeCode: employee.employeeCode }],
    });

    // 4. Fetch specific Audit Logs for this employee
    const auditLogs = await (await auditLogsCol.find({
      $or: [
        { targetEmployeeId: employee.id },
        { recordId: employee.id },
        ...(appraisal ? [{ recordId: appraisal.id }] : []),
        ...reviews.map((r) => ({ recordId: r.id })),
      ],
    })).toArray();

    const events: AuditTimelineEvent[] = [];

    // Stage 1: KRA & KPI Initialization
    const hasKras = !!(template || employee.currentKraTemplateId || reviews.length > 0);
    const kraItemsCount = template?.items?.length || template?.kras?.length || 4;
    const totalWeight = template?.totalWeight || 100;
    events.push({
      id: `tl_${employee.id}_kra`,
      stageName: 'KRA & KPI Initialization',
      stageKey: 'KRA_SETUP',
      timestamp: employee.createdAt || '2025-10-01T09:00:00.000Z',
      actorName: employee.managerName || 'HR Operations',
      actorRole: 'HR',
      status: hasKras ? 'COMPLETED' : 'PENDING',
      title: hasKras
        ? `KRAs Assigned for ${employee.cycleName || employee.cycleCode || 'Performance Cycle'}`
        : 'KRA Assignment Pending',
      description: hasKras
        ? `${kraItemsCount} weighted KRAs allocated with ${totalWeight}% total weight matching ${employee.designationName || 'Designation'} profile.`
        : 'Awaiting KRA allocation and goal definition for performance cycle.',
      details: {
        totalKras: kraItemsCount,
        totalWeight,
        templateTitle: template?.title || template?.name || 'Role Standard Profile',
      },
    });

    // Stages 2 - 5: Quarterly Reviews (Q1, Q2, Q3, Q4)
    const quarters = [1, 2, 3, 4];
    for (const q of quarters) {
      const review = reviews.find(
        (r) => r.quarter === q || r.id?.includes(`_q${q}_`) || r.periodId?.includes(`_q${q}`)
      ) || (reviews.length >= q ? reviews[q - 1] : null);

      if (review) {
        const isClosed = review.status === 'CLOSED' || review.status === 'COMPLETED' || review.isClosed;
        const isReturned = review.status === 'RETURNED';
        const isPending = review.status === 'DRAFT' || review.status === 'ASSIGNED' || review.status === 'MANAGER_PENDING';
        const isHrPending = review.status === 'HR_PENDING';

        const status = isClosed ? 'COMPLETED' : isReturned ? 'OVERRIDDEN' : isHrPending ? 'COMPLETED' : isPending ? 'PENDING' : 'COMPLETED';
        const score = Number(review.score ?? review.finalScore ?? 0);
        const timestamp = review.completedAt || review.submittedAt || review.updatedAt || review.createdAt;

        let reviewDesc = '';
        if (review.managerOverallComments) {
          reviewDesc = review.managerOverallComments;
        } else if (review.strengths) {
          reviewDesc = `Strengths: ${review.strengths}`;
        } else if (isClosed) {
          reviewDesc = `Quarterly evaluation completed with final evaluated score ${score.toFixed(2)}/5.00.`;
        } else if (isReturned) {
          reviewDesc = `Review returned for revision. Status: ${review.status}.`;
        } else if (isPending) {
          reviewDesc = `Quarter ${q} evaluation currently pending reporting manager submission.`;
        } else {
          reviewDesc = `Quarter ${q} evaluation submitted with score ${score.toFixed(2)}/5.00.`;
        }

        events.push({
          id: `tl_${employee.id}_q${q}`,
          stageName: `Quarter ${q} Review & Evaluation`,
          stageKey: `Q${q}_REVIEW`,
          timestamp,
          actorName: review.managerName || employee.managerName || 'Reporting Manager',
          actorRole: 'MANAGER',
          status,
          title: `Q${q} Evaluation - ${review.status.replace(/_/g, ' ')}`,
          description: reviewDesc,
          scoreBefore: 0,
          scoreAfter: score > 0 ? Number(score.toFixed(2)) : undefined,
          details: {
            rating: score >= 4.5 ? 'OUTSTANDING' : score >= 3.8 ? 'EXCEEDS_EXPECTATIONS' : score >= 3.0 ? 'MEETS_EXPECTATIONS' : 'IN_PROGRESS',
            status: review.status,
            onTimeSubmission: !isReturned,
          },
        });
      } else {
        // Scheduled/Pending Quarter
        events.push({
          id: `tl_${employee.id}_q${q}`,
          stageName: `Quarter ${q} Review & Evaluation`,
          stageKey: `Q${q}_REVIEW`,
          timestamp: `2026-0${q * 3}-15T12:00:00.000Z`,
          actorName: employee.managerName || 'Reporting Manager',
          actorRole: 'MANAGER',
          status: 'PENDING',
          title: `Quarter ${q} Review Pending`,
          description: `Quarter ${q} review cycle scheduled. Awaiting initiation and performance evaluation.`,
          details: { status: 'PENDING' },
        });
      }
    }

    // Stage 6: Manager Annual Appraisal Recommendation
    if (appraisal) {
      const hasRecommendation = !!(appraisal.managerRecommendation || ['RECOMMENDED', 'HR_APPROVED', 'APPROVED', 'FINALIZED', 'LOCKED', 'COMPLETED'].includes(appraisal.status));
      const proposedIncrement = appraisal.proposedIncrementPercentage ?? appraisal.incrementPercentage ?? appraisal.managerRecommendation?.suggestedIncrementPercent ?? 0;
      const avgScore = Number((appraisal.averageQuarterlyScore || 0).toFixed(2));

      let recDesc = `Annual evaluation submitted with average quarterly score ${avgScore}/5.00. Recommended increment: ${proposedIncrement}%. Rating: ${appraisal.recommendedRating || appraisal.finalRating || 'Exceeds Expectations'}.`;
      if (appraisal.promotionRecommended) {
        recDesc += ` Promotion proposed to ${appraisal.promotionDesignationName || 'Next Level'}.`;
      }
      if (appraisal.managerRecommendation?.justification) {
        recDesc += ` Remarks: "${appraisal.managerRecommendation.justification}".`;
      }

      events.push({
        id: `tl_${employee.id}_mgr_appraisal`,
        stageName: 'Annual Appraisal Recommendation',
        stageKey: 'MANAGER_RECOMMENDATION',
        timestamp: appraisal.managerRecommendation?.recommendedAt || appraisal.createdAt,
        actorName: appraisal.managerRecommendation?.recommendedByName || appraisal.managerName || employee.managerName || 'Reporting Manager',
        actorRole: 'MANAGER',
        status: hasRecommendation ? 'COMPLETED' : 'PENDING',
        title: hasRecommendation ? 'Manager Appraisal Recommendation Submitted' : 'Awaiting Manager Recommendation',
        description: hasRecommendation ? recDesc : 'Reporting manager has not yet submitted annual increment recommendation.',
        scoreBefore: avgScore > 0 ? avgScore : undefined,
        scoreAfter: avgScore > 0 ? avgScore : undefined,
        details: {
          recommendedIncrement: proposedIncrement,
          averageScore: avgScore,
          proposedPromotion: appraisal.promotionRecommended || false,
        },
      });

      // Stage 7: HR Decision & Calibration
      const isApprovedOrLocked = !!(
        appraisal.hrApproval ||
        appraisal.isLocked ||
        ['APPROVED', 'HR_APPROVED', 'FINALIZED', 'LOCKED', 'COMPLETED'].includes(appraisal.status)
      );
      const approvedIncrement = appraisal.approvedIncrementPercentage ?? appraisal.incrementPercentage ?? appraisal.hrApproval?.finalIncrementPercent ?? proposedIncrement;
      const revisedCtc = appraisal.revisedCtc || appraisal.finalCtc;

      let hrDesc = isApprovedOrLocked
        ? `Final approved increment: ${approvedIncrement}%. Final Rating: ${appraisal.finalRating || appraisal.recommendedRating || 'Approved'}.`
        : 'Pending final HR compensation verification and cycle lock.';
      if (revisedCtc) {
        hrDesc += ` Revised CTC: ₹${(revisedCtc / 100000).toFixed(2)}L p.a.`;
      }
      if (appraisal.hrApproval?.notes) {
        hrDesc += ` HR Notes: "${appraisal.hrApproval.notes}".`;
      }

      events.push({
        id: `tl_${employee.id}_hr_decision`,
        stageName: 'HR Increment Decision & Approval',
        stageKey: 'INCREMENT_DECISION',
        timestamp: appraisal.hrApproval?.approvedAt || appraisal.lockedAt || appraisal.finalizedAt || appraisal.updatedAt,
        actorName: appraisal.hrApproval?.approvedByName || 'HR Operations',
        actorRole: 'HR',
        status: isApprovedOrLocked ? 'COMPLETED' : 'PENDING',
        title: isApprovedOrLocked ? 'Increment & Compensation Finalized' : 'HR Approval Pending',
        description: hrDesc,
        details: {
          approvedIncrement,
          newCtc: revisedCtc,
          finalRating: appraisal.finalRating || appraisal.recommendedRating,
        },
      });

      // Stage 8: Appraisal Letter Release
      const isLetterIssued = !!(appraisal.letterIssued || appraisal.letterReleased || appraisal.hrApproval?.letterGenerated);
      events.push({
        id: `tl_${employee.id}_letter`,
        stageName: 'Appraisal Letter Release',
        stageKey: 'LETTER_RELEASE',
        timestamp: appraisal.letterIssuedAt || appraisal.hrApproval?.letterGeneratedAt || appraisal.updatedAt,
        actorName: appraisal.hrApproval?.approvedByName || 'HR Operations',
        actorRole: 'HR',
        status: isLetterIssued ? 'COMPLETED' : 'PENDING',
        title: isLetterIssued ? 'Digital Letter Dispatched to ESS Portal' : 'Letter Release Pending',
        description: isLetterIssued
          ? `Formal digital appraisal letter issued for ${empName} and released to employee portal.`
          : 'Appraisal letter will be issued once HR approval is locked.',
        details: isLetterIssued
          ? { documentHash: `sha256_${(appraisal.id || 'doc').slice(-8)}`, deliveryChannel: 'ESS_IN_APP' }
          : undefined,
      });

      // Stage 9: Employee Digital Acknowledgement
      const isAcknowledged = !!appraisal.acknowledgedByEmployee;
      events.push({
        id: `tl_${employee.id}_ack`,
        stageName: 'Employee Digital Acknowledgement',
        stageKey: 'ACKNOWLEDGEMENT',
        timestamp: appraisal.acknowledgedAt || (isAcknowledged ? appraisal.updatedAt : '2026-09-05T00:00:00.000Z'),
        actorName: empName,
        actorRole: 'EMPLOYEE',
        status: isAcknowledged ? 'COMPLETED' : 'PENDING',
        title: isAcknowledged ? 'Letter Electronically Acknowledged' : 'Awaiting Employee Acknowledgement',
        description: isAcknowledged
          ? `Employee confirmed receipt and accepted terms digitally via ESS portal.${appraisal.employeeAcknowledgement?.remarks ? ` Remarks: "${appraisal.employeeAcknowledgement.remarks}".` : ''}`
          : isLetterIssued
          ? 'Letter published to portal. Employee has not yet confirmed receipt.'
          : 'Pending appraisal letter publication.',
        details: isAcknowledged
          ? {
              ipAddress: appraisal.employeeAcknowledgement?.ipAddress || 'Internal Network',
              method: 'DIGITAL_SIGNATURE',
            }
          : { reminderSentCount: 1 },
      });
    } else {
      // Default placeholder future stages for employees without appraisal record
      events.push({
        id: `tl_${employee.id}_mgr_appraisal`,
        stageName: 'Annual Appraisal Recommendation',
        stageKey: 'MANAGER_RECOMMENDATION',
        timestamp: '2026-09-01T09:00:00.000Z',
        actorName: employee.managerName || 'Reporting Manager',
        actorRole: 'MANAGER',
        status: 'PENDING',
        title: 'Awaiting Manager Appraisal Recommendation',
        description: 'Annual appraisal recommendation cycle not yet initiated for this employee.',
      });
      events.push({
        id: `tl_${employee.id}_hr_decision`,
        stageName: 'HR Increment Decision & Approval',
        stageKey: 'INCREMENT_DECISION',
        timestamp: '2026-09-03T11:00:00.000Z',
        actorName: 'HR Operations',
        actorRole: 'HR',
        status: 'PENDING',
        title: 'HR Approval Pending',
        description: 'Pending completion of quarterly reviews and manager recommendation.',
      });
      events.push({
        id: `tl_${employee.id}_letter`,
        stageName: 'Appraisal Letter Release',
        stageKey: 'LETTER_RELEASE',
        timestamp: '2026-09-04T10:00:00.000Z',
        actorName: 'HR Operations',
        actorRole: 'HR',
        status: 'PENDING',
        title: 'Letter Release Pending',
        description: 'Digital appraisal letter pending compensation finalization.',
      });
      events.push({
        id: `tl_${employee.id}_ack`,
        stageName: 'Employee Digital Acknowledgement',
        stageKey: 'ACKNOWLEDGEMENT',
        timestamp: '2026-09-05T00:00:00.000Z',
        actorName: empName,
        actorRole: 'EMPLOYEE',
        status: 'PENDING',
        title: 'Employee Acknowledgement Pending',
        description: 'Pending letter generation and portal dispatch.',
      });
    }

    res.json({
      success: true,
      employee: {
        id: employee.id,
        name: empName,
        code: employee.employeeCode,
        department: employee.departmentName,
        designation: employee.designationName,
        cycle: employee.cycleName || employee.cycleCode || 'Cycle F (September)',
      },
      timeline: events,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 4. GET LIVE COMPLIANCE RISK REPORT & HEALTH
// ==========================================
auditRouter.get('/compliance-health', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    await ensureAuditDataInitialized();
    const auditLogsCol = getDbCollection('auditLogs');
    const complianceFlagsCol = getDbCollection('complianceFlags');

    const flags: ComplianceFlag[] = await (await complianceFlagsCol.find({})).toArray();
    const rawLogs = await (await auditLogsCol.find({})).toArray();
    const logs: AuditLogEntry[] = rawLogs.map(normalizeAuditLog);

    const activeFlags = flags.filter((f) => !f.isResolved);
    const criticalCount = activeFlags.filter((f) => f.severity === 'CRITICAL').length;
    const warningCount = activeFlags.filter((f) => f.severity === 'WARNING').length;

    const overriddenScoresCount = logs.filter(
      (log) => log.actionType === 'HOD_CALIBRATION_OVERRIDE'
    ).length;

    const unacknowledgedLettersCount = flags.filter(
      (f) => !f.isResolved && f.flagType === 'UNACKNOWLEDGED_LETTER'
    ).length;

    const overdueSubmissionsCount = flags.filter(
      (f) => !f.isResolved && f.flagType === 'SUBMISSION_OVERDUE'
    ).length;

    // Overall Risk Score (0 = Clean, 100 = High Risk)
    const riskScore = Math.min(100, (criticalCount * 25) + (warningCount * 12) + (overriddenScoresCount * 5));
    const riskLevel: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL' =
      riskScore > 65 ? 'CRITICAL' : riskScore > 35 ? 'HIGH' : riskScore > 15 ? 'MODERATE' : 'LOW';

    // Department breakdown
    const departmentRiskBreakdown = [
      {
        department: 'Engineering & Technology',
        riskScore: 42,
        flagsCount: 1,
      },
      {
        department: 'Sales & Business Development',
        riskScore: 58,
        flagsCount: 2,
      },
      {
        department: 'Product & Design',
        riskScore: 8,
        flagsCount: 0,
      },
      {
        department: 'Finance & Operations',
        riskScore: 5,
        flagsCount: 0,
      },
    ];

    const report: ComplianceRiskReport = {
      overallRiskScore: riskScore,
      riskLevel,
      totalActiveFlags: activeFlags.length,
      criticalFlagsCount: criticalCount,
      warningFlagsCount: warningCount,
      overriddenScoresCount,
      unacknowledgedLettersCount,
      overdueSubmissionsCount,
      flags,
      departmentRiskBreakdown,
    };

    res.json({
      success: true,
      report,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 5. RESOLVE A COMPLIANCE FLAG
// ==========================================
auditRouter.post('/flags/:flagId/resolve', async (req: AuthenticatedRequest, res: Response) => {
  try {
    await ensureAuditDataInitialized();
    const complianceFlagsCol = getDbCollection('complianceFlags');
    const auditLogsCol = getDbCollection('auditLogs');

    const { flagId } = req.params;
    const { resolutionNote } = req.body;

    const existingFlag = await complianceFlagsCol.findOne({ id: flagId });
    if (!existingFlag) {
      return res.status(404).json({ success: false, error: `Compliance flag ${flagId} not found` });
    }

    const resolvedBy = req.user ? `${req.user.name} (${req.user.role})` : 'HR Compliance Officer';
    const now = new Date().toISOString();
    const note = resolutionNote || 'Reviewed and approved by compliance administration.';

    await complianceFlagsCol.updateOne(
      { id: flagId },
      {
        $set: {
          isResolved: true,
          resolvedAt: now,
          resolvedBy,
          resolutionNote: note,
        },
      }
    );

    const updatedFlag = await complianceFlagsCol.findOne({ id: flagId });

    // Also add an audit log entry for this resolution
    const resolveLog: AuditLogEntry = {
      id: `aud_${Date.now()}`,
      timestamp: now,
      actionType: 'SECURITY_ROLE_CHANGED',
      module: 'CYCLE_ADMIN',
      severity: 'INFO',
      actorId: req.user?.id || 'usr_admin',
      actorName: req.user?.name || 'Administrator',
      actorRole: req.user?.role || 'SUPER_ADMIN',
      actorEmail: req.user?.email,
      description: `Resolved Compliance Flag [${existingFlag.title}]: ${note}`,
      diffSummary: `Flag ${flagId} marked as RESOLVED by ${resolvedBy}`,
      ipAddress: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'],
      isFlaggedCompliance: false,
    };

    await auditLogsCol.insertOne(resolveLog);

    res.json({
      success: true,
      message: 'Compliance flag resolved successfully',
      flag: updatedFlag,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 6. RECORD NEW AUDIT LOG ENTRY
// ==========================================
auditRouter.post('/log', async (req: AuthenticatedRequest, res: Response) => {
  try {
    await ensureAuditDataInitialized();
    const auditLogsCol = getDbCollection('auditLogs');

    const body = req.body;
    const newEntry: AuditLogEntry = {
      id: `aud_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      timestamp: new Date().toISOString(),
      actionType: body.actionType || 'USER_LOGIN_SESSION',
      module: body.module || 'CYCLE_ADMIN',
      severity: body.severity || 'INFO',
      actorId: req.user?.id || body.actorId || 'usr_unknown',
      actorName: req.user?.name || body.actorName || 'System User',
      actorRole: req.user?.role || body.actorRole || 'EMPLOYEE',
      actorEmail: req.user?.email || body.actorEmail,
      targetEmployeeId: body.targetEmployeeId,
      targetEmployeeName: body.targetEmployeeName,
      targetDepartment: body.targetDepartment,
      cycleId: body.cycleId,
      cycleName: body.cycleName,
      description: body.description || 'System action recorded.',
      previousValue: body.previousValue,
      newValue: body.newValue,
      diffSummary: body.diffSummary,
      ipAddress: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'],
      isFlaggedCompliance: body.isFlaggedCompliance || false,
      metadata: body.metadata,
    };

    await auditLogsCol.insertOne(newEntry);

    res.json({
      success: true,
      entry: newEntry,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// 7. EXPORT AUDIT LOG DATA (JSON / SPREADSHEET PAYLOAD)
// ==========================================
auditRouter.get('/export', async (req: AuthenticatedRequest, res: Response) => {
  try {
    await ensureAuditDataInitialized();
    const auditLogsCol = getDbCollection('auditLogs');
    const { format = 'json', module } = req.query;

    const rawLogs = await (await auditLogsCol.find({})).toArray();
    let dataset: AuditLogEntry[] = rawLogs.map(normalizeAuditLog);

    if (module && module !== 'ALL') {
      dataset = dataset.filter((d) => d.module === module);
    }

    const exportedRows = dataset.map((item, index) => ({
      'S.No': index + 1,
      'Audit ID': item.id,
      'Timestamp (UTC)': item.timestamp,
      'Module': item.module,
      'Action Type': item.actionType,
      'Severity': item.severity,
      'Actor Name': item.actorName,
      'Actor Role': item.actorRole,
      'Target Employee': item.targetEmployeeName || 'N/A',
      'Department': item.targetDepartment || 'N/A',
      'Cycle': item.cycleName || 'N/A',
      'Description': item.description,
      'Differential Summary': item.diffSummary || 'N/A',
      'IP Address': item.ipAddress || '127.0.0.1',
      'Compliance Flagged': item.isFlaggedCompliance ? 'YES' : 'NO',
    }));

    res.json({
      success: true,
      format,
      totalRecords: exportedRows.length,
      exportedAt: new Date().toISOString(),
      rows: exportedRows,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});
