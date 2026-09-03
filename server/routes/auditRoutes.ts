import { Router, Response } from 'express';
import { getDbCollection } from '../db.js';
import { AuthenticatedRequest, authenticateToken } from '../auth.js';
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

// Apply authentication
auditRouter.use(authenticateToken);

// In-memory backing arrays initialized with seed data if DB collection doesn't contain entries yet
let localAuditLogs: AuditLogEntry[] = [...SEED_PHASE8_AUDIT_LOGS];
let localComplianceFlags: ComplianceFlag[] = [...SEED_COMPLIANCE_FLAGS];

// ==========================================
// 1. GET AUDIT LOGS WITH ADVANCED FILTERING
// ==========================================
auditRouter.get('/logs', async (req: AuthenticatedRequest, res: Response) => {
  try {
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

    let filtered = [...localAuditLogs];

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
    const totalLogs = localAuditLogs.length;
    
    // Count today's logs (or within last 48 hrs for active demo dataset)
    const now = new Date();
    const todayLogsCount = localAuditLogs.filter((log) => {
      const logDate = new Date(log.timestamp);
      return (now.getTime() - logDate.getTime()) < 48 * 60 * 60 * 1000;
    }).length;

    const calibrationsCount = localAuditLogs.filter(
      (log) => log.actionType === 'HOD_CALIBRATION_OVERRIDE'
    ).length;

    const letterAcknowledgementsCount = localAuditLogs.filter(
      (log) => log.actionType === 'LETTER_ACKNOWLEDGED'
    ).length;

    const flaggedAnomaliesCount = localComplianceFlags.filter((f) => !f.isResolved).length;

    // Calculate enterprise compliance index (0 to 100%)
    // Base 100 minus active critical and warning flags
    const activeCritical = localComplianceFlags.filter((f) => !f.isResolved && f.severity === 'CRITICAL').length;
    const activeWarning = localComplianceFlags.filter((f) => !f.isResolved && f.severity === 'WARNING').length;
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
        stageName: 'Quarter 3 Review',
        stageKey: 'Q3_REVIEW',
        timestamp: '2026-06-25T16:00:00.000Z',
        actorName: employee.managerName || 'Reporting Manager',
        actorRole: 'MANAGER',
        status: 'COMPLETED',
        title: 'Q3 Evaluation Submitted',
        description: 'Quarterly review completed with leadership initiative on key platform feature.',
        scoreBefore: 4.25,
        scoreAfter: 4.40,
        details: { rating: 'OUTSTANDING', onTimeSubmission: true },
      },
      {
        id: `tl_${employeeId}_5`,
        stageName: 'Quarter 4 Review & Rolling 4Q Rollup',
        stageKey: 'Q4_REVIEW',
        timestamp: '2026-09-01T09:30:00.000Z',
        actorName: employee.managerName || 'Reporting Manager',
        actorRole: 'MANAGER',
        status: 'COMPLETED',
        title: 'Q4 Review & 4-Quarter Rollup Computed',
        description: 'Completed final quarter evaluation. Rolling 4-quarter weighted aggregate score calculated at 4.35 / 5.0.',
        scoreBefore: 4.40,
        scoreAfter: 4.35,
        details: { annualScore: 4.35, status: 'MANAGER_RECOMMENDED' },
      },
    ];

    // If this employee had a calibration override (e.g. Rohan Gupta), add calibration diff event
    if (employeeId === 'emp_dev_2') {
      events.push({
        id: `tl_${employeeId}_6`,
        stageName: 'Department HOD Calibration & Normalization',
        stageKey: 'CALIBRATION',
        timestamp: '2026-09-01T11:45:00.000Z',
        actorName: 'Vikram Mehta',
        actorRole: 'HOD',
        status: 'OVERRIDDEN',
        title: 'Score Calibrated & Adjusted by HOD',
        description: 'HOD adjusted normalized rating from 4.20 to 3.20 (-1.00 score delta) during departmental bell-curve calibration.',
        scoreBefore: 4.20,
        scoreAfter: 3.20,
        changeReason: 'Major Q4 production incident on payment gateway not accounted for in manager draft evaluation.',
        details: { overrideDelta: -1.0, flagId: 'flag_001' },
      });
    } else {
      events.push({
        id: `tl_${employeeId}_6`,
        stageName: 'Department HOD Calibration & Normalization',
        stageKey: 'CALIBRATION',
        timestamp: '2026-09-01T11:15:00.000Z',
        actorName: 'Vikram Mehta',
        actorRole: 'HOD',
        status: 'COMPLETED',
        title: 'Bell Curve Calibration Confirmed',
        description: 'Department Head reviewed and validated performance bucket alignment within 15% top-tier quota.',
        scoreBefore: 4.35,
        scoreAfter: 4.35,
      });
    }

    // Increment Decision
    events.push({
      id: `tl_${employeeId}_7`,
      stageName: 'Annual Increment & Merit Band Decision',
      stageKey: 'INCREMENT_DECISION',
      timestamp: '2026-09-01T15:20:00.000Z',
      actorName: 'Priya Sundaram',
      actorRole: 'HR',
      status: 'COMPLETED',
      title: 'Salary Revision & Promotion Formulated',
      description: employeeId === 'emp_dev_2' 
        ? 'Allocated 7.5% merit hike (₹82,500 increment) aligned with calibrated Meets Expectations band.'
        : 'Approved 18.6% increment with Fast-Track Promotion to Senior Software Engineer (Band L4).',
      details: { 
        oldCtc: employee.baseSalary || 1450000, 
        newCtc: employeeId === 'emp_dev_2' ? 1182500 : 1720000,
        incrementPercent: employeeId === 'emp_dev_2' ? 7.5 : 18.6 
      },
    });

    // Letter Release & Acknowledgement
    if (employeeId === 'emp_sales_2') {
      events.push({
        id: `tl_${employeeId}_8`,
        stageName: 'Digital Appraisal Letter Release',
        stageKey: 'LETTER_RELEASE',
        timestamp: '2026-08-15T10:00:00.000Z',
        actorName: 'Priya Sundaram',
        actorRole: 'HR',
        status: 'FLAGGED',
        title: 'Letter Published - Signature Pending',
        description: 'Appraisal letter published to employee portal. Overdue for digital signature (>18 days).',
      });
      events.push({
        id: `tl_${employeeId}_9`,
        stageName: 'Employee Digital Acknowledgement',
        stageKey: 'ACKNOWLEDGEMENT',
        timestamp: 'PENDING',
        actorName: 'Priya Iyer',
        actorRole: 'EMPLOYEE',
        status: 'PENDING',
        title: 'Awaiting Employee Signature',
        description: 'Employee has not yet submitted digital sign-off and OTP verification.',
      });
    } else {
      events.push({
        id: `tl_${employeeId}_8`,
        stageName: 'Digital Appraisal Letter Release',
        stageKey: 'LETTER_RELEASE',
        timestamp: '2026-09-01T16:00:00.000Z',
        actorName: 'Priya Sundaram',
        actorRole: 'HR',
        status: 'COMPLETED',
        title: 'Appraisal Letter Released #AL-2026-CYF-001',
        description: 'Official digital appraisal letter generated and sealed with corporate verification code.',
      });
      events.push({
        id: `tl_${employeeId}_9`,
        stageName: 'Employee Digital Acknowledgement',
        stageKey: 'ACKNOWLEDGEMENT',
        timestamp: '2026-09-01T17:45:15.000Z',
        actorName: employee.fullName,
        actorRole: 'EMPLOYEE',
        status: 'COMPLETED',
        title: 'Digitally Acknowledged & Signed',
        description: 'Employee confirmed and accepted revised terms via authenticated mobile session (IP: 49.36.128.45).',
        details: { signatureHash: 'a7f89b...e21', ipAddress: '49.36.128.45' },
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
    const activeFlags = localComplianceFlags.filter((f) => !f.isResolved);
    const criticalCount = activeFlags.filter((f) => f.severity === 'CRITICAL').length;
    const warningCount = activeFlags.filter((f) => f.severity === 'WARNING').length;

    const overriddenScoresCount = localAuditLogs.filter(
      (log) => log.actionType === 'HOD_CALIBRATION_OVERRIDE'
    ).length;

    const unacknowledgedLettersCount = localComplianceFlags.filter(
      (f) => !f.isResolved && f.flagType === 'UNACKNOWLEDGED_LETTER'
    ).length;

    const overdueSubmissionsCount = localComplianceFlags.filter(
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
      flags: localComplianceFlags,
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
    const { flagId } = req.params;
    const { resolutionNote } = req.body;

    const flagIndex = localComplianceFlags.findIndex((f) => f.id === flagId);
    if (flagIndex === -1) {
      return res.status(404).json({ success: false, error: `Compliance flag ${flagId} not found` });
    }

    const resolvedBy = req.user ? `${req.user.name} (${req.user.role})` : 'HR Compliance Officer';
    localComplianceFlags[flagIndex] = {
      ...localComplianceFlags[flagIndex],
      isResolved: true,
      resolvedAt: new Date().toISOString(),
      resolvedBy,
      resolutionNote: resolutionNote || 'Reviewed and approved by compliance administration.',
    };

    // Also add an audit log entry for this resolution
    const resolveLog: AuditLogEntry = {
      id: `aud_${Date.now()}`,
      timestamp: new Date().toISOString(),
      actionType: 'SECURITY_ROLE_CHANGED', // Or custom admin governance
      module: 'CYCLE_ADMIN',
      severity: 'INFO',
      actorId: req.user?.id || 'usr_admin',
      actorName: req.user?.name || 'Administrator',
      actorRole: req.user?.role || 'SUPER_ADMIN',
      actorEmail: req.user?.email,
      description: `Resolved Compliance Flag [${localComplianceFlags[flagIndex].title}]: ${resolutionNote || 'Marked as compliant.'}`,
      diffSummary: `Flag ${flagId} marked as RESOLVED by ${resolvedBy}`,
      ipAddress: req.ip || '127.0.0.1',
      userAgent: req.headers['user-agent'],
      isFlaggedCompliance: false,
    };
    localAuditLogs.unshift(resolveLog);

    res.json({
      success: true,
      message: 'Compliance flag resolved successfully',
      flag: localComplianceFlags[flagIndex],
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

    localAuditLogs.unshift(newEntry);

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
    const { format = 'json', module } = req.query;

    let dataset = [...localAuditLogs];
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
