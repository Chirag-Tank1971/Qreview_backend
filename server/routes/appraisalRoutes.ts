import { Router, Response } from 'express';
import { getDbCollection } from '../db.js';
import { authenticateToken, requireRoles, AuthenticatedRequest, recordAuditLog } from '../auth.js';
import { syncAllActiveEmployees } from '../syncHelpers.js';
import {
  validateBody,
  ManagerRecommendationSchema,
  HodCalibrationSchema,
  HrApprovalSchema,
  AcknowledgementSchema,
} from '../validation.js';
import {
  Appraisal,
  AppraisalQuarterRecord,
  AppraisalSummaryStats,
  Employee,
  Department,
  Cycle,
  EmployeeReview,
  AuditLog,
  Notification,
  User,
  Designation,
} from '../../src/types.js';

export const appraisalRouter = Router();

// Apply real JWT authentication to ALL appraisal routes
appraisalRouter.use(authenticateToken);

// Compute standard rating and default increment bracket based on rolling 4-quarter score
export function computeAppraisalMatrix(avgScore: number) {
  if (avgScore >= 4.5) {
    return {
      recommendedRating: 'OUTSTANDING',
      suggestedIncrementMin: 15,
      suggestedIncrementMax: 20,
      defaultIncrement: 16.5,
    };
  } else if (avgScore >= 3.8) {
    return {
      recommendedRating: 'EXCEEDS_EXPECTATIONS',
      suggestedIncrementMin: 10,
      suggestedIncrementMax: 14,
      defaultIncrement: 12.0,
    };
  } else if (avgScore >= 2.8) {
    return {
      recommendedRating: 'MEETS_EXPECTATIONS',
      suggestedIncrementMin: 5,
      suggestedIncrementMax: 9,
      defaultIncrement: 7.0,
    };
  } else {
    return {
      recommendedRating: 'NEEDS_IMPROVEMENT',
      suggestedIncrementMin: 0,
      suggestedIncrementMax: 4,
      defaultIncrement: 2.0,
    };
  }
}

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

    // Strict RBAC Scoping:
    if (user.role === 'EMPLOYEE') {
      // Employees can STRICTLY ONLY view their own appraisal record
      appraisals = appraisals.filter((a) => a.employeeId === user.employeeId);
    } else if (user.role === 'MANAGER') {
      // Managers can view their direct reports or their own record
      appraisals = appraisals.filter((a) => {
        const empRecord = empMap.get(a.employeeId);
        return (
          a.managerId === user.employeeId ||
          a.employeeId === user.employeeId ||
          empRecord?.managerId === user.employeeId ||
          (user.email && empRecord?.managerName?.toLowerCase() === user.name.toLowerCase())
        );
      });
    } else if (user.role === 'HOD') {
      // HODs can view their department roll-ups, direct reports, or their own record
      appraisals = appraisals.filter((a) => {
        const empRecord = empMap.get(a.employeeId);
        const userDeptId = req.employeeProfile?.departmentId;
        const userDeptName = req.employeeProfile?.departmentName?.toLowerCase();
        return (
          a.hodId === user.employeeId ||
          a.managerId === user.employeeId ||
          a.employeeId === user.employeeId ||
          empRecord?.hodId === user.employeeId ||
          empRecord?.managerId === user.employeeId ||
          (userDeptId && a.departmentId === userDeptId) ||
          (userDeptId && empRecord?.departmentId === userDeptId) ||
          (userDeptName && a.departmentName?.toLowerCase() === userDeptName)
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
      await syncAllActiveEmployees();
      res.json({ success: true, message: 'All active employees and appraisals successfully synchronized.' });
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
  requireRoles('SUPER_ADMIN', 'HR', 'HOD', 'MANAGEMENT', 'MANAGER'),
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

      // Role-based scope
      if (user?.role === 'MANAGER') {
        appraisals = appraisals.filter((a) => {
          const empRecord = empMap.get(a.employeeId);
          return (
            a.managerId === user.employeeId ||
            a.employeeId === user.employeeId ||
            empRecord?.managerId === user.employeeId
          );
        });
      } else if (user?.role === 'HOD') {
        appraisals = appraisals.filter((a) => {
          const empRecord = empMap.get(a.employeeId);
          const userDeptId = req.employeeProfile?.departmentId;
          const userDeptName = req.employeeProfile?.departmentName?.toLowerCase();
          return (
            a.hodId === user.employeeId ||
            a.managerId === user.employeeId ||
            a.employeeId === user.employeeId ||
            empRecord?.hodId === user.employeeId ||
            empRecord?.managerId === user.employeeId ||
            (userDeptId && a.departmentId === userDeptId) ||
            (userDeptId && empRecord?.departmentId === userDeptId) ||
            (userDeptName && a.departmentName?.toLowerCase() === userDeptName)
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

      const totalScore = appraisals.reduce((acc, a) => acc + (a.averageQuarterlyScore || 0), 0);
      const averageScore = total > 0 ? Number((totalScore / total).toFixed(2)) : 0;

      const totalCurrentPayroll = appraisals.reduce((acc, a) => acc + (a.currentCtc || 0), 0);
      const totalRevisedPayroll = appraisals.reduce((acc, a) => acc + (a.revisedCtc || a.currentCtc || 0), 0);
      const totalIncrementBudgetImpact = totalRevisedPayroll - totalCurrentPayroll;

      const increments = appraisals.map((a) => a.approvedIncrementPercentage || a.proposedIncrementPercentage || 0);
      const averageIncrement =
        increments.length > 0
          ? Number((increments.reduce((sum, val) => sum + val, 0) / increments.length).toFixed(2))
          : 0;

      const ratingDistribution = {
        outstanding: appraisals.filter((a) => a.averageQuarterlyScore >= 4.5).length,
        exceeds: appraisals.filter((a) => a.averageQuarterlyScore >= 3.8 && a.averageQuarterlyScore < 4.5).length,
        meets: appraisals.filter((a) => a.averageQuarterlyScore >= 2.8 && a.averageQuarterlyScore < 3.8).length,
        needsImprovement: appraisals.filter((a) => a.averageQuarterlyScore < 2.8).length,
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
 * attrition flight-risk retention analytics, and 8-Cycle execution benchmarks.
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
      const allDepartments: Department[] = await (await departmentsCol.find({ active: true })).toArray();
      const allEmployees: Employee[] = await (await employeesCol.find({ status: 'ACTIVE' })).toArray();
      const allCycles: Cycle[] = await (await cyclesCol.find({})).toArray();

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

      const totalScore = allAppraisals.reduce((acc, a) => acc + (a.averageQuarterlyScore || 0), 0);
      const averageScore = totalAppraisals > 0 ? Number((totalScore / totalAppraisals).toFixed(2)) : 0;
      const totalIncrements = allAppraisals.reduce(
        (acc, a) => acc + (a.approvedIncrementPercentage || a.proposedIncrementPercentage || 0),
        0
      );
      const averageIncrementPercent = totalAppraisals > 0 ? Number((totalIncrements / totalAppraisals).toFixed(2)) : 0;
      const promotionsCount = allAppraisals.filter((a) => a.promotionRecommended || a.hodCalibration?.promotionApproved).length;

      // Overall Target vs Actual Distribution
      const countOutstanding = allAppraisals.filter((a) => a.averageQuarterlyScore >= 4.5).length;
      const countExceeds = allAppraisals.filter((a) => a.averageQuarterlyScore >= 3.8 && a.averageQuarterlyScore < 4.5).length;
      const countMeets = allAppraisals.filter((a) => a.averageQuarterlyScore >= 2.8 && a.averageQuarterlyScore < 3.8).length;
      const countNeedsImp = allAppraisals.filter((a) => a.averageQuarterlyScore < 2.8).length;

      const actualDist = {
        outstanding: totalAppraisals > 0 ? Number(((countOutstanding / totalAppraisals) * 100).toFixed(1)) : 0,
        exceeds: totalAppraisals > 0 ? Number(((countExceeds / totalAppraisals) * 100).toFixed(1)) : 0,
        meets: totalAppraisals > 0 ? Number(((countMeets / totalAppraisals) * 100).toFixed(1)) : 0,
        needsImprovement: totalAppraisals > 0 ? Number(((countNeedsImp / totalAppraisals) * 100).toFixed(1)) : 0,
      };

      // Departmental Budget Pools & Bell Curves
      const departmentBudgets: any[] = [];
      const departmentBellCurves: any[] = [];

      allDepartments.forEach((dept) => {
        const deptAppraisals = allAppraisals.filter(
          (a) => a.departmentId === dept.id || a.departmentName.toLowerCase() === dept.name.toLowerCase()
        );
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

        const deptScores = deptAppraisals.reduce((sum, a) => sum + (a.averageQuarterlyScore || 0), 0);
        const avgScore = headcount > 0 ? Number((deptScores / headcount).toFixed(2)) : 0;
        const deptIncs = deptAppraisals.reduce((sum, a) => sum + (a.approvedIncrementPercentage || a.proposedIncrementPercentage || 0), 0);
        const avgInc = headcount > 0 ? Number((deptIncs / headcount).toFixed(2)) : 0;
        const promoCount = deptAppraisals.filter((a) => a.promotionRecommended || a.hodCalibration?.promotionApproved).length;

        departmentBudgets.push({
          departmentId: dept.id,
          departmentName: dept.name,
          headcount,
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

        // Bell curve for department
        const deptOut = deptAppraisals.filter((a) => a.averageQuarterlyScore >= 4.5).length;
        const deptExc = deptAppraisals.filter((a) => a.averageQuarterlyScore >= 3.8 && a.averageQuarterlyScore < 4.5).length;
        const deptMet = deptAppraisals.filter((a) => a.averageQuarterlyScore >= 2.8 && a.averageQuarterlyScore < 3.8).length;
        const deptNid = deptAppraisals.filter((a) => a.averageQuarterlyScore < 2.8).length;

        const pOut = headcount > 0 ? Number(((deptOut / headcount) * 100).toFixed(1)) : 0;
        const pExc = headcount > 0 ? Number(((deptExc / headcount) * 100).toFixed(1)) : 0;
        const pMet = headcount > 0 ? Number(((deptMet / headcount) * 100).toFixed(1)) : 0;
        const pNid = headcount > 0 ? Number(((deptNid / headcount) * 100).toFixed(1)) : 0;

        let skewAlert: string | undefined = undefined;
        let skewSeverity: 'NORMAL' | 'WARNING' | 'CRITICAL' = 'NORMAL';

        if (pOut > 30) {
          skewAlert = `Inflation Alert: ${pOut}% top performers exceeds 10% target guideline. HOD normalization recommended.`;
          skewSeverity = 'WARNING';
        } else if (pNid === 0 && headcount >= 5) {
          skewAlert = `Zero bottom bucket distribution with ${headcount} employees. Check for lenient rating bias.`;
          skewSeverity = 'WARNING';
        } else if (isOverBudget) {
          skewAlert = `Budget Overrun: Actual increment spend of ${actualSpentPercent}% exceeds ${budgetCapPercent}% departmental limit.`;
          skewSeverity = 'CRITICAL';
        }

        departmentBellCurves.push({
          departmentId: dept.id,
          departmentName: dept.name,
          totalEmployees: headcount,
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
      const attritionRiskInsights: any[] = [];
      allAppraisals.forEach((a) => {
        const isTopPerformer = a.averageQuarterlyScore >= 4.2;
        const increment = a.approvedIncrementPercentage || a.proposedIncrementPercentage || 0;

        if (isTopPerformer) {
          let flightRisk: 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';
          let riskReason = 'Strong performer aligned with merit band';
          let action = 'Maintain standard progression and career mapping.';

          if (increment <= 10) {
            flightRisk = 'HIGH';
            riskReason = `Score ${a.averageQuarterlyScore.toFixed(2)} with only +${increment}% increment (industry median +18% for top quartile).`;
            action = 'Management special equity adjustment or milestone retention bonus recommended.';
          } else if (increment < 14) {
            flightRisk = 'MEDIUM';
            riskReason = 'High score with conservative increment allocation.';
            action = 'Schedule 1-on-1 career growth conversation with HOD.';
          }

          attritionRiskInsights.push({
            employeeId: a.employeeId,
            employeeName: a.employeeName,
            employeeCode: a.employeeCode,
            departmentName: a.departmentName,
            designationName: a.designationName,
            score: a.averageQuarterlyScore,
            incrementPercent: increment,
            rating: a.recommendedRating,
            marketCompRatio: Number((0.85 + (increment / 100) * 0.5).toFixed(2)),
            flightRisk,
            riskReason,
            recommendedRetentionAction: action,
          });
        }
      });

      // 8-Cycle Progress Comparison
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
          averageScore,
          averageIncrementPercent,
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
    } else if (user.role === 'MANAGER') {
      const isManagerMatch =
        appraisal.managerId === user.employeeId ||
        appraisal.employeeId === user.employeeId ||
        empRecord?.managerId === user.employeeId ||
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
 * Batch roll up 4-quarter reviews and initiate annual appraisals for an 8-Cycle cohort (Super Admin & HR only)
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
      const reviewsCol = getDbCollection('employeeReviews');
      const appraisalsCol = getDbCollection('appraisals');
      const auditLogsCol = getDbCollection('auditLogs');
      const notificationsCol = getDbCollection('notifications');

      const eligibleEmployees: Employee[] = await (await employeesCol.find({ cycleId, status: 'ACTIVE' })).toArray();

      if (eligibleEmployees.length === 0) {
        return res.status(400).json({ error: `No active employees found assigned to ${cycle.name}` });
      }

      let createdCount = 0;
      let updatedCount = 0;

      for (const emp of eligibleEmployees) {
        const existing: Appraisal | null = await appraisalsCol.findOne({
          employeeId: emp.id,
          appraisalYear,
        });

        if (existing && !overrideExisting) {
          continue;
        }

        // Fetch all historical reviews for this employee
        const employeeReviews: EmployeeReview[] = await (
          await reviewsCol.find({ employeeId: emp.id })
        ).toArray();

        // Sort reviews chronologically
        employeeReviews.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

        // Aggregate quarterly history
        const quarterlyHistory: AppraisalQuarterRecord[] = employeeReviews.map((rev) => ({
          periodId: rev.reviewPeriodId,
          periodName: rev.reviewPeriodName,
          score: rev.finalScore || 0,
          reviewId: rev.id,
          strengths: rev.strengths,
          managerComments: rev.managerOverallComments,
          hrComments: rev.hrComments,
        }));

        // Calculate rolling 4-quarter average score
        const validScores = quarterlyHistory.filter((q) => q.score > 0).map((q) => q.score);
        const avgScore =
          validScores.length > 0
            ? Number((validScores.reduce((sum, s) => sum + s, 0) / validScores.length).toFixed(2))
            : 4.0; // Standard default

        const matrix = computeAppraisalMatrix(avgScore);
        const currentCtc = emp.currentCtc || 1500000;
        const proposedIncrementPercent = matrix.defaultIncrement;
        const incrementAmount = Math.round((currentCtc * proposedIncrementPercent) / 100);
        const revisedCtc = currentCtc + incrementAmount;

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
          recommendedRating: matrix.recommendedRating,
          suggestedIncrementMin: matrix.suggestedIncrementMin,
          suggestedIncrementMax: matrix.suggestedIncrementMax,
          finalRating: matrix.recommendedRating,
          proposedIncrementPercentage: proposedIncrementPercent,
          approvedIncrementPercentage: proposedIncrementPercent,
          incrementAmount,
          revisedCtc,
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
          `Initiated ${createdCount + updatedCount} appraisals for ${cycle.name} (${appraisalYear})`,
          'Generated rolling 4-quarter performance rollups and standard increment recommendations.'
        );
      }

      res.json({
        message: `Successfully initiated ${cycle.name} cohort appraisals for ${appraisalYear}.`,
        cycleName: cycle.name,
        createdCount,
        updatedCount,
        totalEligible: eligibleEmployees.length,
      });
    } catch (err: any) {
      console.error('Error in POST /api/appraisals/initiate-cycle:', err);
      res.status(500).json({ error: err.message || 'Failed to initiate cycle appraisals' });
    }
  }
);

/**
 * PUT /api/appraisals/:id/manager-recommend
 * Manager submits recommended increment %, promotion recommendation, and qualitative justification
 */
appraisalRouter.put(
  '/appraisals/:id/manager-recommend',
  requireRoles('MANAGER', 'SUPER_ADMIN', 'HR'),
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

      // Safeguard: Check employee status
      const employeesCol = getDbCollection('employees');
      const empRecord = await employeesCol.findOne({ id: appraisal.employeeId });
      if (empRecord && empRecord.status === 'INACTIVE') {
        return res.status(400).json({ error: 'Cannot submit recommendation: Employee is INACTIVE (Offboarded/Exited).' });
      }
      if (empRecord && empRecord.status === 'NOTICE') {
        return res.status(400).json({ error: 'Cannot submit recommendation: Employee is currently serving NOTICE period and ineligible for annual increment/promotion.' });
      }

      // Role check: If caller is MANAGER, verify they are the assigned reporting manager
      if (user?.role === 'MANAGER' && appraisal.managerId !== user.employeeId) {
        return res.status(403).json({ error: 'Unauthorized: You can only submit recommendations for your assigned direct reports.' });
      }

      const currentCtc = appraisal.currentCtc;
      const incPercent = Number(suggestedIncrementPercent) || appraisal.suggestedIncrementMin || 10;
      const incrementAmount = Math.round((currentCtc * incPercent) / 100);
      const revisedCtc = currentCtc + incrementAmount;

      const managerRecommendation = {
        suggestedIncrementPercent: incPercent,
        promotionRecommended: Boolean(promotionRecommended),
        promotionDesignationId: promotionDesignationId || undefined,
        promotionDesignationName: promotionDesignationName || undefined,
        justification: justification || 'Recommended based on rolling quarterly performance.',
        strengthsSummary: strengthsSummary || '',
        recommendedBy: user?.id || 'usr_manager',
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

      await appraisalsCol.updateOne({ id }, { $set: updatedDoc });

      // Notify HOD
      const notifsCol = getDbCollection('notifications');
      await notifsCol.insertOne({
        id: `notif_${Date.now()}`,
        userId: appraisal.hodId || undefined,
        userRole: 'HOD',
        type: 'HOD_ACTION_REQUIRED',
        title: `Manager Appraisal Submitted: ${appraisal.employeeName}`,
        message: `${user?.name || 'Manager'} submitted recommendation (${incPercent}% increment${promotionRecommended ? ' + Promotion' : ''}) for ${appraisal.employeeName}. Ready for HOD calibration.`,
        isRead: false,
        priority: 'HIGH',
        metadata: { appraisalId: id, cycleId: appraisal.cycleId, activeSection: 'appraisals' },
        createdAt: new Date().toISOString(),
      });

      // Audit log
      if (user) {
        await recordAuditLog(
          user.id,
          user.name,
          user.role,
          'APPRAISAL_CALIBRATION',
          'MANAGER_RECOMMENDATION_SUBMITTED',
          id,
          String(appraisal.proposedIncrementPercentage || 0),
          `Suggested ${incPercent}% increment, Promotion: ${promotionRecommended ? 'YES' : 'NO'}`,
          justification || ''
        );
      }

      const refreshed = await appraisalsCol.findOne({ id });
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
  requireRoles('HOD', 'SUPER_ADMIN', 'HR'),
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

      if (appraisal.isLocked) {
        return res.status(400).json({ error: 'Cannot modify a locked appraisal record' });
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

      // HOD Department Verification
      if (user?.role === 'HOD') {
        const isDeptMatch =
          (req.employeeProfile?.departmentId && appraisal.departmentId === req.employeeProfile.departmentId) ||
          (req.employeeProfile?.departmentName && appraisal.departmentName?.toLowerCase() === req.employeeProfile.departmentName.toLowerCase());
        if (appraisal.hodId !== user.employeeId && !isDeptMatch) {
          return res.status(403).json({ error: 'Unauthorized: You can only calibrate appraisals within your department.' });
        }
      }

      const currentCtc = appraisal.currentCtc;
      const finalInc = Number(calibratedIncrementPercent) || appraisal.proposedIncrementPercentage;
      const incrementAmount = Math.round((currentCtc * finalInc) / 100);
      const revisedCtc = currentCtc + incrementAmount;

      const hodCalibration = {
        calibratedIncrementPercent: finalInc,
        promotionApproved: Boolean(promotionApproved),
        calibratedRating: calibratedRating || appraisal.recommendedRating,
        notes: notes || 'HOD departmental calibration and budget alignment completed.',
        calibratedBy: user?.id || 'usr_hod',
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
      await notifsCol.insertOne({
        id: `notif_${Date.now()}`,
        userId: 'ALL',
        userRole: 'HR',
        type: 'HOD_ACTION_REQUIRED',
        title: `Appraisal Calibrated: ${appraisal.employeeName}`,
        message: `${user?.name || 'HOD'} calibrated appraisal for ${appraisal.employeeName} (${finalInc}% increment). Ready for HR final approval.`,
        isRead: false,
        priority: 'HIGH',
        metadata: { appraisalId: id, cycleId: appraisal.cycleId, activeSection: 'appraisals', status: 'HOD_CALIBRATED', openDetail: true },
        createdAt: new Date().toISOString(),
      });

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
      res.json(refreshed);
    } catch (err: any) {
      console.error('Error in PUT /api/appraisals/:id/hod-calibrate:', err);
      res.status(500).json({ error: err.message || 'Failed to calibrate appraisal' });
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

      // Safeguard: Check employee status
      const employeesCol = getDbCollection('employees');
      const empRecord = await employeesCol.findOne({ id: appraisal.employeeId });
      if (empRecord && empRecord.status === 'INACTIVE') {
        return res.status(400).json({ error: 'Cannot approve appraisal: Employee is INACTIVE (Offboarded/Exited).' });
      }
      if (empRecord && empRecord.status === 'NOTICE') {
        return res.status(400).json({ error: 'Cannot approve appraisal: Employee is currently serving NOTICE period and ineligible for annual increment/promotion.' });
      }

      const currentCtc = appraisal.currentCtc;
      const approvedInc = Number(finalIncrementPercent) || appraisal.approvedIncrementPercentage || 12;
      const incrementAmount = Math.round((currentCtc * approvedInc) / 100);
      const revisedCtc = currentCtc + incrementAmount;

      const hrApproval = {
        finalIncrementPercent: approvedInc,
        finalRating: finalRating || appraisal.finalRating,
        revisedCtc,
        effectiveDate: effectiveDate || `${appraisal.appraisalYear}-10-01`,
        letterGenerated: true,
        letterGeneratedAt: new Date().toISOString(),
        notes: notes || 'HR final approval and compensation verification completed.',
        approvedBy: user?.id || 'usr_hr',
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
      await notifsCol.insertOne({
        id: `notif_${Date.now()}`,
        userId: appraisal.hodId || undefined,
        userRole: 'HOD',
        type: 'APPRAISAL_DUE',
        title: `Appraisal Approved by HR: ${appraisal.employeeName}`,
        message: `HR final approval confirmed for ${appraisal.employeeName} (${approvedInc}% increment). Letter generated and staged for release.`,
        isRead: false,
        priority: 'MEDIUM',
        metadata: { appraisalId: id, cycleId: appraisal.cycleId, activeSection: 'appraisals' },
        createdAt: new Date().toISOString(),
      });

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
  requireRoles('HR', 'SUPER_ADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const user = req.user;
      const { id } = req.params;

      const appraisalsCol = getDbCollection('appraisals');
      const appraisal: Appraisal | null = await appraisalsCol.findOne({ id });

      if (!appraisal) {
        return res.status(404).json({ error: 'Appraisal record not found' });
      }

      const lockedAt = new Date().toISOString();
      await appraisalsCol.updateOne(
        { id },
        {
          $set: {
            status: 'LOCKED',
            isLocked: true,
            lockedAt,
            updatedAt: lockedAt,
          },
        }
      );

      // Update Employee Master Record
      const employeesCol = getDbCollection('employees');
      const employee: Employee | null = await employeesCol.findOne({ id: appraisal.employeeId });

      if (employee) {
        const empUpdate: Partial<Employee> = {
          currentCtc: appraisal.revisedCtc,
          lastAppraisalDate: lockedAt,
        };

        if (appraisal.promotionRecommended && appraisal.promotionDesignationId) {
          empUpdate.designationId = appraisal.promotionDesignationId;
          empUpdate.designationName = appraisal.promotionDesignationName;
        }

        await employeesCol.updateOne({ id: employee.id }, { $set: empUpdate });
      }

      // Send Notification to Employee
      const notificationsCol = getDbCollection('notifications');
      await notificationsCol.insertOne({
        id: `notif_${Date.now()}`,
        userId: appraisal.employeeId,
        userRole: 'EMPLOYEE',
        type: 'LETTER_RELEASED',
        title: '🎉 Annual Appraisal Letter Released',
        message: `Your annual performance appraisal for ${appraisal.cycleName} has been approved and locked. View your appraisal letter for compensation details.`,
        isRead: false,
        priority: 'HIGH',
        metadata: { appraisalId: id, cycleId: appraisal.cycleId, subTab: 'appraisal', openLetter: true },
        createdAt: lockedAt,
      });

      if (user) {
        await recordAuditLog(
          user.id,
          user.name,
          user.role,
          'ANNUAL_APPRAISAL',
          'APPRAISAL_LOCKED',
          id,
          'UNLOCKED',
          `Locked appraisal. Updated Employee CTC to ${appraisal.currency}${appraisal.revisedCtc.toLocaleString()}`,
          ''
        );
      }

      const refreshed = await appraisalsCol.findOne({ id });
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
    } else if (user.role === 'MANAGER') {
      if (appraisal.managerId !== user.employeeId && appraisal.employeeId !== user.employeeId) {
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
    res.json(refreshed);
  } catch (err: any) {
    console.error('Error in PUT /api/appraisals/:id/acknowledge:', err);
    res.status(500).json({ error: err.message || 'Failed to acknowledge appraisal' });
  }
});
