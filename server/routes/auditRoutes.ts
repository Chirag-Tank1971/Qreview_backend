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
// 3. GET TIMELINE FOR SPECIFIC EMPLOYEE
// ==========================================
auditRouter.get('/timeline/:employeeId', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { employeeId } = req.params;
    const employeesCol = getDbCollection('employees');
    const employee = await employeesCol.findOne({ id: employeeId });

    if (!employee) {
      return res.status(404).json({ success: false, error: `Employee ${employeeId} not found` });
    }

    // Construct full chronological lifecycle timeline
    const events: AuditTimelineEvent[] = [
      {
        id: `tl_${employeeId}_1`,
        stageName: 'KRA & KPI Initialization',
        stageKey: 'KRA_SETUP',
        timestamp: '2025-10-05T10:00:00.000Z',
        actorName: 'Priya Sundaram',
        actorRole: 'HR',
        status: 'COMPLETED',
        title: 'KRAs Assigned for 8-Cycle Plan',
        description: `4 weighted KRAs allocated with 100% total weight matching ${employee.designationName || 'Designation'} profile.`,
        details: { totalKras: 4, totalWeight: 100 },
      },
      {
        id: `tl_${employeeId}_2`,
        stageName: 'Quarter 1 Review & Goal Check',
        stageKey: 'Q1_REVIEW',
        timestamp: '2025-12-28T14:30:00.000Z',
        actorName: employee.managerName || 'Reporting Manager',
        actorRole: 'MANAGER',
        status: 'COMPLETED',
        title: 'Q1 Evaluation Submitted',
        description: 'First quarterly sprint completed with target milestones reached ahead of schedule.',
        scoreBefore: 0,
        scoreAfter: 4.10,
        details: { rating: 'EXCEEDS_EXPECTATIONS', onTimeSubmission: true },
      },
      {
        id: `tl_${employeeId}_3`,
        stageName: 'Quarter 2 Review & Mid-Year Pulse',
        stageKey: 'Q2_REVIEW',
        timestamp: '2026-03-30T11:15:00.000Z',
        actorName: employee.managerName || 'Reporting Manager',
        actorRole: 'MANAGER',
        status: 'COMPLETED',
        title: 'Q2 Evaluation Submitted',
        description: 'Mid-year evaluation submitted with strong code quality metrics and peer feedback.',
        scoreBefore: 4.10,
        scoreAfter: 4.25,
        details: { rating: 'EXCEEDS_EXPECTATIONS', onTimeSubmission: true },
      },
      {
        id: `tl_${employeeId}_4`,
        stageName: 'Quarter 3 Review & Pre-Appraisal Alignment',
        stageKey: 'Q3_REVIEW',
        timestamp: '2026-06-25T16:00:00.000Z',
        actorName: employee.managerName || 'Reporting Manager',
        actorRole: 'MANAGER',
        status: 'COMPLETED',
        title: 'Q3 Evaluation Submitted',
        description: 'Consistent performance on key architecture milestones with zero SLA breaches.',
        scoreBefore: 4.25,
        scoreAfter: 4.30,
        details: { rating: 'EXCEEDS_EXPECTATIONS', onTimeSubmission: true },
      },
      {
        id: `tl_${employeeId}_5`,
        stageName: 'Quarter 4 Final Evaluation',
        stageKey: 'Q4_REVIEW',
        timestamp: '2026-09-01T09:30:00.000Z',
        actorName: employee.managerName || 'Reporting Manager',
        actorRole: 'MANAGER',
        status: 'COMPLETED',
        title: 'Q4 Evaluation Completed',
        description: 'Annual evaluation completed. Aggregate year score computed at 4.35.',
        scoreBefore: 4.30,
        scoreAfter: 4.35,
        details: { rating: 'OUTSTANDING', onTimeSubmission: true },
      },
      {
        id: `tl_${employeeId}_6`,
        stageName: 'HOD Cross-Departmental Calibration',
        stageKey: 'CALIBRATION',
        timestamp: '2026-09-02T14:10:00.000Z',
        actorName: 'Alice Johnson',
        actorRole: 'HOD',
        status: 'OVERRIDDEN',
        title: 'HOD Bell-Curve Calibration Applied',
        description: 'Score calibrated to 4.30 to meet departmental bell curve and quota distribution guidelines.',
        scoreBefore: 4.35,
        scoreAfter: 4.30,
        changeReason: 'Alignment with 15% top-tier quota guidelines across the Engineering division.',
        details: { variance: -0.05, justificationLogged: true },
      },
      {
        id: `tl_${employeeId}_7`,
        stageName: 'HR & Executive Increment Decision',
        stageKey: 'INCREMENT_DECISION',
        timestamp: '2026-09-03T11:45:00.000Z',
        actorName: 'Frank HR Manager',
        actorRole: 'HR',
        status: 'COMPLETED',
        title: 'Increment & Band Approved',
        description: 'Recommended 12.5% salary increment with Band A promotional progression.',
        details: { recommendedIncrement: 12.5, proposedPromotion: false },
      },
      {
        id: `tl_${employeeId}_8`,
        stageName: 'Appraisal Letter Release',
        stageKey: 'LETTER_RELEASE',
        timestamp: '2026-09-04T10:00:00.000Z',
        actorName: 'Priya Sundaram',
        actorRole: 'HR',
        status: 'COMPLETED',
        title: 'Digital Letter Dispatched to ESS Portal',
        description: 'Formal appraisal letter issued and notification triggered to employee.',
        details: { documentHash: 'sha256_e891bca7', deliveryChannel: 'ESS_IN_APP' },
      },
    ];

    // If employee is in acknowledged state, add final stage
    if (employee.id === 'emp_dev_1' || employee.id === 'emp_com_1') {
      events.push({
        id: `tl_${employeeId}_9`,
        stageName: 'Employee Digital Acknowledgement',
        stageKey: 'ACKNOWLEDGEMENT',
        timestamp: '2026-09-04T15:20:00.000Z',
        actorName: employee.fullName,
        actorRole: 'EMPLOYEE',
        status: 'COMPLETED',
        title: 'Letter Electronically Acknowledged',
        description: 'Employee confirmed receipt and accepted terms digitally via ESS portal.',
        details: { ipAddress: '192.168.1.108', method: 'DIGITAL_SIGNATURE' },
      });
    } else {
      events.push({
        id: `tl_${employeeId}_9`,
        stageName: 'Employee Digital Acknowledgement',
        stageKey: 'ACKNOWLEDGEMENT',
        timestamp: '2026-09-05T00:00:00.000Z',
        actorName: employee.fullName,
        actorRole: 'EMPLOYEE',
        status: 'PENDING',
        title: 'Awaiting Employee Acknowledgement',
        description: 'Letter published. Employee has not yet confirmed receipt.',
        details: { reminderSentCount: 1 },
      });
    }

    res.json({
      success: true,
      employee: {
        id: employee.id,
        name: employee.fullName,
        code: employee.employeeCode,
        department: employee.departmentName,
        designation: employee.designationName,
        cycle: employee.cycleName || 'Cycle F (September)',
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
