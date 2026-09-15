import { getDbCollection } from '../db.js';
import { recordAuditLog } from '../auth.js';
import {
  EmployeeReview,
  ReviewPeriod,
  ReviewKraSnapshot,
  ReviewAction,
  ReviewStatus,
  Employee,
  KraTemplate,
  Cycle,
  Appraisal,
} from '../../src/types.js';

export interface ReviewGenerationReport {
  periodId: string;
  periodName: string;
  totalEligible: number;
  createdCount: number;
  existingCount: number;
  skippedCount: number;
  exceptions: Array<{
    employeeId: string;
    employeeCode: string;
    employeeName: string;
    reason: string;
  }>;
}

/**
 * Idempotent automatic review generation engine
 * - Checks eligible active employees
 * - Verifies reporting manager presence (exceptions flagged, unassigned review NOT created)
 * - Verifies applicable KRA template presence
 * - Takes immutable snapshot of KRA items
 * - Idempotent via UNIQUE(employeeId, reviewPeriodId) check
 * - Sets status: MANAGER_PENDING
 * - Generates notifications and audit trail
 */
export async function generateQuarterlyReviews(
  reviewPeriodId: string,
  initiatedBy?: { id: string; name: string; role: string }
): Promise<ReviewGenerationReport> {
  const periodCol = getDbCollection('reviewPeriods');
  const empCol = getDbCollection('employees');
  const tmplCol = getDbCollection('kraTemplates');
  const cycleCol = getDbCollection('cycles');
  const reviewCol = getDbCollection('employeeReviews');
  const notifCol = getDbCollection('notifications');

  const period: ReviewPeriod | null = await periodCol.findOne({ id: reviewPeriodId });
  if (!period) {
    throw new Error(`Review period ${reviewPeriodId} not found.`);
  }

  // Active employees only
  const allEmployees: Employee[] = await (await empCol.find({})).toArray();
  const activeEmployees = allEmployees.filter((e) => e.status === 'ACTIVE');

  const allTemplates: KraTemplate[] = await (await tmplCol.find({})).toArray();
  const allCycles: Cycle[] = await (await cycleCol.find({})).toArray();
  const existingReviews: EmployeeReview[] = await (await reviewCol.find({ reviewPeriodId })).toArray();
  const existingMap = new Map<string, EmployeeReview>();
  existingReviews.forEach((r) => existingMap.set(r.employeeId, r));

  const report: ReviewGenerationReport = {
    periodId: period.id,
    periodName: period.name,
    totalEligible: activeEmployees.length,
    createdCount: 0,
    existingCount: 0,
    skippedCount: 0,
    exceptions: [],
  };

  const actorId = initiatedBy?.id || 'system';
  const actorName = initiatedBy?.name || 'System Scheduler';
  const actorRole = (initiatedBy?.role as any) || 'SUPER_ADMIN';

  for (const emp of activeEmployees) {
    // 1. Check idempotency: Already generated for this period?
    if (existingMap.has(emp.id)) {
      report.skippedCount++;
      continue;
    }

    // 2. Business Rule: Employee MUST have a reporting manager.
    // If employee has no manager -> Do NOT create an unassigned review! Flag exception.
    if (!emp.managerId && !emp.hodId) {
      report.exceptions.push({
        employeeId: emp.id,
        employeeCode: emp.employeeCode,
        employeeName: emp.name,
        reason: 'Missing reporting manager or HOD assignment.',
      });
      continue;
    }

    // 3. Find applicable KRA Template
    let template = allTemplates.find((t) => t.id === emp.currentKraTemplateId);
    if (!template && emp.designationId) {
      template = allTemplates.find((t) => t.designationId === emp.designationId && t.active !== false);
    }
    if (!template && emp.departmentId) {
      template = allTemplates.find((t) => t.departmentId === emp.departmentId && t.active !== false);
    }
    if (!template && allTemplates.length > 0) {
      template = allTemplates.find((t) => t.active !== false) || allTemplates[0];
    }

    if (!template || !template.items || template.items.length === 0) {
      report.exceptions.push({
        employeeId: emp.id,
        employeeCode: emp.employeeCode,
        employeeName: emp.name,
        reason: 'No applicable active KRA template found.',
      });
      continue;
    }

    // 4. Determine appraisal cycle & whether appraisal month falls in this quarter
    const empCycle = allCycles.find((c) => c.id === emp.cycleId || c.code === emp.cycleCode);
    const appraisalMonth = empCycle ? empCycle.appraisalMonth : 1;
    const quarterMonths = [
      (period.quarter - 1) * 3 + 1,
      (period.quarter - 1) * 3 + 2,
      period.quarter * 3,
    ];
    const isAppraisalMonthDue = quarterMonths.includes(appraisalMonth);

    // 5. Build IMMUTABLE KRA snapshot (Snapshot Rule)
    const kraSnapshot: ReviewKraSnapshot[] = template.items.map((item, idx) => ({
      id: `snap_${Date.now()}_${idx}_${Math.random().toString(36).substring(2, 7)}`,
      kraId: item.kraId,
      kraName: item.title || item.kraName || `KRA ${idx + 1}`,
      title: item.title || item.kraName || `KRA ${idx + 1}`,
      description: item.description || '',
      targetSnapshot: item.target || 'Meet quarterly target SLA',
      measurementCriteria: item.measurementCriteria || '1: Unsatisfactory | 3: Meets Expectations | 5: Exceptional',
      weight: Number(item.weight) || 0,
      achievement: '',
      rating: 0,
      comments: '',
    }));

    const reviewId = `rev_${period.year}_q${period.quarter}_${emp.id}_${Date.now().toString(36).substring(2, 6)}`;
    const now = new Date().toISOString();

    const action: ReviewAction = {
      id: `act_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      reviewId,
      action: 'ASSIGNED',
      performedBy: actorId,
      performedByName: actorName,
      performedByRole: actorRole,
      remarks: `Automated quarterly review generated for ${period.name}`,
      performedAt: now,
    };

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
      managerId: emp.managerId || emp.hodId || '',
      managerName: emp.managerName || emp.hodName || 'Assigned Manager',
      hodId: emp.hodId,
      hodName: emp.hodName,
      status: 'MANAGER_PENDING',
      finalScore: 0,
      kraSnapshot,
      actionHistory: [action],
      isClosed: false,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await reviewCol.insertOne(newReview);
      report.createdCount++;
    } catch (insertErr: any) {
      if (insertErr.code === 11000 || String(insertErr.message).includes('E11000')) {
        report.existingCount++;
        continue;
      }
      throw insertErr;
    }

    // Notify Reporting Manager
    if (newReview.managerId) {
      await notifCol.insertOne({
        id: `notif_${reviewId}_assigned`,
        userId: newReview.managerId,
        userRole: 'MANAGER',
        type: 'REVIEW_ASSIGNED',
        title: `New Quarterly Review Assigned: ${emp.name}`,
        message: `Quarterly review for ${emp.name} (${period.name}) has been generated and is awaiting your evaluation.`,
        isRead: false,
        priority: 'MEDIUM',
        metadata: { reviewId, periodId: period.id },
        createdAt: now,
      });
    }

    // Notify Employee about pending Self-Assessment
    await notifCol.insertOne({
      id: `notif_self_assess_${reviewId}`,
      userId: emp.id,
      userRole: 'EMPLOYEE',
      type: 'REVIEW_ASSIGNED',
      title: `Self-Assessment Due: ${period.name}`,
      message: `Your quarterly performance self-assessment for ${period.name} is open. Please complete your KRA self-ratings and submit your evaluation.`,
      isRead: false,
      priority: 'HIGH',
      metadata: { reviewId, periodId: period.id, subTab: 'reviews', openSelfAssess: true },
      createdAt: now,
    });

    // Audit log
    await recordAuditLog(
      actorId,
      actorName,
      actorRole,
      'EMPLOYEE_REVIEWS',
      'REVIEW_CREATED',
      reviewId,
      '',
      'MANAGER_PENDING',
      `Created quarterly review for ${emp.name} (${emp.employeeCode}) in period ${period.name}`
    );
  }

  return report;
}

/**
 * Server-side weighted score calculator
 * Weighted Score = SUM(KRA Rating * KRA Weight) / 100
 */
export function calculateWeightedScore(kraSnapshot: ReviewKraSnapshot[]): number {
  if (!kraSnapshot || kraSnapshot.length === 0) return 0;
  const total = kraSnapshot.reduce((sum, item) => {
    const rating = Number(item.rating) || 0;
    const weight = Number(item.weight) || 0;
    return sum + (rating * weight);
  }, 0);
  return Number((total / 100).toFixed(2));
}

/**
 * Manager saves draft of review
 */
export async function saveManagerDraft(
  reviewId: string,
  payload: {
    kraSnapshot?: any[];
    kraRatings?: any[];
    strengths?: string;
    improvements?: string;
    managerOverallComments?: string;
  },
  user: { id: string; name: string; role: any; employeeId?: string }
): Promise<EmployeeReview> {
  const reviewCol = getDbCollection('employeeReviews');
  const review: EmployeeReview | null = await reviewCol.findOne({ id: reviewId });
  if (!review) {
    throw new Error('Review not found.');
  }
  if (review.isClosed) {
    throw new Error('This review is closed and cannot be modified.');
  }

  // Ownership verification
  const isManager = review.managerId === user.employeeId;
  const isSuperAdminOrHr = user.role === 'SUPER_ADMIN' || user.role === 'HR';
  if (!isManager && !isSuperAdminOrHr) {
    throw new Error('Forbidden: You are not authorized to edit this review.');
  }

  let finalScore = review.finalScore || 0;
  let updatedSnapshot = review.kraSnapshot;

  const incomingKras = payload.kraSnapshot || payload.kraRatings;
  if (incomingKras && Array.isArray(incomingKras)) {
    updatedSnapshot = (review.kraSnapshot || []).map((existingKra) => {
      const incoming = incomingKras.find(
        (k: any) =>
          k.id === existingKra.id ||
          k.kraId === existingKra.kraId ||
          k.kraName === existingKra.kraName ||
          k.title === existingKra.title
      );
      if (incoming) {
        return {
          ...existingKra,
          rating: Number(incoming.rating) || 0,
          achievement: incoming.achievement || '',
          comments: incoming.comments || '',
          issueReason: incoming.issueReason || '',
        };
      }
      return existingKra;
    });
    finalScore = calculateWeightedScore(updatedSnapshot);
  }

  const now = new Date().toISOString();
  const action: ReviewAction = {
    id: `act_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    reviewId,
    action: 'DRAFT_SAVED',
    performedBy: user.id,
    performedByName: user.name,
    performedByRole: user.role,
    remarks: 'Manager saved review draft',
    performedAt: now,
  };

  const updated: EmployeeReview = {
    ...review,
    kraSnapshot: updatedSnapshot,
    finalScore,
    strengths: payload.strengths !== undefined ? payload.strengths : review.strengths,
    improvements: payload.improvements !== undefined ? payload.improvements : review.improvements,
    managerOverallComments:
      payload.managerOverallComments !== undefined ? payload.managerOverallComments : review.managerOverallComments,
    actionHistory: [...(review.actionHistory || []), action],
    updatedAt: now,
  };

  await reviewCol.updateOne({ id: reviewId }, { $set: updated });
  await recordAuditLog(
    user.id,
    user.name,
    user.role,
    'EMPLOYEE_REVIEWS',
    'REVIEW_DRAFT_SAVED',
    reviewId,
    String(review.finalScore || 0),
    String(finalScore),
    `Saved draft scores for ${review.employeeName}`
  );

  return updated;
}

/**
 * Manager submits review
 * Validates ratings (1-5), calculates weighted score, transitions:
 * MANAGER_COMPLETED -> HR_PENDING
 */
export async function submitManagerReview(
  reviewId: string,
  payload: {
    kraSnapshot?: any[];
    kraRatings?: any[];
    strengths?: string;
    improvements?: string;
    managerOverallComments?: string;
  },
  user: { id: string; name: string; role: any; employeeId?: string }
): Promise<EmployeeReview> {
  const reviewCol = getDbCollection('employeeReviews');
  const review: EmployeeReview | null = await reviewCol.findOne({ id: reviewId });
  if (!review) {
    throw new Error('Review not found.');
  }
  if (review.isClosed) {
    throw new Error('This review is closed and cannot be modified.');
  }

  // Ownership verification
  const isManager = review.managerId === user.employeeId;
  const isSuperAdminOrHr = user.role === 'SUPER_ADMIN' || user.role === 'HR';
  if (!isManager && !isSuperAdminOrHr) {
    throw new Error('Forbidden: Only the designated reporting manager can submit this review.');
  }

  let updatedSnapshot = review.kraSnapshot || [];
  const incomingKras = payload.kraSnapshot || payload.kraRatings;
  if (incomingKras && Array.isArray(incomingKras)) {
    updatedSnapshot = (review.kraSnapshot || []).map((existingKra) => {
      const incoming = incomingKras.find(
        (k: any) =>
          k.id === existingKra.id ||
          k.kraId === existingKra.kraId ||
          k.kraName === existingKra.kraName ||
          k.title === existingKra.title
      );
      if (incoming) {
        return {
          ...existingKra,
          rating: Number(incoming.rating) || 0,
          achievement: incoming.achievement || '',
          comments: incoming.comments || '',
          issueReason: incoming.issueReason || '',
        };
      }
      return existingKra;
    });
  }

  // Strict Validation: ratings must be between 1 and 5
  for (const kra of updatedSnapshot) {
    if (!kra.rating || kra.rating < 1 || kra.rating > 5) {
      throw new Error(`KRA "${kra.kraName || kra.title}" must have a valid rating between 1 and 5.`);
    }
  }

  const finalScore = calculateWeightedScore(updatedSnapshot);
  const now = new Date().toISOString();

  const nextStatus: ReviewStatus = 'HR_PENDING';

  const action: ReviewAction = {
    id: `act_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    reviewId,
    action: 'SUBMITTED',
    performedBy: user.id,
    performedByName: user.name,
    performedByRole: user.role,
    remarks: `Reporting manager submitted review with final weighted score ${finalScore}. Transitioned to ${nextStatus}.`,
    performedAt: now,
  };

  const updated: EmployeeReview = {
    ...review,
    kraSnapshot: updatedSnapshot,
    finalScore,
    strengths: payload.strengths !== undefined ? payload.strengths : review.strengths,
    improvements: payload.improvements !== undefined ? payload.improvements : review.improvements,
    managerOverallComments:
      payload.managerOverallComments !== undefined ? payload.managerOverallComments : review.managerOverallComments,
    status: nextStatus,
    submittedAt: now,
    actionHistory: [...(review.actionHistory || []), action],
    updatedAt: now,
  };

  await reviewCol.updateOne({ id: reviewId }, { $set: updated });

  // Notify HR and auto-resolve previous return/assignment notifications
  const notifCol = getDbCollection('notifications');
  await notifCol.updateMany(
    {
      'metadata.reviewId': reviewId,
      type: { $in: ['RETURNED', 'REVIEW_ASSIGNED'] },
      isRead: false,
    },
    { $set: { isRead: true } }
  );
  await notifCol.insertOne({
    id: `notif_${reviewId}_hr_pending_${Date.now()}`,
    userId: 'ALL',
    userRole: 'HR',
    type: 'MANAGER_SUBMITTED',
    title: `Review Ready for HR Approval: ${review.employeeName}`,
    message: `${user.name} submitted performance review for ${review.employeeName} (${review.reviewPeriodName}) with score ${finalScore}.`,
    isRead: false,
    priority: 'HIGH',
    metadata: { reviewId, periodId: review.reviewPeriodId, status: 'HR_PENDING' },
    createdAt: now,
  });

  await recordAuditLog(
    user.id,
    user.name,
    user.role,
    'EMPLOYEE_REVIEWS',
    'REVIEW_SUBMITTED',
    reviewId,
    review.status,
    nextStatus,
    `Submitted review for ${review.employeeName} with final score: ${finalScore}`
  );

  return updated;
}

/**
 * HR returns review to manager
 * STRICT RULE: Return reason is MANDATORY
 * Transitions: HR_PENDING -> RETURNED -> MANAGER_PENDING
 */
export async function returnReview(
  reviewId: string,
  reason: string,
  user: { id: string; name: string; role: any }
): Promise<EmployeeReview> {
  if (user.role !== 'SUPER_ADMIN' && user.role !== 'HR') {
    throw new Error('Forbidden: Only HR or Super Admin can return a review.');
  }

  if (!reason || !reason.trim()) {
    throw new Error('Return reason is mandatory. Please provide specific feedback for the manager.');
  }

  const reviewCol = getDbCollection('employeeReviews');
  const review: EmployeeReview | null = await reviewCol.findOne({ id: reviewId });
  if (!review) {
    throw new Error('Review not found.');
  }
  if (review.isClosed) {
    throw new Error('Cannot return a closed review.');
  }

  const now = new Date().toISOString();
  const action: ReviewAction = {
    id: `act_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    reviewId,
    action: 'RETURNED',
    performedBy: user.id,
    performedByName: user.name,
    performedByRole: user.role,
    remarks: `Returned by HR: ${reason.trim()}`,
    performedAt: now,
  };

  const updated: EmployeeReview = {
    ...review,
    status: 'RETURNED',
    actionHistory: [...(review.actionHistory || []), action],
    updatedAt: now,
  };

  await reviewCol.updateOne({ id: reviewId }, { $set: updated });

  // Auto-resolve pending manager submissions since review is returned
  const notifCol = getDbCollection('notifications');
  await notifCol.updateMany(
    {
      'metadata.reviewId': reviewId,
      type: { $in: ['MANAGER_SUBMITTED', 'HOD_APPROVED'] },
      isRead: false,
    },
    { $set: { isRead: true } }
  );

  // Notify Reporting Manager
  if (review.managerId) {
    await notifCol.insertOne({
      id: `notif_${reviewId}_returned_${Date.now()}`,
      userId: review.managerId,
      userRole: 'MANAGER',
      type: 'RETURNED',
      title: `Review Returned by HR: ${review.employeeName}`,
      message: `HR returned review for ${review.employeeName}. Reason: ${reason.trim()}`,
      isRead: false,
      priority: 'HIGH',
      metadata: { reviewId, periodId: review.reviewPeriodId, reason: reason.trim() },
      createdAt: now,
    });
  }

  await recordAuditLog(
    user.id,
    user.name,
    user.role,
    'EMPLOYEE_REVIEWS',
    'REVIEW_RETURNED',
    reviewId,
    review.status,
    'RETURNED',
    `Review returned to manager for ${review.employeeName}. Reason: ${reason.trim()}`
  );

  return updated;
}

/**
 * HR completes and closes review
 * Transitions: HR_PENDING -> HR_COMPLETED -> CLOSED
 * Locks record against further edits
 */
export async function completeHRReview(
  reviewId: string,
  hrComments: string,
  user: { id: string; name: string; role: any }
): Promise<EmployeeReview> {
  if (user.role !== 'SUPER_ADMIN' && user.role !== 'HR') {
    throw new Error('Forbidden: Only HR or Super Admin can complete a review.');
  }

  const reviewCol = getDbCollection('employeeReviews');
  const review: EmployeeReview | null = await reviewCol.findOne({ id: reviewId });
  if (!review) {
    throw new Error('Review not found.');
  }
  if (review.isClosed) {
    throw new Error('Review is already closed.');
  }

  const now = new Date().toISOString();
  const action: ReviewAction = {
    id: `act_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    reviewId,
    action: 'APPROVED',
    performedBy: user.id,
    performedByName: user.name,
    performedByRole: user.role,
    remarks: hrComments ? `Completed and closed by HR: ${hrComments}` : 'Completed and permanently closed by HR.',
    performedAt: now,
  };

  const updated: EmployeeReview = {
    ...review,
    status: 'CLOSED',
    isClosed: true,
    completedAt: now,
    hrComments: hrComments !== undefined ? hrComments : review.hrComments,
    actionHistory: [...(review.actionHistory || []), action],
    updatedAt: now,
  };

  await reviewCol.updateOne({ id: reviewId }, { $set: updated });

  // Auto-resolve all prior pending review notifications (HR pending, returns, assignments)
  const notifCol = getDbCollection('notifications');
  await notifCol.updateMany(
    {
      'metadata.reviewId': reviewId,
      type: { $in: ['MANAGER_SUBMITTED', 'HOD_ACTION_REQUIRED', 'HOD_APPROVED', 'RETURNED', 'REVIEW_ASSIGNED'] },
      isRead: false,
    },
    { $set: { isRead: true } }
  );

  // Notify Employee and Manager
  await notifCol.insertOne({
    id: `notif_${reviewId}_closed_${Date.now()}`,
    userId: review.employeeId,
    userRole: 'EMPLOYEE',
    type: 'HR_COMPLETED',
    title: `Quarterly Review Closed: ${review.reviewPeriodName}`,
    message: `Your quarterly performance review for ${review.reviewPeriodName} has been officially approved and closed with final score ${review.finalScore}.`,
    isRead: false,
    priority: 'MEDIUM',
    metadata: { reviewId, periodId: review.reviewPeriodId },
    createdAt: now,
  });

  await recordAuditLog(
    user.id,
    user.name,
    user.role,
    'EMPLOYEE_REVIEWS',
    'REVIEW_CLOSED',
    reviewId,
    review.status,
    'CLOSED',
    `Permanently closed quarterly review for ${review.employeeName} (Final Score: ${review.finalScore})`
  );

  return updated;
}
