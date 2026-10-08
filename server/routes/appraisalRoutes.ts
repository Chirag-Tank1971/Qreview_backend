import { Router, Response } from 'express';
import { getDbCollection } from '../db.js';
import { authenticateToken, requireRoles, AuthenticatedRequest, recordAuditLog } from '../auth.js';
import { syncAllActiveEmployees } from '../syncHelpers.js';
import {
  validateBody,
  ManagerRecommendationSchema,
  HodCalibrationSchema,
  HodReturnSchema,
  HrApprovalSchema,
  LockAppraisalSchema,
  AcknowledgementSchema,
} from '../validation.js';
import {
  Appraisal,
  AppraisalSummaryStats,
  Employee,
  Department,
  Cycle,
  Notification,
} from '../../src/types/index.js';
import { sendNotificationEmail, resolveRecipient } from '../services/emailService.js';
import { renderAppraisalLetterReleasedEmail } from '../services/emailTemplates.js';
import { getActivePipForEmployee } from '../services/pipService.js';
import { checkDepartmentBudget, getDepartmentBudgetSnapshot } from '../services/departmentBudget.js';
import { computeAppraisalMatrix, buildQuarterlyRollup, getRatingBand, RatingBand, refreshAppraisalScore } from '../services/appraisalScoring.js';

export const appraisalRouter = Router();

// Apply real JWT authentication to ALL appraisal routes
appraisalRouter.use(authenticateToken);

/**
 * GET /api/appraisals/due
 * Section 29: Returns only employees whose configured appraisal cycle month is due
 */
appraisalRouter.get(
  '/appraisals/due',
  requireRoles('SUPER_ADMIN', 'HR', 'HOD', 'MANAGEMENT', 'REPORTING_MANAGER', 'MANAGER'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const now = new Date();
      const currentMonth = now.getMonth() + 1;
      const currentYear = now.getFullYear();

      const month = req.query.month ? parseInt(req.query.month as string, 10) : currentMonth;
      const year = req.query.year ? parseInt(req.query.year as string, 10) : currentYear;
      const cycleId = req.query.cycleId as string;

      const cyclesCol = getDbCollection('cycles');
      const employeesCol = getDbCollection('employees');
      const appraisalsCol = getDbCollection('appraisals');

      const allCycles: Cycle[] = await (await cyclesCol.find({})).toArray();
      // Filter active cycles where appraisalMonth matches
      const matchingCycles = allCycles.filter((c) => c.active !== false && c.appraisalMonth === month && (!cycleId || c.id === cycleId));
      const matchingCycleIds = new Set(matchingCycles.map((c) => c.id));
      const matchingCycleCodes = new Set(matchingCycles.map((c) => c.code));

      const activeEmployees: Employee[] = await (await employeesCol.find({ status: 'ACTIVE' })).toArray();
      // Filter employees assigned to these cycles
      let dueEmployees = activeEmployees.filter(
        (e) => (e.cycleId && matchingCycleIds.has(e.cycleId)) || (e.cycleCode && matchingCycleCodes.has(e.cycleCode))
      );

      // Strict role scoping: Managers/HODs only see employees where they actually hold the
      // manager or HOD relationship — checked independently so a person who holds both
      // capacities (e.g. is also the HOD for their own direct reports) sees the union of both,
      // rather than only whichever single role happens to be stored on their account.
      if (['REPORTING_MANAGER', 'MANAGER', 'HOD'].includes(req.user?.role || '')) {
        const deptId = req.employeeProfile?.departmentId;
        dueEmployees = dueEmployees.filter(
          (e) =>
            e.managerId === req.user?.employeeId ||
            e.managerId === req.user?.id ||
            e.hodId === req.user?.employeeId ||
            (req.user?.role === 'HOD' && deptId && e.departmentId === deptId)
        );
      }

      // Check existing appraisal records for this cohort
      const existingAppraisals: Appraisal[] = await (
        await appraisalsCol.find({ appraisalYear: year, appraisalMonth: month })
      ).toArray();
      const appraisalMap = new Map<string, Appraisal>();
      existingAppraisals.forEach((a) => appraisalMap.set(a.employeeId, a));

      const result = dueEmployees.map((emp) => {
        const existing = appraisalMap.get(emp.id);
        const cycle = allCycles.find((c) => c.id === emp.cycleId || c.code === emp.cycleCode);

        return {
          employeeId: emp.id,
          employeeCode: emp.employeeCode,
          employeeName: emp.name,
          departmentName: emp.departmentName,
          designationName: emp.designationName,
          managerName: emp.managerName,
          cycleId: cycle?.id || emp.cycleId,
          cycleCode: cycle?.code || emp.cycleCode,
          cycleName: cycle?.name || 'Cycle',
          appraisalMonth: month,
          appraisalYear: year,
          currentCtc: emp.currentCtc,
          hasInitiatedAppraisal: !!existing,
          appraisalStatus: existing ? existing.status : 'NOT_INITIATED',
          appraisalId: existing?.id,
          finalScore: existing?.averageQuarterlyScore,
          proposedIncrement: existing?.proposedIncrementPercentage,
          approvedIncrement: existing?.approvedIncrementPercentage,
          isLocked: existing?.isLocked || false,
        };
      });

      res.json({
        month,
        year,
        totalDue: result.length,
        initiatedCount: result.filter((r) => r.hasInitiatedAppraisal).length,
        pendingInitiationCount: result.filter((r) => !r.hasInitiatedAppraisal).length,
        employees: result,
      });
    } catch (err: any) {
      console.error('Error in GET /api/appraisals/due:', err);
      res.status(500).json({ error: 'Failed to fetch due appraisals.' });
    }
  }
);

/**
 * GET /api/appraisals
 * List annual appraisals with filtering & strict RBAC data scoping
 */
appraisalRouter.get('/appraisals', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Strict RBAC data scoping on high-speed indexed read
    const { cycleId, year, month, departmentId, status, search, onlyMine, managerId } = req.query;

    const appraisalsCol = getDbCollection('appraisals');
    const employeesCol = getDbCollection('employees');

    const appraisalFilter: any = {};
    if (user.role === 'EMPLOYEE' && user.employeeId) {
      appraisalFilter.employeeId = user.employeeId;
    }
    if (cycleId && cycleId !== 'ALL') {
      appraisalFilter.cycleId = cycleId;
    }
    if (year) {
      const targetYear = parseInt(year as string, 10);
      if (!isNaN(targetYear)) appraisalFilter.appraisalYear = targetYear;
    }
    if (month) {
      const targetMonth = parseInt(month as string, 10);
      if (!isNaN(targetMonth)) appraisalFilter.appraisalMonth = targetMonth;
    }
    if (status && status !== 'ALL') {
      appraisalFilter.status = status;
    }

    let appraisals: Appraisal[] = await (await appraisalsCol.find(appraisalFilter)).toArray();
    const allEmployees: Employee[] = await (await employeesCol.find({})).toArray();
    const empMap = new Map<string, Employee>();
    allEmployees.forEach((e) => empMap.set(e.id, e));

    // Drop orphaned appraisals whose employee record no longer exists
    // (e.g. removed outside the normal delete-employee cascade)
    appraisals = appraisals.filter((a) => empMap.has(a.employeeId));

    // Strict RBAC Scoping:
    if (user.role === 'EMPLOYEE') {
      // Employees can STRICTLY ONLY view their own appraisal record
      appraisals = appraisals.filter((a) => a.employeeId === user.employeeId);
    } else if (['REPORTING_MANAGER', 'MANAGER', 'HOD'].includes(user.role)) {
      // Managers and HODs can view direct reports, their own record, and (for HODs) their
      // department roll-up. The manager and HOD relationships are checked independently so a
      // person who holds both capacities for an employee (e.g. is both their reporting manager
      // and their HOD) sees the record regardless of which single role is stored on their account.
      const isHodRole = user.role === 'HOD';
      appraisals = appraisals.filter((a) => {
        const empRecord = empMap.get(a.employeeId);
        const userDeptId = req.employeeProfile?.departmentId;
        const userDeptName = req.employeeProfile?.departmentName?.toLowerCase();
        return (
          a.managerId === user.employeeId ||
          a.hodId === user.employeeId ||
          a.employeeId === user.employeeId ||
          empRecord?.managerId === user.employeeId ||
          empRecord?.hodId === user.employeeId ||
          (user.email && empRecord?.managerName?.toLowerCase() === user.name.toLowerCase()) ||
          (isHodRole && userDeptId && a.departmentId === userDeptId) ||
          (isHodRole && userDeptId && empRecord?.departmentId === userDeptId) ||
          (isHodRole && userDeptName && a.departmentName?.toLowerCase() === userDeptName)
        );
      });
    }
    // HR, SUPER_ADMIN, MANAGEMENT have organization-wide access

    if (onlyMine === 'true' && user.employeeId) {
      appraisals = appraisals.filter((a) => {
        const empRecord = empMap.get(a.employeeId);
        return (
          (a.managerId === user.employeeId || empRecord?.managerId === user.employeeId) &&
          a.employeeId !== user.employeeId
        );
      });
    }

    // Query Filters
    if (cycleId && cycleId !== 'ALL') {
      appraisals = appraisals.filter((a) => a.cycleId === cycleId);
    }
    if (year) {
      const targetYear = parseInt(year as string, 10);
      if (!isNaN(targetYear)) {
        appraisals = appraisals.filter((a) => a.appraisalYear === targetYear);
      }
    }
    if (month) {
      const targetMonth = parseInt(month as string, 10);
      if (!isNaN(targetMonth)) {
        appraisals = appraisals.filter((a) => a.appraisalMonth === targetMonth);
      }
    }
    if (departmentId && departmentId !== 'ALL') {
      appraisals = appraisals.filter(
        (a) => a.departmentId === departmentId || a.departmentName?.toLowerCase().includes((departmentId as string).toLowerCase())
      );
    }
    if (managerId) {
      appraisals = appraisals.filter((a) => a.managerId === managerId);
    }
    if (status && status !== 'ALL') {
      appraisals = appraisals.filter((a) => a.status === status);
    }
    if (search) {
      const term = (search as string).toLowerCase();
      appraisals = appraisals.filter(
        (a) =>
          a.employeeName.toLowerCase().includes(term) ||
          a.employeeCode.toLowerCase().includes(term) ||
          a.designationName.toLowerCase().includes(term) ||
          a.departmentName.toLowerCase().includes(term)
      );
    }

    // Sort: most recent appraisal year/month, then by score
    appraisals.sort((a, b) => {
      if (a.appraisalYear !== b.appraisalYear) return b.appraisalYear - a.appraisalYear;
      if (a.appraisalMonth !== b.appraisalMonth) return b.appraisalMonth - a.appraisalMonth;
      return b.averageQuarterlyScore - a.averageQuarterlyScore;
    });

    // Enrich with real-time employee employment status
    const enrichedAppraisals = appraisals.map((a) => {
      const empRecord = empMap.get(a.employeeId);
      return {
        ...a,
        employeeStatus: empRecord?.status || a.employeeStatus || 'ACTIVE',
      };
    });

    res.json(enrichedAppraisals);
  } catch (err: any) {
    console.error('Error in GET /api/appraisals:', err);
    res.status(500).json({ error: 'Failed to fetch appraisals' });
  }
});

/**
 * POST /api/appraisals/sync
 * Manually trigger synchronization of active employees, reviews, and appraisals (Restricted to HR / Admin)
 */
appraisalRouter.post(
  '/appraisals/sync',
  requireRoles('SUPER_ADMIN', 'HR'),
  async (_req: AuthenticatedRequest, res: Response) => {
    try {
      const { employeesProcessed } = await syncAllActiveEmployees();
      res.json({
        success: true,
        message: `Synchronized ${employeesProcessed} active/probation employees, their reviews, and appraisals.`,
        employeesProcessed,
      });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to synchronize appraisals: ' + err.message });
    }
  }
);

/**
 * GET /api/appraisals/stats
 * Cohort metrics, budget pool, and calibration distribution (Restricted to HR, Admin, HOD, Management)
 */
appraisalRouter.get(
  '/appraisals/stats',
  requireRoles('SUPER_ADMIN', 'HR', 'HOD', 'MANAGEMENT', 'REPORTING_MANAGER', 'MANAGER'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user;
      const { cycleId, year, departmentId } = req.query;
      const appraisalsCol = getDbCollection('appraisals');
      const employeesCol = getDbCollection('employees');

      let appraisals: Appraisal[] = await (await appraisalsCol.find({})).toArray();
      const allEmployees: Employee[] = await (await employeesCol.find({})).toArray();
      const empMap = new Map<string, Employee>();
      allEmployees.forEach((e) => empMap.set(e.id, e));

      // Role-based scope: manager and HOD relationships are checked independently so a person
      // who holds both capacities for an employee sees the record either way.
      if (['REPORTING_MANAGER', 'MANAGER', 'HOD'].includes(user?.role || '')) {
        const isHodRole = user?.role === 'HOD';
        appraisals = appraisals.filter((a) => {
          const empRecord = empMap.get(a.employeeId);
          const userDeptId = req.employeeProfile?.departmentId;
          const userDeptName = req.employeeProfile?.departmentName?.toLowerCase();
          return (
            a.managerId === user?.employeeId ||
            a.hodId === user?.employeeId ||
            a.employeeId === user?.employeeId ||
            empRecord?.managerId === user?.employeeId ||
            empRecord?.hodId === user?.employeeId ||
            (isHodRole && userDeptId && a.departmentId === userDeptId) ||
            (isHodRole && userDeptId && empRecord?.departmentId === userDeptId) ||
            (isHodRole && userDeptName && a.departmentName?.toLowerCase() === userDeptName)
          );
        });
      }

      if (cycleId && cycleId !== 'ALL') {
        appraisals = appraisals.filter((a) => a.cycleId === cycleId);
      }
      if (year) {
        const targetYear = parseInt(year as string, 10);
        if (!isNaN(targetYear)) {
          appraisals = appraisals.filter((a) => a.appraisalYear === targetYear);
        }
      }
      if (departmentId && departmentId !== 'ALL') {
        appraisals = appraisals.filter((a) => a.departmentId === departmentId);
      }

      const total = appraisals.length;
      const pending = appraisals.filter((a) => a.status === 'PENDING').length;
      const managerRecommended = appraisals.filter((a) => a.status === 'MANAGER_RECOMMENDED').length;
      const hodCalibrated = appraisals.filter((a) => a.status === 'HOD_CALIBRATED').length;
      const hrApproved = appraisals.filter((a) => a.status === 'HR_APPROVED').length;
      const locked = appraisals.filter((a) => a.status === 'LOCKED' || a.isLocked).length;
      const promotionsCount = appraisals.filter((a) => a.promotionRecommended || a.hodCalibration?.promotionApproved).length;

      // Unscored appraisals (no evaluated quarters yet) are excluded from the average and bands.
      const scored = appraisals.filter((a) => (a.averageQuarterlyScore || 0) > 0);
      const averageScore = scored.length > 0
        ? Number((scored.reduce((acc, a) => acc + a.averageQuarterlyScore, 0) / scored.length).toFixed(2))
        : 0;

      const totalCurrentPayroll = appraisals.reduce((acc, a) => acc + (a.currentCtc || 0), 0);
      const totalRevisedPayroll = appraisals.reduce((acc, a) => acc + (a.revisedCtc || a.currentCtc || 0), 0);
      const totalIncrementBudgetImpact = totalRevisedPayroll - totalCurrentPayroll;

      const increments = appraisals.map((a) => a.approvedIncrementPercentage || a.proposedIncrementPercentage || 0);
      const averageIncrement =
        increments.length > 0
          ? Number((increments.reduce((sum, val) => sum + val, 0) / increments.length).toFixed(2))
          : 0;

      const ratingDistribution = {
        outstanding: appraisals.filter((a) => getRatingBand(a) === 'OUTSTANDING').length,
        exceeds: appraisals.filter((a) => getRatingBand(a) === 'EXCEEDS_EXPECTATIONS').length,
        meets: appraisals.filter((a) => getRatingBand(a) === 'MEETS_EXPECTATIONS').length,
        needsImprovement: appraisals.filter((a) => getRatingBand(a) === 'NEEDS_IMPROVEMENT').length,
      };

      const stats: AppraisalSummaryStats = {
        total,
        pending,
        managerRecommended,
        hodCalibrated,
        hrApproved,
        locked,
        promotionsCount,
        averageScore,
        averageIncrement,
        totalCurrentPayroll,
        totalRevisedPayroll,
        totalIncrementBudgetImpact,
        ratingDistribution,
      };

      res.json(stats);
    } catch (err: any) {
      console.error('Error in GET /api/appraisals/stats:', err);
      res.status(500).json({ error: 'Failed to fetch appraisal stats' });
    }
  }
);

/**
 * GET /api/appraisals/analytics/executive
 * Comprehensive Executive Dashboard data: Cross-department budget pools, Bell Curve Normalization curves,
 * attrition flight-risk retention analytics, and appraisal cycle execution benchmarks.
 */
appraisalRouter.get(
  '/appraisals/analytics/executive',
  requireRoles('SUPER_ADMIN', 'HR', 'HOD', 'MANAGEMENT'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { cycleId, year } = req.query;
      const appraisalsCol = getDbCollection('appraisals');
      const departmentsCol = getDbCollection('departments');
      const employeesCol = getDbCollection('employees');
      const cyclesCol = getDbCollection('cycles');

      let allAppraisals: Appraisal[] = await (await appraisalsCol.find({})).toArray();
      const allDeptsRaw: any[] = await (await departmentsCol.find({})).toArray();
      const allDepartments: Department[] = allDeptsRaw.filter(
        (d) => d.active !== false && d.isActive !== false && d.status !== 'INACTIVE'
      );
      const allEmployees: Employee[] = await (await employeesCol.find({ status: { $ne: 'INACTIVE' } })).toArray();
      const allCyclesRaw: Cycle[] = await (await cyclesCol.find({})).toArray();
      const allCycles: Cycle[] = allCyclesRaw.filter((c) => c.active !== false);

      if (cycleId && cycleId !== 'ALL') {
        allAppraisals = allAppraisals.filter((a) => a.cycleId === cycleId);
      }
      if (year) {
        const targetYear = parseInt(year as string, 10);
        if (!isNaN(targetYear)) {
          allAppraisals = allAppraisals.filter((a) => a.appraisalYear === targetYear);
        }
      }

      const totalAppraisals = allAppraisals.length;
      const totalCurrentPayroll = allAppraisals.reduce((acc, a) => acc + (a.currentCtc || 0), 0);
      const totalRevisedPayroll = allAppraisals.reduce((acc, a) => acc + (a.revisedCtc || a.currentCtc || 0), 0);
      const totalBudgetSpent = totalRevisedPayroll - totalCurrentPayroll;
      let totalBudgetCap = totalCurrentPayroll * 0.12; // 12% organizational default fallback

      // Rating bands: calibrated finalRating when set, else the rolling score's band. Appraisals
      // with no evaluated quarters are UNRATED and kept out of the distribution percentages —
      // previously their 0 score dropped them all into "Needs Improvement".
      const bandOf = new Map(allAppraisals.map((a) => [a.id, getRatingBand(a)]));
      const countBands = (list: Appraisal[]) => {
        const counts: Record<RatingBand | 'UNRATED', number> = {
          OUTSTANDING: 0, EXCEEDS_EXPECTATIONS: 0, MEETS_EXPECTATIONS: 0, NEEDS_IMPROVEMENT: 0, UNRATED: 0,
        };
        list.forEach((a) => counts[bandOf.get(a.id) || 'UNRATED']++);
        return { counts, rated: list.length - counts.UNRATED };
      };
      const pct = (n: number, of: number) => (of > 0 ? Number(((n / of) * 100).toFixed(1)) : 0);
      const scoredAvg = (list: Appraisal[]) => {
        const scored = list.filter((a) => (a.averageQuarterlyScore || 0) > 0);
        return scored.length > 0
          ? Number((scored.reduce((s, a) => s + a.averageQuarterlyScore, 0) / scored.length).toFixed(2))
          : 0;
      };
      // An appraisal belongs to a department by ID; the name is only a fallback for legacy
      // records with no departmentId (two departments can share a name, e.g. two "Service").
      const inDept = (rec: { departmentId?: string; departmentName?: string }, dept: Department) =>
        rec.departmentId
          ? rec.departmentId === dept.id
          : Boolean(rec.departmentName && dept.name && rec.departmentName.trim().toLowerCase() === dept.name.trim().toLowerCase());

      const averageScore = scoredAvg(allAppraisals);
      const totalIncrements = allAppraisals.reduce(
        (acc, a) => acc + (a.approvedIncrementPercentage || a.proposedIncrementPercentage || 0),
        0
      );
      const averageIncrementPercent = totalAppraisals > 0 ? Number((totalIncrements / totalAppraisals).toFixed(2)) : 0;
      // Committed = appraisals whose revised CTC has actually been set above current CTC.
      const committed = allAppraisals.filter((a) => (a.revisedCtc || 0) > (a.currentCtc || 0));
      const committedAverageIncrementPercent = committed.length > 0
        ? Number((committed.reduce((s, a) => s + ((a.revisedCtc - a.currentCtc) / (a.currentCtc || 1)) * 100, 0) / committed.length).toFixed(2))
        : 0;
      const promotionsCount = allAppraisals.filter((a) => a.promotionRecommended || a.hodCalibration?.promotionApproved).length;

      // Overall Target vs Actual Distribution
      const { counts: orgCounts, rated: orgRated } = countBands(allAppraisals);
      const countOutstanding = orgCounts.OUTSTANDING;
      const countExceeds = orgCounts.EXCEEDS_EXPECTATIONS;
      const countMeets = orgCounts.MEETS_EXPECTATIONS;
      const countNeedsImp = orgCounts.NEEDS_IMPROVEMENT;

      const actualDist = {
        outstanding: pct(countOutstanding, orgRated),
        exceeds: pct(countExceeds, orgRated),
        meets: pct(countMeets, orgRated),
        needsImprovement: pct(countNeedsImp, orgRated),
      };

      // Departmental Budget Pools & Bell Curves
      const departmentBudgets: any[] = [];
      const departmentBellCurves: any[] = [];

      allDepartments.forEach((dept) => {
        const deptAppraisals = allAppraisals.filter((a) => inDept(a, dept));
        const deptEmployees = allEmployees.filter((e) =>
          inDept({ departmentId: e.departmentId, departmentName: e.departmentName || (e as any).department }, dept)
        );

        // The pool covers only the employees actually being appraised in the selected cohort.
        // A department with no appraisals here has no pool — falling back to its whole
        // payroll (as before) added budget to the org total for people not in the cohort,
        // which is what inflated the overall cap % above every department's own cap.
        const headcount = deptAppraisals.length;
        const currentCtc = deptAppraisals.reduce((sum, a) => sum + (a.currentCtc || 0), 0);

        const budgetCapPercent = typeof dept.budgetCapPercent === 'number' && dept.budgetCapPercent >= 0 ? dept.budgetCapPercent : 12.0;
        const allocatedBudgetAmount = currentCtc * (budgetCapPercent / 100);
        const revisedCtc = deptAppraisals.reduce((sum, a) => sum + (a.revisedCtc || a.currentCtc || 0), 0);
        const actualSpentAmount = revisedCtc - currentCtc;
        const remainingBudgetAmount = allocatedBudgetAmount - actualSpentAmount;
        const actualSpentPercent = currentCtc > 0 ? Number(((actualSpentAmount / currentCtc) * 100).toFixed(2)) : 0;
        const isOverBudget = actualSpentAmount > allocatedBudgetAmount;

        let status: 'WITHIN_BUDGET' | 'NEAR_CAP' | 'EXCEEDED' = 'WITHIN_BUDGET';
        if (isOverBudget) status = 'EXCEEDED';
        else if (actualSpentAmount > allocatedBudgetAmount * 0.9) status = 'NEAR_CAP';

        const avgScore = scoredAvg(deptAppraisals);
        const deptIncs = deptAppraisals.reduce((sum, a) => sum + (a.approvedIncrementPercentage || a.proposedIncrementPercentage || 0), 0);
        const avgInc = deptAppraisals.length > 0 ? Number((deptIncs / deptAppraisals.length).toFixed(2)) : 0;
        const promoCount = deptAppraisals.filter((a) => a.promotionRecommended || a.hodCalibration?.promotionApproved).length;

        departmentBudgets.push({
          departmentId: dept.id,
          departmentName: dept.name,
          departmentCode: dept.code,
          headcount,
          employeeHeadcount: deptEmployees.length,
          inCohort: headcount > 0,
          totalCurrentCtc: currentCtc,
          budgetCapPercent,
          allocatedBudgetAmount,
          actualSpentAmount,
          remainingBudgetAmount,
          actualSpentPercent,
          isOverBudget,
          status,
          averageScore: avgScore,
          averageIncrement: avgInc,
          promotionsCount: promoCount,
        });

        // Bell curve for department (based on active appraisals in this cycle/cohort)
        const totalDeptAppraisals = deptAppraisals.length;
        const { counts: deptCounts, rated: ratedDeptAppraisals } = countBands(deptAppraisals);
        const deptOut = deptCounts.OUTSTANDING;
        const deptExc = deptCounts.EXCEEDS_EXPECTATIONS;
        const deptMet = deptCounts.MEETS_EXPECTATIONS;
        const deptNid = deptCounts.NEEDS_IMPROVEMENT;

        const pOut = pct(deptOut, ratedDeptAppraisals);
        const pExc = pct(deptExc, ratedDeptAppraisals);
        const pMet = pct(deptMet, ratedDeptAppraisals);
        const pNid = pct(deptNid, ratedDeptAppraisals);

        let skewAlert: string | undefined = undefined;
        let skewSeverity: 'NORMAL' | 'WARNING' | 'CRITICAL' = 'NORMAL';

        // Overrun is checked first so the most severe alert isn't masked by a distribution warning.
        if (isOverBudget) {
          skewAlert = `Budget Overrun: Actual increment spend of ${actualSpentPercent}% exceeds ${budgetCapPercent}% departmental limit.`;
          skewSeverity = 'CRITICAL';
        } else if (ratedDeptAppraisals > 0) {
          if (pOut > 30) {
            skewAlert = `Inflation Alert: ${pOut}% top performers exceeds 10% target guideline. HOD normalization recommended.`;
            skewSeverity = 'WARNING';
          } else if (pNid === 0 && ratedDeptAppraisals >= 5) {
            skewAlert = `Zero bottom bucket distribution with ${ratedDeptAppraisals} rated employees. Check for lenient rating bias.`;
            skewSeverity = 'WARNING';
          }
        }

        departmentBellCurves.push({
          departmentId: dept.id,
          departmentName: dept.name,
          departmentCode: dept.code,
          totalEmployees: totalDeptAppraisals,
          ratedEmployees: ratedDeptAppraisals,
          unratedEmployees: deptCounts.UNRATED,
          skewAlert,
          skewSeverity,
          buckets: [
            {
              ratingBand: 'OUTSTANDING',
              label: 'Outstanding (Top 10%)',
              scoreRange: '4.50 - 5.00',
              targetPercent: 10,
              actualCount: deptOut,
              actualPercent: pOut,
              deltaPercent: Number((pOut - 10).toFixed(1)),
              status: pOut > 15 ? 'SURPLUS' : pOut < 5 ? 'DEFICIT' : 'ALIGNED',
              color: '#10b981',
            },
            {
              ratingBand: 'EXCEEDS_EXPECTATIONS',
              label: 'Exceeds (25%)',
              scoreRange: '3.80 - 4.49',
              targetPercent: 25,
              actualCount: deptExc,
              actualPercent: pExc,
              deltaPercent: Number((pExc - 25).toFixed(1)),
              status: pExc > 35 ? 'SURPLUS' : pExc < 15 ? 'DEFICIT' : 'ALIGNED',
              color: '#3b82f6',
            },
            {
              ratingBand: 'MEETS_EXPECTATIONS',
              label: 'Meets Expectations (45%)',
              scoreRange: '2.80 - 3.79',
              targetPercent: 45,
              actualCount: deptMet,
              actualPercent: pMet,
              deltaPercent: Number((pMet - 45).toFixed(1)),
              status: pMet > 60 ? 'SURPLUS' : pMet < 30 ? 'DEFICIT' : 'ALIGNED',
              color: '#6366f1',
            },
            {
              ratingBand: 'NEEDS_IMPROVEMENT',
              label: 'Needs Improvement (20%)',
              scoreRange: '< 2.80',
              targetPercent: 20,
              actualCount: deptNid,
              actualPercent: pNid,
              deltaPercent: Number((pNid - 20).toFixed(1)),
              status: pNid > 25 ? 'SURPLUS' : pNid < 10 ? 'DEFICIT' : 'ALIGNED',
              color: '#f59e0b',
            },
          ],
        });
      });

      const sumAllocatedDepts = departmentBudgets.reduce((acc, d) => acc + (d.allocatedBudgetAmount || 0), 0);
      if (sumAllocatedDepts > 0) {
        totalBudgetCap = sumAllocatedDepts;
      }

      // High Performer Retention & Flight Risk Insights
      // Risk is derived only from data the system holds: the employee's increment compared
      // with this system's own guideline band for their score (computeAppraisalMatrix) and
      // with the average increment of the other top performers in the selected cohort. There
      // is no external market/salary-survey data here, so none is implied.
      const TOP_PERFORMER_SCORE = 4.2;
      const incrementOf = (a: Appraisal) => a.approvedIncrementPercentage || a.proposedIncrementPercentage || 0;
      const topPerformers = allAppraisals.filter((a) => (a.averageQuarterlyScore || 0) >= TOP_PERFORMER_SCORE);
      const attritionRiskInsights: any[] = topPerformers.map((a) => {
        const score = a.averageQuarterlyScore;
        const increment = incrementOf(a);
        const band = computeAppraisalMatrix(score);
        const bandMid = (band.suggestedIncrementMin + band.suggestedIncrementMax) / 2;
        const peers = topPerformers.filter((p) => p.id !== a.id);
        const peerAvg = peers.length > 0
          ? Number((peers.reduce((s, p) => s + incrementOf(p), 0) / peers.length).toFixed(1))
          : null;
        const bandLabel = `${band.recommendedRating.replace(/_/g, ' ').toLowerCase()} guideline band (${band.suggestedIncrementMin}–${band.suggestedIncrementMax}%)`;
        const isSystemDefault = a.status === 'PENDING' && !a.managerRecommendation;

        let flightRisk: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
        let riskReason = `+${increment}% is within the ${bandLabel}.`;
        let action = 'Maintain standard progression and career mapping.';

        if (increment < band.suggestedIncrementMin) {
          flightRisk = 'HIGH';
          riskReason = `Score ${score.toFixed(2)} but +${increment}% is below the ${bandLabel}.`;
          action = 'Raise to at least the band minimum, or record a justification for the lower increment.';
        } else if (increment < bandMid || (peerAvg !== null && increment < peerAvg - 2)) {
          flightRisk = 'MEDIUM';
          riskReason =
            increment < bandMid
              ? `+${increment}% is in the lower half of the ${bandLabel}.`
              : `+${increment}% is more than 2 points below the ${peerAvg}% average for other top performers in this cohort.`;
          action = 'Review during HOD calibration and hold a career growth conversation.';
        }
        if (isSystemDefault) {
          riskReason += ' (System default — manager has not proposed an increment yet.)';
        }

        return {
          employeeId: a.employeeId,
          employeeName: a.employeeName,
          employeeCode: a.employeeCode,
          departmentName: a.departmentName,
          designationName: a.designationName,
          score,
          incrementPercent: increment,
          rating: a.recommendedRating,
          guidelineMinPercent: band.suggestedIncrementMin,
          guidelineMaxPercent: band.suggestedIncrementMax,
          peerAverageIncrementPercent: peerAvg,
          isSystemDefaultIncrement: isSystemDefault,
          flightRisk,
          riskReason,
          recommendedRetentionAction: action,
        };
      });
      const riskOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      attritionRiskInsights.sort((x, y) => riskOrder[x.flightRisk as 'HIGH'] - riskOrder[y.flightRisk as 'HIGH'] || y.score - x.score);

      // Appraisal Cycle Progress Comparison
      const cycleProgressComparison = allCycles.map((c) => {
        const monthNames = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
        const cycleAppraisals = allAppraisals.filter((a) => a.cycleId === c.id || a.cycleCode === c.code);
        const headcount = allEmployees.filter((e) => e.cycleId === c.id || e.cycleCode === c.code).length;
        const locked = cycleAppraisals.filter((a) => a.isLocked || a.status === 'LOCKED').length;
        const completionPercent = headcount > 0 ? Math.min(100, Math.round((locked / headcount) * 100)) : 0;
        const incTotal = cycleAppraisals.reduce((sum, a) => sum + (a.approvedIncrementPercentage || a.proposedIncrementPercentage || 0), 0);
        const avgInc = cycleAppraisals.length > 0 ? Number((incTotal / cycleAppraisals.length).toFixed(1)) : 0;

        let status: 'COMPLETED' | 'IN_PROGRESS' | 'UPCOMING' = 'UPCOMING';
        if (completionPercent === 100 && headcount > 0) status = 'COMPLETED';
        else if (cycleAppraisals.length > 0) status = 'IN_PROGRESS';

        return {
          cycleCode: c.code,
          cycleName: c.name,
          appraisalMonthName: monthNames[c.appraisalMonth] || `Month ${c.appraisalMonth}`,
          headcount,
          completionPercent,
          avgIncrement: avgInc,
          status,
        };
      });

      res.json({
        cohortSummary: {
          totalEmployees: allEmployees.length,
          totalActiveAppraisals: totalAppraisals,
          ratedAppraisals: orgRated,
          unratedAppraisals: orgCounts.UNRATED,
          averageScore,
          averageIncrementPercent,
          committedAppraisals: committed.length,
          committedAverageIncrementPercent,
          totalPayrollPre: totalCurrentPayroll,
          totalPayrollPost: totalRevisedPayroll,
          totalBudgetSpent,
          totalBudgetCap,
          promotionsCount,
        },
        bellCurveDistribution: {
          target: { outstanding: 10, exceeds: 25, meets: 45, needsImprovement: 20 },
          actual: actualDist,
          actualCount: {
            outstanding: countOutstanding,
            exceeds: countExceeds,
            meets: countMeets,
            needsImprovement: countNeedsImp,
            unrated: orgCounts.UNRATED,
          },
        },
        departmentBudgets,
        departmentBellCurves,
        attritionRiskInsights,
        cycleProgressComparison,
      });
    } catch (err: any) {
      console.error('Error in GET /api/appraisals/analytics/executive:', err);
      res.status(500).json({ error: 'Failed to generate executive analytics' });
    }
  }
);

/**
 * GET /api/appraisals/:id
 * Retrieve single appraisal details with full 4-quarter review snapshot and strict IDOR check
 */
appraisalRouter.get('/appraisals/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const appraisalsCol = getDbCollection('appraisals');
    const appraisal: Appraisal | null = await appraisalsCol.findOne({ id });

    if (!appraisal) {
      return res.status(404).json({ error: 'Appraisal record not found' });
    }

    // Ownership & Role Verification (IDOR Protection)
    const employeesCol = getDbCollection('employees');
    const empRecord = await employeesCol.findOne({ id: appraisal.employeeId });

    if (user.role === 'EMPLOYEE') {
      if (appraisal.employeeId !== user.employeeId) {
        return res.status(403).json({ error: 'Access denied: You can only view your own appraisal record.' });
      }
    } else if (user.role === 'REPORTING_MANAGER' || user.role === 'MANAGER') {
      const isManagerMatch =
        appraisal.managerId === user.employeeId ||
        appraisal.hodId === user.employeeId ||
        appraisal.employeeId === user.employeeId ||
        empRecord?.managerId === user.employeeId ||
        empRecord?.hodId === user.employeeId ||
        (user.name && empRecord?.managerName?.toLowerCase() === user.name.toLowerCase());

      if (!isManagerMatch) {
        return res.status(403).json({ error: 'Access denied: You can only view appraisals for your direct reports.' });
      }
    } else if (user.role === 'HOD') {
      const isDeptMatch =
        (req.employeeProfile?.departmentId && appraisal.departmentId === req.employeeProfile.departmentId) ||
        (req.employeeProfile?.departmentName && appraisal.departmentName?.toLowerCase() === req.employeeProfile.departmentName.toLowerCase()) ||
        (req.employeeProfile?.departmentId && empRecord?.departmentId === req.employeeProfile.departmentId);

      const isHodMatch =
        appraisal.hodId === user.employeeId ||
        appraisal.managerId === user.employeeId ||
        appraisal.employeeId === user.employeeId ||
        empRecord?.hodId === user.employeeId ||
        empRecord?.managerId === user.employeeId ||
        isDeptMatch;

      if (!isHodMatch) {
        return res.status(403).json({ error: 'Access denied: You can only view appraisals within your department.' });
      }
    }

    res.json({
      ...appraisal,
      employeeStatus: empRecord?.status || appraisal.employeeStatus || 'ACTIVE',
    });
  } catch (err: any) {
    console.error('Error in GET /api/appraisals/:id:', err);
    res.status(500).json({ error: 'Failed to fetch appraisal' });
  }
});

/**
 * POST /api/appraisals/initiate-cycle
 * Batch roll up 4-quarter reviews and initiate annual appraisals for an appraisal cycle cohort (Super Admin & HR only)
 */
appraisalRouter.post(
  '/appraisals/initiate-cycle',
  requireRoles('SUPER_ADMIN', 'HR'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user;
      const { cycleId, appraisalYear = 2026, overrideExisting = false } = req.body;

      if (!cycleId) {
        return res.status(400).json({ error: 'cycleId is required to initiate appraisal cohort' });
      }

      const cyclesCol = getDbCollection('cycles');
      const cycle: Cycle | null = await cyclesCol.findOne({ id: cycleId });
      if (!cycle) {
        return res.status(404).json({ error: 'Appraisal Cycle not found' });
      }

      const employeesCol = getDbCollection('employees');
      const appraisalsCol = getDbCollection('appraisals');
      const notificationsCol = getDbCollection('notifications');

      const eligibleEmployees: Employee[] = await (
        await employeesCol.find({
          $or: [{ cycleId: cycle.id }, { cycleCode: cycle.code }],
          status: { $ne: 'INACTIVE' },
        })
      ).toArray();

      if (eligibleEmployees.length === 0) {
        return res.status(400).json({ error: `No active employees found assigned to ${cycle.name}` });
      }

      let createdCount = 0;
      let updatedCount = 0;
      let skippedForPipCount = 0;

      for (const emp of eligibleEmployees) {
        const existing: Appraisal | null = await appraisalsCol.findOne({
          employeeId: emp.id,
          appraisalYear,
        });

        if (existing && !overrideExisting) {
          continue;
        }

        // Employees currently on an active performance improvement plan are not eligible for
        // annual appraisal/increment processing until the plan resolves (succeeds, fails, or
        // is cancelled) — never silently include them.
        const activePip = await getActivePipForEmployee(emp.id);
        if (activePip) {
          skippedForPipCount++;
          continue;
        }

        // Rolling score: average of the latest 4 manager-evaluated quarters
        const { quarterlyHistory, avgScore, evaluatedCount } = await buildQuarterlyRollup(emp.id);
        const hasScores = evaluatedCount > 0;

        const matrix = computeAppraisalMatrix(avgScore);
        const currentCtc = emp.currentCtc || 0;
        const proposedIncrementPercent = hasScores ? matrix.defaultIncrement : 0;

        const appraisalDoc: Appraisal = {
          id: existing ? existing.id : `appr_${appraisalYear}_${emp.id}`,
          employeeId: emp.id,
          employeeCode: emp.employeeCode,
          employeeName: emp.name,
          departmentId: emp.departmentId,
          departmentName: emp.departmentName || 'General',
          designationId: emp.designationId,
          designationName: emp.designationName || 'Specialist',
          managerId: emp.managerId,
          managerName: emp.managerName,
          hodId: emp.hodId,
          hodName: emp.hodName,
          cycleId: cycle.id,
          cycleCode: cycle.code,
          cycleName: cycle.name,
          cycleColor: cycle.colorHex,
          appraisalYear,
          appraisalMonth: cycle.appraisalMonth,
          currentCtc,
          currency: emp.currency || '₹',
          quarterlyHistory,
          averageQuarterlyScore: avgScore,
          evaluatedQuarterCount: evaluatedCount,
          recommendedRating: hasScores ? matrix.recommendedRating : 'PENDING',
          suggestedIncrementMin: hasScores ? matrix.suggestedIncrementMin : 0,
          suggestedIncrementMax: hasScores ? matrix.suggestedIncrementMax : 0,
          finalRating: hasScores ? matrix.recommendedRating : 'PENDING',
          proposedIncrementPercentage: proposedIncrementPercent,
          approvedIncrementPercentage: 0,
          incrementAmount: 0,
          revisedCtc: currentCtc,
          promotionRecommended: false,
          effectiveDate: (() => {
            const m = cycle.appraisalMonth || 1;
            const effMonth = (m % 12) + 1;
            const effYear = m === 12 ? appraisalYear + 1 : appraisalYear;
            return `${effYear}-${String(effMonth).padStart(2, '0')}-01`;
          })(),
          status: 'PENDING',
          isLocked: false,
          createdAt: existing ? existing.createdAt : new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        if (existing) {
          await appraisalsCol.updateOne({ id: existing.id }, { $set: appraisalDoc });
          updatedCount++;
        } else {
          await appraisalsCol.insertOne(appraisalDoc);
          createdCount++;
        }

        // Create Notification for Manager
        if (emp.managerId) {
          const notif: Notification = {
            id: `notif_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            userId: emp.managerId,
            type: 'APPRAISAL_DUE',
            title: `Annual Appraisal Calibration Due: ${emp.name}`,
            message: `${emp.name} (${emp.employeeCode}) is due for ${cycle.name} annual appraisal and salary calibration.`,
            isRead: false,
            createdAt: new Date().toISOString(),
          };
          await notificationsCol.insertOne(notif);
        }
      }

      // Audit Log
      if (user) {
        await recordAuditLog(
          user.id,
          user.name,
          user.role,
          'ANNUAL_APPRAISAL',
          'BATCH_INITIATE_COHORT',
          cycle.id,
          '',
          `Initiated ${createdCount + updatedCount} appraisals for ${cycle.name} (${appraisalYear})${skippedForPipCount > 0 ? `; skipped ${skippedForPipCount} on active PIP` : ''}`,
          'Generated rolling 4-quarter performance rollups and standard increment recommendations.'
        );
      }

      res.json({
        message: `Successfully initiated ${cycle.name} cohort appraisals for ${appraisalYear}.${skippedForPipCount > 0 ? ` ${skippedForPipCount} employee(s) on an active performance improvement plan were skipped.` : ''}`,
        cycleName: cycle.name,
        createdCount,
        updatedCount,
        skippedForPipCount,
        totalEligible: eligibleEmployees.length,
      });
    } catch (err: any) {
      console.error('Error in POST /api/appraisals/initiate-cycle:', err);
      res.status(500).json({ error: err.message || 'Failed to initiate cycle appraisals' });
    }
  }
);

/**
 * GET /api/appraisals/:id/budget
 * Department budget pool for this appraisal, so the calibration UI can warn before submit.
 * The same pool is enforced server-side on every increment write (see checkDepartmentBudget).
 */
appraisalRouter.get(
  '/appraisals/:id/budget',
  requireRoles('SUPER_ADMIN', 'HR', 'HOD', 'MANAGEMENT', 'REPORTING_MANAGER', 'MANAGER'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const appraisal: Appraisal | null = await getDbCollection('appraisals').findOne({ id: req.params.id });
      if (!appraisal) {
        return res.status(404).json({ error: 'Appraisal record not found' });
      }
      res.json(await getDepartmentBudgetSnapshot(appraisal));
    } catch (err: any) {
      console.error('Error in GET /api/appraisals/:id/budget:', err);
      res.status(500).json({ error: err.message || 'Failed to load department budget' });
    }
  }
);

/**
 * PUT /api/appraisals/:id/manager-recommend
 * Manager submits recommended increment %, promotion recommendation, and qualitative justification
 */
appraisalRouter.put(
  '/appraisals/:id/manager-recommend',
  requireRoles('REPORTING_MANAGER', 'MANAGER', 'HOD', 'MANAGEMENT', 'SUPER_ADMIN'),
  validateBody(ManagerRecommendationSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user;
      const { id } = req.params;
      const {
        suggestedIncrementPercent,
        promotionRecommended,
        promotionDesignationId,
        promotionDesignationName,
        justification,
        strengthsSummary,
      } = req.body;

      const appraisalsCol = getDbCollection('appraisals');
      const appraisal: Appraisal | null = await appraisalsCol.findOne({ id });

      if (!appraisal) {
        return res.status(404).json({ error: 'Appraisal record not found' });
      }

      if (appraisal.isLocked) {
        return res.status(400).json({ error: 'Cannot modify a locked appraisal record' });
      }

      // Mandatory-stage guard: manager can only submit/revise before HOD has calibrated
      if (!['PENDING', 'MANAGER_RECOMMENDED'].includes(appraisal.status)) {
        return res.status(400).json({
          error: `Cannot submit manager recommendation in status "${appraisal.status}". Must be PENDING or MANAGER_RECOMMENDED.`,
        });
      }

      // Safeguard: Check employee status
      const employeesCol = getDbCollection('employees');
      const empRecord = await employeesCol.findOne({ id: appraisal.employeeId });
      if (empRecord && empRecord.status === 'INACTIVE') {
        return res.status(400).json({ error: 'Cannot submit recommendation: Employee is INACTIVE (Offboarded/Exited).' });
      }
      if (empRecord && empRecord.status === 'NOTICE') {
        return res.status(400).json({ error: 'Cannot submit recommendation: Employee is currently serving NOTICE period and ineligible for annual increment/promotion.' });
      }
      if (await getActivePipForEmployee(appraisal.employeeId)) {
        return res.status(400).json({ error: 'Cannot submit recommendation: Employee is currently on an active performance improvement plan and ineligible for annual increment/promotion until it resolves.' });
      }

      // Ownership check: caller must actually be the assigned reporting manager for this
      // employee (regardless of their account's stored role label — a person can hold the
      // manager relationship on a record even if their account role is HOD/MANAGEMENT/etc).
      if (
        user?.role !== 'SUPER_ADMIN' &&
        appraisal.managerId !== user?.employeeId &&
        appraisal.managerId !== user?.id
      ) {
        return res.status(403).json({ error: 'Unauthorized: You can only submit recommendations for your assigned direct reports.' });
      }

      const currentCtc = appraisal.currentCtc;
      const incPercent = Number(suggestedIncrementPercent) || appraisal.suggestedIncrementMin || 10;
      const incrementAmount = Math.round((currentCtc * incPercent) / 100);
      const revisedCtc = currentCtc + incrementAmount;

      const budgetError = await checkDepartmentBudget(appraisal, incrementAmount);
      if (budgetError) {
        return res.status(400).json({ error: budgetError, code: 'BUDGET_CAP_EXCEEDED' });
      }

      const managerRecommendation = {
        suggestedIncrementPercent: incPercent,
        promotionRecommended: Boolean(promotionRecommended),
        promotionDesignationId: promotionDesignationId || undefined,
        promotionDesignationName: promotionDesignationName || undefined,
        justification: justification || 'Recommended based on rolling quarterly performance.',
        strengthsSummary: strengthsSummary || '',
        recommendedBy: user?.id || user?.employeeId || '',
        recommendedByName: user?.name || 'Reporting Manager',
        recommendedAt: new Date().toISOString(),
      };

      const updatedDoc: Partial<Appraisal> = {
        proposedIncrementPercentage: incPercent,
        approvedIncrementPercentage: incPercent,
        incrementAmount,
        revisedCtc,
        promotionRecommended: Boolean(promotionRecommended),
        promotionDesignationId: promotionDesignationId || undefined,
        promotionDesignationName: promotionDesignationName || undefined,
        managerRecommendation,
        status: 'MANAGER_RECOMMENDED',
        remarks: `Manager evaluation submitted (${incPercent}% increment${promotionRecommended ? ' + Promotion' : ''}).`,
        updatedAt: new Date().toISOString(),
      };

      await appraisalsCol.updateOne({ id }, { $set: updatedDoc, $unset: { hodReturn: '' } });

      const hodMissing = !appraisal.hodId;

      // Notify HOD, or HR if no HOD is configured for this employee (missing-HOD exception)
      const notifsCol = getDbCollection('notifications');
      if (hodMissing) {
        await notifsCol.updateOne(
          { 'metadata.appraisalId': id, type: 'APPRAISAL_HOD_MISSING_EXCEPTION' },
          {
            $set: {
              id: `notif_${id}_hod_missing`,
              userId: 'ALL',
              userRole: 'HR',
              type: 'APPRAISAL_HOD_MISSING_EXCEPTION',
              title: `Action Required: No HOD Assigned - ${appraisal.employeeName}`,
              message: `Manager recommendation submitted for ${appraisal.employeeName}, but no HOD is configured for this employee. Assign an HOD via Employee Master to unblock calibration.`,
              isRead: false,
              priority: 'HIGH',
              metadata: { appraisalId: id, cycleId: appraisal.cycleId, activeSection: 'appraisals' },
              createdAt: new Date().toISOString(),
            },
          },
          { upsert: true }
        );
      } else {
        await notifsCol.updateOne(
          { 'metadata.appraisalId': id, type: 'HOD_ACTION_REQUIRED' },
          {
            $set: {
              id: `notif_${id}_hod`,
              userId: appraisal.hodId,
              userRole: 'HOD',
              type: 'HOD_ACTION_REQUIRED',
              title: `Manager Appraisal Submitted: ${appraisal.employeeName}`,
              message: `${user?.name || 'Manager'} submitted recommendation (${incPercent}% increment${promotionRecommended ? ' + Promotion' : ''}) for ${appraisal.employeeName}. Ready for HOD calibration.`,
              isRead: false,
              priority: 'HIGH',
              metadata: { appraisalId: id, cycleId: appraisal.cycleId, activeSection: 'appraisals' },
              createdAt: new Date().toISOString(),
            },
          },
          { upsert: true }
        );
      }

      // Audit log
      if (user) {
        await recordAuditLog(
          user.id,
          user.name,
          user.role,
          'APPRAISAL_CALIBRATION',
          hodMissing ? 'MANAGER_RECOMMENDATION_SUBMITTED_HOD_MISSING' : 'MANAGER_RECOMMENDATION_SUBMITTED',
          id,
          String(appraisal.proposedIncrementPercentage || 0),
          `Suggested ${incPercent}% increment, Promotion: ${promotionRecommended ? 'YES' : 'NO'}`,
          justification || ''
        );
      }

      const refreshed = await appraisalsCol.findOne({ id });
      console.log(`[Appraisal] Manager recommendation submitted: ${id} for "${appraisal.employeeName}" (${appraisal.employeeCode}), Suggested Hike: ${incPercent}%, Promotion: ${promotionRecommended ? 'YES' : 'NO'}, by "${user?.name}" [${user?.role}]`);
      res.json(refreshed);
    } catch (err: any) {
      console.error('Error in PUT /api/appraisals/:id/manager-recommend:', err);
      res.status(500).json({ error: err.message || 'Failed to submit manager recommendation' });
    }
  }
);

/**
 * PUT /api/appraisals/:id/hod-calibrate
 * HOD normalizes increment %, reviews promotion readiness, and ensures department budget alignment
 */
appraisalRouter.put(
  '/appraisals/:id/hod-calibrate',
  requireRoles('SUPER_ADMIN', 'HOD', 'REPORTING_MANAGER', 'MANAGER', 'MANAGEMENT'),
  validateBody(HodCalibrationSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user;
      const { id } = req.params;
      const { calibratedIncrementPercent, promotionApproved, calibratedRating, notes } = req.body;

      const appraisalsCol = getDbCollection('appraisals');
      const appraisal: Appraisal | null = await appraisalsCol.findOne({ id });

      if (!appraisal) {
        return res.status(404).json({ error: 'Appraisal record not found' });
      }

      // Strict HOD ownership: only the employee's actually-configured HOD may calibrate,
      // not any HOD-role user in the department. Checked against the relationship, not the
      // caller's stored role label, so a manager who is also this employee's HOD can act
      // (SUPER_ADMIN bypasses).
      if (user?.role !== 'SUPER_ADMIN' && appraisal.hodId !== user?.employeeId) {
        return res.status(403).json({ error: 'Unauthorized: Only the designated HOD or Super Admin can calibrate this appraisal.' });
      }

      if (appraisal.isLocked) {
        return res.status(400).json({ error: 'Cannot modify a locked appraisal record' });
      }

      // Mandatory-stage guard: HOD can only calibrate after the manager has submitted a recommendation
      if (!['MANAGER_RECOMMENDED', 'HOD_CALIBRATED'].includes(appraisal.status)) {
        return res.status(400).json({
          error: `Cannot calibrate appraisal in status "${appraisal.status}". Must be MANAGER_RECOMMENDED or HOD_CALIBRATED.`,
        });
      }

      // Safeguard: Check employee status
      const employeesCol = getDbCollection('employees');
      const empRecord = await employeesCol.findOne({ id: appraisal.employeeId });
      if (empRecord && empRecord.status === 'INACTIVE') {
        return res.status(400).json({ error: 'Cannot calibrate appraisal: Employee is INACTIVE (Offboarded/Exited).' });
      }
      if (empRecord && empRecord.status === 'NOTICE') {
        return res.status(400).json({ error: 'Cannot calibrate appraisal: Employee is currently serving NOTICE period and ineligible for annual increment/promotion.' });
      }
      if (await getActivePipForEmployee(appraisal.employeeId)) {
        return res.status(400).json({ error: 'Cannot calibrate appraisal: Employee is currently on an active performance improvement plan and ineligible for annual increment/promotion until it resolves.' });
      }

      const currentCtc = appraisal.currentCtc;
      const finalInc = Number(calibratedIncrementPercent) || appraisal.proposedIncrementPercentage;
      const incrementAmount = Math.round((currentCtc * finalInc) / 100);
      const revisedCtc = currentCtc + incrementAmount;

      const budgetError = await checkDepartmentBudget(appraisal, incrementAmount);
      if (budgetError) {
        return res.status(400).json({ error: budgetError, code: 'BUDGET_CAP_EXCEEDED' });
      }

      const hodCalibration = {
        calibratedIncrementPercent: finalInc,
        promotionApproved: Boolean(promotionApproved),
        calibratedRating: calibratedRating || appraisal.recommendedRating,
        notes: notes || 'HOD departmental calibration and budget alignment completed.',
        calibratedBy: user?.id || user?.employeeId || '',
        calibratedByName: user?.name || 'Head of Department',
        calibratedAt: new Date().toISOString(),
      };

      const updatedDoc: Partial<Appraisal> = {
        approvedIncrementPercentage: finalInc,
        incrementAmount,
        revisedCtc,
        promotionRecommended: Boolean(promotionApproved),
        finalRating: calibratedRating || appraisal.finalRating,
        hodCalibration,
        status: 'HOD_CALIBRATED',
        remarks: `HOD calibrated with ${finalInc}% increment and budget clearance.`,
        updatedAt: new Date().toISOString(),
      };

      await appraisalsCol.updateOne({ id }, { $set: updatedDoc });

      // Notify HR of HOD calibration completion
      const notifsCol = getDbCollection('notifications');
      await notifsCol.updateOne(
        { 'metadata.appraisalId': id, type: 'HOD_ACTION_REQUIRED', userRole: 'HR' },
        {
          $set: {
            id: `notif_${id}_calibrated_hr`,
            userId: 'ALL',
            userRole: 'HR',
            type: 'HOD_ACTION_REQUIRED',
            title: `Appraisal Calibrated: ${appraisal.employeeName}`,
            message: `${user?.name || 'HOD'} calibrated appraisal for ${appraisal.employeeName} (${finalInc}% increment). Ready for HR final approval.`,
            isRead: false,
            priority: 'HIGH',
            metadata: { appraisalId: id, cycleId: appraisal.cycleId, activeSection: 'appraisals', status: 'HOD_CALIBRATED', openDetail: true },
            createdAt: new Date().toISOString(),
          },
        },
        { upsert: true }
      );

      if (user) {
        await recordAuditLog(
          user.id,
          user.name,
          user.role,
          'APPRAISAL_CALIBRATION',
          'HOD_CALIBRATION_COMPLETED',
          id,
          String(appraisal.approvedIncrementPercentage || 0),
          `Calibrated to ${finalInc}% increment`,
          notes || ''
        );
      }

      const refreshed = await appraisalsCol.findOne({ id });
      console.log(`[Appraisal] HOD calibrated: ${id} for "${appraisal.employeeName}" (${appraisal.employeeCode}), Final Hike: ${finalInc}%, Rating: ${calibratedRating || appraisal.finalRating || appraisal.recommendedRating}, by "${user?.name}" [${user?.role}]`);
      res.json(refreshed);
    } catch (err: any) {
      console.error('Error in PUT /api/appraisals/:id/hod-calibrate:', err);
      res.status(500).json({ error: err.message || 'Failed to calibrate appraisal' });
    }
  }
);

/**
 * PUT /api/appraisals/:id/hod-return
 * HOD sends the appraisal back to the Reporting Manager for rework instead of calibrating it forward
 */
appraisalRouter.put(
  '/appraisals/:id/hod-return',
  requireRoles('SUPER_ADMIN', 'HOD', 'REPORTING_MANAGER', 'MANAGER', 'MANAGEMENT'),
  validateBody(HodReturnSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user;
      const { id } = req.params;
      const { reason } = req.body;

      const appraisalsCol = getDbCollection('appraisals');
      const appraisal: Appraisal | null = await appraisalsCol.findOne({ id });

      if (!appraisal) {
        return res.status(404).json({ error: 'Appraisal record not found' });
      }

      // Strict HOD ownership: only the employee's actually-configured HOD may return it, not
      // any HOD-role user, checked against the relationship rather than the caller's stored
      // role label (SUPER_ADMIN bypasses).
      if (user?.role !== 'SUPER_ADMIN' && appraisal.hodId !== user?.employeeId) {
        return res.status(403).json({ error: 'Unauthorized: Only the designated HOD or Super Admin can return this appraisal.' });
      }

      if (appraisal.isLocked) {
        return res.status(400).json({ error: 'Cannot modify a locked appraisal record' });
      }

      // Mandatory-stage guard: HOD can only return an appraisal that is awaiting/has had HOD calibration.
      if (!['MANAGER_RECOMMENDED', 'HOD_CALIBRATED'].includes(appraisal.status)) {
        return res.status(400).json({
          error: `Cannot return appraisal in status "${appraisal.status}". Must be MANAGER_RECOMMENDED or HOD_CALIBRATED.`,
        });
      }

      const updatedDoc: Partial<Appraisal> = {
        status: 'PENDING',
        remarks: `Returned to Reporting Manager by ${user?.name || 'HOD'}: ${reason}`,
        hodReturn: {
          reason,
          returnedBy: user?.id || user?.employeeId || '',
          returnedByName: user?.name || 'Head of Department',
          returnedAt: new Date().toISOString(),
        },
        updatedAt: new Date().toISOString(),
      };

      await appraisalsCol.updateOne({ id }, { $set: updatedDoc, $unset: { hodCalibration: '' } });

      // Notify the Reporting Manager that the appraisal needs rework
      const notifsCol = getDbCollection('notifications');
      await notifsCol.updateOne(
        { 'metadata.appraisalId': id, type: 'HOD_ACTION_REQUIRED', userRole: 'MANAGER' },
        {
          $set: {
            id: `notif_${id}_hod_returned_manager`,
            userId: appraisal.managerId || 'ALL',
            userRole: 'MANAGER',
            type: 'HOD_ACTION_REQUIRED',
            title: `Appraisal Returned: ${appraisal.employeeName}`,
            message: `${user?.name || 'HOD'} returned the appraisal recommendation for ${appraisal.employeeName} for rework. Reason: ${reason}`,
            isRead: false,
            priority: 'HIGH',
            metadata: { appraisalId: id, cycleId: appraisal.cycleId, activeSection: 'appraisals', status: 'PENDING', openDetail: true },
            createdAt: new Date().toISOString(),
          },
        },
        { upsert: true }
      );

      if (user) {
        await recordAuditLog(
          user.id,
          user.name,
          user.role,
          'APPRAISAL_CALIBRATION',
          'HOD_RETURNED_TO_MANAGER',
          id,
          appraisal.status,
          'PENDING',
          reason
        );
      }

      const refreshed = await appraisalsCol.findOne({ id });
      console.log(`[Appraisal] HOD returned to manager: ${id} for "${appraisal.employeeName}" (${appraisal.employeeCode}), by "${user?.name}" [${user?.role}]`);
      res.json(refreshed);
    } catch (err: any) {
      console.error('Error in PUT /api/appraisals/:id/hod-return:', err);
      res.status(500).json({ error: err.message || 'Failed to return appraisal to manager' });
    }
  }
);

/**
 * PUT /api/appraisals/:id/hr-approve
 * HR confirms final increment, revised CTC, effective date, and generates formal letter
 */
appraisalRouter.put(
  '/appraisals/:id/hr-approve',
  requireRoles('HR', 'SUPER_ADMIN'),
  validateBody(HrApprovalSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user;
      const { id } = req.params;
      const { finalIncrementPercent, finalRating, effectiveDate, notes } = req.body;

      const appraisalsCol = getDbCollection('appraisals');
      const appraisal: Appraisal | null = await appraisalsCol.findOne({ id });

      if (!appraisal) {
        return res.status(404).json({ error: 'Appraisal record not found' });
      }

      if (appraisal.isLocked) {
        return res.status(400).json({ error: 'Cannot modify a locked appraisal record' });
      }

      // Mandatory-stage guard: HR cannot approve until HOD calibration is complete
      if (!['HOD_CALIBRATED', 'HR_APPROVED'].includes(appraisal.status)) {
        return res.status(400).json({
          error: `Cannot approve appraisal in status "${appraisal.status}". HOD calibration must be completed first.`,
        });
      }

      // Safeguard: Check employee status
      const employeesCol = getDbCollection('employees');
      const empRecord = await employeesCol.findOne({ id: appraisal.employeeId });
      if (empRecord && empRecord.status === 'INACTIVE') {
        return res.status(400).json({ error: 'Cannot approve appraisal: Employee is INACTIVE (Offboarded/Exited).' });
      }
      if (empRecord && empRecord.status === 'NOTICE') {
        return res.status(400).json({ error: 'Cannot approve appraisal: Employee is currently serving NOTICE period and ineligible for annual increment/promotion.' });
      }
      if (await getActivePipForEmployee(appraisal.employeeId)) {
        return res.status(400).json({ error: 'Cannot approve appraisal: Employee is currently on an active performance improvement plan and ineligible for annual increment/promotion until it resolves.' });
      }

      const currentCtc = appraisal.currentCtc;
      const approvedInc = Number(finalIncrementPercent) || appraisal.approvedIncrementPercentage || 12;
      const incrementAmount = Math.round((currentCtc * approvedInc) / 100);
      const revisedCtc = currentCtc + incrementAmount;

      const budgetError = await checkDepartmentBudget(appraisal, incrementAmount);
      if (budgetError) {
        return res.status(400).json({ error: budgetError, code: 'BUDGET_CAP_EXCEEDED' });
      }

      const hrApproval = {
        finalIncrementPercent: approvedInc,
        finalRating: finalRating || appraisal.finalRating,
        revisedCtc,
        effectiveDate: effectiveDate || `${appraisal.appraisalYear}-10-01`,
        letterGenerated: true,
        letterGeneratedAt: new Date().toISOString(),
        notes: notes || 'HR final approval and compensation verification completed.',
        approvedBy: user?.id || user?.employeeId || '',
        approvedByName: user?.name || 'HR Manager',
        approvedAt: new Date().toISOString(),
      };

      const updatedDoc: Partial<Appraisal> = {
        approvedIncrementPercentage: approvedInc,
        incrementAmount,
        revisedCtc,
        finalRating: finalRating || appraisal.finalRating,
        effectiveDate: effectiveDate || `${appraisal.appraisalYear}-10-01`,
        hrApproval,
        status: 'HR_APPROVED',
        remarks: 'HR approval confirmed. Appraisal letter generated and ready for release.',
        updatedAt: new Date().toISOString(),
      };

      await appraisalsCol.updateOne({ id }, { $set: updatedDoc });

      // Notify HOD
      const notifsCol = getDbCollection('notifications');
      await notifsCol.updateOne(
        { 'metadata.appraisalId': id, type: 'APPRAISAL_DUE', userRole: 'HOD' },
        {
          $set: {
            id: `notif_${id}_approved_hod`,
            userId: appraisal.hodId || undefined,
            userRole: 'HOD',
            type: 'APPRAISAL_DUE',
            title: `Appraisal Approved by HR: ${appraisal.employeeName}`,
            message: `HR final approval confirmed for ${appraisal.employeeName} (${approvedInc}% increment). Letter generated and staged for release.`,
            isRead: false,
            priority: 'MEDIUM',
            metadata: { appraisalId: id, cycleId: appraisal.cycleId, activeSection: 'appraisals' },
            createdAt: new Date().toISOString(),
          },
        },
        { upsert: true }
      );

      if (user) {
        await recordAuditLog(
          user.id,
          user.name,
          user.role,
          'APPRAISAL_CALIBRATION',
          'HR_FINAL_APPROVAL',
          id,
          String(appraisal.approvedIncrementPercentage || 0),
          `Final approved increment: ${approvedInc}%, Revised CTC: ${revisedCtc}`,
          notes || ''
        );
      }

      const refreshed = await appraisalsCol.findOne({ id });
      res.json(refreshed);
    } catch (err: any) {
      console.error('Error in PUT /api/appraisals/:id/hr-approve:', err);
      res.status(500).json({ error: err.message || 'Failed to approve appraisal' });
    }
  }
);

/**
 * PUT /api/appraisals/:id/lock
 * Lock appraisal, update employee profile with revised compensation/designation, and notify employee
 */
appraisalRouter.put(
  '/appraisals/:id/lock',
  requireRoles('SUPER_ADMIN'),
  validateBody(LockAppraisalSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user;
      const { id } = req.params;
      const {
        finalIncrementPercent,
        finalRating,
        revisedCtc: revisedCtcOverride,
        effectiveDate,
        promotionApproved,
        promotionDesignationId,
        promotionDesignationName,
        notes,
      } = req.body;

      const appraisalsCol = getDbCollection('appraisals');
      const appraisal: Appraisal | null = await appraisalsCol.findOne({ id });

      if (!appraisal) {
        return res.status(404).json({ error: 'Appraisal record not found' });
      }

      if (appraisal.isLocked) {
        return res.status(400).json({ error: 'Appraisal is already locked.' });
      }

      // Mandatory-stage guard: only lock once HR has given final approval
      if (appraisal.status !== 'HR_APPROVED') {
        return res.status(400).json({
          error: `Cannot lock appraisal in status "${appraisal.status}". Must be HR_APPROVED.`,
        });
      }

      // Pre-flight check: block lock while the employee has unfinalized/pending quarterly reviews
      const reviewsCol = getDbCollection('employeeReviews');
      const pendingReviews = await (await reviewsCol.find({
        employeeId: appraisal.employeeId,
        status: { $in: ['DRAFT', 'ASSIGNED', 'MANAGER_PENDING', 'RETURNED'] },
      })).toArray();

      if (pendingReviews.length > 0) {
        return res.status(400).json({
          error: `Cannot lock appraisal: Employee has ${pendingReviews.length} quarterly review(s) still pending completion/evaluation.`,
        });
      }

      // Bring the rolling score/history up to date so the locked record reflects every
      // evaluated quarter (refreshAppraisalScore never touches increments or HR's rating).
      await refreshAppraisalScore(appraisal);

      // Super Admin may make last-mile edits before the final lock; when present, these
      // final values supersede whatever HR had approved and become what gets locked in
      // and reflected on the official appraisal letter.
      const currentCtc = appraisal.currentCtc;
      const finalInc = finalIncrementPercent !== undefined ? Number(finalIncrementPercent) : appraisal.approvedIncrementPercentage || 0;
      const incrementAmount = Math.round((currentCtc * finalInc) / 100);
      const finalRevisedCtc = revisedCtcOverride !== undefined ? Number(revisedCtcOverride) : currentCtc + incrementAmount;

      // Checked against the CTC actually being locked in, so a revisedCtc override can't bypass the cap.
      const budgetError = await checkDepartmentBudget(appraisal, finalRevisedCtc - currentCtc);
      if (budgetError) {
        return res.status(400).json({ error: budgetError, code: 'BUDGET_CAP_EXCEEDED' });
      }
      const finalRatingValue = finalRating || appraisal.finalRating;
      const finalEffectiveDate = effectiveDate || appraisal.effectiveDate || `${appraisal.appraisalYear}-10-01`;
      const finalPromotionRecommended = promotionApproved !== undefined ? Boolean(promotionApproved) : Boolean(appraisal.promotionRecommended);
      const finalPromotionDesignationId = promotionDesignationId || appraisal.promotionDesignationId;
      const finalPromotionDesignationName = promotionDesignationName || appraisal.promotionDesignationName;

      const lockedAt = new Date().toISOString();
      await appraisalsCol.updateOne(
        { id },
        {
          $set: {
            status: 'LOCKED',
            isLocked: true,
            lockedAt,
            lockedById: user?.id || user?.employeeId || '',
            lockedByName: user?.name || 'Super Admin',
            approvedIncrementPercentage: finalInc,
            incrementAmount,
            revisedCtc: finalRevisedCtc,
            finalRating: finalRatingValue,
            effectiveDate: finalEffectiveDate,
            promotionRecommended: finalPromotionRecommended,
            promotionDesignationId: finalPromotionDesignationId,
            promotionDesignationName: finalPromotionDesignationName,
            'hrApproval.finalIncrementPercent': finalInc,
            'hrApproval.revisedCtc': finalRevisedCtc,
            'hrApproval.finalRating': finalRatingValue,
            'hrApproval.effectiveDate': finalEffectiveDate,
            'hrApproval.letterGeneratedAt': lockedAt,
            'hrApproval.notes': notes || appraisal.hrApproval?.notes,
            updatedAt: lockedAt,
          },
        }
      );

      // Update Employee Master Record with the final locked-in values (not the pre-edit snapshot)
      const employeesCol = getDbCollection('employees');
      const employee: Employee | null = await employeesCol.findOne({ id: appraisal.employeeId });

      if (employee) {
        const empUpdate: Partial<Employee> = {
          currentCtc: finalRevisedCtc,
          lastAppraisalDate: lockedAt,
        };

        if (finalPromotionRecommended && finalPromotionDesignationId) {
          empUpdate.designationId = finalPromotionDesignationId;
          empUpdate.designationName = finalPromotionDesignationName;
        }

        await employeesCol.updateOne({ id: employee.id }, { $set: empUpdate });
      }

      // Send Notification to Employee
      const notificationsCol = getDbCollection('notifications');
      await notificationsCol.updateOne(
        { 'metadata.appraisalId': id, userId: appraisal.employeeId, type: 'LETTER_RELEASED' },
        {
          $set: {
            id: `notif_${id}_letter_rel`,
            userId: appraisal.employeeId,
            userRole: 'EMPLOYEE',
            type: 'LETTER_RELEASED',
            title: '🎉 Annual Appraisal Letter Released',
            message: `Your annual performance appraisal for ${appraisal.cycleName} has been approved and locked. View your appraisal letter for compensation details.`,
            isRead: false,
            priority: 'HIGH',
            metadata: { appraisalId: id, cycleId: appraisal.cycleId, subTab: 'appraisal', openLetter: true },
            createdAt: lockedAt,
          },
        },
        { upsert: true }
      );

      // Dispatch Email Notification to Employee (Asynchronously)
      (async () => {
        try {
          const recipient = await resolveRecipient(appraisal.employeeId);
          if (recipient) {
            const baseUrl = process.env.APP_URL || 'http://localhost:5173';
            const { subject, html } = renderAppraisalLetterReleasedEmail({
              employeeName: appraisal.employeeName,
              cycleName: appraisal.cycleName || 'Annual Cycle',
              appraisalUrl: `${baseUrl}/#dashboard`,
              effectiveDate: finalEffectiveDate,
            });
            await sendNotificationEmail({
              recipientId: appraisal.employeeId,
              recipientEmail: recipient.email,
              recipientName: recipient.name,
              subject,
              html,
              templateType: 'LETTER_RELEASED',
              metadata: { appraisalId: id, cycleId: appraisal.cycleId },
            });
          }
        } catch (mailErr: any) {
          console.warn('[AppraisalRoutes] Failed to dispatch letter release email:', mailErr.message);
        }
      })();

      if (user) {
        await recordAuditLog(
          user.id,
          user.name,
          user.role,
          'ANNUAL_APPRAISAL',
          'APPRAISAL_LOCKED',
          id,
          'UNLOCKED',
          `Locked appraisal. Updated Employee CTC to ${appraisal.currency}${finalRevisedCtc.toLocaleString()}`,
          ''
        );
      }

      const refreshed = await appraisalsCol.findOne({ id });
      console.log(`[Appraisal] Appraisal locked & finalized: ${id} for "${appraisal.employeeName}" (${appraisal.employeeCode}), Revised CTC: ${appraisal.currency}${finalRevisedCtc.toLocaleString()}, by "${user?.name}" [${user?.role}]`);
      res.json(refreshed);
    } catch (err: any) {
      console.error('Error in PUT /api/appraisals/:id/lock:', err);
      res.status(500).json({ error: err.message || 'Failed to lock appraisal' });
    }
  }
);

/**
 * GET /api/appraisals/:id/letter
 * Generates formatted Appraisal & Promotion letter data with IDOR authorization
 */
appraisalRouter.get('/appraisals/:id/letter', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const appraisalsCol = getDbCollection('appraisals');
    const appraisal: Appraisal | null = await appraisalsCol.findOne({ id });

    if (!appraisal) {
      return res.status(404).json({ error: 'Appraisal record not found' });
    }

    // Role & Ownership Verification
    if (user.role === 'EMPLOYEE') {
      if (appraisal.employeeId !== user.employeeId) {
        return res.status(403).json({ error: 'Access denied: You may only view your own appraisal letter.' });
      }
    } else if (user.role === 'REPORTING_MANAGER' || user.role === 'MANAGER') {
      if (appraisal.managerId !== user.employeeId && appraisal.hodId !== user.employeeId && appraisal.employeeId !== user.employeeId) {
        return res.status(403).json({ error: 'Access denied: You may only view appraisal letters for your direct reports.' });
      }
    } else if (user.role === 'HOD') {
      const isDeptMatch =
        (req.employeeProfile?.departmentId && appraisal.departmentId === req.employeeProfile.departmentId) ||
        (req.employeeProfile?.departmentName && appraisal.departmentName?.toLowerCase() === req.employeeProfile.departmentName.toLowerCase());
      if (appraisal.hodId !== user.employeeId && appraisal.managerId !== user.employeeId && appraisal.employeeId !== user.employeeId && !isDeptMatch) {
        return res.status(403).json({ error: 'Access denied: You may only view appraisal letters within your department.' });
      }
    }

    const currentMonthly = Math.round(appraisal.currentCtc / 12);
    const revisedMonthly = Math.round(appraisal.revisedCtc / 12);
    const monthlyIncrement = revisedMonthly - currentMonthly;

    const letterData = {
      referenceNumber: `HR/APP/${appraisal.appraisalYear}/${appraisal.employeeCode}`,
      date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      employeeName: appraisal.employeeName,
      employeeCode: appraisal.employeeCode,
      departmentName: appraisal.departmentName,
      currentDesignation: appraisal.designationName,
      cycleName: appraisal.cycleName,
      appraisalYear: appraisal.appraisalYear,
      effectiveDate: appraisal.effectiveDate || `${appraisal.appraisalYear}-10-01`,
      compositeScore: appraisal.averageQuarterlyScore,
      ratingBand: appraisal.finalRating,
      isPromoted: appraisal.promotionRecommended,
      promotedDesignation: appraisal.promotionDesignationName,
      compensation: {
        currency: appraisal.currency,
        currentAnnualCtc: appraisal.currentCtc,
        currentMonthlyCtc: currentMonthly,
        incrementPercentage: appraisal.approvedIncrementPercentage || appraisal.proposedIncrementPercentage,
        annualIncrementAmount: appraisal.incrementAmount,
        monthlyIncrementAmount: monthlyIncrement,
        revisedAnnualCtc: appraisal.revisedCtc,
        revisedMonthlyCtc: revisedMonthly,
      },
      quarterlyHighlights: appraisal.quarterlyHistory.map((q) => ({
        period: q.periodName,
        score: q.score,
        highlight: q.strengths || q.managerComments || 'Met quarterly milestones',
      })),
      managerRemarks: appraisal.managerRecommendation?.justification || appraisal.remarks,
      signatories: [
        {
          role: 'Reporting Manager',
          name: appraisal.managerName || 'Reporting Manager',
          date: appraisal.managerRecommendation?.recommendedAt || new Date().toISOString(),
        },
        {
          role: 'Head of Department',
          name: appraisal.hodName || 'Head of Department',
          date: appraisal.hodCalibration?.calibratedAt || new Date().toISOString(),
        },
        {
          role: 'VP / Head of Human Resources',
          name: appraisal.hrApproval?.approvedByName || 'Pooja Iyer (HR Lead)',
          date: appraisal.hrApproval?.approvedAt || new Date().toISOString(),
        },
      ],
      acknowledgement: appraisal.employeeAcknowledgement || null,
    };

    res.json(letterData);
  } catch (err: any) {
    console.error('Error in GET /api/appraisals/:id/letter:', err);
    res.status(500).json({ error: 'Failed to generate appraisal letter' });
  }
});

/**
 * PUT /api/appraisals/:id/acknowledge
 * Employee digitally acknowledges and accepts their finalized appraisal letter
 */
appraisalRouter.put(
  '/appraisals/:id/acknowledge',
  validateBody(AcknowledgementSchema),
  async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = req.user;
    const { id } = req.params;
    const { comments } = req.body;

    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const appraisalsCol = getDbCollection('appraisals');
    const appraisal: Appraisal | null = await appraisalsCol.findOne({ id });

    if (!appraisal) {
      return res.status(404).json({ error: 'Appraisal record not found' });
    }

    // Only the target employee or Super Admin can acknowledge the appraisal letter
    if (user.role !== 'SUPER_ADMIN' && user.employeeId !== appraisal.employeeId) {
      return res.status(403).json({ error: 'Unauthorized: You can only acknowledge your own appraisal letter.' });
    }

    const acknowledgedAt = new Date().toISOString();
    const ackRecord = {
      acknowledged: true,
      acknowledgedAt,
      acknowledgedBy: user.id,
      acknowledgedByName: user.name || appraisal.employeeName,
      comments: comments || 'Digitally acknowledged and accepted.',
      ipAddress: (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '127.0.0.1',
    };

    await appraisalsCol.updateOne(
      { id },
      {
        $set: {
          employeeAcknowledgement: ackRecord,
          updatedAt: acknowledgedAt,
        },
      }
    );

    // Audit Log
    await recordAuditLog(
      user.id,
      user.name,
      user.role,
      'ANNUAL_APPRAISAL',
      'APPRAISAL_ACKNOWLEDGED',
      id,
      'UNACKNOWLEDGED',
      `Digitally acknowledged by ${appraisal.employeeName}`,
      comments || 'Digital acceptance of appraisal letter and compensation revision terms.'
    );

    // Notify HR
    const notificationsCol = getDbCollection('notifications');
    await notificationsCol.insertOne({
      id: `notif_${Date.now()}`,
      userId: 'ALL',
      userRole: 'HR',
      type: 'LETTER_ACKNOWLEDGED',
      title: 'Appraisal Letter Acknowledged',
      message: `${appraisal.employeeName} (${appraisal.employeeCode}) has digitally acknowledged their ${appraisal.cycleName} appraisal letter.`,
      isRead: false,
      priority: 'MEDIUM',
      metadata: { appraisalId: id, cycleId: appraisal.cycleId, activeSection: 'appraisals' },
      createdAt: acknowledgedAt,
    });

    const refreshed = await appraisalsCol.findOne({ id });
    console.log(`[Appraisal] Digitally acknowledged: ${id} by "${appraisal.employeeName}" (${appraisal.employeeCode})`);
    res.json(refreshed);
  } catch (err: any) {
    console.error('Error in PUT /api/appraisals/:id/acknowledge:', err);
    res.status(500).json({ error: err.message || 'Failed to acknowledge appraisal' });
  }
});

