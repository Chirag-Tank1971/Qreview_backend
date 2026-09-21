import { getDbCollection } from './db.js';
import {
  Employee,
  EmployeeReview,
  Appraisal,
  ReviewPeriod,
  KraTemplate,
  Cycle,
  ReviewKraSnapshot,
  AppraisalQuarterRecord,
} from '../src/types/index.js';
import {
  checkEmployeeReviewEligibility,
  createQuarterlyReview,
  buildKraSnapshotFromTemplate,
} from './services/reviewEligibility.js';

/**
 * Synchronize appraisal & quarterly review records for a single employee
 */
export async function syncEmployeeAppraisalsAndReviews(emp: Employee) {
  try {
    const reviewsCol = getDbCollection('employeeReviews');
    const appraisalsCol = getDbCollection('appraisals');
    const periodsCol = getDbCollection('reviewPeriods');
    const cyclesCol = getDbCollection('cycles');

    const allPeriods: ReviewPeriod[] = await (await periodsCol.find({})).toArray();
    const allCycles: Cycle[] = await (await cyclesCol.find({})).toArray();

    const empCycle = allCycles.find((c) => c.id === emp.cycleId || c.code === emp.cycleCode);

    // 1. Ensure KRA reviews exist for all review periods
    for (const period of allPeriods) {
      const existingReview = await reviewsCol.findOne({
        employeeId: emp.id,
        reviewPeriodId: period.id,
      });

      if (existingReview) {
        // CRITICAL HISTORICAL IMMUTABILITY:
        // Finalized and closed reviews must NEVER be overwritten simply because employee
        // changed department, designation, or reporting manager.
        if (existingReview.isClosed || existingReview.status === 'CLOSED') {
          continue;
        }

        // For open / unsubmitted / editable reviews only, sync manager/hod/department fields
        await reviewsCol.updateOne(
          { id: existingReview.id },
          {
            $set: {
              employeeCode: emp.employeeCode,
              employeeName: emp.name,
              departmentId: emp.departmentId,
              departmentName: emp.departmentName || 'Department',
              designationName: emp.designationName || 'Designation',
              managerId: emp.managerId || '',
              managerName: emp.managerName || '',
              hodId: emp.hodId,
              hodName: emp.hodName,
              cycleId: emp.cycleId,
              cycleCode: emp.cycleCode || empCycle?.code || 'N/A',
              cycleColor: emp.cycleColor || empCycle?.colorHex || '#64748b',
              updatedAt: new Date().toISOString(),
            },
          }
        );
      } else if (period.status === 'ACTIVE') {
        // ONLY generate a new review if employee is eligible under system rules (minimum tenure, manager, status)
        const eligibility = await checkEmployeeReviewEligibility(emp, period);
        if (eligibility.eligible) {
          try {
            await createQuarterlyReview({
              emp,
              period,
              source: 'AUTOMATIC',
            });
          } catch (_createErr) {
            // quiet fallback if already created concurrently
          }
        }
      }
    }

    // 2. Annual Appraisal records:
    // Only update master employee metadata for EXISTING unlocked appraisals.
    // Appraisals must NEVER be created automatically on employee save — they are initiated exclusively
    // by HR/Super Admin through POST /api/appraisals/initiate-cycle for each appraisal cycle cohort (June/September).
    const appraisalYear = 2026;
    const existingAppraisal: Appraisal | null = await appraisalsCol.findOne({
      employeeId: emp.id,
      appraisalYear,
    });

    if (existingAppraisal && !existingAppraisal.isLocked && existingAppraisal.status !== 'LOCKED') {
      const currentCtc = emp.currentCtc || existingAppraisal.currentCtc || 0;
      await appraisalsCol.updateOne(
        { id: existingAppraisal.id },
        {
          $set: {
            employeeCode: emp.employeeCode,
            employeeName: emp.name,
            departmentId: emp.departmentId,
            departmentName: emp.departmentName || 'Department',
            designationId: emp.designationId,
            designationName: emp.designationName || 'Designation',
            managerId: emp.managerId,
            managerName: emp.managerName,
            hodId: emp.hodId,
            hodName: emp.hodName,
            cycleId: emp.cycleId,
            cycleCode: emp.cycleCode || empCycle?.code || 'N/A',
            cycleName: emp.cycleName || empCycle?.name || 'Unassigned',
            cycleColor: emp.cycleColor || empCycle?.colorHex || '#64748b',
            currentCtc,
            currency: emp.currency || '₹',
            updatedAt: new Date().toISOString(),
          },
        }
      );
    }
  } catch (err) {
    console.error('Error syncing employee reviews and appraisals:', err);
  }
}

/**
 * Re-syncs an employee's not-yet-scored review(s) to match their currently assigned
 * KRA scorecard.
 *
 * A review's kraSnapshot is frozen at creation time — if the employee's
 * currentKraTemplateId changes afterward (a KRA assigned/re-assigned via the employee
 * editor, bulk upload, etc.), any review created before that point is left showing
 * stale or fallback KRAs. `syncEmployeeAppraisalsAndReviews` deliberately never
 * touches kraSnapshot, since blindly overwriting it could wipe out real ratings
 * already entered — so callers that just changed an employee's KRA assignment must
 * invoke this afterward.
 *
 * Only reviews with zero recorded progress (no ratings, achievements, or comments on
 * any KRA item) are rewritten; anything with real work in it is left untouched, same
 * as the closed-review protection in syncEmployeeAppraisalsAndReviews.
 */
export async function resyncUnscoredReviewKraSnapshots(employeeId: string): Promise<void> {
  try {
    const empCol = getDbCollection('employees');
    const reviewsCol = getDbCollection('employeeReviews');
    const templatesCol = getDbCollection('kraTemplates');

    const emp: Employee | null = await empCol.findOne({ id: employeeId });
    if (!emp || !emp.currentKraTemplateId) return;

    const template: KraTemplate | null = await templatesCol.findOne({ id: emp.currentKraTemplateId });
    if (!template || !template.items || template.items.length === 0) return;

    const openReviews: EmployeeReview[] = await (
      await reviewsCol.find({ employeeId, isClosed: { $ne: true }, status: { $ne: 'CLOSED' } })
    ).toArray();

    for (const review of openReviews) {
      const snapshot = review.kraSnapshot || [];
      const hasAnyProgress = snapshot.some(
        (k: ReviewKraSnapshot) =>
          (Number(k.rating) || 0) > 0 ||
          (Number(k.selfRating) || 0) > 0 ||
          Boolean(k.comments?.trim()) ||
          Boolean(k.selfComments?.trim()) ||
          Boolean(k.achievement?.trim()) ||
          Boolean(k.selfAchievement?.trim())
      );
      if (hasAnyProgress) continue;

      await reviewsCol.updateOne(
        { id: review.id },
        {
          $set: {
            kraSnapshot: buildKraSnapshotFromTemplate(template),
            updatedAt: new Date().toISOString(),
          },
        }
      );
    }
  } catch (err) {
    console.error('Error resyncing review KRA snapshots:', err);
  }
}

/**
 * Synchronize all active employees across the company — re-evaluates each one's review/
 * appraisal eligibility and auto-generates anything newly eligible (e.g. a KRA was just
 * assigned, or tenure has now crossed the minimum threshold). Used both by the manual
 * "Sync" admin action and the daily automated sync job in jobs/scheduler.ts.
 *
 * Includes PROBATION employees, not just ACTIVE — checkEmployeeReviewEligibility treats
 * PROBATION as review-eligible by default (systemConfig.includeProbationInReviews), so
 * excluding them here would silently skip a whole employee status from ever being
 * auto-generated a review. Fetching both is always safe: the per-employee eligibility
 * check inside syncEmployeeAppraisalsAndReviews still applies that config correctly.
 */
export async function syncAllActiveEmployees(): Promise<{ employeesProcessed: number }> {
  try {
    const empCol = getDbCollection('employees');
    const activeEmployees: Employee[] = await (
      await empCol.find({ status: { $in: ['ACTIVE', 'PROBATION'] } })
    ).toArray();
    for (const emp of activeEmployees) {
      await syncEmployeeAppraisalsAndReviews(emp);
    }
    return { employeesProcessed: activeEmployees.length };
  } catch (err) {
    console.error('Error during batch sync of active employees:', err);
    return { employeesProcessed: 0 };
  }
}
