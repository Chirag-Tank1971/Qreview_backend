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
} from '../src/types.js';
import {
  checkEmployeeReviewEligibility,
  createQuarterlyReview,
} from './services/reviewEligibility.js';

export function computeAppraisalMatrix(avgScore: number) {
  if (avgScore <= 0) {
    return {
      recommendedRating: 'PENDING' as const,
      suggestedIncrementMin: 0,
      suggestedIncrementMax: 0,
      defaultIncrement: 0,
    };
  } else if (avgScore >= 4.5) {
    return {
      recommendedRating: 'OUTSTANDING' as const,
      suggestedIncrementMin: 15,
      suggestedIncrementMax: 20,
      defaultIncrement: 16.5,
    };
  } else if (avgScore >= 3.8) {
    return {
      recommendedRating: 'EXCEEDS_EXPECTATIONS' as const,
      suggestedIncrementMin: 10,
      suggestedIncrementMax: 14,
      defaultIncrement: 12.0,
    };
  } else if (avgScore >= 2.8) {
    return {
      recommendedRating: 'MEETS_EXPECTATIONS' as const,
      suggestedIncrementMin: 5,
      suggestedIncrementMax: 9,
      defaultIncrement: 7.0,
    };
  } else {
    return {
      recommendedRating: 'NEEDS_IMPROVEMENT' as const,
      suggestedIncrementMin: 0,
      suggestedIncrementMax: 4,
      defaultIncrement: 2.0,
    };
  }
}

/**
 * Synchronize appraisal & quarterly review records for a single employee
 */
export async function syncEmployeeAppraisalsAndReviews(emp: Employee) {
  try {
    const reviewsCol = getDbCollection('employeeReviews');
    const appraisalsCol = getDbCollection('appraisals');
    const periodsCol = getDbCollection('reviewPeriods');
    const templatesCol = getDbCollection('kraTemplates');
    const cyclesCol = getDbCollection('cycles');

    const allPeriods: ReviewPeriod[] = await (await periodsCol.find({})).toArray();
    const allTemplates: KraTemplate[] = await (await templatesCol.find({})).toArray();
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
              cycleCode: emp.cycleCode || empCycle?.code || 'A',
              cycleColor: emp.cycleColor || empCycle?.colorHex || '#1e3a8a',
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
    // by HR/Super Admin through POST /api/appraisals/initiate-cycle for each 8-Cycle cohort.
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
            cycleCode: emp.cycleCode || empCycle?.code || 'A',
            cycleName: emp.cycleName || empCycle?.name || `Cycle ${emp.cycleCode || empCycle?.code || 'A'}`,
            cycleColor: emp.cycleColor || empCycle?.colorHex || '#1e3a8a',
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
 * Synchronize all active employees across the company
 */
export async function syncAllActiveEmployees() {
  try {
    const empCol = getDbCollection('employees');
    const activeEmployees: Employee[] = await (await empCol.find({ status: 'ACTIVE' })).toArray();
    for (const emp of activeEmployees) {
      await syncEmployeeAppraisalsAndReviews(emp);
    }
  } catch (err) {
    console.error('Error during batch sync of active employees:', err);
  }
}
