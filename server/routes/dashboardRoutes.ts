import express, { Response } from 'express';
import { getDbCollection } from '../db.js';
import { authenticateToken, requireRoles, AuthenticatedRequest } from '../auth.js';
import {
  EmployeeReview,
  ReviewPeriod,
  Appraisal,
  Employee,
  Department,
  Cycle,
} from '../../src/types.js';

export const dashboardRouter = express.Router();
dashboardRouter.use(authenticateToken);

/**
 * GET /api/dashboard/hr
 * HR & Super Admin centralized operational dashboard
 */
dashboardRouter.get(
  '/dashboard/hr',
  requireRoles('SUPER_ADMIN', 'HR'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const reviewCol = getDbCollection('employeeReviews');
      const periodCol = getDbCollection('reviewPeriods');
      const appraisalCol = getDbCollection('appraisals');
      const empCol = getDbCollection('employees');
      const cycleCol = getDbCollection('cycles');

      const currentPeriod: ReviewPeriod | null =
        (await periodCol.findOne({ status: 'ACTIVE' })) ||
        (await periodCol.find({})).sort({ year: -1, quarter: -1 })[0] ||
        null;

      const allEmployees: Employee[] = await (await empCol.find({})).toArray();
      const activeEmployees = allEmployees.filter((e) => e.status === 'ACTIVE');

      const reviews: EmployeeReview[] = currentPeriod
        ? await (await reviewCol.find({ reviewPeriodId: currentPeriod.id })).toArray()
        : [];

      const totalReviews = reviews.length;
      const managerPending = reviews.filter((r) => r.status === 'MANAGER_PENDING').length;
      const managerCompleted = reviews.filter((r) => r.status === 'MANAGER_COMPLETED').length;
      const hrPending = reviews.filter((r) => r.status === 'HR_PENDING').length;
      const returned = reviews.filter((r) => r.status === 'RETURNED').length;
      const closed = reviews.filter((r) => r.status === 'CLOSED' || r.isClosed).length;
      const completionRate = totalReviews > 0 ? Math.round((closed / totalReviews) * 100) : 0;

      // Unassigned managers exceptions
      const unassignedEmployees = activeEmployees.filter((e) => !e.managerId && !e.hodId);

      // Annual appraisal summary
      const currentMonth = new Date().getMonth() + 1;
      const currentYear = new Date().getFullYear();
      const allCycles: Cycle[] = await (await cycleCol.find({})).toArray();
      const currentMonthCycles = allCycles.filter((c) => c.appraisalMonth === currentMonth);
      const currentMonthCycleIds = new Set(currentMonthCycles.map((c) => c.id));

      const dueForAppraisalCount = activeEmployees.filter(
        (e) => e.cycleId && currentMonthCycleIds.has(e.cycleId)
      ).length;

      const appraisals: Appraisal[] = await (
        await appraisalCol.find({ appraisalYear: currentYear })
      ).toArray();

      const totalPayroll = appraisals.reduce((sum, a) => sum + (a.currentCtc || 0), 0);
      const revisedPayroll = appraisals.reduce((sum, a) => sum + (a.revisedCtc || a.currentCtc || 0), 0);
      const budgetConsumed = revisedPayroll - totalPayroll;

      res.json({
        period: currentPeriod,
        employeeCounts: {
          total: allEmployees.length,
          active: activeEmployees.length,
          unassignedManagers: unassignedEmployees.length,
        },
        reviewMetrics: {
          total: totalReviews,
          managerPending,
          managerCompleted,
          hrPending,
          returned,
          closed,
          completionRate,
        },
        appraisalMetrics: {
          currentMonth,
          currentYear,
          dueThisMonth: dueForAppraisalCount,
          totalInitiated: appraisals.length,
          budgetConsumed,
          lockedCount: appraisals.filter((a) => a.isLocked).length,
        },
        actionRequired: {
          pendingHrApprovals: hrPending,
          returnedReviews: returned,
          unassignedEmployees: unassignedEmployees.map((e) => ({
            id: e.id,
            name: e.name,
            code: e.employeeCode,
            department: e.departmentName,
          })),
        },
      });
    } catch (err: any) {
      console.error('Failed to fetch HR dashboard:', err);
      res.status(500).json({ error: 'Failed to load HR dashboard data.' });
    }
  }
);

/**
 * GET /api/dashboard/manager
 * Reporting Manager team dashboard
 */
dashboardRouter.get(
  '/dashboard/manager',
  requireRoles('REPORTING_MANAGER', 'MANAGER', 'HOD', 'SUPER_ADMIN', 'HR'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const managerId = req.user?.employeeId || req.user?.id;
      const reviewCol = getDbCollection('employeeReviews');
      const empCol = getDbCollection('employees');
      const periodCol = getDbCollection('reviewPeriods');
      const appraisalCol = getDbCollection('appraisals');

      const currentPeriod: ReviewPeriod | null =
        (await periodCol.findOne({ status: 'ACTIVE' })) ||
        (await periodCol.find({})).sort({ year: -1, quarter: -1 })[0] ||
        null;

      // Direct reports
      const directReports: Employee[] = await (
        await empCol.find({
          status: 'ACTIVE',
          $or: [{ managerId }, { managerId: req.user?.id }],
        })
      ).toArray();

      // Direct report reviews
      const teamReviews: EmployeeReview[] = currentPeriod
        ? await (
            await reviewCol.find({
              reviewPeriodId: currentPeriod.id,
              $or: [{ managerId }, { managerId: req.user?.id }],
            })
          ).toArray()
        : [];

      const pendingEvaluations = teamReviews.filter(
        (r) => r.status === 'MANAGER_PENDING' || r.status === 'RETURNED' || r.status === 'DRAFT'
      );
      const submittedEvaluations = teamReviews.filter(
        (r) => r.status === 'HR_PENDING' || r.status === 'CLOSED' || r.status === 'MANAGER_COMPLETED'
      );

      // Team scores
      const completedScores = teamReviews
        .filter((r) => (r.finalScore || 0) > 0)
        .map((r) => r.finalScore || 0);
      const avgTeamScore =
        completedScores.length > 0
          ? Number((completedScores.reduce((a, b) => a + b, 0) / completedScores.length).toFixed(2))
          : 0;

      // Upcoming appraisal recommendations
      const currentYear = new Date().getFullYear();
      const teamAppraisals: Appraisal[] = await (
        await appraisalCol.find({
          appraisalYear: currentYear,
          $or: [{ managerId }, { managerId: req.user?.id }],
        })
      ).toArray();

      res.json({
        currentPeriod,
        directReportsCount: directReports.length,
        pendingEvaluationsCount: pendingEvaluations.length,
        submittedEvaluationsCount: submittedEvaluations.length,
        averageTeamScore: avgTeamScore,
        pendingReviewsList: pendingEvaluations.map((r) => ({
          id: r.id,
          employeeId: r.employeeId,
          employeeName: r.employeeName,
          employeeCode: r.employeeCode,
          designationName: r.designationName,
          status: r.status,
          selfScore: r.selfScore,
          isSelfSubmitted: r.isSelfSubmitted,
        })),
        appraisalsSummary: {
          total: teamAppraisals.length,
          pendingRecommendations: teamAppraisals.filter((a) => a.status === 'PENDING').length,
          completed: teamAppraisals.filter((a) => a.status !== 'PENDING').length,
        },
      });
    } catch (err: any) {
      console.error('Failed to fetch manager dashboard:', err);
      res.status(500).json({ error: 'Failed to load manager dashboard data.' });
    }
  }
);

/**
 * GET /api/dashboard/hod
 * Department Head roll-up metrics, calibration, and budget status
 */
dashboardRouter.get(
  '/dashboard/hod',
  requireRoles('HOD', 'SUPER_ADMIN', 'HR'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const deptId = req.employeeProfile?.departmentId;
      const deptCol = getDbCollection('departments');
      const empCol = getDbCollection('employees');
      const reviewCol = getDbCollection('employeeReviews');
      const appraisalCol = getDbCollection('appraisals');
      const periodCol = getDbCollection('reviewPeriods');

      const department: Department | null = deptId
        ? await deptCol.findOne({ id: deptId })
        : null;

      const currentPeriod: ReviewPeriod | null =
        (await periodCol.findOne({ status: 'ACTIVE' })) ||
        (await periodCol.find({})).sort({ year: -1, quarter: -1 })[0] ||
        null;

      const deptFilter = deptId ? { departmentId: deptId } : {};
      const deptEmployees: Employee[] = await (await empCol.find({ ...deptFilter, status: 'ACTIVE' })).toArray();

      const deptReviews: EmployeeReview[] = currentPeriod
        ? await (await reviewCol.find({ ...deptFilter, reviewPeriodId: currentPeriod.id })).toArray()
        : [];

      const currentYear = new Date().getFullYear();
      const deptAppraisals: Appraisal[] = await (
        await appraisalCol.find({ ...deptFilter, appraisalYear: currentYear })
      ).toArray();

      const currentPayroll = deptAppraisals.reduce((sum, a) => sum + (a.currentCtc || 0), 0);
      const budgetCapPercent = department?.budgetCapPercent || 12.0;
      const allocatedBudget = currentPayroll * (budgetCapPercent / 100);
      const revisedPayroll = deptAppraisals.reduce((sum, a) => sum + (a.revisedCtc || a.currentCtc || 0), 0);
      const actualSpent = revisedPayroll - currentPayroll;

      res.json({
        department: department || { name: 'All Departments' },
        currentPeriod,
        headcount: deptEmployees.length,
        reviewsProgress: {
          total: deptReviews.length,
          completed: deptReviews.filter((r) => r.status === 'CLOSED' || r.isClosed).length,
          inProgress: deptReviews.filter((r) => r.status !== 'CLOSED' && !r.isClosed).length,
        },
        budgetPool: {
          currentPayroll,
          budgetCapPercent,
          allocatedBudget,
          actualSpent,
          remainingBudget: allocatedBudget - actualSpent,
          isOverBudget: actualSpent > allocatedBudget,
        },
        calibrationStatus: {
          total: deptAppraisals.length,
          pendingHOD: deptAppraisals.filter((a) => a.status === 'MANAGER_RECOMMENDED').length,
          calibrated: deptAppraisals.filter((a) => a.status === 'HOD_CALIBRATED' || a.status === 'HR_APPROVED' || a.isLocked).length,
        },
      });
    } catch (err: any) {
      console.error('Failed to fetch HOD dashboard:', err);
      res.status(500).json({ error: 'Failed to load HOD dashboard data.' });
    }
  }
);

/**
 * GET /api/dashboard/employee
 * Employee self-service dashboard: active review, score history, appraisal status
 */
dashboardRouter.get(
  '/dashboard/employee',
  requireRoles('EMPLOYEE', 'REPORTING_MANAGER', 'MANAGER', 'HOD', 'HR', 'SUPER_ADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const employeeId = req.user?.employeeId || req.user?.id;
      const reviewCol = getDbCollection('employeeReviews');
      const periodCol = getDbCollection('reviewPeriods');
      const appraisalCol = getDbCollection('appraisals');
      const empCol = getDbCollection('employees');

      const employee: Employee | null = await empCol.findOne({ id: employeeId });
      const currentPeriod: ReviewPeriod | null =
        (await periodCol.findOne({ status: 'ACTIVE' })) ||
        (await periodCol.find({})).sort({ year: -1, quarter: -1 })[0] ||
        null;

      // Active review for current period
      const currentReview: EmployeeReview | null = currentPeriod
        ? await reviewCol.findOne({ employeeId, reviewPeriodId: currentPeriod.id })
        : null;

      // Past reviews
      const allReviews: EmployeeReview[] = await (
        await reviewCol.find({ employeeId })
      ).toArray();

      allReviews.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      // Latest annual appraisal
      const latestAppraisal: Appraisal | null =
        (await appraisalCol.find({ employeeId })).sort({ appraisalYear: -1 })[0] || null;

      res.json({
        employee: {
          id: employee?.id,
          name: employee?.name,
          employeeCode: employee?.employeeCode,
          email: employee?.email,
          phone: employee?.phone,
          location: employee?.location,
          departmentId: employee?.departmentId,
          departmentName: employee?.departmentName,
          designationId: employee?.designationId,
          designationName: employee?.designationName,
          joiningDate: employee?.joiningDate,
          status: employee?.status,
          managerId: employee?.managerId,
          managerName: employee?.managerName,
          hodId: employee?.hodId,
          hodName: employee?.hodName,
          cycleId: employee?.cycleId,
          cycleName: employee?.cycleName || 'Quarterly Cycle',
          cycleCode: employee?.cycleCode,
          currentCtc: employee?.currentCtc,
          currency: employee?.currency || '₹',
        },
        currentQuarter: {
          period: currentPeriod,
          reviewId: currentReview?.id,
          status: currentReview?.status || 'NOT_STARTED',
          isSelfSubmitted: currentReview?.isSelfSubmitted || false,
          selfScore: currentReview?.selfScore,
          finalScore: currentReview?.finalScore,
          isClosed: currentReview?.isClosed || false,
        },
        history: allReviews.map((r) => ({
          id: r.id,
          periodName: r.reviewPeriodName,
          finalScore: r.finalScore,
          selfScore: r.selfScore,
          status: r.status,
          completedAt: r.completedAt,
        })),
        appraisal: latestAppraisal
          ? {
              id: latestAppraisal.id,
              year: latestAppraisal.appraisalYear,
              cycleName: latestAppraisal.cycleName,
              status: latestAppraisal.status,
              isLocked: latestAppraisal.isLocked,
              letterReleased: latestAppraisal.letterReleased,
              acknowledged: !!latestAppraisal.employeeAcknowledgement?.acknowledged,
            }
          : null,
      });
    } catch (err: any) {
      console.error('Failed to fetch employee dashboard:', err);
      res.status(500).json({ error: 'Failed to load employee dashboard data.' });
    }
  }
);
