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
  if (avgScore >= 4.5) {
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
        // Sync manager/hod/department fields if changed
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
              cycleCode: emp.cycleCode,
              cycleColor: emp.cycleColor || empCycle?.colorHex || '#1e3a8a',
              updatedAt: new Date().toISOString(),
            },
          }
        );
      } else {
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
          selfRating: 4.0,
          selfComments: 'Consistently met and exceeded key delivery milestones for this quarter.',
          rating: 4.0,
          comments: 'Strong execution and great team collaboration throughout the review cycle.',
        }));

        const isAppraisalQuarter = (period.quarter === 1);

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
          cycleCode: emp.cycleCode || 'A',
          cycleColor: emp.cycleColor || empCycle?.colorHex || '#1e3a8a',
          reviewPeriodId: period.id,
          reviewPeriodName: period.name,
          isAppraisalMonthDue: isAppraisalQuarter,
          kraSnapshot: kraSnapshot,
          status: 'MANAGER_PENDING',
          isSelfSubmitted: true,
          selfSubmittedAt: new Date().toISOString(),
          finalScore: 4.0,
          selfScore: 4.0,
          strengths: 'Reliable execution, positive attitude, and consistent quality of work.',
          improvements: 'Take on more autonomous project leadership and cross-functional initiatives.',
          managerOverallComments: 'Solid performance throughout this quarter with high quality output.',
          isClosed: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        await reviewsCol.insertOne(newReview);
      }
    }

    // 2. Ensure Annual Appraisal Record exists for current year (2026)
    const appraisalYear = 2026;
    const existingAppraisal: Appraisal | null = await appraisalsCol.findOne({
      employeeId: emp.id,
      appraisalYear,
    });

    const empReviews: EmployeeReview[] = await (
      await reviewsCol.find({ employeeId: emp.id })
    ).toArray();

    const quarterlyHistory: AppraisalQuarterRecord[] = empReviews.map((rev) => ({
      periodId: rev.reviewPeriodId,
      periodName: rev.reviewPeriodName,
      score: rev.finalScore || 4.0,
      reviewId: rev.id,
      strengths: rev.strengths,
      managerComments: rev.managerOverallComments,
      hrComments: rev.hrComments,
    }));

    const validScores = quarterlyHistory.filter((q) => q.score > 0).map((q) => q.score);
    const avgScore =
      validScores.length > 0
        ? Number((validScores.reduce((sum, s) => sum + s, 0) / validScores.length).toFixed(2))
        : 4.0;

    const matrix = computeAppraisalMatrix(avgScore);
    const currentCtc = emp.currentCtc || 1600000;
    const proposedIncrementPercent = matrix.defaultIncrement;
    const incrementAmount = Math.round((currentCtc * proposedIncrementPercent) / 100);
    const revisedCtc = currentCtc + incrementAmount;

    if (existingAppraisal) {
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
            cycleCode: emp.cycleCode || 'A',
            cycleName: emp.cycleName || empCycle?.name || 'Cycle A',
            cycleColor: emp.cycleColor || empCycle?.colorHex || '#1e3a8a',
            currentCtc,
            currency: emp.currency || '₹',
            updatedAt: new Date().toISOString(),
          },
        }
      );
    } else {
      const appraisalDoc: Appraisal = {
        id: `appr_${appraisalYear}_${emp.id}`,
        employeeId: emp.id,
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
        cycleCode: emp.cycleCode || 'A',
        cycleName: emp.cycleName || empCycle?.name || 'Cycle A',
        cycleColor: emp.cycleColor || empCycle?.colorHex || '#1e3a8a',
        appraisalYear,
        appraisalMonth: empCycle?.appraisalMonth || 1,
        currentCtc,
        currency: emp.currency || '₹',
        quarterlyHistory: quarterlyHistory.length > 0 ? quarterlyHistory : [
          { periodId: 'period_2026_q1', periodName: '2026-Q1 (Jan - Mar)', score: 4.0 },
        ],
        averageQuarterlyScore: avgScore,
        recommendedRating: matrix.recommendedRating,
        suggestedIncrementMin: matrix.suggestedIncrementMin,
        suggestedIncrementMax: matrix.suggestedIncrementMax,
        finalRating: matrix.recommendedRating,
        proposedIncrementPercentage: proposedIncrementPercent,
        approvedIncrementPercentage: proposedIncrementPercent,
        incrementAmount,
        revisedCtc,
        promotionRecommended: false,
        effectiveDate: (() => {
          const m = empCycle?.appraisalMonth || 1;
          const effMonth = (m % 12) + 1;
          const effYear = m === 12 ? appraisalYear + 1 : appraisalYear;
          return `${effYear}-${String(effMonth).padStart(2, '0')}-01`;
        })(),
        status: 'PENDING',
        isLocked: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await appraisalsCol.insertOne(appraisalDoc);
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
