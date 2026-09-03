import express, { Response } from 'express';
import { getDbCollection } from '../db.js';
import { authenticateToken, requireRoles, recordAuditLog, AuthenticatedRequest } from '../auth.js';
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
} from '../../src/types.js';

export const reviewRouter = express.Router();

// All review routes require authentication
reviewRouter.use(authenticateToken);

// ==========================================
// 1. REVIEW PERIODS
// ==========================================

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
    let reviews: EmployeeReview[] = await (await reviewCol.find({})).toArray();

    // Strict RBAC Role-based visibility filtering
    if (req.user?.role === 'EMPLOYEE') {
      reviews = reviews.filter((r) => r.employeeId === req.user?.employeeId);
    } else if (req.user?.role === 'MANAGER') {
      // Managers can strictly ONLY see their direct reports (or themselves)
      reviews = reviews.filter(
        (r) => r.managerId === req.user?.employeeId || r.employeeId === req.user?.employeeId
      );
    } else if (req.user?.role === 'HOD') {
      // HODs can strictly ONLY see their department roll-ups, direct reports, or themselves
      reviews = reviews.filter(
        (r) => r.hodId === req.user?.employeeId || r.managerId === req.user?.employeeId || r.employeeId === req.user?.employeeId
      );
    }
    // SUPER_ADMIN and HR can see everything.

    if (onlyMine === 'true' && req.user?.employeeId) {
      reviews = reviews.filter((r) => r.managerId === req.user?.employeeId && r.employeeId !== req.user?.employeeId);
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
          r.managerName.toLowerCase().includes(q)
      );
    }

    // Sort: most recently updated first
    reviews.sort((a, b) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());

    res.json(reviews);
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
    let reviews: EmployeeReview[] = await (await reviewCol.find({})).toArray();

    // Strict RBAC Role-based visibility filtering
    if (req.user?.role === 'EMPLOYEE') {
      reviews = reviews.filter((r) => r.employeeId === req.user?.employeeId);
    } else if (req.user?.role === 'MANAGER') {
      reviews = reviews.filter(
        (r) => r.managerId === req.user?.employeeId || r.employeeId === req.user?.employeeId
      );
    } else if (req.user?.role === 'HOD') {
      reviews = reviews.filter(
        (r) => r.hodId === req.user?.employeeId || r.managerId === req.user?.employeeId || r.employeeId === req.user?.employeeId
      );
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
    const managerCompleted = reviews.filter((r) => r.status === 'MANAGER_COMPLETED').length;
    const hrPending = reviews.filter((r) => r.status === 'HR_PENDING' || r.status === 'HR_COMPLETED').length;
    const closed = reviews.filter((r) => r.status === 'CLOSED' || r.isClosed).length;

    const scoredReviews = reviews.filter((r) => (r.finalScore || 0) > 0);
    const avgScore =
      scoredReviews.length > 0
        ? Number(
            (scoredReviews.reduce((sum, r) => sum + (r.finalScore || 0), 0) / scoredReviews.length).toFixed(2)
          )
        : 0;

    const completionRate = total > 0 ? Math.round(((managerCompleted + hrPending + closed) / total) * 100) : 0;

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
      hrPending,
      closed,
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
 * GET /api/reviews/:id
 */
reviewRouter.get('/reviews/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const reviewCol = getDbCollection('employeeReviews');
    const review: EmployeeReview | null = await reviewCol.findOne({ id });

    if (!review) {
      return res.status(404).json({ error: 'Review not found.' });
    }

    // Role check
    if (req.user?.role === 'EMPLOYEE' && review.employeeId !== req.user?.employeeId) {
      return res.status(403).json({ error: 'Unauthorized to view this performance review.' });
    }

    res.json(review);
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
  requireRoles('SUPER_ADMIN', 'HR', 'HOD'),
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
      if (cycleId && cycleId !== 'ALL') {
        employees = employees.filter((e) => e.cycleId === cycleId);
      }

      const allTemplates: KraTemplate[] = await (await tmplCol.find({})).toArray();
      const allCycles: Cycle[] = await (await cycleCol.find({})).toArray();
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
          cycleCode: emp.cycleCode,
          cycleColor: emp.cycleColor || '#1e3a8a',
          isAppraisalMonthDue,
          managerId: emp.managerId || emp.hodId || 'emp_mgr_eng',
          managerName: emp.managerName || emp.hodName || 'Engineering Manager',
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
      await notifCol.insertOne({
        id: `notif_${Date.now()}`,
        userId: 'usr_mgr_eng',
        type: 'REVIEW_ASSIGNED',
        title: `Reviews Generated for ${period.name}`,
        message: `${createdCount} employee quarterly review evaluation sheets generated and ready for manager scoring.`,
        isRead: false,
        createdAt: new Date().toISOString(),
      });

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
reviewRouter.put('/reviews/:id/score', async (req: AuthenticatedRequest, res: Response) => {
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

    if (existing.isClosed) {
      return res.status(400).json({ error: 'This quarterly review is closed and locked from further scoring changes.' });
    }

    // Role check: Only assigned manager, HOD, HR, or Super Admin can score
    const isManager = req.user?.employeeId === existing.managerId || req.user?.role === 'MANAGER';
    const isHrOrAdmin = req.user?.role === 'HR' || req.user?.role === 'SUPER_ADMIN' || req.user?.role === 'HOD';
    const isSelf = req.user?.employeeId === existing.employeeId;

    if (!isManager && !isHrOrAdmin && !isSelf) {
      return res.status(403).json({ error: 'Unauthorized to score or evaluate this review.' });
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
    if (isSubmitting) {
      // Determine next status:
      if (existing.isAppraisalMonthDue) {
        newStatus = 'MANAGER_COMPLETED';
      } else {
        newStatus = 'MANAGER_COMPLETED';
      }
    }

    const action: ReviewAction = {
      id: `act_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      reviewId: id,
      action: isSubmitting ? 'SUBMITTED' : 'DRAFT_SAVED',
      performedBy: req.user?.id || 'system',
      performedByName: req.user?.name || 'Manager',
      performedByRole: req.user?.role || 'MANAGER',
      remarks: isSubmitting
        ? `Manager submitted scores with final weighted score: ${finalScore}`
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

      // Notify HR
      await notifsCol.insertOne({
        id: `notif_${Date.now()}_hr`,
        userId: 'usr_mgr_hr',
        userRole: 'HR',
        type: 'MANAGER_SUBMITTED',
        title: `Quarterly Review Scored: ${existing.employeeName}`,
        message: `${req.user?.name || 'Manager'} submitted evaluation scores (${finalScore}) for ${existing.employeeName}. Ready for HR review.`,
        isRead: false,
        priority: 'MEDIUM',
        metadata: { reviewId: id, periodId: existing.reviewPeriodId, status: 'MANAGER_COMPLETED' },
        createdAt: now,
      });

      // Notify Employee
      await notifsCol.insertOne({
        id: `notif_${Date.now()}_emp`,
        userId: existing.employeeId,
        userRole: 'EMPLOYEE',
        type: 'LETTER_RELEASED',
        title: `Quarterly Review Evaluated: ${existing.reviewPeriodName}`,
        message: `Your manager has submitted your quarterly performance review score (${finalScore}). View your review in the portal.`,
        isRead: false,
        priority: 'MEDIUM',
        metadata: { reviewId: id, periodId: existing.reviewPeriodId, subTab: 'reviews' },
        createdAt: now,
      });
    }

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
  requireRoles('SUPER_ADMIN', 'HR', 'HOD', 'MANAGER'),
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

      const isClosing = status === 'CLOSED';
      let actionType: ReviewAction['action'] = 'SUBMITTED';
      if (status === 'RETURNED') actionType = 'RETURNED';
      else if (status === 'HR_COMPLETED' || status === 'MANAGER_COMPLETED') actionType = 'APPROVED';
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
        isClosed: isClosing ? true : existing.isClosed,
        completedAt: isClosing ? new Date().toISOString() : existing.completedAt,
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
        await notifsCol.insertOne({
          id: `notif_${Date.now()}_ret`,
          userId: existing.managerId,
          userRole: 'MANAGER',
          type: 'RETURNED',
          title: `Review Returned: ${existing.employeeName}`,
          message: `HR returned the ${existing.reviewPeriodName} review for ${existing.employeeName}: ${remarks || 'Please re-evaluate scores.'}`,
          isRead: false,
          priority: 'HIGH',
          metadata: { reviewId: id, periodId: existing.reviewPeriodId, status: 'RETURNED' },
          createdAt: now,
        });
      } else if (status === 'HR_COMPLETED') {
        await notifsCol.insertOne({
          id: `notif_${Date.now()}_fin`,
          userId: existing.employeeId,
          userRole: 'EMPLOYEE',
          type: 'HR_COMPLETED',
          title: `Quarterly Review Approved: ${existing.reviewPeriodName}`,
          message: `HR has finalized and approved your performance review for ${existing.reviewPeriodName}.`,
          isRead: false,
          priority: 'MEDIUM',
          metadata: { reviewId: id, periodId: existing.reviewPeriodId, subTab: 'reviews' },
          createdAt: now,
        });
      }

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
reviewRouter.put('/reviews/:id/self-assess', async (req: AuthenticatedRequest, res: Response) => {
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
      performedBy: req.user?.id || 'usr_emp',
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
      // Notify Manager
      const notificationsCol = getDbCollection('notifications');
      await notificationsCol.insertOne({
        id: `notif_${Date.now()}`,
        userId: existing.managerId || 'usr_mgr_eng',
        type: 'REVIEW_ASSIGNED',
        title: 'Quarterly Self-Assessment Submitted',
        message: `${existing.employeeName} has completed and submitted their self-evaluation for ${existing.reviewPeriodName}. Review is ready for your evaluation.`,
        isRead: false,
        createdAt: now,
      });
    }

    res.json(updatedReview);
  } catch (error: any) {
    console.error('Failed to submit self assessment:', error);
    res.status(500).json({ error: 'Failed to save self assessment.' });
  }
});
