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
      } else if (period.status === 'ACTIVE' && (emp.status === 'ACTIVE' || emp.status === 'PROBATION')) {
        // ONLY generate a new review if this is the currently ACTIVE period and employee joined on or before period end date
        const empAny = emp as any;
        const joiningTime = emp.joiningDate
          ? new Date(emp.joiningDate).getTime()
          : empAny.dateOfJoining
          ? new Date(empAny.dateOfJoining).getTime()
          : 0;
        const periodEndTime = period.endDate ? new Date(period.endDate).getTime() : Infinity;

        if (joiningTime <= periodEndTime) {
          // Find matching KRA template
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

          const kraSnapshot: ReviewKraSnapshot[] = (template?.items || [
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
          ]).map((item: any, idx: number) => ({
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

          const appraisalMonth = empCycle ? empCycle.appraisalMonth : 1;
          const cycleQuarter = Math.ceil(appraisalMonth / 3);
          const isAppraisalQuarter = (period.quarter === cycleQuarter);

          const newReview: EmployeeReview = {
            id: `rev_${period.id}_${emp.id}`,
            employeeId: emp.id,
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
            reviewPeriodId: period.id,
            reviewPeriodName: period.name,
            isAppraisalMonthDue: isAppraisalQuarter,
            kraSnapshot: kraSnapshot,
            status: 'ASSIGNED',
            isSelfSubmitted: false,
            finalScore: 0,
            selfScore: 0,
            strengths: '',
            improvements: '',
            managerOverallComments: '',
            isClosed: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };

          await reviewsCol.insertOne(newReview);

          // Notify employee of self-assessment due
          try {
            const notifCol = getDbCollection('notifications');
            await notifCol.insertOne({
              id: `notif_self_assess_${newReview.id}`,
              userId: emp.id,
              userRole: 'EMPLOYEE',
              type: 'REVIEW_ASSIGNED',
              title: `Self-Assessment Due: ${period.name}`,
              message: `Your quarterly performance self-assessment for ${period.name} is open. Please complete your KRA self-ratings and submit your evaluation.`,
              isRead: false,
              priority: 'HIGH',
              metadata: { reviewId: newReview.id, periodId: period.id, subTab: 'reviews', openSelfAssess: true },
              createdAt: new Date().toISOString(),
            });
          } catch (_notifErr) {
            // quiet fallback
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
