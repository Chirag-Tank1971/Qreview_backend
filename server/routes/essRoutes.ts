import express, { Response } from 'express';
import { getDbCollection } from '../db.js';
import { AuthenticatedRequest, authenticateToken } from '../auth.js';
import {
  Employee,
  EmployeeReview,
  Appraisal,
  KraTemplate,
  ReviewPeriod,
} from '../../src/types/index.js';

export const essRouter = express.Router();

/**
 * GET /api/ess/overview/:employeeId?
 * Returns consolidated employee self-service data
 */
essRouter.get('/ess/overview/:employeeId?', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const requestedEmpId = req.params.employeeId;
    let targetEmployeeId = requestedEmpId;

    // If not explicitly requested in params or "me", use authenticated user's employeeId
    if (!targetEmployeeId || targetEmployeeId === 'me') {
      targetEmployeeId = user.employeeId || '';
    }

    // Role-based IDOR enforcement:
    if (user.role === 'EMPLOYEE') {
      if (requestedEmpId && requestedEmpId !== 'me' && requestedEmpId !== user.employeeId) {
        return res.status(403).json({ error: 'Access denied: Employees may only view their own ESS profile.' });
      }
      targetEmployeeId = user.employeeId;
    }

    const employeesCol = getDbCollection('employees');
    let employee: Employee | null = null;

    if (targetEmployeeId) {
      employee = await employeesCol.findOne({ id: targetEmployeeId });
    }

    if (!employee) {
      return res.status(404).json({ error: 'Employee record not found.' });
    }

    // Manager / HOD IDOR Scope Verification
    if (user.role === 'MANAGER' || user.role === 'REPORTING_MANAGER') {
      if (employee.id !== user.employeeId && employee.managerId !== user.employeeId) {
        return res.status(403).json({ error: 'Access denied: Managers can only view ESS profiles of their direct reports.' });
      }
    } else if (user.role === 'HOD') {
      const isDeptMatch =
        (req.employeeProfile?.departmentId && employee.departmentId === req.employeeProfile.departmentId) ||
        (req.employeeProfile?.departmentName && employee.departmentName?.toLowerCase() === req.employeeProfile.departmentName.toLowerCase());
      if (employee.id !== user.employeeId && employee.hodId !== user.employeeId && employee.managerId !== user.employeeId && !isDeptMatch) {
        return res.status(403).json({ error: 'Access denied: HODs can only view ESS profiles within their department.' });
      }
    }

    // Ensure employee object has valid currentCtc and currency
    if (!employee.currentCtc) {
      employee.currentCtc = 0;
    }
    if (!employee.currency) {
      employee.currency = '₹';
    }

    // Hydrate any missing master display names
    const departmentsCol = getDbCollection('departments');
    const designationsCol = getDbCollection('designations');
    const cyclesCol = getDbCollection('cycles');

    if (!employee.departmentName && employee.departmentId) {
      const dept = await departmentsCol.findOne({ id: employee.departmentId });
      if (dept) employee.departmentName = dept.name;
    }
    if (!employee.designationName && employee.designationId) {
      const desig = await designationsCol.findOne({ id: employee.designationId });
      if (desig) employee.designationName = desig.name;
    }
    if (!employee.managerName && employee.managerId) {
      const mgr = await employeesCol.findOne({ id: employee.managerId });
      if (mgr) employee.managerName = mgr.name;
    }
    if (!employee.hodName && employee.hodId) {
      const hod = await employeesCol.findOne({ id: employee.hodId });
      if (hod) employee.hodName = hod.name;
    }
    if (!employee.cycleName && (employee.cycleId || employee.cycleCode)) {
      const cycle = await cyclesCol.findOne({
        $or: [{ id: employee.cycleId }, { code: employee.cycleCode }]
      });
      if (cycle) {
        employee.cycleName = cycle.name;
        if (!employee.cycleColor) employee.cycleColor = cycle.colorHex;
      }
    }

    const empId = employee.id;

    const reviewsCol = getDbCollection('employeeReviews');
    const appraisalsCol = getDbCollection('appraisals');
    const kraTemplatesCol = getDbCollection('kraTemplates');
    const periodsCol = getDbCollection('reviewPeriods');

    const templateInitialPromise = employee.currentKraTemplateId
      ? kraTemplatesCol.findOne({ id: employee.currentKraTemplateId })
      : employee.designationId
      ? kraTemplatesCol.findOne({ designationId: employee.designationId })
      : Promise.resolve(null);

    // Parallel execution of all sub-queries
    const [reviewsRes, appraisalsRes, initialTemplate, periods] = await Promise.all([
      (await reviewsCol.find({ employeeId: empId })).toArray(),
      (await appraisalsCol.find({ employeeId: empId })).toArray(),
      templateInitialPromise,
      (await periodsCol.find({})).toArray(),
    ]);

    const reviews: EmployeeReview[] = reviewsRes;
    reviews.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    const appraisals: Appraisal[] = appraisalsRes;
    appraisals.sort((a, b) => b.appraisalYear - a.appraisalYear);
    const activeAppraisal = appraisals[0] || null;

    let activeKraTemplate: KraTemplate | null = initialTemplate;
    if (!activeKraTemplate && employee.designationId) {
      activeKraTemplate = await kraTemplatesCol.findOne({ designationId: employee.designationId });
    }

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

    // Calculate rolling average score from manager-evaluated reviews only
    const evaluatedStatuses = ['MANAGER_COMPLETED', 'HR_PENDING', 'CLOSED'];
    const completedReviews = reviews.filter(
      (r) =>
        (r.isClosed || evaluatedStatuses.includes(r.status)) &&
        typeof r.finalScore === 'number' &&
        r.finalScore > 0
    );
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
