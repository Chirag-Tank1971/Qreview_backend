import { Router, Response } from 'express';
import { getDbCollection } from '../db.js';
import { AuthenticatedRequest, authenticateToken, requireRoles } from '../auth.js';
import {
  Employee,
  Department,
  Cycle,
  EmployeeReview,
  ReviewPeriod,
  Appraisal,
  AuditLog,
} from '../../src/types.js';

export const reportRouter = Router();
reportRouter.use('/reports', authenticateToken);
reportRouter.use('/reports', requireRoles('SUPER_ADMIN', 'HR', 'HOD', 'MANAGER'));

/**
 * 1. Quarterly Review Status Report (Section 16.1)
 */
reportRouter.get('/reports/quarterly-status', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { periodId, departmentId, cycleId, status } = req.query;
    const reviewsCol = getDbCollection('employeeReviews');
    const employeesCol = getDbCollection('employees');

    let reviews: EmployeeReview[] = await (await reviewsCol.find({})).toArray();
    const employees: Employee[] = await (await employeesCol.find({})).toArray();
    const empMap = new Map(employees.map((e) => [e.id, e]));

    // Apply filters
    if (periodId && periodId !== 'ALL') {
      reviews = reviews.filter((r) => r.reviewPeriodId === periodId);
    }
    if (departmentId && departmentId !== 'ALL') {
      reviews = reviews.filter((r) => {
        const emp = empMap.get(r.employeeId);
        return emp?.departmentId === departmentId || r.departmentId === departmentId;
      });
    }
    if (cycleId && cycleId !== 'ALL') {
      reviews = reviews.filter((r) => r.cycleId === cycleId || r.cycleCode === cycleId);
    }
    if (status && status !== 'ALL') {
      reviews = reviews.filter((r) => r.status === status);
    }

    const reportData = reviews.map((r) => {
      const emp = empMap.get(r.employeeId);
      const isOverdue = r.status !== 'CLOSED' && r.status !== 'HR_COMPLETED';

      return {
        id: r.id,
        employeeCode: r.employeeCode || emp?.employeeCode || 'N/A',
        employeeName: r.employeeName || emp?.name || 'N/A',
        departmentName: r.departmentName || emp?.departmentName || 'N/A',
        designationName: r.designationName || emp?.designationName || 'N/A',
        managerName: r.managerName || emp?.managerName || 'N/A',
        cycleCode: r.cycleCode || emp?.cycleCode || 'A',
        periodName: r.reviewPeriodName || 'N/A',
        status: r.status,
        finalScore: r.finalScore || 0,
        submissionDate: r.submittedAt || null,
        completedDate: r.completedAt || null,
        isOverdue,
        krasCount: r.kraSnapshot?.length || 0,
      };
    });

    const summary = {
      total: reportData.length,
      completed: reportData.filter((r) => r.status === 'CLOSED' || r.status === 'HR_COMPLETED').length,
      managerPending: reportData.filter((r) => r.status === 'MANAGER_PENDING' || r.status === 'ASSIGNED').length,
      hrPending: reportData.filter((r) => r.status === 'HR_PENDING' || r.status === 'MANAGER_COMPLETED').length,
      returned: reportData.filter((r) => r.status === 'RETURNED').length,
      overdue: reportData.filter((r) => r.isOverdue).length,
      averageScore:
        reportData.length > 0
          ? Number((reportData.reduce((acc, r) => acc + (r.finalScore || 0), 0) / reportData.length).toFixed(2))
          : 0,
    };

    res.json({ reportData, summary });
  } catch (error: any) {
    console.error('Failed to generate quarterly status report:', error);
    res.status(500).json({ error: 'Failed to generate quarterly status report.' });
  }
});

/**
 * 2. Pending & Overdue Review Report (Section 16.2)
 */
reportRouter.get('/reports/pending-overdue', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { departmentId, cycleId } = req.query;
    const reviewsCol = getDbCollection('employeeReviews');
    const employeesCol = getDbCollection('employees');

    let reviews: EmployeeReview[] = await (await reviewsCol.find({})).toArray();
    const employees: Employee[] = await (await employeesCol.find({})).toArray();
    const empMap = new Map(employees.map((e) => [e.id, e]));

    // Filter only pending/non-closed reviews
    reviews = reviews.filter((r) => r.status !== 'CLOSED' && r.status !== 'HR_COMPLETED');

    if (departmentId && departmentId !== 'ALL') {
      reviews = reviews.filter((r) => {
        const emp = empMap.get(r.employeeId);
        return emp?.departmentId === departmentId || r.departmentId === departmentId;
      });
    }
    if (cycleId && cycleId !== 'ALL') {
      reviews = reviews.filter((r) => r.cycleId === cycleId || r.cycleCode === cycleId);
    }

    const now = new Date();
    const reportData = reviews.map((r) => {
      const emp = empMap.get(r.employeeId);
      const createdAt = new Date(r.createdAt || Date.now());
      const daysAging = Math.max(1, Math.floor((now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24)));

      let pendingWith = 'Reporting Manager';
      if (r.status === 'HR_PENDING' || r.status === 'MANAGER_COMPLETED') {
        pendingWith = 'HR / Calibration Team';
      } else if (r.status === 'RETURNED') {
        pendingWith = 'Manager (Action on Return)';
      }

      return {
        id: r.id,
        employeeCode: r.employeeCode || emp?.employeeCode || 'N/A',
        employeeName: r.employeeName || emp?.name || 'N/A',
        departmentName: r.departmentName || emp?.departmentName || 'N/A',
        designationName: r.designationName || emp?.designationName || 'N/A',
        managerName: r.managerName || emp?.managerName || 'N/A',
        cycleCode: r.cycleCode || emp?.cycleCode || 'A',
        periodName: r.reviewPeriodName || 'N/A',
        status: r.status,
        pendingWith,
        daysAging,
        isOverdue: daysAging > 15,
        dueDate: '2026-09-30',
        lastActionDate: r.updatedAt || r.createdAt,
      };
    });

    reportData.sort((a, b) => b.daysAging - a.daysAging);

    res.json({
      reportData,
      summary: {
        totalPending: reportData.length,
        managerPendingCount: reportData.filter((r) => r.pendingWith.includes('Manager')).length,
        hrPendingCount: reportData.filter((r) => r.pendingWith.includes('HR')).length,
        criticalOverdueCount: reportData.filter((r) => r.daysAging > 30).length,
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to generate pending & overdue report.' });
  }
});

/**
 * 3. Employee Performance History Report (Section 16.3)
 */
reportRouter.get('/reports/employee-history', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { departmentId, cycleId, search } = req.query;
    const employeesCol = getDbCollection('employees');
    const reviewsCol = getDbCollection('employeeReviews');
    const appraisalsCol = getDbCollection('appraisals');
    const periodsCol = getDbCollection('reviewPeriods');

    let employees: Employee[] = await (await employeesCol.find({ status: 'ACTIVE' })).toArray();
    const reviews: EmployeeReview[] = await (await reviewsCol.find({})).toArray();
    const appraisals: Appraisal[] = await (await appraisalsCol.find({})).toArray();
    const periods: ReviewPeriod[] = await (await periodsCol.find({})).toArray();

    const periodMap = new Map(periods.map((p) => [p.id, p]));

    if (departmentId && departmentId !== 'ALL') {
      employees = employees.filter((e) => e.departmentId === departmentId);
    }
    if (cycleId && cycleId !== 'ALL') {
      employees = employees.filter((e) => e.cycleId === cycleId || e.cycleCode === cycleId);
    }
    if (search) {
      const q = String(search).toLowerCase();
      employees = employees.filter(
        (e) => e.name.toLowerCase().includes(q) || e.employeeCode.toLowerCase().includes(q)
      );
    }

    const reportData = employees.map((emp) => {
      const empReviews = reviews.filter((r) => r.employeeId === emp.id);

      const q1 = empReviews.find((r) => {
        const p = periodMap.get(r.reviewPeriodId);
        return p?.quarter === 1 || r.reviewPeriodName?.includes('Q1');
      });
      const q2 = empReviews.find((r) => {
        const p = periodMap.get(r.reviewPeriodId);
        return p?.quarter === 2 || r.reviewPeriodName?.includes('Q2');
      });
      const q3 = empReviews.find((r) => {
        const p = periodMap.get(r.reviewPeriodId);
        return p?.quarter === 3 || r.reviewPeriodName?.includes('Q3');
      });
      const q4 = empReviews.find((r) => {
        const p = periodMap.get(r.reviewPeriodId);
        return p?.quarter === 4 || r.reviewPeriodName?.includes('Q4');
      });

      const scoredReviews = empReviews.filter((r) => typeof r.finalScore === 'number' && r.finalScore > 0);
      const avgScore =
        scoredReviews.length > 0
          ? Number((scoredReviews.reduce((acc, r) => acc + (r.finalScore || 0), 0) / scoredReviews.length).toFixed(2))
          : 0;

      const latestAppraisal = appraisals.find((a) => a.employeeId === emp.id);

      return {
        employeeId: emp.id,
        employeeCode: emp.employeeCode,
        employeeName: emp.name,
        departmentName: emp.departmentName || 'General',
        designationName: emp.designationName || 'Specialist',
        cycleCode: emp.cycleCode || 'A',
        joiningDate: emp.joiningDate,
        totalReviews: empReviews.length,
        q1Score: q1?.finalScore || null,
        q2Score: q2?.finalScore || null,
        q3Score: q3?.finalScore || null,
        q4Score: q4?.finalScore || null,
        averageQuarterlyScore: avgScore,
        performanceBand:
          avgScore >= 4.5
            ? 'OUTSTANDING'
            : avgScore >= 3.8
            ? 'EXCEEDS'
            : avgScore >= 2.8
            ? 'MEETS'
            : avgScore > 0
            ? 'NEEDS_IMP'
            : 'UNRATED',
        latestAppraisalStatus: latestAppraisal?.status || 'NOT_INITIATED',
        approvedIncrement: latestAppraisal?.approvedIncrementPercentage || null,
        promotionRecommended: !!latestAppraisal?.promotionRecommended,
      };
    });

    res.json({ reportData });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to generate employee history report.' });
  }
});

/**
 * 4. Department Performance Report (Section 16.4)
 */
reportRouter.get('/reports/department-performance', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const departmentsCol = getDbCollection('departments');
    const employeesCol = getDbCollection('employees');
    const reviewsCol = getDbCollection('employeeReviews');

    const departments: Department[] = await (await departmentsCol.find({ active: true })).toArray();
    const employees: Employee[] = await (await employeesCol.find({ status: 'ACTIVE' })).toArray();
    const reviews: EmployeeReview[] = await (await reviewsCol.find({})).toArray();

    const reportData = departments.map((dept) => {
      const deptEmployees = employees.filter((e) => e.departmentId === dept.id);
      const empIds = new Set(deptEmployees.map((e) => e.id));
      const deptReviews = reviews.filter((r) => empIds.has(r.employeeId) || r.departmentId === dept.id);

      const scoredReviews = deptReviews.filter((r) => typeof r.finalScore === 'number' && r.finalScore > 0);
      const avgScore =
        scoredReviews.length > 0
          ? Number((scoredReviews.reduce((acc, r) => acc + (r.finalScore || 0), 0) / scoredReviews.length).toFixed(2))
          : 0;

      const completedCount = deptReviews.filter(
        (r) => r.status === 'CLOSED' || r.status === 'HR_COMPLETED'
      ).length;
      const completionRate = deptReviews.length > 0 ? Math.round((completedCount / deptReviews.length) * 100) : 0;

      const outstandingCount = scoredReviews.filter((r) => r.finalScore && r.finalScore >= 4.5).length;
      const exceedsCount = scoredReviews.filter((r) => r.finalScore && r.finalScore >= 3.8 && r.finalScore < 4.5).length;
      const meetsCount = scoredReviews.filter((r) => r.finalScore && r.finalScore >= 2.8 && r.finalScore < 3.8).length;
      const needsImpCount = scoredReviews.filter((r) => r.finalScore && r.finalScore < 2.8).length;

      return {
        departmentId: dept.id,
        departmentName: dept.name,
        headcount: deptEmployees.length,
        totalReviews: deptReviews.length,
        completedReviews: completedCount,
        completionRate,
        averageScore: avgScore,
        outstandingCount,
        exceedsCount,
        meetsCount,
        needsImpCount,
      };
    });

    reportData.sort((a, b) => b.averageScore - a.averageScore);

    res.json({ reportData });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to generate department performance report.' });
  }
});

/**
 * 5. Manager-wise Review Completion Report (Section 16.5)
 */
reportRouter.get('/reports/manager-completion', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const employeesCol = getDbCollection('employees');
    const reviewsCol = getDbCollection('employeeReviews');

    const employees: Employee[] = await (await employeesCol.find({})).toArray();
    const reviews: EmployeeReview[] = await (await reviewsCol.find({})).toArray();

    // Group reviews by manager
    const managerMap = new Map<string, { name: string; dept: string; reviews: EmployeeReview[] }>();

    employees.forEach((emp) => {
      if (emp.managerId && emp.managerName) {
        if (!managerMap.has(emp.managerId)) {
          managerMap.set(emp.managerId, {
            name: emp.managerName,
            dept: emp.departmentName || 'Operations',
            reviews: [],
          });
        }
      }
    });

    reviews.forEach((r) => {
      if (r.managerId) {
        if (!managerMap.has(r.managerId)) {
          managerMap.set(r.managerId, {
            name: r.managerName || 'Manager',
            dept: r.departmentName || 'General',
            reviews: [],
          });
        }
        managerMap.get(r.managerId)?.reviews.push(r);
      }
    });

    const reportData = Array.from(managerMap.entries()).map(([managerId, data]) => {
      const total = data.reviews.length;
      const submitted = data.reviews.filter(
        (r) => r.status !== 'ASSIGNED' && r.status !== 'MANAGER_PENDING' && r.status !== 'DRAFT'
      ).length;
      const closed = data.reviews.filter(
        (r) => r.status === 'CLOSED' || r.status === 'HR_COMPLETED'
      ).length;
      const returned = data.reviews.filter((r) => r.status === 'RETURNED').length;
      const overdue = data.reviews.filter(
        (r) => r.status !== 'CLOSED' && r.status !== 'HR_COMPLETED'
      ).length;

      const completionRate = total > 0 ? Math.round((submitted / total) * 100) : 0;
      const scoredReviews = data.reviews.filter((r) => r.finalScore && r.finalScore > 0);
      const avgScoreAwarded =
        scoredReviews.length > 0
          ? Number((scoredReviews.reduce((acc, r) => acc + (r.finalScore || 0), 0) / scoredReviews.length).toFixed(2))
          : 0;

      return {
        managerId,
        managerName: data.name,
        departmentName: data.dept,
        totalAssigned: total,
        submittedCount: submitted,
        closedCount: closed,
        returnedCount: returned,
        overdueCount: overdue,
        completionRate,
        avgScoreAwarded,
      };
    });

    reportData.sort((a, b) => b.completionRate - a.completionRate);

    res.json({ reportData });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to generate manager completion report.' });
  }
});

/**
 * 6. Appraisal Due Report (Section 16.6)
 */
reportRouter.get('/reports/appraisal-due', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { cycleId, year } = req.query;
    const employeesCol = getDbCollection('employees');
    const cyclesCol = getDbCollection('cycles');
    const appraisalsCol = getDbCollection('appraisals');
    const reviewsCol = getDbCollection('employeeReviews');

    const employees: Employee[] = await (await employeesCol.find({ status: 'ACTIVE' })).toArray();
    const cycles: Cycle[] = await (await cyclesCol.find({})).toArray();
    const appraisals: Appraisal[] = await (await appraisalsCol.find({})).toArray();
    const reviews: EmployeeReview[] = await (await reviewsCol.find({})).toArray();

    const targetYear = year ? parseInt(year as string, 10) : 2026;
    const cycleMap = new Map(cycles.map((c) => [c.id, c]));

    let eligibleEmployees = employees;
    if (cycleId && cycleId !== 'ALL') {
      eligibleEmployees = eligibleEmployees.filter((e) => e.cycleId === cycleId || e.cycleCode === cycleId);
    }

    const monthNames = [
      '',
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ];

    const reportData = eligibleEmployees.map((emp) => {
      const cycle = cycleMap.get(emp.cycleId || '') || cycles.find((c) => c.code === emp.cycleCode);
      const empAppraisal = appraisals.find((a) => a.employeeId === emp.id && a.appraisalYear === targetYear);
      const empReviews = reviews.filter((r) => r.employeeId === emp.id);

      const scored = empReviews.filter((r) => r.finalScore && r.finalScore > 0);
      const avgScore =
        scored.length > 0
          ? Number((scored.reduce((acc, r) => acc + (r.finalScore || 0), 0) / scored.length).toFixed(2))
          : 0;

      const appraisalMonth = cycle?.appraisalMonth || 1;

      return {
        employeeId: emp.id,
        employeeCode: emp.employeeCode,
        employeeName: emp.name,
        departmentName: emp.departmentName || 'General',
        designationName: emp.designationName || 'Specialist',
        cycleCode: cycle?.code || emp.cycleCode || 'A',
        cycleName: cycle?.name || `Cycle ${emp.cycleCode}`,
        appraisalMonthName: monthNames[appraisalMonth] || `Month ${appraisalMonth}`,
        appraisalYear: targetYear,
        currentCtc: emp.currentCtc || 0,
        averageQuarterlyScore: avgScore,
        appraisalStatus: empAppraisal?.status || 'PENDING_INITIATION',
        proposedIncrement: empAppraisal?.proposedIncrementPercentage || 0,
        approvedIncrement: empAppraisal?.approvedIncrementPercentage || null,
        revisedCtc: empAppraisal?.revisedCtc || emp.currentCtc || 0,
        isLocked: !!empAppraisal?.isLocked,
      };
    });

    res.json({ reportData });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to generate appraisal due report.' });
  }
});

/**
 * 7. Quarterly Rating Trend Report (Section 16.7)
 */
reportRouter.get('/reports/rating-trend', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const reviewsCol = getDbCollection('employeeReviews');
    const periodsCol = getDbCollection('reviewPeriods');
    const departmentsCol = getDbCollection('departments');

    const reviews: EmployeeReview[] = await (await reviewsCol.find({})).toArray();
    const periods: ReviewPeriod[] = await (await periodsCol.find({})).toArray();
    const departments: Department[] = await (await departmentsCol.find({ active: true })).toArray();

    const periodMap = new Map(periods.map((p) => [p.id, p]));

    const quarters = [
      { name: 'Q1 2026', quarter: 1 },
      { name: 'Q2 2026', quarter: 2 },
      { name: 'Q3 2026', quarter: 3 },
      { name: 'Q4 2026', quarter: 4 },
    ];

    const trends = quarters.map((q) => {
      const qReviews = reviews.filter((r) => {
        const p = periodMap.get(r.reviewPeriodId);
        return p?.quarter === q.quarter || r.reviewPeriodName?.includes(`Q${q.quarter}`);
      });

      const scored = qReviews.filter((r) => r.finalScore && r.finalScore > 0);
      const avg =
        scored.length > 0
          ? Number((scored.reduce((acc, r) => acc + (r.finalScore || 0), 0) / scored.length).toFixed(2))
          : 0;

      const outstanding = scored.filter((r) => r.finalScore && r.finalScore >= 4.5).length;
      const exceeds = scored.filter((r) => r.finalScore && r.finalScore >= 3.8 && r.finalScore < 4.5).length;
      const meets = scored.filter((r) => r.finalScore && r.finalScore >= 2.8 && r.finalScore < 3.8).length;
      const needsImp = scored.filter((r) => r.finalScore && r.finalScore < 2.8).length;

      const deptBreakdown: Record<string, number> = {};
      departments.forEach((dept) => {
        const dReviews = qReviews.filter(
          (r) => r.departmentName?.toLowerCase() === dept.name.toLowerCase() || r.departmentId === dept.id
        );
        const dScored = dReviews.filter((r) => r.finalScore && r.finalScore > 0);
        const dAvg =
          dScored.length > 0
            ? Number((dScored.reduce((acc, r) => acc + (r.finalScore || 0), 0) / dScored.length).toFixed(2))
            : 0;
        deptBreakdown[dept.name] = dAvg;
      });

      return {
        quarter: q.name,
        totalReviews: qReviews.length,
        averageScore: avg,
        distribution: { outstanding, exceeds, meets, needsImp },
        departmentAverages: deptBreakdown,
      };
    });

    res.json({ trends });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to generate rating trend report.' });
  }
});

/**
 * 8. KRA-wise Performance Report (Section 16.8)
 */
reportRouter.get('/reports/kra-performance', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const reviewsCol = getDbCollection('employeeReviews');
    const reviews: EmployeeReview[] = await (await reviewsCol.find({})).toArray();

    const kraMap = new Map<string, { totalWeight: number; ratings: number[]; occurrences: number }>();

    reviews.forEach((r) => {
      if (Array.isArray(r.kraSnapshot)) {
        r.kraSnapshot.forEach((k) => {
          const name = k.kraName || k.title || 'General KRA';
          if (!kraMap.has(name)) {
            kraMap.set(name, { totalWeight: 0, ratings: [], occurrences: 0 });
          }
          const item = kraMap.get(name)!;
          item.occurrences++;
          item.totalWeight += k.weight || 0;
          if (typeof k.rating === 'number' && k.rating > 0) {
            item.ratings.push(k.rating);
          }
        });
      }
    });

    const reportData = Array.from(kraMap.entries()).map(([kraName, stat]) => {
      const avgRating =
        stat.ratings.length > 0
          ? Number((stat.ratings.reduce((a, b) => a + b, 0) / stat.ratings.length).toFixed(2))
          : 0;
      const avgWeight =
        stat.occurrences > 0 ? Number((stat.totalWeight / stat.occurrences).toFixed(1)) : 0;

      return {
        kraName,
        occurrencesCount: stat.occurrences,
        averageWeightPercent: avgWeight,
        averageRating: avgRating,
        ratingCount: stat.ratings.length,
        masteryLevel:
          avgRating >= 4.2
            ? 'HIGH_PROFICIENCY'
            : avgRating >= 3.5
            ? 'COMPETENT'
            : avgRating >= 2.5
            ? 'MODERATE'
            : 'NEEDS_UPSKILLING',
      };
    });

    reportData.sort((a, b) => b.occurrencesCount - a.occurrencesCount);

    res.json({ reportData });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to generate KRA performance report.' });
  }
});

/**
 * 9. Comprehensive Audit Trail Report (Section 16.9)
 */
reportRouter.get('/reports/audit-trail', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { module, limit } = req.query;
    const auditCol = getDbCollection('auditLogs');
    let logs: AuditLog[] = await (await auditCol.find({})).toArray();

    if (module && module !== 'ALL') {
      logs = logs.filter((l) => l.module === module);
    }

    logs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const maxItems = limit ? parseInt(limit as string, 10) : 200;
    res.json({ logs: logs.slice(0, maxItems) });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch audit trail report.' });
  }
});
