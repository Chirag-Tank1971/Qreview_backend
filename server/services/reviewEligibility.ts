import {
  Employee,
  ReviewPeriod,
  SystemConfig,
  KraTemplate,
  Cycle,
  EmployeeReview,
  ReviewKraSnapshot,
  ReviewAction,
  UserRole,
} from '../../src/types/index.js';
import { getDbCollection } from '../db.js';
import { recordAuditLog } from '../auth.js';

export interface ReviewEligibilityResult {
  eligible: boolean;
  canInitiateManually: boolean;
  requiresManualOverride: boolean;
  tenureDays: number;
  minTenureDays: number;
  reason?: string;
  checks: {
    statusActive: boolean;
    hasManager: boolean;
    hasKraTemplate: boolean;
    alreadyHasReview: boolean;
    periodActiveOrUpcoming: boolean;
    tenureMet: boolean;
  };
}

export interface CreateQuarterlyReviewOptions {
  emp: Employee;
  period: ReviewPeriod;
  template?: KraTemplate | null;
  source: 'AUTOMATIC' | 'MANUAL';
  initiatedBy?: { id: string; name: string; role: UserRole };
  manualOverrideReason?: string;
}

/**
 * Calculate tenure days for an employee relative to a quarterly review period.
 * 
 * Rules:
 * 1. If joining date is after the period end date -> 0 days (joined in future quarter).
 * 2. If joining date is on or before period start date -> Full quarter tenure (from start to end).
 * 3. If joining date is within the quarter (startDate < joiningDate <= endDate) ->
 *    Tenure is measured from joiningDate to period endDate (inclusive).
 */
export function calculatePeriodTenureDays(
  joiningDateStr?: string,
  periodStartDateStr?: string,
  periodEndDateStr?: string
): number {
  if (!joiningDateStr || !periodEndDateStr) {
    return 0;
  }

  const joining = new Date(joiningDateStr);
  const end = new Date(periodEndDateStr);

  if (isNaN(joining.getTime()) || isNaN(end.getTime())) {
    return 0;
  }

  // Joined after the quarter ended
  if (joining.getTime() > end.getTime()) {
    return 0;
  }

  // Check if joined before or on the period start date
  if (periodStartDateStr) {
    const start = new Date(periodStartDateStr);
    if (!isNaN(start.getTime()) && joining.getTime() <= start.getTime()) {
      const fullDiffMs = end.getTime() - start.getTime();
      return Math.floor(fullDiffMs / (1000 * 60 * 60 * 24)) + 1;
    }
  }

  // Joined during the quarter: calculate days from joining date to period end date (inclusive)
  const diffMs = end.getTime() - joining.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24)) + 1;
  return Math.max(0, diffDays);
}

/**
 * Check review eligibility for an employee in a given review period against system config.
 */
export async function checkEmployeeReviewEligibility(
  emp: Employee,
  period: ReviewPeriod,
  cachedConfig?: SystemConfig | null
): Promise<ReviewEligibilityResult> {
  const reviewsCol = getDbCollection('employeeReviews');
  const templatesCol = getDbCollection('kraTemplates');
  const configCol = getDbCollection('systemConfig');

  let config = cachedConfig;
  if (!config) {
    try {
      config = await configCol.findOne({ id: 'global_config' });
    } catch {
      // Fallback if not loaded
    }
  }

  const minTenureDays = config?.minTenureDaysForReview ?? 30;
  const includeProbation = config?.includeProbationInReviews ?? true;

  // 1. Status check
  const statusActive = emp.status === 'ACTIVE' || (includeProbation && emp.status === 'PROBATION');

  // 2. Manager check
  const hasManager = Boolean(emp.managerId || emp.hodId);

  // 3. Existing review check
  const existingReview = await reviewsCol.findOne({
    employeeId: emp.id,
    reviewPeriodId: period.id,
  });
  const alreadyHasReview = Boolean(existingReview);

  // 4. KRA Template check
  let hasKraTemplate = false;
  try {
    const allTemplates: KraTemplate[] = await (await templatesCol.find({})).toArray();
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
    hasKraTemplate = Boolean(template && template.items && template.items.length > 0);
  } catch {
    hasKraTemplate = false;
  }

  // 5. Period status check
  const periodActiveOrUpcoming = period.status === 'ACTIVE' || period.status === 'UPCOMING';

  // 6. Tenure check
  const empAny = emp as any;
  const joiningDate = emp.joiningDate || empAny.dateOfJoining;
  const tenureDays = calculatePeriodTenureDays(joiningDate, period.startDate, period.endDate);
  const tenureMet = tenureDays >= minTenureDays;

  // Automatic eligibility: All core checks pass + period is ACTIVE + tenureMet
  const coreEligible = statusActive && hasManager && hasKraTemplate && !alreadyHasReview;
  const eligible = coreEligible && period.status === 'ACTIVE' && tenureMet;

  // Can manual override: Core checks pass + period is active or upcoming
  const canInitiateManually = coreEligible && periodActiveOrUpcoming;
  const requiresManualOverride = canInitiateManually && !tenureMet;

  let reason: string | undefined;
  if (alreadyHasReview) {
    reason = 'A review already exists for this employee in this review period.';
  } else if (!statusActive) {
    reason = `Employee status (${emp.status}) is not eligible for reviews.`;
  } else if (!hasManager) {
    reason = 'Employee has no reporting manager or HOD assigned.';
  } else if (!hasKraTemplate) {
    reason = 'No active KRA template found for this employee.';
  } else if (!periodActiveOrUpcoming) {
    reason = `Review period status is ${period.status}; must be ACTIVE or UPCOMING.`;
  } else if (!tenureMet) {
    reason = `Tenure within quarter is ${tenureDays} days, which is less than the required ${minTenureDays} days.`;
  }

  return {
    eligible,
    canInitiateManually,
    requiresManualOverride,
    tenureDays,
    minTenureDays,
    reason,
    checks: {
      statusActive,
      hasManager,
      hasKraTemplate,
      alreadyHasReview,
      periodActiveOrUpcoming,
      tenureMet,
    },
  };
}

/**
 * Create a quarterly performance review record with KRA snapshot, notifications, and audit logging.
 * Reusable for both AUTOMATIC and MANUAL initiation flows.
 */
export async function createQuarterlyReview(options: CreateQuarterlyReviewOptions): Promise<EmployeeReview> {
  const { emp, period, template: providedTemplate, source, initiatedBy, manualOverrideReason } = options;

  const reviewsCol = getDbCollection('employeeReviews');
  const templatesCol = getDbCollection('kraTemplates');
  const cyclesCol = getDbCollection('cycles');
  const notifCol = getDbCollection('notifications');
  const configCol = getDbCollection('systemConfig');

  // 1. Validate uniqueness: Check if review already exists
  const existing = await reviewsCol.findOne({
    employeeId: emp.id,
    reviewPeriodId: period.id,
  });
  if (existing) {
    throw new Error(`A review record already exists for ${emp.name} in ${period.name}.`);
  }

  // 2. Validate Manager
  if (!emp.managerId && !emp.hodId) {
    throw new Error(`Employee ${emp.name} (${emp.employeeCode}) has no reporting manager or HOD assigned.`);
  }

  // 3. Validate Status
  let config: SystemConfig | null = null;
  try {
    config = await configCol.findOne({ id: 'global_config' });
  } catch {
    // optional fallback
  }
  const includeProbation = config?.includeProbationInReviews ?? true;
  if (emp.status !== 'ACTIVE' && (!includeProbation || emp.status !== 'PROBATION')) {
    throw new Error(`Cannot initiate review: Employee status is ${emp.status}. Only ACTIVE or PROBATION employees are eligible.`);
  }

  // 4. Validate Tenure & Manual Reason
  const empAny = emp as any;
  const joiningDate = emp.joiningDate || empAny.dateOfJoining;
  const tenureDays = calculatePeriodTenureDays(joiningDate, period.startDate, period.endDate);
  const minTenureDays = config?.minTenureDaysForReview ?? 30;

  if (source === 'AUTOMATIC' && tenureDays < minTenureDays) {
    throw new Error(
      `Automatic review creation failed: Tenure in quarter is ${tenureDays} days (< ${minTenureDays} days required).`
    );
  }

  if (source === 'MANUAL' && tenureDays < minTenureDays) {
    if (!manualOverrideReason || manualOverrideReason.trim().length === 0) {
      throw new Error(
        `A justification reason is mandatory when manually initiating a review for an employee with tenure under ${minTenureDays} days.`
      );
    }
  }

  // 5. Resolve KRA Template
  let template = providedTemplate;
  if (!template) {
    const allTemplates: KraTemplate[] = await (await templatesCol.find({})).toArray();
    template = allTemplates.find((t) => t.id === emp.currentKraTemplateId);
    if (!template && emp.designationId) {
      template = allTemplates.find((t) => t.designationId === emp.designationId && t.active !== false);
    }
    if (!template && emp.departmentId) {
      template = allTemplates.find((t) => t.departmentId === emp.departmentId && t.active !== false);
    }
    if (!template && allTemplates.length > 0) {
      template = allTemplates.find((t) => t.active !== false) || allTemplates[0];
    }
  }

  const defaultItems = [
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
  ];

  const rawItems = (template && template.items && template.items.length > 0) ? template.items : defaultItems;

  // 6. Build immutable KRA snapshot
  const kraSnapshot: ReviewKraSnapshot[] = rawItems.map((item: any, idx: number) => ({
    id: `snap_${Date.now()}_${idx}_${Math.random().toString(36).substr(2, 6)}`,
    kraId: item.kraId || item.id,
    kraName: item.title || item.kraName || `KRA ${idx + 1}`,
    title: item.title || item.kraName || `KRA ${idx + 1}`,
    description: item.description || '',
    targetSnapshot: item.target || item.targetSnapshot || 'Meet quarterly targets',
    weight: item.weight || 25,
    measurementCriteria: item.measurementCriteria || '',
    rating: 0,
    selfRating: 0,
    comments: '',
    selfComments: '',
  }));

  // 7. Cycle & Appraisal month mapping
  const allCycles: Cycle[] = await (await cyclesCol.find({})).toArray();
  const empCycle = allCycles.find((c) => c.id === emp.cycleId || c.code === emp.cycleCode);
  const appraisalMonth = empCycle ? empCycle.appraisalMonth : 1;
  const cycleQuarter = Math.ceil(appraisalMonth / 3);
  const isAppraisalQuarter = period.quarter === cycleQuarter;

  const reviewId = `rev_${period.id}_${emp.id}`;
  const now = new Date().toISOString();

  const actorId = initiatedBy?.id || 'system';
  const actorName = initiatedBy?.name || (source === 'MANUAL' ? 'Admin Override' : 'System Automated');
  const actorRole: UserRole = initiatedBy?.role || 'SUPER_ADMIN';

  const action: ReviewAction = {
    id: `act_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    reviewId,
    action: 'ASSIGNED',
    performedBy: actorId,
    performedByName: actorName,
    performedByRole: actorRole,
    remarks:
      source === 'MANUAL'
        ? `Manual review initiated for ${period.name}.${manualOverrideReason ? ` Reason: ${manualOverrideReason}` : ''}`
        : `Automated quarterly review generated for ${period.name}`,
    performedAt: now,
  };

  const newReview: EmployeeReview = {
    id: reviewId,
    employeeId: emp.id,
    employeeCode: emp.employeeCode,
    employeeName: emp.name,
    departmentId: emp.departmentId,
    departmentName: emp.departmentName || 'Department',
    designationName: emp.designationName || 'Designation',
    managerId: emp.managerId || emp.hodId || '',
    managerName: emp.managerName || emp.hodName || '',
    hodId: emp.hodId,
    hodName: emp.hodName,
    cycleId: emp.cycleId,
    cycleCode: emp.cycleCode || empCycle?.code || 'A',
    cycleColor: emp.cycleColor || empCycle?.colorHex || '#1e3a8a',
    reviewPeriodId: period.id,
    reviewPeriodName: period.name,
    isAppraisalMonthDue: isAppraisalQuarter,
    kraSnapshot,
    actionHistory: [action],
    status: 'ASSIGNED',
    isSelfSubmitted: false,
    finalScore: 0,
    selfScore: 0,
    strengths: '',
    improvements: '',
    managerOverallComments: '',
    isClosed: false,
    creationSource: source,
    manualOverrideReason: manualOverrideReason?.trim() || undefined,
    initiatedBy: initiatedBy ? `${initiatedBy.name} (${initiatedBy.role})` : undefined,
    createdAt: now,
    updatedAt: now,
  };

  await reviewsCol.insertOne(newReview);

  // 8. Notifications
  try {
    // Notify employee of self-assessment due (upsert to prevent duplicate alerts)
    await notifCol.updateOne(
      { id: `notif_self_assess_${newReview.id}` },
      {
        $set: {
          id: `notif_self_assess_${newReview.id}`,
          userId: emp.id,
          userRole: 'EMPLOYEE',
          type: 'REVIEW_ASSIGNED',
          title: `Self-Assessment Due: ${period.name}`,
          message: `Your quarterly performance self-assessment for ${period.name} is open. Please complete your KRA self-ratings and submit your evaluation.`,
          isRead: false,
          priority: 'HIGH',
          metadata: { reviewId: newReview.id, periodId: period.id, subTab: 'reviews', openSelfAssess: true },
          createdAt: now,
        },
      },
      { upsert: true }
    );

    // If manually initiated, also notify reporting manager (upsert to prevent duplicate alerts)
    if (source === 'MANUAL' && (emp.managerId || emp.hodId)) {
      const targetMgrId = emp.managerId || emp.hodId;
      if (targetMgrId && targetMgrId !== initiatedBy?.id) {
        await notifCol.updateOne(
          { id: `notif_mgr_review_${newReview.id}` },
          {
            $set: {
              id: `notif_mgr_review_${newReview.id}`,
              userId: targetMgrId,
              userRole: 'MANAGER',
              type: 'REVIEW_ASSIGNED',
              title: `Quarterly Review Initiated: ${emp.name}`,
              message: `A quarterly review for ${emp.name} (${period.name}) has been initiated by ${actorName}.`,
              isRead: false,
              priority: 'NORMAL',
              metadata: { reviewId: newReview.id, periodId: period.id, subTab: 'reviews' },
              createdAt: now,
            },
          },
          { upsert: true }
        );
      }
    }
  } catch (_notifErr) {
    // quiet fallback for notifications
  }

  // 9. Audit Logging (for manual initiation)
  if (source === 'MANUAL') {
    try {
      await recordAuditLog(
        actorId,
        actorName,
        actorRole,
        'QUARTERLY_REVIEW',
        'MANUAL_REVIEW_INITIATED',
        reviewId,
        '',
        JSON.stringify({ status: 'ASSIGNED', reviewPeriodId: period.id, creationSource: 'MANUAL' }),
        `Manual review initiated for ${emp.name} (${emp.employeeCode}). Reason: ${manualOverrideReason || 'Not provided'}. Tenure: ${tenureDays} days.`
      );
    } catch (_auditErr) {
      // quiet fallback for audit
    }
  }

  return newReview;
}
