import express, { Response } from 'express';
import { getDbCollection } from '../db.js';
import {
  authenticateToken,
  requireRoles,
  recordAuditLog,
  AuthenticatedRequest,
  authorizeEmployeeAccess,
  authorizeReviewAccess,
} from '../auth.js';
import { validateBody, SubmitSelfAssessmentSchema, SubmitManagerReviewSchema } from '../validation.js';
import {
  EmployeeReview,
  ReviewPeriod,
  ReviewKraSnapshot,
  ReviewAction,
  ReviewStatus,
  Employee,
  KraTemplate,
  Cycle,
  Department,
  ReviewSummaryStats,
} from '../../src/types/index.js';
import { sendNotificationEmail, resolveRecipient } from '../services/emailService.js';
import { renderSelfAssessmentSubmittedEmail, renderManagerReviewSubmittedEmail } from '../services/emailTemplates.js';
import {
  generateQuarterlyReviews,
  submitManagerReview,
  returnReview,
  completeHRReview,
  saveManagerDraft,
  hodApproveReview,
  hodReturnReview,
} from '../services/workflowService.js';
import {
  checkEmployeeReviewEligibility,
  createQuarterlyReview,
  calculatePeriodTenureDays,
} from '../services/reviewEligibility.js';

export const reviewRouter = express.Router();

// All review routes require authentication
reviewRouter.use(authenticateToken);

// ==========================================
// 1. REVIEW PERIODS
// ==========================================

/**
 * GET /api/review-periods/current
 * Returns the currently active quarterly period
 */
reviewRouter.get('/review-periods/current', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const periodCol = getDbCollection('reviewPeriods');
    let current = await periodCol.findOne({ status: 'ACTIVE' });
    if (!current) {
      const periods: ReviewPeriod[] = await (await periodCol.find({})).toArray();
      periods.sort((a, b) => (b.year !== a.year ? b.year - a.year : b.quarter - a.quarter));
      current = periods[0] || null;
    }
    if (!current) {
      return res.status(404).json({ error: 'No review periods found.' });
    }
    res.json(current);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch current review period.' });
  }
});

/**
 * GET /api/review-periods
 */
reviewRouter.get('/review-periods', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const periodCol = getDbCollection('reviewPeriods');
    const periods: ReviewPeriod[] = await (await periodCol.find({})).toArray();
    // Sort descending by year and quarter
    periods.sort((a, b) => {
      if (b.year !== a.year) return b.year - a.year;
      return b.quarter - a.quarter;
    });
    res.json(periods);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch review periods.' });
  }
});

/**
 * POST /api/review-periods
 * Super Admin & HR only
 */
reviewRouter.post(
  '/review-periods',
  requireRoles('SUPER_ADMIN', 'HR'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { name, quarter, year, startDate, endDate, dueDate, status } = req.body;

      if (!name || !quarter || !year) {
        return res.status(400).json({ error: 'Name, quarter, and year are required.' });
      }

      const periodCol = getDbCollection('reviewPeriods');
      const newPeriod: ReviewPeriod = {
        id: `period_${year}_q${quarter}_${Date.now().toString(36)}`,
        name,
        quarter: Number(quarter) as 1 | 2 | 3 | 4,
        year: Number(year),
        startDate: startDate || new Date(year, (quarter - 1) * 3, 1).toISOString(),
        endDate: endDate || new Date(year, quarter * 3, 0, 23, 59, 59).toISOString(),
        dueDate: dueDate || new Date(year, quarter * 3, 15, 23, 59, 59).toISOString(),
        status: status || 'ACTIVE',
      };

      await periodCol.insertOne(newPeriod);

      if (req.user) {
        await recordAuditLog(
          req.user.id,
          req.user.name,
          req.user.role,
          'REVIEW_PERIODS',
          'CREATE',
          newPeriod.id,
          '',
          newPeriod.name,
          `Created review period ${newPeriod.name}`
        );
      }

      res.status(201).json(newPeriod);
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to create review period.' });
    }
  }
);

/**
 * PUT /api/review-periods/:id
 * Super Admin & HR only
 */
reviewRouter.put(
  '/review-periods/:id',
  requireRoles('SUPER_ADMIN', 'HR'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = req.params;
      const updates = req.body;
      const periodCol = getDbCollection('reviewPeriods');

      const existing = await periodCol.findOne({ id });
      if (!existing) {
        return res.status(404).json({ error: 'Review period not found.' });
      }

      if (updates.status === 'ACTIVE') {
        // Only one period should normally be ACTIVE at any given time. Transition any existing ACTIVE period to LOCKED.
        const allActive = await (await periodCol.find({ status: 'ACTIVE' })).toArray();
        for (const act of allActive) {
          if (act.id !== id) {
            await periodCol.updateOne({ id: act.id }, { $set: { status: 'LOCKED' } });
          }
        }
      }

      const updated = { ...existing, ...updates };
      await periodCol.updateOne({ id }, { $set: updated });

      if (req.user) {
        await recordAuditLog(
          req.user.id,
          req.user.name,
          req.user.role,
          'REVIEW_PERIODS',
          'UPDATE',
          id,
          existing.status,
          updated.status,
          `Updated review period ${existing.name} status to ${updated.status}`
        );
      }

      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to update review period.' });
    }
  }
);

// ==========================================
// 2. EMPLOYEE REVIEWS & WORKFLOW
// ==========================================

/**
 * GET /api/reviews
 * Query parameters: periodId, departmentId, managerId, employeeId, status, search, onlyMine
 */
reviewRouter.get('/reviews', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { periodId, departmentId, managerId, employeeId, status, search, onlyMine } = req.query;

    const reviewCol = getDbCollection('employeeReviews');
    const employeesCol = getDbCollection('employees');

    const reviewQuery: any = {};
    if (req.user?.role === 'EMPLOYEE' && req.user?.employeeId) {
      reviewQuery.employeeId = req.user.employeeId;
    } else if (employeeId) {
      reviewQuery.employeeId = employeeId;
    }
    if (periodId && periodId !== 'ALL') {
      reviewQuery.reviewPeriodId = periodId;
    }
    if (status && status !== 'ALL' && status !== 'undefined') {
      if (status === 'SELF_ASSESSED') {
        reviewQuery.status = 'MANAGER_PENDING';
      } else if (status === 'MANAGER_COMPLETED' || status === 'HR_PENDING') {
        reviewQuery.status = { $in: ['HR_PENDING', 'MANAGER_COMPLETED'] };
      } else {
        reviewQuery.status = status;
      }
    }

    let reviews: EmployeeReview[] = await (await reviewCol.find(reviewQuery)).toArray();
    const allEmployees: Employee[] = await (await employeesCol.find({})).toArray();
    const empMap = new Map<string, Employee>();
    allEmployees.forEach((e) => empMap.set(e.id, e));

    // Strict RBAC Role-based visibility filtering
    if (req.user?.role === 'EMPLOYEE') {
      reviews = reviews.filter((r) => r.employeeId === req.user?.employeeId);
    } else if (req.user?.role === 'MANAGER' || req.user?.role === 'REPORTING_MANAGER') {
      // Managers can see their direct reports (or themselves) - strictly by ID
      reviews = reviews.filter((r) => {
        const empRecord = empMap.get(r.employeeId);
        return (
          r.managerId === req.user?.employeeId ||
          r.managerId === req.user?.id ||
          r.employeeId === req.user?.employeeId ||
          empRecord?.managerId === req.user?.employeeId ||
          empRecord?.managerId === req.user?.id
        );
      });
    } else if (req.user?.role === 'HOD') {
      // HODs can see their department roll-ups, direct reports, or themselves
      reviews = reviews.filter((r) => {
        const empRecord = empMap.get(r.employeeId);
        const userDeptId = req.employeeProfile?.departmentId;
        const userDeptName = req.employeeProfile?.departmentName?.toLowerCase();
        return (
          r.hodId === req.user?.employeeId ||
          r.managerId === req.user?.employeeId ||
          r.employeeId === req.user?.employeeId ||
          empRecord?.hodId === req.user?.employeeId ||
          empRecord?.managerId === req.user?.employeeId ||
          (userDeptId && r.departmentId === userDeptId) ||
          (userDeptId && empRecord?.departmentId === userDeptId) ||
          (userDeptName && r.departmentName?.toLowerCase() === userDeptName)
        );
      });
    }
    // SUPER_ADMIN and HR can see everything.

    if (onlyMine === 'true' && req.user?.employeeId) {
      reviews = reviews.filter((r) => {
        const empRecord = empMap.get(r.employeeId);
        return (
          (r.managerId === req.user?.employeeId || empRecord?.managerId === req.user?.employeeId) &&
          r.employeeId !== req.user?.employeeId
        );
      });
    }

    if (periodId && periodId !== 'ALL' && periodId !== 'undefined') {
      reviews = reviews.filter((r) => r.reviewPeriodId === periodId);
    }

    if (departmentId && departmentId !== 'ALL' && departmentId !== 'undefined') {
      reviews = reviews.filter((r) => r.departmentId === departmentId);
    }

    if (managerId && managerId !== 'ALL' && managerId !== 'undefined') {
      reviews = reviews.filter((r) => r.managerId === managerId);
    }

    if (employeeId && employeeId !== 'undefined') {
      reviews = reviews.filter((r) => r.employeeId === employeeId);
    }

    if (status && status !== 'ALL' && status !== 'undefined') {
      if (status === 'SELF_ASSESSED') {
        reviews = reviews.filter(
          (r) => (r.status === 'MANAGER_PENDING' && r.isSelfSubmitted) || r.status === 'MANAGER_PENDING'
        );
      } else if (status === 'MANAGER_COMPLETED' || status === 'HR_PENDING') {
        reviews = reviews.filter(
          (r) => r.status === 'HR_PENDING' || r.status === 'MANAGER_COMPLETED'
        );
      } else {
        reviews = reviews.filter((r) => r.status === status);
      }
    }

    if (search) {
      const q = String(search).toLowerCase();
      reviews = reviews.filter(
        (r) =>
          r.employeeName.toLowerCase().includes(q) ||
          r.employeeCode.toLowerCase().includes(q) ||
          r.departmentName.toLowerCase().includes(q) ||
          r.designationName.toLowerCase().includes(q) ||
          r.managerName?.toLowerCase().includes(q)
      );
    }

    // Sort: most recently updated first
    reviews.sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());

    // Enrich with real-time employee employment status
    const enrichedReviews = reviews.map((r) => {
      const empRecord = empMap.get(r.employeeId);
      return {
        ...r,
        employeeStatus: empRecord?.status || r.employeeStatus || 'ACTIVE',
      };
    });

    res.json(enrichedReviews);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch employee reviews.' });
  }
});

/**
 * GET /api/reviews/stats
 * Aggregate metrics for review dashboard
 */
reviewRouter.get('/reviews/stats', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { periodId, departmentId } = req.query;
    const reviewCol = getDbCollection('employeeReviews');
    const employeesCol = getDbCollection('employees');

    let reviews: EmployeeReview[] = await (await reviewCol.find({})).toArray();
    const allEmployees: Employee[] = await (await employeesCol.find({})).toArray();
    const empMap = new Map<string, Employee>();
    allEmployees.forEach((e) => empMap.set(e.id, e));

    // Strict RBAC Role-based visibility filtering
    if (req.user?.role === 'EMPLOYEE') {
      reviews = reviews.filter((r) => r.employeeId === req.user?.employeeId);
    } else if (req.user?.role === 'MANAGER' || req.user?.role === 'REPORTING_MANAGER') {
      reviews = reviews.filter((r) => {
        const empRecord = empMap.get(r.employeeId);
        return (
          r.managerId === req.user?.employeeId ||
          r.managerId === req.user?.id ||
          r.employeeId === req.user?.employeeId ||
          empRecord?.managerId === req.user?.employeeId ||
          empRecord?.managerId === req.user?.id
        );
      });
    } else if (req.user?.role === 'HOD') {
      reviews = reviews.filter((r) => {
        const empRecord = empMap.get(r.employeeId);
        const userDeptId = req.employeeProfile?.departmentId;
        const userDeptName = req.employeeProfile?.departmentName?.toLowerCase();
        return (
          r.hodId === req.user?.employeeId ||
          r.managerId === req.user?.employeeId ||
          r.employeeId === req.user?.employeeId ||
          empRecord?.hodId === req.user?.employeeId ||
          empRecord?.managerId === req.user?.employeeId ||
          (userDeptId && r.departmentId === userDeptId) ||
          (userDeptId && empRecord?.departmentId === userDeptId) ||
          (userDeptName && r.departmentName?.toLowerCase() === userDeptName)
        );
      });
    }

    if (periodId && periodId !== 'ALL') {
      reviews = reviews.filter((r) => r.reviewPeriodId === periodId);
    }

    if (departmentId && departmentId !== 'ALL') {
      reviews = reviews.filter((r) => r.departmentId === departmentId);
    }

    const total = reviews.length;
    const draft = reviews.filter((r) => r.status === 'DRAFT' || r.status === 'ASSIGNED').length;
    const managerPending = reviews.filter((r) => r.status === 'MANAGER_PENDING').length;
    const managerCompleted = reviews.filter((r) => r.status === 'MANAGER_COMPLETED' || r.status === 'HR_PENDING').length;
    const hodPending = reviews.filter((r) => r.status === 'HOD_PENDING').length;
    const hrPending = reviews.filter((r) => r.status === 'HR_PENDING' || r.status === 'HR_COMPLETED').length;
    const closed = reviews.filter((r) => r.status === 'CLOSED' || r.isClosed).length;
    const exceptions = reviews.filter((r) => r.status === 'HOD_PENDING' && !r.hodId).length;

    const scoredReviews = reviews.filter((r) => (r.finalScore || 0) > 0);
    const avgScore =
      scoredReviews.length > 0
        ? Number(
            (scoredReviews.reduce((sum, r) => sum + (r.finalScore || 0), 0) / scoredReviews.length).toFixed(2)
          )
        : 0;

    const completedReviewsCount = reviews.filter((r) => !['DRAFT', 'ASSIGNED', 'MANAGER_PENDING'].includes(r.status)).length;
    const completionRate = total > 0 ? Math.round((completedReviewsCount / total) * 100) : 0;

    const distribution = {
      outstanding: scoredReviews.filter((r) => (r.finalScore || 0) >= 4.5).length,
      exceeds: scoredReviews.filter((r) => (r.finalScore || 0) >= 3.5 && (r.finalScore || 0) < 4.5).length,
      meets: scoredReviews.filter((r) => (r.finalScore || 0) >= 2.5 && (r.finalScore || 0) < 3.5).length,
      needsImprovement: scoredReviews.filter((r) => (r.finalScore || 0) > 0 && (r.finalScore || 0) < 2.5).length,
      unscored: reviews.filter((r) => !r.finalScore || r.finalScore === 0).length,
    };

    const stats: ReviewSummaryStats = {
      total,
      draft,
      managerPending,
      managerCompleted,
      hodPending,
      hrPending,
      closed,
      exceptions,
      averageScore: avgScore,
      completionRate,
      distribution,
    };

    res.json(stats);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to calculate review statistics.' });
  }
});

/**
 * GET /api/reviews/check-eligibility
 * Check if an employee is eligible for review in a specific quarter.
 * Returns tenure calculation, pass/fail checks, and whether manual override is allowed.
 * Roles: SUPER_ADMIN, HR, HOD, MANAGER
 */
reviewRouter.get(
  '/reviews/check-eligibility',
  requireRoles('SUPER_ADMIN', 'HR', 'HOD', 'MANAGER', 'REPORTING_MANAGER'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { employeeId, reviewPeriodId } = req.query;

      if (!employeeId || !reviewPeriodId) {
        return res.status(400).json({ error: 'employeeId and reviewPeriodId are required query parameters.' });
      }

      const empCol = getDbCollection('employees');
      const periodCol = getDbCollection('reviewPeriods');

      const emp = await empCol.findOne({ id: String(employeeId) });
      if (!emp) {
        return res.status(404).json({ error: 'Employee not found.' });
      }

      const period = await periodCol.findOne({ id: String(reviewPeriodId) });
      if (!period) {
        return res.status(404).json({ error: 'Review period not found.' });
      }

      const eligibility = await checkEmployeeReviewEligibility(emp, period);

      res.json({
        ...eligibility,
        employee: {
          id: emp.id,
          name: emp.name,
          employeeCode: emp.employeeCode,
          status: emp.status,
          joiningDate: emp.joiningDate || (emp as any).dateOfJoining,
          managerName: emp.managerName,
          departmentName: emp.departmentName,
          designationName: emp.designationName,
        },
        period: {
          id: period.id,
          name: period.name,
          quarter: period.quarter,
          year: period.year,
          startDate: period.startDate,
          endDate: period.endDate,
          status: period.status,
        },
      });
    } catch (error: any) {
      console.error('Error checking review eligibility:', error);
      res.status(500).json({ error: 'Failed to check review eligibility.' });
    }
  }
);

/**
 * POST /api/reviews/initiate
 * Manually initiate a quarterly performance review for an employee.
 * Strictly restricted to Super Admin and HR.
 * Bypasses only the tenure check (requiring a justification reason if tenure < 30 days),
 * but validates all other invariants (active status, manager assignment, KRA template, duplicate prevention).
 */
reviewRouter.post(
  '/reviews/initiate',
  requireRoles('SUPER_ADMIN', 'HR'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { employeeId, reviewPeriodId, reason } = req.body;

      if (!employeeId || !reviewPeriodId) {
        return res.status(400).json({ error: 'employeeId and reviewPeriodId are required in the request body.' });
      }

      const empCol = getDbCollection('employees');
      const periodCol = getDbCollection('reviewPeriods');

      const emp = await empCol.findOne({ id: String(employeeId) });
      if (!emp) {
        return res.status(404).json({ error: `Employee ${employeeId} not found.` });
      }

      const period = await periodCol.findOne({ id: String(reviewPeriodId) });
      if (!period) {
        return res.status(404).json({ error: `Review period ${reviewPeriodId} not found.` });
      }

      const eligibility = await checkEmployeeReviewEligibility(emp, period);

      if (!eligibility.canInitiateManually) {
        return res.status(400).json({
          error: eligibility.reason || 'Employee is not eligible for manual review initiation.',
          checks: eligibility.checks,
        });
      }

      if (eligibility.requiresManualOverride && (!reason || !String(reason).trim())) {
        return res.status(400).json({
          error: `Justification reason is mandatory when manually initiating a review for an employee with tenure under ${eligibility.minTenureDays} days.`,
          requiresReason: true,
          tenureDays: eligibility.tenureDays,
          minTenureDays: eligibility.minTenureDays,
        });
      }

      const newReview = await createQuarterlyReview({
        emp,
        period,
        source: 'MANUAL',
        initiatedBy: {
          id: req.user!.id,
          name: req.user!.name,
          role: req.user!.role,
        },
        manualOverrideReason: reason ? String(reason).trim() : undefined,
      });

      res.status(201).json({
        message: `Quarterly review successfully initiated for ${emp.name} (${period.name}).`,
        review: newReview,
      });
    } catch (error: any) {
      console.error('Error initiating manual review:', error);
      res.status(400).json({ error: error.message || 'Failed to initiate review.' });
    }
  }
);

/**
 * GET /api/reviews/my-pending
 * Returns pending reviews assigned to the currently authenticated manager
 */
reviewRouter.get(
  '/reviews/my-pending',
  requireRoles('REPORTING_MANAGER', 'MANAGER', 'HOD', 'SUPER_ADMIN', 'HR'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const reviewCol = getDbCollection('employeeReviews');
      const employeesCol = getDbCollection('employees');
      const managerEmployeeId = req.user?.employeeId;
      const managerUserId = req.user?.id;
      const managerName = req.user?.name?.toLowerCase().trim();
      const role = req.user?.role;

      let reviews: EmployeeReview[] = await (await reviewCol.find({})).toArray();

      if (role === 'HOD') {
        // Strictly scoped to reviews where this HOD is the employee's configured HOD —
        // not every review in the HOD's department (an HOD role does not imply ownership
        // of every employee's review in that department).
        reviews = reviews.filter((r) => r.hodId === managerEmployeeId && r.status === 'HOD_PENDING');
      } else if (role === 'REPORTING_MANAGER' || role === 'MANAGER') {
        const allEmployees: Employee[] = await (await employeesCol.find({})).toArray();
        const directReportIds = new Set(
          allEmployees
            .filter(
              (e) =>
                (managerEmployeeId && e.managerId === managerEmployeeId) ||
                (managerUserId && e.managerId === managerUserId)
            )
            .map((e) => e.id)
        );
        reviews = reviews.filter(
          (r) =>
            (r.managerId === managerEmployeeId ||
              r.managerId === managerUserId ||
              directReportIds.has(r.employeeId)) &&
            (r.status === 'MANAGER_PENDING' || r.status === 'RETURNED' || r.status === 'DRAFT')
        );
      } else {
        // SUPER_ADMIN and HR
        reviews = reviews.filter(
          (r) =>
            r.status === 'MANAGER_PENDING' ||
            r.status === 'HOD_PENDING' ||
            r.status === 'HR_PENDING' ||
            r.status === 'RETURNED' ||
            r.status === 'DRAFT'
        );
      }

      reviews.sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
      res.json(reviews);
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to fetch pending reviews.' });
    }
  }
);

/**
 * GET /api/reviews/:id
 * Protected by authorizeReviewAccess('read')
 */
reviewRouter.get('/reviews/:id', authorizeReviewAccess('read'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const review = req.review!;
    const employeesCol = getDbCollection('employees');
    const empRecord = await employeesCol.findOne({ id: review.employeeId });

    res.json({
      ...review,
      employeeStatus: empRecord?.status || review.employeeStatus || 'ACTIVE',
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch review details.' });
  }
});

/**
 * POST /api/reviews/generate-batch
 * Generates reviews for active employees for a given reviewPeriodId, taking immutable snapshot of KRA template
 * Super Admin, HR, and HOD only
 */
reviewRouter.post(
  '/reviews/generate-batch',
  requireRoles('SUPER_ADMIN', 'HR'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { reviewPeriodId, departmentId, cycleId, overrideExisting } = req.body;

      if (!reviewPeriodId) {
        return res.status(400).json({ error: 'reviewPeriodId is required.' });
      }

      const periodCol = getDbCollection('reviewPeriods');
      const empCol = getDbCollection('employees');
      const tmplCol = getDbCollection('kraTemplates');
      const cycleCol = getDbCollection('cycles');
      const reviewCol = getDbCollection('employeeReviews');
      const notifCol = getDbCollection('notifications');

      const period: ReviewPeriod | null = await periodCol.findOne({ id: reviewPeriodId });
      if (!period) {
        return res.status(404).json({ error: 'Review period not found.' });
      }

      let employees: Employee[] = await (await empCol.find({})).toArray();
      employees = employees.filter((e) => e.status === 'ACTIVE' || e.status === 'PROBATION');

      if (departmentId && departmentId !== 'ALL') {
        employees = employees.filter((e) => e.departmentId === departmentId);
      }
      const allTemplates: KraTemplate[] = await (await tmplCol.find({})).toArray();
      const allCycles: Cycle[] = await (await cycleCol.find({})).toArray();

      if (cycleId && cycleId !== 'ALL') {
        const targetCycle = allCycles.find((c) => c.id === cycleId || c.code === cycleId);
        employees = employees.filter(
          (e) =>
            e.cycleId === cycleId ||
            (targetCycle && (e.cycleId === targetCycle.id || e.cycleCode === targetCycle.code))
        );
      }
      const existingReviews: EmployeeReview[] = await (await reviewCol.find({ reviewPeriodId })).toArray();

      let createdCount = 0;
      let skippedCount = 0;
      const newReviews: EmployeeReview[] = [];

      for (const emp of employees) {
        const existing = existingReviews.find((r) => r.employeeId === emp.id);
        if (existing && !overrideExisting) {
          skippedCount++;
          continue;
        }

        // Tenure eligibility check: Skip employees who do not meet the minimum tenure for the quarter
        const eligibility = await checkEmployeeReviewEligibility(emp, period);
        if (!eligibility.checks.tenureMet) {
          skippedCount++;
          continue;
        }

        // Find best matching KRA template:
        // 1. Explicit template ID on employee
        // 2. Matching designationId
        // 3. Matching departmentId
        // 4. Default fallback template
        let template = allTemplates.find((t) => t.id === emp.currentKraTemplateId);
        if (!template && emp.designationId) {
          template = allTemplates.find((t) => t.designationId === emp.designationId);
        }
        if (!template && emp.departmentId) {
          template = allTemplates.find((t) => t.departmentId === emp.departmentId);
        }
        if (!template && allTemplates.length > 0) {
          template = allTemplates[0];
        }

        if (!template || !template.items || template.items.length === 0) {
          // If no template exists, provide generic fallback KRA items
          template = {
            id: 'fallback_tmpl',
            title: 'General Performance KRA',
            departmentId: emp.departmentId,
            totalWeight: 100,
            active: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            items: [
              {
                id: 'item_fb_1',
                title: 'Core Deliverables & Execution',
                description: 'Timely and accurate delivery of core quarterly deliverables',
                target: 'Complete assigned quarterly goals within SLA',
                measurementCriteria: '1: Below SLA | 3: Meets SLA | 5: Exceeds SLA',
                weight: 50,
              },
              {
                id: 'item_fb_2',
                title: 'Quality & Process Discipline',
                description: 'Adherence to quality standards and zero defect slip rates',
                target: 'Maintain high standards and zero critical defect slippages',
                measurementCriteria: '1: Defects reported | 3: Clean execution | 5: Optimization',
                weight: 30,
              },
              {
                id: 'item_fb_3',
                title: 'Team Collaboration & Initiative',
                description: 'Peer collaboration, cross-functional synergy, and proactive initiatives',
                target: 'Active cross-functional participation and peer support',
                measurementCriteria: '1: Low initiative | 3: Solid support | 5: Proactive leadership',
                weight: 20,
              },
            ],
          };
        }

        // Determine if appraisal month is due in this quarter
        const empCycle = allCycles.find((c) => c.id === emp.cycleId || c.code === emp.cycleCode);
        const appraisalMonth = empCycle ? empCycle.appraisalMonth : 1;
        // Quarter 1 = 1, 2, 3 | Quarter 2 = 4, 5, 6 | Quarter 3 = 7, 8, 9 | Quarter 4 = 10, 11, 12
        const quarterMonths = [
          (period.quarter - 1) * 3 + 1,
          (period.quarter - 1) * 3 + 2,
          period.quarter * 3,
        ];
        const isAppraisalMonthDue = quarterMonths.includes(appraisalMonth);

        // Build immutable KRA snapshot
        const kraSnapshot: ReviewKraSnapshot[] = template.items.map((item, idx) => ({
          id: `snap_${Date.now()}_${idx}_${Math.random().toString(36).substr(2, 6)}`,
          kraId: item.kraId,
          kraName: item.title || item.kraName || `KRA ${idx + 1}`,
          title: item.title || item.kraName || `KRA ${idx + 1}`,
          description: item.description || '',
          targetSnapshot: item.target || 'Target SLA',
          measurementCriteria: item.measurementCriteria || '1: Below Target | 3: Meets Target | 5: Exceeds Target',
          weight: Number(item.weight) || 0,
          achievement: '',
          rating: 0,
          comments: '',
        }));

        const action: ReviewAction = {
          id: `act_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
          reviewId: '',
          action: 'ASSIGNED',
          performedBy: req.user?.id || 'system',
          performedByName: req.user?.name || 'System Administrator',
          performedByRole: req.user?.role || 'SUPER_ADMIN',
          remarks: `Batch generated for ${period.name} review cycle`,
          performedAt: new Date().toISOString(),
        };

        const reviewId = existing
          ? existing.id
          : `rev_${period.year}_q${period.quarter}_${emp.id}_${Date.now().toString(36).substr(2, 4)}`;
        action.reviewId = reviewId;

        const newReview: EmployeeReview = {
          id: reviewId,
          employeeId: emp.id,
          employeeCode: emp.employeeCode,
          employeeName: emp.name,
          departmentId: emp.departmentId,
          departmentName: emp.departmentName || 'General',
          designationName: emp.designationName || 'Staff',
          reviewPeriodId: period.id,
          reviewPeriodName: period.name,
          cycleId: emp.cycleId,
          cycleCode: emp.cycleCode || empCycle?.code || 'A',
          cycleColor: emp.cycleColor || empCycle?.colorHex || '#1e3a8a',
          isAppraisalMonthDue,
          managerId: emp.managerId || emp.hodId || '',
          managerName: emp.managerName || emp.hodName || 'Unassigned Manager',
          hodId: emp.hodId,
          hodName: emp.hodName,
          status: 'MANAGER_PENDING',
          finalScore: 0,
          kraSnapshot,
          actionHistory: [action],
          isClosed: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        if (existing) {
          await reviewCol.updateOne({ id: reviewId }, { $set: newReview });
        } else {
          await reviewCol.insertOne(newReview);
        }

        newReviews.push(newReview);
        createdCount++;
      }

      // Notify managers about new reviews
      const distinctManagerIds = Array.from(new Set(newReviews.map(r => r.managerId).filter((m): m is string => Boolean(m))));
      for (const mgrId of distinctManagerIds) {
        await notifCol.insertOne({
          id: `notif_${Date.now()}_${mgrId}`,
          userId: mgrId,
          type: 'REVIEW_ASSIGNED',
          title: `Reviews Generated for ${period.name}`,
          message: `Quarterly review evaluation sheets generated for ${period.name} and ready for scoring.`,
          isRead: false,
          createdAt: new Date().toISOString(),
        });
      }

      // Notify employees about pending self-assessment
      for (const rev of newReviews) {
        if (rev.employeeId) {
          await notifCol.insertOne({
            id: `notif_self_assess_${rev.id}`,
            userId: rev.employeeId,
            userRole: 'EMPLOYEE',
            type: 'REVIEW_ASSIGNED',
            title: `Self-Assessment Due: ${period.name}`,
            message: `Your quarterly performance self-assessment for ${period.name} has been generated. Please complete your ratings and achievements.`,
            isRead: false,
            priority: 'HIGH',
            metadata: { reviewId: rev.id, periodId: period.id, subTab: 'reviews', openSelfAssess: true },
            createdAt: new Date().toISOString(),
          });
        }
      }

      if (req.user) {
        await recordAuditLog(
          req.user.id,
          req.user.name,
          req.user.role,
          'EMPLOYEE_REVIEWS',
          'BATCH_GENERATE',
          period.id,
          '',
          `${createdCount} reviews`,
          `Batch generated ${createdCount} quarterly reviews for ${period.name}`
        );
      }

      console.log(`[Review] Batch generated: ${createdCount} reviews created (${skippedCount} skipped) for period "${period.name}" by "${req.user?.name}" [${req.user?.role}]`);

      res.status(201).json({
        message: `Successfully generated ${createdCount} quarterly reviews for ${period.name}.`,
        createdCount,
        skippedCount,
        periodName: period.name,
      });
    } catch (error: any) {
      console.error('Error generating batch reviews:', error);
      res.status(500).json({ error: 'Failed to generate batch reviews.' });
    }
  }
);

/**
 * PUT /api/reviews/:id/score
 * Updates review scores (ratings 1-5, achievements, comments) and recalculates finalScore
 * Managers, HODs, HR, and Super Admins
 */
reviewRouter.put(
  '/reviews/:id/score',
  authorizeReviewAccess('score'),
  validateBody(SubmitManagerReviewSchema),
  async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const {
      kraSnapshot,
      strengths,
      improvements,
      managerOverallComments,
      employeeComments,
      hrComments,
      isDraft,
    } = req.body;

    const reviewCol = getDbCollection('employeeReviews');
    const existing: EmployeeReview | null = await reviewCol.findOne({ id });

    if (!existing) {
      return res.status(404).json({ error: 'Review not found.' });
    }

    // Role check: Only assigned reporting manager, HR, or Super Admin can score. HOD cannot score reviews.
    const isAssignedManager =
      (req.user?.role === 'REPORTING_MANAGER' || req.user?.role === 'MANAGER') &&
      (req.user?.employeeId === existing.managerId || req.user?.id === existing.managerId);
    const isSuperAdminOrHr = req.user?.role === 'SUPER_ADMIN' || req.user?.role === 'HR';

    if (!isAssignedManager && !isSuperAdminOrHr) {
      return res.status(403).json({ error: 'Unauthorized: Only the designated Reporting Manager or HR can evaluate and score this review. HOD has view-only access to department reviews.' });
    }

    if (existing.isClosed) {
      return res.status(400).json({ error: 'This quarterly review is closed and locked from further scoring changes.' });
    }

    // Safeguard: Check if employee is inactive
    const employeesCol = getDbCollection('employees');
    const empRecord = await employeesCol.findOne({ id: existing.employeeId });
    if (empRecord && empRecord.status === 'INACTIVE') {
      return res.status(400).json({ error: 'Cannot score review: This employee is marked INACTIVE (Offboarded/Exited).' });
    }

    // Calculate real-time weighted score: sum(rating * weight) / 100
    let totalWeightedScore = 0;
    const updatedSnapshot: ReviewKraSnapshot[] = (kraSnapshot || existing.kraSnapshot).map((k: any) => {
      const rating = Number(k.rating) || 0;
      const weight = Number(k.weight) || 0;
      totalWeightedScore += (rating * weight) / 100;

      return {
        ...k,
        rating,
        weight,
        achievement: k.achievement || '',
        comments: k.comments || '',
      };
    });

    const finalScore = Number(totalWeightedScore.toFixed(2));
    const isSubmitting = !isDraft;

    let newStatus: ReviewStatus = existing.status;
    let submittedByManager = false;
    if (isSubmitting) {
      if (req.user?.role === 'HR' || req.user?.role === 'SUPER_ADMIN') {
        newStatus = 'HR_COMPLETED';
      } else {
        // Manager submissions must pass through the mandatory HOD stage first.
        newStatus = 'HOD_PENDING';
        submittedByManager = true;
      }
    }
    const managerSubmitHodMissing = submittedByManager && !existing.hodId;

    const userRole = req.user?.role || 'MANAGER';
    const userName = req.user?.name || (userRole === 'HOD' ? 'Department HOD' : userRole === 'HR' ? 'HR Administrator' : 'Manager');
    const roleLabel = userRole === 'HOD' ? 'HOD' : userRole === 'HR' ? 'HR' : 'Manager';

    const action: ReviewAction = {
      id: `act_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      reviewId: id,
      action: managerSubmitHodMissing ? 'HOD_MISSING_EXCEPTION' : isSubmitting ? 'SUBMITTED' : 'DRAFT_SAVED',
      performedBy: req.user?.id || 'system',
      performedByName: userName,
      performedByRole: userRole,
      remarks: managerSubmitHodMissing
        ? `${roleLabel} submitted evaluation scores with final weighted score: ${finalScore}. No HOD is configured for ${existing.employeeName} — review is blocked pending HOD assignment.`
        : isSubmitting
        ? `${roleLabel} submitted evaluation scores with final weighted score: ${finalScore}`
        : 'Saved score and comment drafts',
      performedAt: new Date().toISOString(),
    };

    const updatedReview: EmployeeReview = {
      ...existing,
      kraSnapshot: updatedSnapshot,
      finalScore,
      strengths: strengths !== undefined ? strengths : existing.strengths,
      improvements: improvements !== undefined ? improvements : existing.improvements,
      managerOverallComments:
        managerOverallComments !== undefined ? managerOverallComments : existing.managerOverallComments,
      employeeComments: employeeComments !== undefined ? employeeComments : existing.employeeComments,
      hrComments: hrComments !== undefined ? hrComments : existing.hrComments,
      status: newStatus,
      actionHistory: [...(existing.actionHistory || []), action],
      submittedAt: isSubmitting ? new Date().toISOString() : existing.submittedAt,
      updatedAt: new Date().toISOString(),
    };

    await reviewCol.updateOne({ id }, { $set: updatedReview });

    if (req.user) {
      await recordAuditLog(
        req.user.id,
        req.user.name,
        req.user.role,
        'EMPLOYEE_REVIEWS',
        isSubmitting ? 'SUBMIT_SCORES' : 'SAVE_DRAFT',
        id,
        String(existing.finalScore || 0),
        String(updatedReview.finalScore || 0),
        isSubmitting
          ? `Submitted review scores for ${existing.employeeName} (${finalScore})`
          : `Saved review drafts for ${existing.employeeName}`
      );
    }

    if (isSubmitting) {
      const notifsCol = getDbCollection('notifications');
      const now = new Date().toISOString();

      if (submittedByManager && managerSubmitHodMissing) {
        // No HOD configured for this employee — alert HR instead of a non-existent HOD.
        await notifsCol.updateOne(
          { 'metadata.reviewId': id, type: 'HOD_MISSING_EXCEPTION', userRole: 'HR' },
          {
            $set: {
              id: `notif_${id}_hod_missing`,
              userId: 'ALL',
              userRole: 'HR',
              type: 'HOD_MISSING_EXCEPTION',
              title: `Review Blocked: No HOD Configured for ${existing.employeeName}`,
              message: `${req.user?.name || 'Manager'} submitted a review for ${existing.employeeName}, but no HOD is assigned to this employee. Assign an HOD to unblock the review.`,
              isRead: false,
              priority: 'HIGH',
              metadata: { reviewId: id, periodId: existing.reviewPeriodId, status: newStatus },
              createdAt: now,
            },
          },
          { upsert: true }
        );
      } else if (submittedByManager) {
        // Notify the assigned HOD
        await notifsCol.updateOne(
          { 'metadata.reviewId': id, type: 'HOD_PENDING', userId: existing.hodId },
          {
            $set: {
              id: `notif_${id}_hod`,
              userId: existing.hodId,
              userRole: 'HOD',
              type: 'HOD_PENDING',
              title: `Review Ready for Your Approval: ${existing.employeeName}`,
              message: `${req.user?.name || 'Manager'} submitted evaluation scores (${finalScore}) for ${existing.employeeName}. Ready for HOD review.`,
              isRead: false,
              priority: 'MEDIUM',
              metadata: { reviewId: id, periodId: existing.reviewPeriodId, status: newStatus },
              createdAt: now,
            },
          },
          { upsert: true }
        );
      }

      // Notify Employee
      await notifsCol.updateOne(
        { 'metadata.reviewId': id, userId: existing.employeeId, type: 'LETTER_RELEASED' },
        {
          $set: {
            id: `notif_${id}_emp`,
            userId: existing.employeeId,
            userRole: 'EMPLOYEE',
            type: 'LETTER_RELEASED',
            title: `Quarterly Review Evaluated: ${existing.reviewPeriodName}`,
            message: `Your manager has submitted your quarterly performance review score (${finalScore}). View your review in the portal.`,
            isRead: false,
            priority: 'MEDIUM',
            metadata: { reviewId: id, periodId: existing.reviewPeriodId, subTab: 'reviews' },
            createdAt: now,
          },
        },
        { upsert: true }
      );
    }

    console.log(`[Review] Review scored: ${id} for "${existing.employeeName}" (${existing.employeeCode}), Final Score: ${finalScore} (isDraft: ${isDraft}) by "${req.user?.name}" [${req.user?.role}]`);

    res.json(updatedReview);
  } catch (error: any) {
    console.error('Failed to score review:', error);
    res.status(500).json({ error: 'Failed to save review scoring.' });
  }
});

/**
 * PUT /api/reviews/:id/status
 * Updates review lifecycle status (HR_PENDING, RETURNED, HR_COMPLETED, CLOSED)
 */
reviewRouter.put(
  '/reviews/:id/status',
  requireRoles('SUPER_ADMIN', 'HR'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = req.params;
      const { status, remarks } = req.body;

      if (!status) {
        return res.status(400).json({ error: 'Status is required.' });
      }

      const reviewCol = getDbCollection('employeeReviews');
      const existing: EmployeeReview | null = await reviewCol.findOne({ id });

      if (!existing) {
        return res.status(404).json({ error: 'Review not found.' });
      }

      if ((existing.isClosed || existing.status === 'CLOSED') && req.user?.role !== 'SUPER_ADMIN') {
        return res.status(400).json({ error: 'Cannot modify a closed review.' });
      }

      // NOTE: Quarterly Reviews must pass through the mandatory HOD_PENDING stage before
      // reaching HR — non-Super-Admin HR can no longer jump Manager-stage statuses directly
      // to HR_PENDING/HR_COMPLETED/CLOSED via this manual override tool. Super Admin bypasses
      // this table entirely (see isSuperAdmin short-circuit below) and is unaffected.
      const allowedTransitions: Record<string, string[]> = {
        DRAFT: ['ASSIGNED', 'MANAGER_PENDING'],
        ASSIGNED: ['MANAGER_PENDING'],
        MANAGER_PENDING: ['HOD_PENDING', 'RETURNED'],
        MANAGER_COMPLETED: ['HOD_PENDING', 'RETURNED'],
        HOD_PENDING: ['HR_PENDING', 'MANAGER_PENDING'],
        HR_PENDING: ['HR_COMPLETED', 'CLOSED', 'RETURNED', 'MANAGER_PENDING', 'HOD_PENDING'],
        HR_COMPLETED: ['CLOSED', 'RETURNED', 'HR_PENDING'],
        RETURNED: ['MANAGER_PENDING', 'HOD_PENDING'],
        CLOSED: ['HR_COMPLETED', 'HR_PENDING', 'MANAGER_PENDING'],
      };

      const isSuperAdmin = req.user?.role === 'SUPER_ADMIN';
      const validNextStatuses = allowedTransitions[existing.status] || [];
      if (!isSuperAdmin && status !== existing.status && !validNextStatuses.includes(status)) {
        return res.status(400).json({
          error: `Invalid status transition from '${existing.status}' to '${status}'.`,
        });
      }

      const isClosing = status === 'CLOSED';
      let actionType: ReviewAction['action'] = 'SUBMITTED';
      if (status === 'RETURNED') actionType = 'RETURNED';
      else if (status === 'HR_COMPLETED' || status === 'MANAGER_COMPLETED' || status === 'HOD_COMPLETED') actionType = 'APPROVED';
      else if (status === 'CLOSED') actionType = 'CLOSED';

      const action: ReviewAction = {
        id: `act_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        reviewId: id,
        action: actionType,
        performedBy: req.user?.id || 'system',
        performedByName: req.user?.name || 'Administrator',
        performedByRole: req.user?.role || 'HR',
        remarks: remarks || `Review status transitioned to ${status}`,
        performedAt: new Date().toISOString(),
      };

      const updatedReview: EmployeeReview = {
        ...existing,
        status: status as ReviewStatus,
        isClosed: isClosing,
        completedAt: isClosing ? (existing.completedAt || new Date().toISOString()) : undefined,
        actionHistory: [...(existing.actionHistory || []), action],
        updatedAt: new Date().toISOString(),
      };

      await reviewCol.updateOne({ id }, { $set: updatedReview });

      if (req.user) {
        await recordAuditLog(
          req.user.id,
          req.user.name,
          req.user.role,
          'EMPLOYEE_REVIEWS',
          'TRANSITION_STATUS',
          id,
          existing.status,
          updatedReview.status,
          `Transitioned review status for ${existing.employeeName} to ${status}: ${remarks || ''}`
        );
      }

      // Workflow notification triggers
      const notifsCol = getDbCollection('notifications');
      const now = new Date().toISOString();

      if (status === 'RETURNED' && existing.managerId) {
        await notifsCol.updateOne(
          { 'metadata.reviewId': id, type: 'RETURNED' },
          {
            $set: {
              id: `notif_${id}_ret`,
              userId: existing.managerId,
              userRole: 'MANAGER',
              type: 'RETURNED',
              title: `Review Returned: ${existing.employeeName}`,
              message: `HR returned the ${existing.reviewPeriodName} review for ${existing.employeeName}: ${remarks || 'Please re-evaluate scores.'}`,
              isRead: false,
              priority: 'HIGH',
              metadata: { reviewId: id, periodId: existing.reviewPeriodId, status: 'RETURNED' },
              createdAt: now,
            },
          },
          { upsert: true }
        );
      } else if (status === 'HR_COMPLETED') {
        await notifsCol.updateOne(
          { 'metadata.reviewId': id, userId: existing.employeeId, type: 'HR_COMPLETED' },
          {
            $set: {
              id: `notif_${id}_fin`,
              userId: existing.employeeId,
              userRole: 'EMPLOYEE',
              type: 'HR_COMPLETED',
              title: `Quarterly Review Approved: ${existing.reviewPeriodName}`,
              message: `HR has finalized and approved your performance review for ${existing.reviewPeriodName}.`,
              isRead: false,
              priority: 'MEDIUM',
              metadata: { reviewId: id, periodId: existing.reviewPeriodId, subTab: 'reviews' },
              createdAt: now,
            },
          },
          { upsert: true }
        );
      }

      console.log(`[Review] Status transition: Review ${id} ("${existing.employeeName}"): ${existing.status} -> ${status} by "${req.user?.name}" [${req.user?.role}]`);

      res.json(updatedReview);
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to update review status.' });
    }
  }
);

/**
 * PUT /api/reviews/:id/self-assess
 * Employee submits their quarterly self-evaluation (self ratings, self achievements, strengths, obstacles)
 */
reviewRouter.put(
  '/reviews/:id/self-assess',
  authorizeReviewAccess('self_assess'),
  validateBody(SubmitSelfAssessmentSchema),
  async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const {
      kraSnapshot,
      selfStrengths,
      selfImprovements,
      selfObstacles,
      isDraft,
    } = req.body;

    const reviewCol = getDbCollection('employeeReviews');
    const existing: EmployeeReview | null = await reviewCol.findOne({ id });

    if (!existing) {
      return res.status(404).json({ error: 'Review not found.' });
    }

    if (existing.isClosed) {
      return res.status(400).json({ error: 'This quarterly review is closed.' });
    }

    // Once reporting manager has submitted evaluation, self-assessment can no longer be modified
    const hasManagerSubmitted = Boolean(existing.submittedAt) || !['ASSIGNED', 'MANAGER_PENDING', 'DRAFT'].includes(existing.status);
    if (hasManagerSubmitted) {
      return res.status(400).json({
        error: 'Self-assessment can no longer be edited because the reporting manager has already submitted their review.',
      });
    }

    // Role check: Only the employee or admins/managers can save/submit self assessment
    const isSelf = req.user?.employeeId === existing.employeeId;
    const isAdmin = req.user?.role === 'SUPER_ADMIN' || req.user?.role === 'HR';

    if (!isSelf && !isAdmin) {
      return res.status(403).json({ error: 'Unauthorized to submit self assessment for this employee.' });
    }

    // Calculate self weighted score: sum(selfRating * weight) / 100
    let totalSelfWeightedScore = 0;
    let scoredKraCount = 0;

    const updatedSnapshot: ReviewKraSnapshot[] = (existing.kraSnapshot || []).map((k) => {
      const incoming = (kraSnapshot || []).find((inKra: any) => inKra.id === k.id || inKra.kraId === k.kraId);
      const selfRating = incoming && incoming.selfRating !== undefined ? Number(incoming.selfRating) : (k.selfRating || 0);
      const selfAchievement = incoming && incoming.selfAchievement !== undefined ? incoming.selfAchievement : (k.selfAchievement || '');
      const selfComments = incoming && incoming.selfComments !== undefined ? incoming.selfComments : (k.selfComments || '');

      if (selfRating > 0) {
        totalSelfWeightedScore += (selfRating * (k.weight || 0)) / 100;
        scoredKraCount++;
      }

      return {
        ...k,
        selfRating,
        selfAchievement,
        selfComments,
      };
    });

    const selfScore = scoredKraCount > 0 ? Number(totalSelfWeightedScore.toFixed(2)) : (existing.selfScore || 0);
    const isSubmitting = !isDraft;
    const now = new Date().toISOString();

    const action: ReviewAction = {
      id: `act_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      reviewId: id,
      action: isSubmitting ? 'SELF_SUBMITTED' : 'DRAFT_SAVED',
      performedBy: req.user?.id || req.user?.employeeId || existing.employeeId || 'unknown',
      performedByName: req.user?.name || existing.employeeName,
      performedByRole: req.user?.role || 'EMPLOYEE',
      remarks: isSubmitting
        ? `Employee submitted self-evaluation with score: ${selfScore}`
        : 'Saved self-assessment draft',
      performedAt: now,
    };

    const updatedReview: EmployeeReview = {
      ...existing,
      kraSnapshot: updatedSnapshot,
      selfScore,
      selfStrengths: selfStrengths !== undefined ? selfStrengths : existing.selfStrengths,
      selfImprovements: selfImprovements !== undefined ? selfImprovements : existing.selfImprovements,
      selfObstacles: selfObstacles !== undefined ? selfObstacles : existing.selfObstacles,
      isSelfSubmitted: isSubmitting ? true : existing.isSelfSubmitted,
      selfSubmittedAt: isSubmitting ? now : existing.selfSubmittedAt,
      // If employee submits self-evaluation and status was DRAFT/ASSIGNED, move to MANAGER_PENDING
      status: isSubmitting && (existing.status === 'DRAFT' || existing.status === 'ASSIGNED')
        ? 'MANAGER_PENDING'
        : existing.status,
      actionHistory: [...(existing.actionHistory || []), action],
      updatedAt: now,
    };

    await reviewCol.updateOne({ id }, { $set: updatedReview });

    if (req.user) {
      await recordAuditLog(
        req.user.id,
        req.user.name,
        req.user.role,
        'EMPLOYEE_REVIEWS',
        isSubmitting ? 'SELF_ASSESSMENT_SUBMITTED' : 'SELF_ASSESSMENT_DRAFT',
        id,
        String(existing.selfScore || 0),
        String(selfScore),
        isSubmitting
          ? `Self assessment submitted by ${existing.employeeName} (Self Score: ${selfScore})`
          : `Saved self assessment draft for ${existing.employeeName}`
      );
    }

    if (isSubmitting) {
      const notificationsCol = getDbCollection('notifications');

      // Mark employee self-assessment notification as completed/read
      await notificationsCol.updateMany(
        {
          'metadata.reviewId': id,
          userId: { $in: [existing.employeeId, req.user?.id, req.user?.employeeId].filter(Boolean) },
          type: 'REVIEW_ASSIGNED',
        },
        { $set: { isRead: true } }
      );

      if (existing.managerId) {
        // Notify Manager
        await notificationsCol.updateOne(
          { 'metadata.reviewId': id, type: 'REVIEW_ASSIGNED', userId: existing.managerId },
          {
            $set: {
              id: `notif_${id}_self_sub`,
              userId: existing.managerId,
              userRole: 'MANAGER',
              type: 'REVIEW_ASSIGNED',
              title: 'Quarterly Self-Assessment Submitted',
              message: `${existing.employeeName} has completed and submitted their self-evaluation for ${existing.reviewPeriodName}. Review is ready for your evaluation.`,
              isRead: false,
              metadata: { reviewId: id, periodId: existing.reviewPeriodId, subTab: 'reviews' },
              createdAt: now,
            },
          },
          { upsert: true }
        );
      }

      // Dispatch Email Notification to Manager (Asynchronously)
      (async () => {
        try {
          const managerTarget = existing.managerId;
          if (!managerTarget) return;
          const recipient = await resolveRecipient(managerTarget);
          if (recipient) {
            const baseUrl = process.env.APP_URL || 'http://localhost:5173';
            const { subject, html } = renderSelfAssessmentSubmittedEmail({
              employeeName: existing.employeeName,
              managerName: recipient.name,
              reviewPeriodName: existing.reviewPeriodName || 'Quarterly Review',
              selfScore: Number(selfScore) || 0,
              reviewUrl: `${baseUrl}/#reviews`,
            });
            await sendNotificationEmail({
              recipientId: managerTarget,
              recipientEmail: recipient.email,
              recipientName: recipient.name,
              subject,
              html,
              templateType: 'SELF_ASSESSMENT_SUBMITTED',
              metadata: { reviewId: id, employeeId: existing.employeeId },
            });
          }
        } catch (mailErr: any) {
          console.warn('[ReviewRoutes] Failed to dispatch self-assessment email:', mailErr.message);
        }
      })();
    }

    console.log(`[Review] Self-assessment ${isSubmitting ? 'submitted' : 'draft saved'} for "${existing.employeeName}" (${existing.employeeCode}), Self Score: ${selfScore}`);

    res.json(updatedReview);
  } catch (error: any) {
    console.error('Failed to submit self assessment:', error);
    res.status(500).json({ error: 'Failed to save self assessment.' });
  }
});

// ==========================================
// 3. SECTION 29 SPECIFICATION WORKFLOW ENDPOINTS
// ==========================================

/**
 * POST /api/reviews/generate
 * Section 29: Triggers automated quarterly review generation
 * Super Admin & HR only
 */
reviewRouter.post(
  '/reviews/generate',
  requireRoles('SUPER_ADMIN', 'HR'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { reviewPeriodId } = req.body;
      if (!reviewPeriodId) {
        return res.status(400).json({ error: 'reviewPeriodId is required.' });
      }

      const report = await generateQuarterlyReviews(reviewPeriodId, {
        id: req.user!.id,
        name: req.user!.name,
        role: req.user!.role,
      });

      res.status(201).json(report);
    } catch (error: any) {
      console.error('Failed to generate quarterly reviews:', error);
      res.status(500).json({ error: error.message || 'Failed to generate reviews.' });
    }
  }
);

/**
 * POST /api/reviews/:id/submit
 * Section 29: Reporting manager submits review scores and transitions to HR_PENDING
 */
reviewRouter.post(
  '/reviews/:id/submit',
  authorizeReviewAccess('submit'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = req.params;
      const updated = await submitManagerReview(id, req.body, {
        id: req.user!.id,
        name: req.user!.name,
        role: req.user!.role,
        employeeId: req.user!.employeeId,
      });

      // Dispatch email notification to employee (Asynchronously)
      (async () => {
        try {
          const recipient = await resolveRecipient(updated.employeeId);
          if (recipient) {
            const baseUrl = process.env.APP_URL || 'http://localhost:5173';
            const { subject, html } = renderManagerReviewSubmittedEmail({
              employeeName: updated.employeeName,
              managerName: req.user!.name,
              reviewPeriodName: updated.reviewPeriodName || 'Quarterly Review',
              managerScore: updated.finalScore || 0,
              reviewUrl: `${baseUrl}/#reviews`,
            });
            await sendNotificationEmail({
              recipientId: updated.employeeId,
              recipientEmail: recipient.email,
              recipientName: recipient.name,
              subject,
              html,
              templateType: 'MANAGER_REVIEW_SUBMITTED',
              metadata: { reviewId: id, employeeId: updated.employeeId },
            });
          }
        } catch (mailErr: any) {
          console.warn('[ReviewRoutes] Failed to dispatch manager review email:', mailErr.message);
        }
      })();

      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ error: error.message || 'Failed to submit review.' });
    }
  }
);

/**
 * POST /api/reviews/:id/return
 * Section 29: HR returns review to manager with MANDATORY return reason
 */
reviewRouter.post(
  '/reviews/:id/return',
  authorizeReviewAccess('return'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = req.params;
      const reason = req.body.reason || req.body.returnReason;

      if (!reason || !reason.trim()) {
        return res.status(400).json({ error: 'Return reason is mandatory. Please provide specific feedback.' });
      }

      const updated = await returnReview(id, reason, {
        id: req.user!.id,
        name: req.user!.name,
        role: req.user!.role,
      });

      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ error: error.message || 'Failed to return review.' });
    }
  }
);

/**
 * POST /api/reviews/:id/hod-approve
 * HOD approves the manager's assessment. Transitions: HOD_PENDING -> HR_PENDING
 */
reviewRouter.post(
  '/reviews/:id/hod-approve',
  authorizeReviewAccess('hod_approve'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = req.params;
      const updated = await hodApproveReview(id, req.body.hodComments, {
        id: req.user!.id,
        name: req.user!.name,
        role: req.user!.role,
        employeeId: req.user!.employeeId,
      });

      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ error: error.message || 'Failed to approve review.' });
    }
  }
);

/**
 * POST /api/reviews/:id/hod-return
 * HOD returns the review to the reporting manager with a MANDATORY reason.
 * Transitions: HOD_PENDING -> MANAGER_PENDING
 */
reviewRouter.post(
  '/reviews/:id/hod-return',
  authorizeReviewAccess('hod_return'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = req.params;
      const reason = req.body.reason || req.body.returnReason;

      if (!reason || !reason.trim()) {
        return res.status(400).json({ error: 'Return reason is mandatory. Please provide specific feedback.' });
      }

      const updated = await hodReturnReview(id, reason, {
        id: req.user!.id,
        name: req.user!.name,
        role: req.user!.role,
        employeeId: req.user!.employeeId,
      });

      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ error: error.message || 'Failed to return review.' });
    }
  }
);

/**
 * POST /api/reviews/:id/complete
 * Section 29: HR finalizes review, locks record permanently (isClosed: true)
 */
reviewRouter.post(
  '/reviews/:id/complete',
  authorizeReviewAccess('complete'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = req.params;
      const { hrComments } = req.body;

      const updated = await completeHRReview(id, hrComments || '', {
        id: req.user!.id,
        name: req.user!.name,
        role: req.user!.role,
      });

      res.json(updated);
    } catch (error: any) {
      res.status(400).json({ error: error.message || 'Failed to complete review.' });
    }
  }
);

/**
 * GET /api/employees/:id/review-history
 * Section 29: Returns employee review history with quarter-to-quarter score comparisons
 * Protected by strict resource authorization (IDOR protection)
 */
reviewRouter.get(
  '/employees/:id/review-history',
  authorizeEmployeeAccess('id'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = req.params;
      const reviewCol = getDbCollection('employeeReviews');
      const periodCol = getDbCollection('reviewPeriods');

      const reviews: EmployeeReview[] = await (await reviewCol.find({ employeeId: id })).toArray();
      const periods: ReviewPeriod[] = await (await periodCol.find({})).toArray();
      const periodMap = new Map<string, ReviewPeriod>();
      periods.forEach((p) => periodMap.set(p.id, p));

      // Sort chronologically ascending to calculate progression
      reviews.sort((a, b) => {
        const periodA = periodMap.get(a.reviewPeriodId);
        const periodB = periodMap.get(b.reviewPeriodId);
        if (periodA && periodB) {
          if (periodA.year !== periodB.year) return periodA.year - periodB.year;
          return periodA.quarter - periodB.quarter;
        }
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });

      // Calculate quarter-to-quarter score delta
      let previousScore: number | null = null;
      const historyWithComparisons = reviews.map((rev) => {
        const currentScore = rev.finalScore ?? 0;
        let scoreDelta: number | null = null;
        let percentageChange: number | null = null;

        if (previousScore !== null && currentScore > 0) {
          scoreDelta = Number((currentScore - previousScore).toFixed(2));
          percentageChange = previousScore > 0
            ? Number((((currentScore - previousScore) / previousScore) * 100).toFixed(1))
            : 0;
        }

        if (currentScore > 0) {
          previousScore = currentScore;
        }

        return {
          id: rev.id,
          periodId: rev.reviewPeriodId,
          periodName: rev.reviewPeriodName,
          status: rev.status,
          finalScore: rev.finalScore,
          selfScore: rev.selfScore,
          scoreDelta,
          percentageChange,
          managerName: rev.managerName,
          completedAt: rev.completedAt,
          submittedAt: rev.submittedAt,
          kraCount: rev.kraSnapshot?.length || 0,
          isClosed: rev.isClosed,
        };
      });

      // Return newest first
      historyWithComparisons.reverse();

      res.json({
        employeeId: id,
        totalReviews: historyWithComparisons.length,
        history: historyWithComparisons,
      });
    } catch (error: any) {
      res.status(500).json({ error: 'Failed to fetch review history.' });
    }
  }
);
