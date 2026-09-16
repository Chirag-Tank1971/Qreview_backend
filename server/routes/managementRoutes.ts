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

export const managementRouter = express.Router();

// Enforce authentication & Executive Management role restriction (not admin)
managementRouter.use(authenticateToken);
managementRouter.use(requireRoles('MANAGEMENT'));

/**
 * Audit logger helper for Management actions
 */
async function logManagementAudit(req: AuthenticatedRequest, action: string, details?: any) {
  try {
    const auditLogsCol = getDbCollection('auditLogs');
    const periodText = details?.periodId ? ` for period ${details.periodId}` : '';
    await auditLogsCol.insertOne({
      id: `aud_mgmt_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      timestamp: new Date().toISOString(),
      actionType: action,
      module: 'MANAGEMENT_DASHBOARD',
      severity: 'INFO',
      actorId: req.user?.id || 'usr_unknown',
      actorName: req.user?.name || 'Executive User',
      actorRole: req.user?.role || 'MANAGEMENT',
      actorEmail: req.user?.email,
      description: `Executive viewed management dashboard${periodText}`,
      details: details || {},
    });
  } catch (err) {
    console.warn('[ManagementAudit] Could not write audit entry:', err);
  }
}

/**
 * GET /api/dashboard/management
 * Organization-wide executive dashboard summary & real-time KPIs
 */
managementRouter.get(
  '/dashboard/management',
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { periodId, year, quarter } = req.query;

      const reviewCol = getDbCollection('employeeReviews');
      const periodCol = getDbCollection('reviewPeriods');
      const empCol = getDbCollection('employees');
      const deptCol = getDbCollection('departments');
      const appraisalCol = getDbCollection('appraisals');
      const cycleCol = getDbCollection('cycles');

      // 1. Resolve Target Review Period
      let targetPeriod: ReviewPeriod | null = null;
      if (periodId && typeof periodId === 'string' && periodId !== 'ALL') {
        targetPeriod = await periodCol.findOne({ id: periodId });
      }
      if (!targetPeriod && year && quarter) {
        targetPeriod = await periodCol.findOne({ year: Number(year), quarter: Number(quarter) });
      }
      if (!targetPeriod) {
        targetPeriod =
          (await periodCol.findOne({ status: 'ACTIVE' })) ||
          (await periodCol.find({})).sort({ year: -1, quarter: -1 })[0] ||
          null;
      }

      // 2. Resolve Previous Period for variance
      let previousPeriod: ReviewPeriod | null = null;
      if (targetPeriod) {
        const prevQuarter = targetPeriod.quarter === 1 ? 4 : targetPeriod.quarter - 1;
        const prevYear = targetPeriod.quarter === 1 ? targetPeriod.year - 1 : targetPeriod.year;
        previousPeriod = await periodCol.findOne({ year: prevYear, quarter: prevQuarter });
      }

      // 3. Organization Headcount & Departments
      const allEmployees: Employee[] = await (await empCol.find({})).toArray();
      const activeEmployees = allEmployees.filter((e) => e.status !== 'INACTIVE');
      const allDepartments: Department[] = await (await deptCol.find({})).toArray();
      const activeDepartments = allDepartments.filter((d) => (d as any).active !== false && (d as any).isActive !== false);

      // 4. Target Period Reviews
      const reviewsFilter: any = {};
      if (targetPeriod) {
        reviewsFilter.reviewPeriodId = targetPeriod.id;
      }
      const currentReviews: EmployeeReview[] = await (await reviewCol.find(reviewsFilter)).toArray();

      const totalReviews = currentReviews.length;
      const completedReviews = currentReviews.filter((r) => r.status === 'CLOSED' || r.isClosed);
      const completedCount = completedReviews.length;
      const managerPendingCount = currentReviews.filter((r) => r.status === 'MANAGER_PENDING').length;
      const hrPendingCount = currentReviews.filter((r) => r.status === 'HR_PENDING' || r.status === 'HR_COMPLETED').length;
      const returnedCount = currentReviews.filter((r) => r.status === 'RETURNED').length;

      // Overdue calculation (due date past and not closed)
      const nowIso = new Date().toISOString();
      const overdueReviewsCount = currentReviews.filter((r) => {
        if (r.status === 'CLOSED' || r.isClosed) return false;
        const reviewDue = (r as any).dueDate || targetPeriod?.dueDate;
        if (reviewDue && reviewDue < nowIso) return true;
        return false;
      }).length;

      const reviewCompletionRate = totalReviews > 0 ? Math.round((completedCount / totalReviews) * 100) : 0;

      // 5. Performance Score Calculations (calculated strictly from CLOSED / finalized reviews)
      const currentQuarterScores = completedReviews
        .filter((r) => typeof r.finalScore === 'number' && r.finalScore > 0)
        .map((r) => r.finalScore as number);

      const currentQuarterAverageScore =
        currentQuarterScores.length > 0
          ? Number((currentQuarterScores.reduce((acc, val) => acc + val, 0) / currentQuarterScores.length).toFixed(2))
          : 0;

      // Previous period performance
      let previousQuarterAverageScore = 0;
      if (previousPeriod) {
        const prevReviews: EmployeeReview[] = await (
          await reviewCol.find({ reviewPeriodId: previousPeriod.id })
        ).toArray();
        const prevClosed = prevReviews.filter((r) => (r.status === 'CLOSED' || r.isClosed) && typeof r.finalScore === 'number' && r.finalScore > 0);
        if (prevClosed.length > 0) {
          previousQuarterAverageScore = Number(
            (prevClosed.reduce((sum, r) => sum + (r.finalScore || 0), 0) / prevClosed.length).toFixed(2)
          );
        }
      }

      // Overall Organization Average (across all closed reviews in current cohort / year)
      const allClosedReviews: EmployeeReview[] = await (
        await reviewCol.find({ $or: [{ status: 'CLOSED' }, { isClosed: true }] })
      ).toArray();
      const allValidScores = allClosedReviews
        .filter((r) => typeof r.finalScore === 'number' && r.finalScore > 0)
        .map((r) => r.finalScore as number);
      const overallAverageScore =
        allValidScores.length > 0
          ? Number((allValidScores.reduce((a, b) => a + b, 0) / allValidScores.length).toFixed(2))
          : currentQuarterAverageScore;

      const scoreDelta =
        previousQuarterAverageScore > 0
          ? Number((currentQuarterAverageScore - previousQuarterAverageScore).toFixed(2))
          : 0;
      const trendDirection: 'UP' | 'DOWN' | 'FLAT' =
        scoreDelta > 0.05 ? 'UP' : scoreDelta < -0.05 ? 'DOWN' : 'FLAT';

      // 6. Departmental Roll-up for Top & Attention lists
      const deptScoresMap: Record<string, { id: string; name: string; scores: number[]; total: number; closed: number; pending: number }> = {};
      activeDepartments.forEach((d) => {
        deptScoresMap[d.id] = { id: d.id, name: d.name, scores: [], total: 0, closed: 0, pending: 0 };
      });

      currentReviews.forEach((r) => {
        if (!r.departmentId || !deptScoresMap[r.departmentId]) {
          if (r.departmentId) {
            deptScoresMap[r.departmentId] = { id: r.departmentId, name: r.departmentName || 'General', scores: [], total: 0, closed: 0, pending: 0 };
          }
        }
        if (r.departmentId && deptScoresMap[r.departmentId]) {
          deptScoresMap[r.departmentId].total += 1;
          if (r.status === 'CLOSED' || r.isClosed) {
            deptScoresMap[r.departmentId].closed += 1;
            if (typeof r.finalScore === 'number' && r.finalScore > 0) {
              deptScoresMap[r.departmentId].scores.push(r.finalScore);
            }
          } else {
            deptScoresMap[r.departmentId].pending += 1;
          }
        }
      });

      const deptPerformanceList = Object.values(deptScoresMap).map((d) => {
        const avg = d.scores.length > 0 ? Number((d.scores.reduce((a, b) => a + b, 0) / d.scores.length).toFixed(2)) : 0;
        const compRate = d.total > 0 ? Math.round((d.closed / d.total) * 100) : 0;
        return {
          id: d.id,
          name: d.name,
          averageScore: avg,
          completionRate: compRate,
          totalReviews: d.total,
          pendingCount: d.pending,
        };
      });

      const highestPerformingDepartments = [...deptPerformanceList]
        .filter((d) => d.averageScore > 0)
        .sort((a, b) => b.averageScore - a.averageScore)
        .slice(0, 3);

      const departmentsRequiringAttention = [...deptPerformanceList]
        .filter((d) => d.totalReviews > 0 && (d.averageScore < 3.2 || d.completionRate < 80 || d.pendingCount > 3))
        .sort((a, b) => a.averageScore - b.averageScore)
        .slice(0, 4);

      // 7. Appraisal Triggers Summary
      const currentMonth = new Date().getMonth() + 1;
      const currentYear = new Date().getFullYear();
      const allCycles: Cycle[] = await (await cycleCol.find({})).toArray();
      const currentMonthCycleIds = new Set(allCycles.filter((c) => c.appraisalMonth === currentMonth).map((c) => c.id));
      const appraisalDueCount = activeEmployees.filter((e) => e.cycleId && currentMonthCycleIds.has(e.cycleId)).length;

      const appraisals = await (await appraisalCol.find({ appraisalYear: currentYear })).toArray();

      // Log executive view
      await logManagementAudit(req, 'MANAGEMENT_VIEW_DASHBOARD', { periodId: targetPeriod?.id });

      res.json({
        period: targetPeriod,
        organizationSummary: {
          totalActiveEmployees: activeEmployees.length,
          totalDepartments: activeDepartments.length,
          currentQuarter: targetPeriod ? `Q${targetPeriod.quarter} ${targetPeriod.year}` : `Year ${currentYear}`,
          totalQuarterlyReviews: totalReviews,
          completedReviews: completedCount,
          pendingManagerReviews: managerPendingCount,
          pendingHrReviews: hrPendingCount,
          returnedReviews: returnedCount,
          overdueReviews: overdueReviewsCount,
          reviewCompletionRate,
          employeesDueForAppraisal: appraisalDueCount,
        },
        organizationPerformance: {
          overallAverageScore,
          currentQuarterAverageScore,
          previousQuarterAverageScore,
          scoreDelta,
          trendDirection,
          highestPerformingDepartments,
          departmentsRequiringAttention,
        },
        appraisalSummary: {
          currentYear,
          currentMonth,
          totalDue: appraisalDueCount,
          totalInitiated: appraisals.length,
          totalLocked: appraisals.filter((a) => a.isLocked || a.status === 'LOCKED').length,
          averageIncrementPercent:
            appraisals.length > 0
              ? Number(
                  (
                    appraisals.reduce((sum, a) => sum + (a.approvedIncrementPercentage || a.proposedIncrementPercentage || 0), 0) /
                    appraisals.length
                  ).toFixed(2)
                )
              : 0,
        },
      });
    } catch (err: any) {
      console.error('[ManagementAPI] Error in GET /dashboard/management:', err);
      res.status(500).json({ error: 'Failed to load executive management dashboard.' });
    }
  }
);

/**
 * GET /api/management/departments/performance
 * Department performance comparison matrix with sorting, filtering, and search
 */
managementRouter.get(
  '/management/departments/performance',
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { periodId, search, sortBy = 'averageScore', sortOrder = 'desc' } = req.query;

      const deptCol = getDbCollection('departments');
      const empCol = getDbCollection('employees');
      const reviewCol = getDbCollection('employeeReviews');
      const periodCol = getDbCollection('reviewPeriods');
      const cycleCol = getDbCollection('cycles');
      const appraisalCol = getDbCollection('appraisals');

      // Resolve period
      let targetPeriod: ReviewPeriod | null = null;
      if (periodId && typeof periodId === 'string' && periodId !== 'ALL') {
        targetPeriod = await periodCol.findOne({ id: periodId });
      } else {
        targetPeriod =
          (await periodCol.findOne({ status: 'ACTIVE' })) ||
          (await periodCol.find({})).sort({ year: -1, quarter: -1 })[0] ||
          null;
      }

      let previousPeriod: ReviewPeriod | null = null;
      if (targetPeriod) {
        const prevQuarter = targetPeriod.quarter === 1 ? 4 : targetPeriod.quarter - 1;
        const prevYear = targetPeriod.quarter === 1 ? targetPeriod.year - 1 : targetPeriod.year;
        previousPeriod = await periodCol.findOne({ year: prevYear, quarter: prevQuarter });
      }

      const allDepts: Department[] = await (await deptCol.find({})).toArray();
      const allEmps: Employee[] = await (await empCol.find({ status: { $ne: 'INACTIVE' } })).toArray();
      const allCycles: Cycle[] = await (await cycleCol.find({})).toArray();
      const targetYear = targetPeriod?.year || new Date().getFullYear();
      const allAppraisals: Appraisal[] = await (await appraisalCol.find({ appraisalYear: targetYear })).toArray();

      const currentMonth = new Date().getMonth() + 1;
      const currentMonthCycles = new Set(allCycles.filter((c) => c.appraisalMonth === currentMonth).map((c) => c.id));

      const currentReviews: EmployeeReview[] = targetPeriod
        ? await (await reviewCol.find({ reviewPeriodId: targetPeriod.id })).toArray()
        : [];

      const prevReviews: EmployeeReview[] = previousPeriod
        ? await (await reviewCol.find({ reviewPeriodId: previousPeriod.id })).toArray()
        : [];

      const nowIso = new Date().toISOString();

      let comparison = allDepts.map((dept) => {
        const deptEmployees = allEmps.filter((e) => e.departmentId === dept.id);
        const deptReviews = currentReviews.filter((r) => r.departmentId === dept.id);
        const deptPrevReviews = prevReviews.filter((r) => r.departmentId === dept.id);

        const totalReviewsCount = deptReviews.length;
        const closedReviews = deptReviews.filter((r) => r.status === 'CLOSED' || r.isClosed);
        const completedReviewsCount = closedReviews.length;
        const reviewCompletionRate = totalReviewsCount > 0 ? Math.round((completedReviewsCount / totalReviewsCount) * 100) : 0;

        const managerPending = deptReviews.filter(
          (r) => ['MANAGER_PENDING', 'ASSIGNED', 'DRAFT', 'PENDING', 'MANAGER_REVIEW', 'SELF_SUBMITTED'].includes(r.status)
        ).length;

        const hrPending = deptReviews.filter(
          (r) => ['HR_PENDING', 'HR_COMPLETED', 'MANAGER_COMPLETED', 'HR_REVIEW', 'MANAGER_SUBMITTED', 'CALIBRATION'].includes(r.status)
        ).length;

        const returnedCount = deptReviews.filter((r) => r.status === 'RETURNED').length;

        const overdueCount = deptReviews.filter((r) => {
          if (r.status === 'CLOSED' || r.isClosed) return false;
          const reviewDue = (r as any).dueDate || targetPeriod?.dueDate;
          if (reviewDue && reviewDue < nowIso) return true;
          return false;
        }).length;

        const validScores = closedReviews
          .filter((r) => typeof r.finalScore === 'number' && r.finalScore > 0)
          .map((r) => r.finalScore as number);
        const averageScore =
          validScores.length > 0
            ? Number((validScores.reduce((a, b) => a + b, 0) / validScores.length).toFixed(2))
            : 0;

        const prevValidScores = deptPrevReviews
          .filter((r) => (r.status === 'CLOSED' || r.isClosed) && typeof r.finalScore === 'number' && r.finalScore > 0)
          .map((r) => r.finalScore as number);
        const previousQuarterScore =
          prevValidScores.length > 0
            ? Number((prevValidScores.reduce((a, b) => a + b, 0) / prevValidScores.length).toFixed(2))
            : 0;

        const performanceChange =
          previousQuarterScore > 0 && averageScore > 0
            ? Number((averageScore - previousQuarterScore).toFixed(2))
            : 0;

        const trend: 'UP' | 'DOWN' | 'FLAT' =
          performanceChange > 0.05 ? 'UP' : performanceChange < -0.05 ? 'DOWN' : 'FLAT';

        const deptAppraisals = allAppraisals.filter((a) => a.departmentId === dept.id);
        const pendingDeptAppraisals = deptAppraisals.filter((a) => !a.isLocked && a.status !== 'LOCKED');
        const appraisalDueCount =
          pendingDeptAppraisals.length > 0
            ? pendingDeptAppraisals.length
            : deptAppraisals.length > 0
            ? deptAppraisals.length
            : deptEmployees.filter((e) => e.cycleId && currentMonthCycles.has(e.cycleId)).length;

        return {
          departmentId: dept.id,
          departmentName: dept.name,
          headcount: deptEmployees.length,
          employeeCount: deptEmployees.length,
          totalReviews: totalReviewsCount,
          totalReviewsCount,
          completedReviews: completedReviewsCount,
          completedReviewsCount,
          completionRate: reviewCompletionRate,
          reviewCompletionRate,
          managerPending,
          hrPending,
          returnedCount,
          overdueCount,
          averageScore,
          previousQuarterScore,
          scoreDelta: performanceChange,
          performanceChange,
          trend,
          appraisalDueCount,
        };
      });

      // Filter by search query
      if (search && typeof search === 'string' && search.trim()) {
        const q = search.toLowerCase().trim();
        comparison = comparison.filter((d) => d.departmentName.toLowerCase().includes(q));
      }

      // Sort
      comparison.sort((a: any, b: any) => {
        let valA = a[sortBy as string] ?? 0;
        let valB = b[sortBy as string] ?? 0;
        if (typeof valA === 'string') valA = valA.toLowerCase();
        if (typeof valB === 'string') valB = valB.toLowerCase();
        if (sortOrder === 'asc') {
          return valA > valB ? 1 : -1;
        } else {
          return valA < valB ? 1 : -1;
        }
      });

      res.json({
        period: targetPeriod,
        departments: comparison,
      });
    } catch (err: any) {
      console.error('[ManagementAPI] Error in GET /management/departments/performance:', err);
      res.status(500).json({ error: 'Failed to fetch department performance matrix.' });
    }
  }
);

/**
 * GET /api/management/performance/trends
 * Multi-quarter performance trend trajectory for line charts (Q1 -> Q4)
 */
managementRouter.get(
  '/management/performance/trends',
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { year = 2026, departmentId, cycleId } = req.query;
      const targetYear = Number(year) || 2026;

      const reviewCol = getDbCollection('employeeReviews');
      const periodCol = getDbCollection('reviewPeriods');
      const deptCol = getDbCollection('departments');

      // Fetch all periods for this year
      const periods: ReviewPeriod[] = await (
        await periodCol.find({ year: targetYear })
      ).sort({ quarter: 1 }).toArray();

      const allDepts: Department[] = await (await deptCol.find({})).toArray();

      const quartersData = await Promise.all(
        [1, 2, 3, 4].map(async (q) => {
          const matchedPeriod = periods.find((p) => p.quarter === q);
          if (!matchedPeriod) {
            return {
              quarter: `Q${q}`,
              quarterNumber: q,
              year: targetYear,
              averageScore: 0,
              totalClosed: 0,
              periodName: `Q${q} ${targetYear}`,
            };
          }

          const query: any = {
            reviewPeriodId: matchedPeriod.id,
            $or: [{ status: 'CLOSED' }, { isClosed: true }],
          };
          if (departmentId && departmentId !== 'ALL') {
            query.departmentId = departmentId;
          }
          if (cycleId && cycleId !== 'ALL') {
            query.cycleId = cycleId;
          }

          const closedReviews: EmployeeReview[] = await (await reviewCol.find(query)).toArray();
          const validScores = closedReviews
            .filter((r) => typeof r.finalScore === 'number' && r.finalScore > 0)
            .map((r) => r.finalScore as number);

          const avg =
            validScores.length > 0
              ? Number((validScores.reduce((a, b) => a + b, 0) / validScores.length).toFixed(2))
              : 0;

          return {
            quarter: `Q${q}`,
            quarterNumber: q,
            year: targetYear,
            averageScore: avg,
            totalClosed: validScores.length,
            periodName: matchedPeriod.name || `Q${q} ${targetYear}`,
          };
        })
      );

      // Compute department quarter-by-quarter averages
      const deptAverages = await Promise.all(
        allDepts.map(async (d) => {
          const deptQuarterScores: { [key: string]: number } = { q1: 0, q2: 0, q3: 0, q4: 0 };
          let totalScoreSum = 0;
          let totalScoredCount = 0;

          for (let q = 1; q <= 4; q++) {
            const p = periods.find((item) => item.quarter === q);
            if (p) {
              const closed = await (
                await reviewCol.find({
                  reviewPeriodId: p.id,
                  departmentId: d.id,
                  $or: [{ status: 'CLOSED' }, { isClosed: true }],
                })
              ).toArray();
              const scores = closed
                .filter((r) => typeof r.finalScore === 'number' && r.finalScore > 0)
                .map((r) => r.finalScore as number);
              if (scores.length > 0) {
                const avg = Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2));
                deptQuarterScores[`q${q}`] = avg;
                totalScoreSum += scores.reduce((a, b) => a + b, 0);
                totalScoredCount += scores.length;
              }
            }
          }

          const overall =
            totalScoredCount > 0 ? Number((totalScoreSum / totalScoredCount).toFixed(2)) : 0;

          return {
            departmentId: d.id,
            departmentName: d.name,
            q1: deptQuarterScores.q1,
            q2: deptQuarterScores.q2,
            q3: deptQuarterScores.q3,
            q4: deptQuarterScores.q4,
            overallAvg: overall,
          };
        })
      );

      res.json({
        year: targetYear,
        quarters: quartersData.map((q) => {
          const matchedPeriod = periods.find((p) => p.quarter === q.quarterNumber);
          return {
            quarter: q.quarterNumber,
            label: q.quarter,
            periodId: matchedPeriod?.id || null,
            periodStatus: matchedPeriod?.status || null,
            averageScore: q.averageScore,
            completedReviewsCount: q.totalClosed,
            totalReviewsCount: q.totalClosed,
            completionRate: q.totalClosed > 0 ? 100 : 0,
          };
        }),
        trends: quartersData,
        departments: allDepts.map((d) => ({ id: d.id, name: d.name })),
        departmentAverages: deptAverages,
      });
    } catch (err: any) {
      console.error('[ManagementAPI] Error in GET /management/performance/trends:', err);
      res.status(500).json({ error: 'Failed to generate performance trends.' });
    }
  }
);

/**
 * GET /api/management/high-performers
 * List of employees with highest finalized quarterly scores
 */
managementRouter.get(
  '/management/high-performers',
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { periodId, departmentId, cycleId, threshold = 4.0, limit = 10 } = req.query;

      const reviewCol = getDbCollection('employeeReviews');
      const periodCol = getDbCollection('reviewPeriods');

      let targetPeriodId = periodId as string;
      if (!targetPeriodId || targetPeriodId === 'ALL') {
        const activePeriod = (await periodCol.findOne({ status: 'ACTIVE' })) ||
          (await periodCol.find({})).sort({ year: -1, quarter: -1 })[0];
        targetPeriodId = activePeriod?.id || '';
      }

      const query: any = {
        finalScore: { $gte: Number(threshold) },
        $or: [{ status: 'CLOSED' }, { isClosed: true }],
      };
      if (targetPeriodId) {
        query.reviewPeriodId = targetPeriodId;
      }
      if (departmentId && departmentId !== 'ALL') {
        query.departmentId = departmentId;
      }
      if (cycleId && cycleId !== 'ALL') {
        query.cycleId = cycleId;
      }

      const reviews: EmployeeReview[] = await (
        await reviewCol.find(query)
      ).sort({ finalScore: -1 }).limit(Number(limit) || 10).toArray();

      const performers = reviews.map((r) => ({
        employeeId: r.employeeId,
        employeeName: r.employeeName,
        employeeCode: r.employeeCode,
        departmentName: r.departmentName,
        designationName: r.designationName,
        designation: r.designationName,
        cycleCode: r.cycleCode,
        cycleColor: r.cycleColor,
        managerName: r.managerName,
        finalScore: r.finalScore || 0,
        latestScore: r.finalScore || 0,
        status: r.status,
        reviewStatus: r.status,
        periodName: r.reviewPeriodName,
        reviewPeriodName: r.reviewPeriodName,
      }));

      res.json({
        count: performers.length,
        threshold: Number(threshold),
        performers,
      });
    } catch (err: any) {
      console.error('[ManagementAPI] Error in GET /management/high-performers:', err);
      res.status(500).json({ error: 'Failed to fetch high performers.' });
    }
  }
);

/**
 * GET /api/management/attention-required
 * Employees requiring organizational support or management attention
 */
managementRouter.get(
  '/management/attention-required',
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { periodId, departmentId, cycleId, threshold = 3.2, limit = 10 } = req.query;

      const reviewCol = getDbCollection('employeeReviews');
      const periodCol = getDbCollection('reviewPeriods');

      let targetPeriodId = periodId as string;
      if (!targetPeriodId || targetPeriodId === 'ALL') {
        const activePeriod = (await periodCol.findOne({ status: 'ACTIVE' })) ||
          (await periodCol.find({})).sort({ year: -1, quarter: -1 })[0];
        targetPeriodId = activePeriod?.id || '';
      }

      const query: any = {
        $or: [
          { finalScore: { $gt: 0, $lte: Number(threshold) }, status: 'CLOSED' },
          { status: 'RETURNED' },
          { status: 'MANAGER_PENDING' },
        ],
      };
      if (targetPeriodId) {
        query.reviewPeriodId = targetPeriodId;
      }
      if (departmentId && departmentId !== 'ALL') {
        query.departmentId = departmentId;
      }
      if (cycleId && cycleId !== 'ALL') {
        query.cycleId = cycleId;
      }

      const reviews: EmployeeReview[] = await (
        await reviewCol.find(query)
      ).limit(Number(limit) || 15).toArray();

      const attentionList = reviews.map((r) => {
        let observation = 'Performance requires coaching';
        if (r.status === 'RETURNED') {
          observation = 'Review returned by reviewer for revisions';
        } else if (r.status === 'MANAGER_PENDING') {
          observation = 'Evaluation pending manager submission';
        } else if (r.finalScore && r.finalScore < 2.8) {
          observation = `Score below minimum performance threshold (${r.finalScore} / 5.0)`;
        } else if (r.finalScore && r.finalScore <= Number(threshold)) {
          observation = `Needs improvement (${r.finalScore} / 5.0)`;
        }

        return {
          employeeId: r.employeeId,
          employeeName: r.employeeName,
          employeeCode: r.employeeCode,
          departmentName: r.departmentName,
          designationName: r.designationName,
          designation: r.designationName,
          cycleCode: r.cycleCode,
          cycleColor: r.cycleColor,
          managerName: r.managerName,
          score: r.finalScore || 0,
          latestScore: r.finalScore || 0,
          status: r.status,
          reason: observation,
          observation,
          urgency: (r.status === 'RETURNED' || (r.finalScore && r.finalScore < 2.5) ? 'HIGH' : 'MEDIUM') as 'HIGH' | 'MEDIUM',
          periodName: r.reviewPeriodName,
          reviewPeriodName: r.reviewPeriodName,
        };
      });

      res.json({
        count: attentionList.length,
        threshold: Number(threshold),
        attentionList,
        attentionItems: attentionList,
      });
    } catch (err: any) {
      console.error('[ManagementAPI] Error in GET /management/attention-required:', err);
      res.status(500).json({ error: 'Failed to fetch attention required records.' });
    }
  }
);

/**
 * GET /api/management/appraisals/summary
 * Executive appraisal cohort rollups, cycle status, and department increment impact
 */
managementRouter.get(
  '/management/appraisals/summary',
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { year = 2026, cycleId, departmentId } = req.query;
      const targetYear = Number(year) || 2026;

      const appraisalCol = getDbCollection('appraisals');
      const deptCol = getDbCollection('departments');
      const cycleCol = getDbCollection('cycles');
      const empCol = getDbCollection('employees');

      const query: any = { appraisalYear: targetYear };
      if (cycleId && cycleId !== 'ALL') query.cycleId = cycleId;
      if (departmentId && departmentId !== 'ALL') query.departmentId = departmentId;

      const appraisals: Appraisal[] = await (await appraisalCol.find(query)).toArray();
      const allDepts: Department[] = await (await deptCol.find({})).toArray();
      const allCycles: Cycle[] = await (await cycleCol.find({})).toArray();
      const allEmployees: Employee[] = await (await empCol.find({ status: { $ne: 'INACTIVE' } })).toArray();

      const totalDue = appraisals.length;
      const completedCount = appraisals.filter((a) => a.isLocked || a.status === 'LOCKED').length;
      const pendingCount = totalDue - completedCount;

      const ratingsWithScores = appraisals.filter((a) => typeof a.averageQuarterlyScore === 'number' && a.averageQuarterlyScore > 0);
      const averageFinalRating =
        ratingsWithScores.length > 0
          ? Number((ratingsWithScores.reduce((sum, a) => sum + a.averageQuarterlyScore, 0) / ratingsWithScores.length).toFixed(2))
          : 0;

      const totalCurrentPayroll = appraisals.reduce((sum, a) => sum + (a.currentCtc || 0), 0);
      const totalRevisedPayroll = appraisals.reduce((sum, a) => sum + (a.revisedCtc || a.currentCtc || 0), 0);
      const budgetConsumed = totalRevisedPayroll - totalCurrentPayroll;

      const incs = appraisals.filter((a) => (a.approvedIncrementPercentage || a.proposedIncrementPercentage || 0) > 0);
      const averageIncrementPercent =
        incs.length > 0
          ? Number((incs.reduce((sum, a) => sum + (a.approvedIncrementPercentage || a.proposedIncrementPercentage || 0), 0) / incs.length).toFixed(2))
          : 0;

      const promotionsCount = appraisals.filter((a) => a.promotionRecommended || a.hodCalibration?.promotionApproved).length;

      // Cycle breakdown
      const byCycle = allCycles.map((c) => {
        const cycleApprs = appraisals.filter((a) => a.cycleId === c.id || a.cycleCode === c.code);
        const closedApprs = cycleApprs.filter((a) => a.isLocked || a.status === 'LOCKED');
        const avgR = cycleApprs.length > 0
          ? Number((cycleApprs.reduce((sum, a) => sum + (a.averageQuarterlyScore || 0), 0) / cycleApprs.length).toFixed(2))
          : 0;
        return {
          cycleId: c.id,
          cycleCode: c.code,
          cycleName: c.name,
          appraisalMonth: c.appraisalMonth,
          dueCount: cycleApprs.length,
          completedCount: closedApprs.length,
          averageRating: avgR,
        };
      });

      // Department breakdown
      const byDepartment = allDepts.map((d) => {
        const deptApprs = appraisals.filter((a) => a.departmentId === d.id);
        const deptClosed = deptApprs.filter((a) => a.isLocked || a.status === 'LOCKED');
        const deptCurr = deptApprs.reduce((sum, a) => sum + (a.currentCtc || 0), 0);
        const deptRev = deptApprs.reduce((sum, a) => sum + (a.revisedCtc || a.currentCtc || 0), 0);
        const avgR = deptApprs.length > 0
          ? Number((deptApprs.reduce((sum, a) => sum + (a.averageQuarterlyScore || 0), 0) / deptApprs.length).toFixed(2))
          : 0;
        return {
          departmentId: d.id,
          departmentName: d.name,
          dueCount: deptApprs.length,
          completedCount: deptClosed.length,
          averageRating: avgR,
          budgetImpact: deptRev - deptCurr,
        };
      });

      await logManagementAudit(req, 'MANAGEMENT_VIEW_APPRAISAL_SUMMARY', { year: targetYear });

      const completionRate = totalDue > 0 ? Math.round((completedCount / totalDue) * 100) : 0;

      const departmentBreakdowns = byDepartment.map((d) => ({
        departmentId: d.departmentId,
        departmentName: d.departmentName,
        headcount: d.dueCount,
        appraisalCount: d.dueCount,
        lockedCount: d.completedCount,
        averageIncrementPercent: d.completedCount > 0 ? averageIncrementPercent : 0,
        payrollImpact: d.budgetImpact,
      }));

      const cycleBreakdowns = byCycle.map((c) => ({
        cycleId: c.cycleId,
        cycleName: c.cycleName,
        appraisalMonth: c.appraisalMonth,
        eligibleCount: c.dueCount,
        initiatedCount: c.dueCount,
        lockedCount: c.completedCount,
        averageIncrementPercent: 0,
      }));

      res.json({
        year: targetYear,
        summary: {
          totalDue,
          completed: completedCount,
          pending: pendingCount,
          averageFinalRating,
          totalCurrentPayroll,
          totalRevisedPayroll,
          budgetConsumed,
          averageIncrementPercent,
          promotionsCount,

          // Aliases matching frontend types:
          totalEligible: totalDue,
          totalInitiated: totalDue,
          totalLocked: completedCount,
          totalPayrollImpact: budgetConsumed,
          completionRate,
          pendingManager: pendingCount,
          pendingHod: 0,
          pendingHr: 0,
        },
        byCycle,
        byDepartment,
        departmentBreakdowns,
        cycleBreakdowns,
      });
    } catch (err: any) {
      console.error('[ManagementAPI] Error in GET /management/appraisals/summary:', err);
      res.status(500).json({ error: 'Failed to fetch appraisal summary.' });
    }
  }
);

/**
 * GET /api/management/reviews/summary
 * Organization quarterly review progress breakdown and read-only list
 */
managementRouter.get(
  '/management/reviews/summary',
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { periodId, departmentId, status, cycleId } = req.query;

      const reviewCol = getDbCollection('employeeReviews');
      const periodCol = getDbCollection('reviewPeriods');

      let targetPeriodId = periodId as string;
      if (!targetPeriodId || targetPeriodId === 'ALL') {
        const activePeriod = (await periodCol.findOne({ status: 'ACTIVE' })) ||
          (await periodCol.find({})).sort({ year: -1, quarter: -1 })[0];
        targetPeriodId = activePeriod?.id || '';
      }

      const query: any = {};
      if (targetPeriodId) query.reviewPeriodId = targetPeriodId;
      if (departmentId && departmentId !== 'ALL') query.departmentId = departmentId;
      if (status && status !== 'ALL') query.status = status;
      if (cycleId && cycleId !== 'ALL') query.cycleId = cycleId;

      const reviews: EmployeeReview[] = await (await reviewCol.find(query)).toArray();

      res.json({
        total: reviews.length,
        managerPending: reviews.filter((r) => r.status === 'MANAGER_PENDING').length,
        hrPending: reviews.filter((r) => r.status === 'HR_PENDING').length,
        closed: reviews.filter((r) => r.status === 'CLOSED' || r.isClosed).length,
        returned: reviews.filter((r) => r.status === 'RETURNED').length,
        reviews: reviews.map((r) => ({
          id: r.id,
          employeeId: r.employeeId,
          employeeCode: r.employeeCode,
          employeeName: r.employeeName,
          departmentName: r.departmentName,
          designationName: r.designationName,
          managerName: r.managerName,
          cycleCode: r.cycleCode,
          cycleColor: r.cycleColor,
          finalScore: r.finalScore || 0,
          status: r.status,
          dueDate: (r as any).dueDate || null,
          periodName: r.reviewPeriodName,
          isClosed: r.isClosed,
        })),
      });
    } catch (err: any) {
      console.error('[ManagementAPI] Error in GET /management/reviews/summary:', err);
      res.status(500).json({ error: 'Failed to fetch reviews summary.' });
    }
  }
);

/**
 * GET /api/management/employee/:id/performance
 * Read-only 360 employee performance profile dossier
 */
managementRouter.get(
  '/management/employee/:id/performance',
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = req.params;

      const empCol = getDbCollection('employees');
      const reviewCol = getDbCollection('employeeReviews');
      const appraisalCol = getDbCollection('appraisals');

      const employee: Employee | null = await empCol.findOne({ id });
      if (!employee) {
        return res.status(404).json({ error: 'Employee not found.' });
      }

      // Fetch all past reviews chronologically
      const reviews: EmployeeReview[] = await (
        await reviewCol.find({ employeeId: id })
      ).sort({ createdAt: -1 }).toArray();

      // Fetch latest appraisal
      const appraisal: Appraisal | null = await appraisalCol.findOne(
        { employeeId: id },
        { sort: { appraisalYear: -1 } } as any
      );

      // Score trend across quarters
      const quarterlyScoreTrend = reviews
        .filter((r) => typeof r.finalScore === 'number' && r.finalScore > 0)
        .map((r) => ({
          quarter: r.reviewPeriodName || 'Quarterly Review',
          year: (r as any).cycleYear || (r as any).year || 2026,
          score: r.finalScore as number,
          status: r.status,
          date: r.createdAt,
        }))
        .reverse();

      await logManagementAudit(req, 'MANAGEMENT_VIEW_EMPLOYEE_PERFORMANCE', { targetEmployeeId: id });

      res.json({
        employee: {
          id: employee.id,
          name: employee.name,
          employeeCode: employee.employeeCode,
          email: employee.email,
          departmentId: employee.departmentId,
          departmentName: employee.departmentName,
          designationName: employee.designationName,
          managerName: employee.managerName,
          hodName: employee.hodName,
          cycleCode: employee.cycleCode,
          cycleName: employee.cycleName,
          cycleColor: employee.cycleColor,
          joiningDate: employee.joiningDate,
          status: employee.status,
        },
        reviews: reviews.map((r) => ({
          id: r.id,
          periodName: r.reviewPeriodName,
          finalScore: r.finalScore || 0,
          status: r.status,
          isClosed: r.isClosed,
          strengths: r.strengths,
          areasOfImprovement: (r as any).areasOfImprovement || r.improvements,
          managerFeedback: r.managerOverallComments,
          hrFeedback: (r as any).hrReviewerComments || r.hrComments,
          kraSnapshot: r.kraSnapshot || [],
          kraScores: (r as any).kraScores || (r.kraSnapshot || []).map((k: any) => ({ kraTitle: k.title || k.kraName, weight: k.weight, rating: k.rating })),
          updatedAt: r.updatedAt,
        })),
        appraisal: appraisal
          ? {
              id: appraisal.id,
              year: appraisal.appraisalYear,
              averageScore: appraisal.averageQuarterlyScore,
              finalRating: appraisal.finalRating,
              proposedIncrement: appraisal.proposedIncrementPercentage,
              approvedIncrement: appraisal.approvedIncrementPercentage,
              status: appraisal.status,
              isLocked: appraisal.isLocked,
              promotionRecommended: appraisal.promotionRecommended,
              promotionDesignationName: appraisal.promotionDesignationName,
              effectiveDate: appraisal.effectiveDate,
            }
          : null,
        quarterlyScoreTrend,
      });
    } catch (err: any) {
      console.error('[ManagementAPI] Error in GET /management/employee/:id/performance:', err);
      res.status(500).json({ error: 'Failed to fetch employee performance profile.' });
    }
  }
);
