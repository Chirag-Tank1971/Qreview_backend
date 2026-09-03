import express, { Response } from 'express';
import { getDbCollection } from '../db.js';
import { AuthenticatedRequest, authenticateToken } from '../auth.js';
import {
  Employee,
  EmployeeReview,
  Appraisal,
  KraTemplate,
  ReviewPeriod,
} from '../../src/types.js';

export const essRouter = express.Router();

/**
 * GET /api/ess/overview/:employeeId?
 * Returns consolidated employee self-service data
 */
essRouter.get('/ess/overview/:employeeId?', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const requestedEmpId = req.params.employeeId;
    let targetEmployeeId = requestedEmpId;

    // If not explicitly requested in params or "me", use authenticated user's employeeId
    if (!targetEmployeeId || targetEmployeeId === 'me') {
      targetEmployeeId = req.user?.employeeId || '';
    }

    const employeesCol = getDbCollection('employees');
    let employee: Employee | null = null;

    if (targetEmployeeId) {
      employee = await employeesCol.findOne({ id: targetEmployeeId });
    }

    // If still null, fallback to first active employee (e.g. Siddharth Patel emp_dev_1)
    if (!employee) {
      employee = await employeesCol.findOne({ id: 'emp_dev_1' });
    }

    if (!employee) {
      const allEmps = await (await employeesCol.find({ status: 'ACTIVE' })).toArray();
      employee = allEmps[0] || null;
    }

    if (!employee) {
      return res.status(404).json({ error: 'No employee record found.' });
    }

    // Ensure employee object has valid currentCtc and currency
    if (!employee.currentCtc || employee.currentCtc === 0) {
      const defaultCtcMap: Record<string, number> = {
        emp_exec_mgmt: 4500000,
        emp_hod_eng: 3600000,
        emp_hod_sales: 3200000,
        emp_mgr_eng: 2400000,
        emp_dev_1: 1800000,
        emp_hr_lead: 1750000,
        emp_admin: 1600000,
        emp_sales_1: 1350000,
        emp_dev_2: 1100000,
      };
      employee.currentCtc = defaultCtcMap[employee.id] || 1600000;
    }
    if (!employee.currency) {
      employee.currency = '₹';
    }

    const empId = employee.id;

    // 1. Fetch all quarterly reviews for this employee
    const reviewsCol = getDbCollection('employeeReviews');
    const reviews: EmployeeReview[] = await (
      await reviewsCol.find({ employeeId: empId })
    ).toArray();

    // Sort reviews by reviewPeriod or createdAt
    reviews.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    // 2. Fetch latest appraisal for this employee
    const appraisalsCol = getDbCollection('appraisals');
    const appraisals: Appraisal[] = await (
      await appraisalsCol.find({ employeeId: empId })
    ).toArray();

    appraisals.sort((a, b) => b.appraisalYear - a.appraisalYear);
    const activeAppraisal = appraisals[0] || null;

    // 3. Fetch active KRA template
    const kraTemplatesCol = getDbCollection('kraTemplates');
    let activeKraTemplate: KraTemplate | null = null;
    if (employee.currentKraTemplateId) {
      activeKraTemplate = await kraTemplatesCol.findOne({ id: employee.currentKraTemplateId });
    }
    if (!activeKraTemplate && employee.designationId) {
      activeKraTemplate = await kraTemplatesCol.findOne({ designationId: employee.designationId });
    }

    // 4. Fetch review periods to cross-reference
    const periodsCol = getDbCollection('reviewPeriods');
    const periods: ReviewPeriod[] = await (await periodsCol.find({})).toArray();

    // 5. Calculate longitudinal performance trajectory
    const performanceHistory = reviews
      .filter((r) => r.finalScore && r.finalScore > 0)
      .map((r) => ({
        periodId: r.reviewPeriodId,
        periodName: r.reviewPeriodName,
        score: r.finalScore,
        selfScore: r.selfScore || 0,
        status: r.status,
      }))
      .reverse();

    // 6. Action items checklist for employee
    const actionItems = [];

    // Check if there is an open review that needs self-assessment
    const pendingSelfReview = reviews.find(
      (r) => !r.isClosed && !r.isSelfSubmitted
    );
    if (pendingSelfReview) {
      actionItems.push({
        id: `act_self_${pendingSelfReview.id}`,
        type: 'SELF_ASSESSMENT_DUE',
        priority: 'HIGH',
        title: `Self-Evaluation Due: ${pendingSelfReview.reviewPeriodName}`,
        description: 'Complete and submit your KRA self-rating and key deliverables for manager evaluation.',
        linkTab: 'reviews',
        reviewId: pendingSelfReview.id,
      });
    }

    // Check if there is a locked appraisal pending acknowledgement
    if (activeAppraisal && activeAppraisal.isLocked && !activeAppraisal.employeeAcknowledgement?.acknowledged) {
      actionItems.push({
        id: `act_appraisal_${activeAppraisal.id}`,
        type: 'APPRAISAL_ACKNOWLEDGE_DUE',
        priority: 'URGENT',
        title: `Annual Appraisal Letter Signature Required (${activeAppraisal.appraisalYear})`,
        description: 'Your annual performance appraisal letter and revised compensation are ready for digital sign-off.',
        linkTab: 'appraisal',
        appraisalId: activeAppraisal.id,
      });
    }

    // Calculate rolling average score
    const completedReviews = reviews.filter((r) => r.finalScore && r.finalScore > 0);
    const averageScore =
      completedReviews.length > 0
        ? Number(
            (
              completedReviews.reduce((sum, r) => sum + (r.finalScore || 0), 0) /
              completedReviews.length
            ).toFixed(2)
          )
        : 0;

    res.json({
      employee,
      activeAppraisal,
      allAppraisals: appraisals,
      reviews,
      activeKraTemplate,
      periods,
      performanceHistory,
      actionItems,
      metrics: {
        averageScore,
        completedReviewsCount: completedReviews.length,
        totalReviewsCount: reviews.length,
        selfSubmittedCount: reviews.filter((r) => r.isSelfSubmitted).length,
        hasAcknowledgedAppraisal: Boolean(activeAppraisal?.employeeAcknowledgement?.acknowledged),
        isAppraisalLocked: Boolean(activeAppraisal?.isLocked),
      },
    });
  } catch (error: any) {
    console.error('Error fetching ESS overview:', error);
    res.status(500).json({ error: 'Failed to fetch ESS overview.' });
  }
});
