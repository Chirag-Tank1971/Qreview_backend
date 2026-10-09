import { getDbCollection } from '../db.js';
import { Employee, EmployeeReview, PerformanceImprovementPlan, ReviewKraSnapshot } from '../../src/types/index.js';
import { ACTIVE_PIP_STATUSES } from './pipService.js';

export interface PipReviewGenerateResult {
  review?: EmployeeReview;
  created: boolean;
  skipped?: boolean;
  reason?: string;
}

/**
 * Maps PIP goals into immutable review KRA snapshots with balanced weights.
 */
function buildKraSnapshotFromGoals(goals: PerformanceImprovementPlan['goals']): ReviewKraSnapshot[] {
  if (!goals || goals.length === 0) {
    return [
      {
        id: `kra_fallback_${Date.now()}`,
        kraName: 'Performance Improvement Deliverables',
        title: 'Performance Improvement Deliverables',
        description: 'Achieve performance expectations outlined in PIP',
        targetSnapshot: '100% Target Met',
        weight: 100,
        rating: 0,
      },
    ];
  }

  const defaultWeight = Math.floor(100 / goals.length);
  const remainder = 100 - defaultWeight * goals.length;

  return goals.map((g, idx) => ({
    id: `kra_${g.id}`,
    kraId: g.id,
    kraName: g.description,
    title: g.description,
    description: g.description,
    targetSnapshot: g.targetMetric || '100% Target Met',
    weight: idx === 0 ? defaultWeight + remainder : defaultWeight,
    rating: 0,
  }));
}

/**
 * Generates the next due PIP review (either 7-day weekly cycle or final evaluation) for a plan.
 */
export async function generatePipReviewForPlan(
  pipId: string,
  options?: { forceType?: 'PIP_WEEKLY' | 'PIP_FINAL'; forceCycleNumber?: number }
): Promise<PipReviewGenerateResult> {
  const pipCol = getDbCollection('performanceImprovementPlans');
  const reviewCol = getDbCollection('employeeReviews');
  const empCol = getDbCollection('employees');

  const pip: PerformanceImprovementPlan | null = await pipCol.findOne({ id: pipId });
  if (!pip) {
    return { created: false, skipped: true, reason: 'PIP not found' };
  }

  if (!options?.forceType && !ACTIVE_PIP_STATUSES.includes(pip.status)) {
    return { created: false, skipped: true, reason: `PIP is not active (${pip.status})` };
  }

  const existingReviews: EmployeeReview[] = await reviewCol.find({ pipId: pip.id }).toArray();
  const now = Date.now();
  const isPastEndDate = now >= new Date(pip.endDate).getTime();

  const isFinal = options?.forceType === 'PIP_FINAL' || (isPastEndDate && !options?.forceType);
  const reviewType = isFinal ? 'PIP_FINAL' : 'PIP_WEEKLY';

  if (isFinal) {
    const existingFinal = existingReviews.find((r) => r.reviewType === 'PIP_FINAL');
    if (existingFinal) {
      return { review: existingFinal, created: false, skipped: true, reason: 'Final PIP review already exists' };
    }
  }

  let cycleNum = 1;
  if (!isFinal) {
    const elapsedDays = Math.max(0, Math.floor((now - new Date(pip.startDate).getTime()) / (24 * 60 * 60 * 1000)));
    const calculatedCycle = Math.floor(elapsedDays / 7) + 1;
    cycleNum = options?.forceCycleNumber || calculatedCycle;

    const existingForCycle = existingReviews.find((r) => r.reviewType === 'PIP_WEEKLY' && r.pipCycleNumber === cycleNum);
    if (existingForCycle) {
      return { review: existingForCycle, created: false, skipped: true, reason: `Week ${cycleNum} PIP review already exists` };
    }

    // Overlap protection: if any prior weekly review is still open, do not stack a new one
    const openWeeklyReview = existingReviews.find(
      (r) => r.reviewType === 'PIP_WEEKLY' && !r.isClosed && r.status !== 'CLOSED' && r.status !== 'HR_COMPLETED'
    );
    if (openWeeklyReview && !options?.forceType) {
      const managerId = pip.managerId || openWeeklyReview.managerId;
      if (managerId) {
        const notifCol = getDbCollection('notifications');
        // One reminder per skipped week, so the daily runner doesn't spam the manager
        const notifId = `notif_pip_skip_${pip.id}_w${cycleNum}`;
        if (!(await notifCol.findOne({ id: notifId }))) {
          await notifCol.insertOne({
            id: notifId,
            userId: managerId,
            userRole: 'MANAGER',
            type: 'DUE_SOON',
            title: `PIP Week ${cycleNum} review skipped`,
            message: `${pip.employeeName}'s ${openWeeklyReview.reviewPeriodName} is still open, so week ${cycleNum} was not generated. Complete the open review to resume weekly check-ins.`,
            isRead: false,
            priority: 'HIGH',
            metadata: { pipId: pip.id, reviewId: openWeeklyReview.id },
            createdAt: new Date().toISOString(),
          });
        }
      }
      return {
        created: false,
        skipped: true,
        reason: `Previous weekly review (${openWeeklyReview.reviewPeriodName}) is still pending evaluation. Review stacking prevented.`,
      };
    }
  }

  const emp: Employee | null = await empCol.findOne({ id: pip.employeeId });
  const kraSnapshot = buildKraSnapshotFromGoals(pip.goals);

  const periodKey = isFinal ? 'final' : `w${cycleNum}`;
  const reviewId = `rev_pip_${pip.id}_${periodKey}`;
  const periodName = isFinal ? 'PIP Final Review' : `PIP Week ${cycleNum} Review`;
  const timestamp = new Date().toISOString();

  const newReview: EmployeeReview = {
    id: reviewId,
    employeeId: emp?.id || pip.employeeId,
    employeeCode: emp?.employeeCode || pip.employeeCode,
    employeeName: emp?.name || pip.employeeName,
    employeeStatus: emp?.status || 'ACTIVE',
    departmentId: emp?.departmentId || pip.departmentId || 'general',
    departmentName: emp?.departmentName || pip.departmentName || 'General',
    designationName: emp?.designationName || pip.designationName || 'Specialist',
    reviewPeriodId: `period_${reviewId}`,
    reviewPeriodName: periodName,
    cycleId: emp?.cycleId || 'cycle_pip',
    cycleCode: 'PIP',
    cycleColor: '#d97706', // warm amber
    managerId: emp?.managerId || pip.managerId || '',
    managerName: emp?.managerName || pip.managerName || '',
    hodId: emp?.hodId || pip.hodId,
    hodName: emp?.hodName || pip.hodName,
    status: 'ASSIGNED',
    isSelfSubmitted: false,
    reviewType,
    pipId: pip.id,
    pipCycleNumber: isFinal ? undefined : cycleNum,
    kraSnapshot,
    actionHistory: [
      {
        id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        reviewId,
        action: 'ASSIGNED',
        performedBy: 'system',
        performedByName: 'Automated PIP Engine',
        performedByRole: 'SUPER_ADMIN',
        remarks: `${periodName} generated for ${emp?.name || pip.employeeName}`,
        performedAt: timestamp,
      },
    ],
    creationSource: 'AUTOMATIC',
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  await reviewCol.insertOne(newReview);

  // Send assignment notification to employee
  const notifCol = getDbCollection('notifications');
  await notifCol.insertOne({
    id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    userId: pip.employeeId,
    userRole: 'EMPLOYEE',
    type: 'SELF_ASSESSMENT',
    title: `${periodName} Ready`,
    message: `Your ${periodName.toLowerCase()} has been generated. Please review your goals and submit your self-assessment.`,
    isRead: false,
    priority: 'HIGH',
    metadata: { reviewId: newReview.id, pipId: pip.id },
    createdAt: timestamp,
  });

  return { review: newReview, created: true };
}

/**
 * Background runner: scans all active PIPs and generates due 7-day and final reviews.
 */
export async function generateDuePipReviews(): Promise<{ generatedCount: number; checkedCount: number }> {
  const pipCol = getDbCollection('performanceImprovementPlans');
  const activePips: PerformanceImprovementPlan[] = await pipCol
    .find({ status: { $in: ACTIVE_PIP_STATUSES } })
    .toArray();

  let generatedCount = 0;
  for (const pip of activePips) {
    try {
      const res = await generatePipReviewForPlan(pip.id);
      if (res.created) generatedCount++;
    } catch (err) {
      console.error(`[PipReviewService] Failed to generate review for PIP ${pip.id}:`, err);
    }
  }

  return { generatedCount, checkedCount: activePips.length };
}
