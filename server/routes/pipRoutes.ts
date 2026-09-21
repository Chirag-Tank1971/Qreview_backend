import express, { Response } from 'express';
import { getDbCollection } from '../db.js';
import { authenticateToken, requireRoles, recordAuditLog, AuthenticatedRequest } from '../auth.js';
import {
  validateBody,
  CreatePipSchema,
  UpdatePipSchema,
  PipCheckInSchema,
  PipAcknowledgementSchema,
  PipOutcomeSchema,
  PipCancelSchema,
  PipFailureResolutionSchema,
} from '../validation.js';
import { Employee, PerformanceImprovementPlan, PipCheckIn } from '../../src/types/index.js';
import { ACTIVE_PIP_STATUSES } from '../services/pipService.js';

export const pipRouter = express.Router();

pipRouter.use(authenticateToken);

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

/** Whether the current user is allowed to see/act on this specific employee's PIP. */
function canAccessEmployeePip(req: AuthenticatedRequest, pip: PerformanceImprovementPlan): boolean {
  const role = req.user?.role;
  if (role === 'SUPER_ADMIN' || role === 'HR' || role === 'MANAGEMENT') return true;
  const myEmployeeId = req.user?.employeeId;
  if (!myEmployeeId) return false;
  if (pip.employeeId === myEmployeeId) return true; // the employee themselves
  if ((role === 'HOD') && pip.hodId === myEmployeeId) return true;
  if ((role === 'MANAGER' || role === 'REPORTING_MANAGER') && pip.managerId === myEmployeeId) return true;
  return false;
}

// ==========================================
// 1. LIST & READ
// ==========================================

/**
 * GET /api/pips
 * Role-scoped: SUPER_ADMIN/HR/MANAGEMENT see all, HOD/Manager see their reportees',
 * Employee sees only their own.
 */
pipRouter.get('/pips', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const pipCol = getDbCollection('performanceImprovementPlans');
    const role = req.user?.role;
    const myEmployeeId = req.user?.employeeId;

    let query: any = {};
    if (role === 'SUPER_ADMIN' || role === 'HR' || role === 'MANAGEMENT') {
      query = {};
    } else if (role === 'HOD') {
      query = { $or: [{ hodId: myEmployeeId }, { employeeId: myEmployeeId }] };
    } else if (role === 'MANAGER' || role === 'REPORTING_MANAGER') {
      query = { $or: [{ managerId: myEmployeeId }, { employeeId: myEmployeeId }] };
    } else {
      query = { employeeId: myEmployeeId || '__none__' };
    }

    const { status } = req.query;
    const plans: PerformanceImprovementPlan[] = await (await pipCol.find(query)).toArray();
    const filtered = status ? plans.filter((p) => p.status === status) : plans;

    filtered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.json(filtered);
  } catch (error: any) {
    console.error('Error fetching PIPs:', error);
    res.status(500).json({ error: 'Failed to fetch performance improvement plans.' });
  }
});

/**
 * GET /api/pips/analytics
 * HR/Admin only — summary metrics for a People Analytics view: status breakdown, outcome
 * success rate, and average duration. Declared before /pips/:id so "analytics" is never
 * swallowed by the :id param route.
 */
pipRouter.get('/pips/analytics', requireRoles('SUPER_ADMIN', 'HR'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const pipCol = getDbCollection('performanceImprovementPlans');
    const plans: PerformanceImprovementPlan[] = await (await pipCol.find({})).toArray();

    const byStatus: Record<string, number> = {};
    for (const p of plans) {
      byStatus[p.status] = (byStatus[p.status] || 0) + 1;
    }

    const resolved = plans.filter((p) => p.status === 'SUCCEEDED' || p.status === 'FAILED');
    const succeededCount = resolved.filter((p) => p.status === 'SUCCEEDED').length;
    const successRate = resolved.length > 0 ? Math.round((succeededCount / resolved.length) * 100) : null;

    const closedDurations = plans
      .filter((p) => p.status !== 'DRAFT' && p.status !== 'CANCELLED')
      .map((p) => p.durationDays);
    const avgDurationDays =
      closedDurations.length > 0
        ? Math.round(closedDurations.reduce((sum, d) => sum + d, 0) / closedDurations.length)
        : null;

    const byDepartment: Record<string, number> = {};
    for (const p of plans) {
      if ((p.status === 'ACTIVE' || p.status === 'EXTENDED') && p.departmentName) {
        byDepartment[p.departmentName] = (byDepartment[p.departmentName] || 0) + 1;
      }
    }

    res.json({
      total: plans.length,
      activeCount: (byStatus['ACTIVE'] || 0) + (byStatus['EXTENDED'] || 0),
      byStatus,
      successRate,
      avgDurationDays,
      byDepartment,
    });
  } catch (error: any) {
    console.error('Error computing PIP analytics:', error);
    res.status(500).json({ error: 'Failed to compute performance improvement plan analytics.' });
  }
});

pipRouter.get('/pips/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const pipCol = getDbCollection('performanceImprovementPlans');
    const pip: PerformanceImprovementPlan | null = await pipCol.findOne({ id: req.params.id });
    if (!pip) {
      return res.status(404).json({ error: 'Performance improvement plan not found.' });
    }
    if (!canAccessEmployeePip(req, pip)) {
      return res.status(403).json({ error: 'You do not have access to this performance improvement plan.' });
    }
    res.json(pip);
  } catch (error: any) {
    console.error('Error fetching PIP:', error);
    res.status(500).json({ error: 'Failed to fetch performance improvement plan.' });
  }
});

// ==========================================
// 2. CREATE / UPDATE / PUBLISH (HR / SUPER_ADMIN only)
// ==========================================

/**
 * POST /api/pips
 * HR/Admin only — the only roles allowed to put an employee on a PIP. Duration is always
 * an explicit HR/Admin-chosen number of days, never a fixed preset.
 */
pipRouter.post(
  '/pips',
  requireRoles('SUPER_ADMIN', 'HR'),
  validateBody(CreatePipSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { employeeId, reason, category, triggeredByReviewId, startDate, durationDays, goals, publish } = req.body;
      const currentUser = req.user!;

      const empCol = getDbCollection('employees');
      const employee: Employee | null = await empCol.findOne({ id: employeeId });
      if (!employee) {
        return res.status(404).json({ error: 'Employee not found.' });
      }

      const pipCol = getDbCollection('performanceImprovementPlans');
      const existingActive: PerformanceImprovementPlan | null = await pipCol.findOne({
        employeeId,
        status: { $in: ACTIVE_PIP_STATUSES },
      });
      if (existingActive) {
        return res.status(400).json({
          error: `${employee.name} already has an active performance improvement plan (started ${new Date(existingActive.startDate).toLocaleDateString()}). Resolve it before starting a new one.`,
        });
      }

      const now = new Date().toISOString();
      const endDate = addDays(startDate, durationDays);

      const newPip: PerformanceImprovementPlan = {
        id: `pip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        employeeId: employee.id,
        employeeCode: employee.employeeCode,
        employeeName: employee.name,
        departmentId: employee.departmentId,
        departmentName: employee.departmentName,
        designationName: employee.designationName,
        managerId: employee.managerId,
        managerName: employee.managerName,
        hodId: employee.hodId,
        hodName: employee.hodName,
        triggeredByReviewId: triggeredByReviewId || undefined,
        reason,
        category: category || undefined,
        startDate,
        durationDays,
        endDate,
        goals: (goals || []).map((g: any, idx: number) => ({
          id: g.id || `pipgoal_${Date.now()}_${idx}`,
          description: g.description,
          targetMetric: g.targetMetric || undefined,
          dueDate: g.dueDate || undefined,
          status: g.status || 'PENDING',
        })),
        checkIns: [],
        status: publish ? 'ACTIVE' : 'DRAFT',
        initiatedById: currentUser.id,
        initiatedByName: currentUser.name,
        initiatedAt: now,
        publishedAt: publish ? now : undefined,
        createdAt: now,
        updatedAt: now,
      };

      await pipCol.insertOne(newPip);

      if (publish) {
        await notifyPipPublished(newPip);
      }

      await recordAuditLog(
        currentUser.id,
        currentUser.name,
        currentUser.role,
        'PERFORMANCE_IMPROVEMENT_PLAN',
        publish ? 'CREATE_AND_PUBLISH' : 'CREATE_DRAFT',
        newPip.id,
        '',
        JSON.stringify({ employeeId, durationDays, startDate, endDate }),
        `${publish ? 'Published' : 'Drafted'} a ${durationDays}-day PIP for ${employee.name} (${employee.employeeCode}).`
      );

      res.status(201).json(newPip);
    } catch (error: any) {
      console.error('Error creating PIP:', error);
      res.status(500).json({ error: 'Failed to create performance improvement plan.' });
    }
  }
);

/**
 * PUT /api/pips/:id
 * Edit a DRAFT plan only — once published, use the dedicated check-in/outcome/cancel actions.
 */
pipRouter.put(
  '/pips/:id',
  requireRoles('SUPER_ADMIN', 'HR'),
  validateBody(UpdatePipSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const pipCol = getDbCollection('performanceImprovementPlans');
      const pip: PerformanceImprovementPlan | null = await pipCol.findOne({ id: req.params.id });
      if (!pip) {
        return res.status(404).json({ error: 'Performance improvement plan not found.' });
      }
      if (pip.status !== 'DRAFT') {
        return res.status(400).json({ error: 'Only a draft plan can be edited. Published plans are managed via check-ins, outcome, or cancellation.' });
      }

      const { reason, category, startDate, durationDays, goals } = req.body;
      const updateData: Partial<PerformanceImprovementPlan> = { updatedAt: new Date().toISOString() };
      if (reason !== undefined) updateData.reason = reason;
      if (category !== undefined) updateData.category = category;
      if (startDate !== undefined) updateData.startDate = startDate;
      if (durationDays !== undefined) updateData.durationDays = durationDays;
      if (startDate !== undefined || durationDays !== undefined) {
        updateData.endDate = addDays(startDate || pip.startDate, durationDays ?? pip.durationDays);
      }
      if (goals !== undefined) {
        updateData.goals = goals.map((g: any, idx: number) => ({
          id: g.id || `pipgoal_${Date.now()}_${idx}`,
          description: g.description,
          targetMetric: g.targetMetric || undefined,
          dueDate: g.dueDate || undefined,
          status: g.status || 'PENDING',
        }));
      }

      await pipCol.updateOne({ id: pip.id }, { $set: updateData });
      const updated = await pipCol.findOne({ id: pip.id });
      res.json(updated);
    } catch (error: any) {
      console.error('Error updating PIP:', error);
      res.status(500).json({ error: 'Failed to update performance improvement plan.' });
    }
  }
);

/**
 * POST /api/pips/:id/publish
 * Moves a DRAFT plan to ACTIVE — notifies the employee, manager, and HOD.
 */
pipRouter.post('/pips/:id/publish', requireRoles('SUPER_ADMIN', 'HR'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const pipCol = getDbCollection('performanceImprovementPlans');
    const pip: PerformanceImprovementPlan | null = await pipCol.findOne({ id: req.params.id });
    if (!pip) {
      return res.status(404).json({ error: 'Performance improvement plan not found.' });
    }
    if (pip.status !== 'DRAFT') {
      return res.status(400).json({ error: `Plan is already ${pip.status}.` });
    }

    const now = new Date().toISOString();
    await pipCol.updateOne({ id: pip.id }, { $set: { status: 'ACTIVE', publishedAt: now, updatedAt: now } });
    const updated: PerformanceImprovementPlan = await pipCol.findOne({ id: pip.id });

    await notifyPipPublished(updated);

    const currentUser = req.user!;
    await recordAuditLog(
      currentUser.id,
      currentUser.name,
      currentUser.role,
      'PERFORMANCE_IMPROVEMENT_PLAN',
      'PUBLISH',
      pip.id,
      'DRAFT',
      'ACTIVE',
      `Published PIP for ${pip.employeeName} (${pip.employeeCode}).`
    );

    res.json(updated);
  } catch (error: any) {
    console.error('Error publishing PIP:', error);
    res.status(500).json({ error: 'Failed to publish performance improvement plan.' });
  }
});

// ==========================================
// 3. CHECK-INS (Manager / HOD / HR / Admin)
// ==========================================

/**
 * POST /api/pips/:id/checkins
 * Any of the employee's manager, HOD, or HR/Admin can log a check-in. Per design, check-ins
 * are visible to the employee immediately (no held-back "internal only" notes).
 */
pipRouter.post('/pips/:id/checkins', validateBody(PipCheckInSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const pipCol = getDbCollection('performanceImprovementPlans');
    const pip: PerformanceImprovementPlan | null = await pipCol.findOne({ id: req.params.id });
    if (!pip) {
      return res.status(404).json({ error: 'Performance improvement plan not found.' });
    }

    const currentUser = req.user!;
    const role = currentUser.role;
    const isManagerOrHod =
      (role === 'MANAGER' || role === 'REPORTING_MANAGER') && pip.managerId === currentUser.employeeId ||
      role === 'HOD' && pip.hodId === currentUser.employeeId;
    const isHrOrAdmin = role === 'SUPER_ADMIN' || role === 'HR';
    if (!isManagerOrHod && !isHrOrAdmin) {
      return res.status(403).json({ error: 'Only the employee\'s manager, HOD, or HR/Admin can log a check-in on this plan.' });
    }
    if (!ACTIVE_PIP_STATUSES.includes(pip.status)) {
      return res.status(400).json({ error: `Cannot add a check-in to a plan that is ${pip.status}.` });
    }

    const { notes, goalRatings } = req.body;

    let validatedGoalRatings: PipCheckIn['goalRatings'];
    if (goalRatings && goalRatings.length > 0) {
      const validGoalIds = new Set(pip.goals.map((g) => g.id));
      const unknownGoalId = goalRatings.find((r: any) => !validGoalIds.has(r.goalId));
      if (unknownGoalId) {
        return res.status(400).json({ error: `Goal "${unknownGoalId.goalId}" does not belong to this plan.` });
      }
      validatedGoalRatings = goalRatings;
    }

    const checkIn: PipCheckIn = {
      id: `pipcheckin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      date: new Date().toISOString(),
      byId: currentUser.id,
      byName: currentUser.name,
      byRole: currentUser.role,
      notes,
      goalRatings: validatedGoalRatings,
    };

    await pipCol.updateOne(
      { id: pip.id },
      { $set: { checkIns: [...pip.checkIns, checkIn], updatedAt: new Date().toISOString() } }
    );

    const notifCol = getDbCollection('notifications');
    await notifCol.insertOne({
      id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      userId: pip.employeeId,
      userRole: 'EMPLOYEE',
      type: 'PIP_CHECKIN',
      title: `New Check-In on Your Improvement Plan`,
      message: `${currentUser.name} logged a new check-in on your performance improvement plan.`,
      isRead: false,
      priority: 'MEDIUM',
      metadata: { pipId: pip.id },
      createdAt: new Date().toISOString(),
    });

    const updated = await pipCol.findOne({ id: pip.id });
    res.status(201).json(updated);
  } catch (error: any) {
    console.error('Error adding PIP check-in:', error);
    res.status(500).json({ error: 'Failed to add check-in.' });
  }
});

// ==========================================
// 4. EMPLOYEE ACKNOWLEDGEMENT
// ==========================================

pipRouter.post('/pips/:id/acknowledge', validateBody(PipAcknowledgementSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const pipCol = getDbCollection('performanceImprovementPlans');
    const pip: PerformanceImprovementPlan | null = await pipCol.findOne({ id: req.params.id });
    if (!pip) {
      return res.status(404).json({ error: 'Performance improvement plan not found.' });
    }
    if (pip.employeeId !== req.user?.employeeId) {
      return res.status(403).json({ error: 'Only the employee this plan belongs to can acknowledge it.' });
    }
    if (!ACTIVE_PIP_STATUSES.includes(pip.status)) {
      return res.status(400).json({ error: `Cannot acknowledge a plan that is ${pip.status}.` });
    }

    const { comments } = req.body;
    const now = new Date().toISOString();
    await pipCol.updateOne(
      { id: pip.id },
      {
        $set: {
          employeeAcknowledgement: { acknowledged: true, acknowledgedAt: now, comments: comments || undefined },
          updatedAt: now,
        },
      }
    );

    const notifCol = getDbCollection('notifications');
    const notifyTargets = [pip.managerId, pip.hodId].filter(Boolean) as string[];
    for (const targetId of notifyTargets) {
      await notifCol.insertOne({
        id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        userId: targetId,
        type: 'PIP_ACKNOWLEDGED',
        title: `Improvement Plan Acknowledged: ${pip.employeeName}`,
        message: `${pip.employeeName} (${pip.employeeCode}) has acknowledged their performance improvement plan.`,
        isRead: false,
        metadata: { pipId: pip.id },
        createdAt: now,
      });
    }

    const updated = await pipCol.findOne({ id: pip.id });
    res.json(updated);
  } catch (error: any) {
    console.error('Error acknowledging PIP:', error);
    res.status(500).json({ error: 'Failed to acknowledge performance improvement plan.' });
  }
});

// ==========================================
// 5. OUTCOME (HR / SUPER_ADMIN only)
// ==========================================

/**
 * POST /api/pips/:id/outcome
 * HR/Admin only. SUCCEEDED/FAILED resolve the plan (unblocking annual appraisal eligibility
 * again); EXTENDED keeps it active with a new HR/Admin-chosen number of additional days.
 */
pipRouter.post('/pips/:id/outcome', requireRoles('SUPER_ADMIN', 'HR'), validateBody(PipOutcomeSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const pipCol = getDbCollection('performanceImprovementPlans');
    const pip: PerformanceImprovementPlan | null = await pipCol.findOne({ id: req.params.id });
    if (!pip) {
      return res.status(404).json({ error: 'Performance improvement plan not found.' });
    }
    if (!ACTIVE_PIP_STATUSES.includes(pip.status)) {
      return res.status(400).json({ error: `Plan is already resolved (${pip.status}).` });
    }

    const { decision, notes, additionalDays } = req.body;
    const currentUser = req.user!;
    const now = new Date().toISOString();

    const outcomeRecord = {
      decision,
      decidedById: currentUser.id,
      decidedByName: currentUser.name,
      decidedAt: now,
      notes: notes || undefined,
      newEndDate: decision === 'EXTENDED' ? addDays(pip.endDate, additionalDays) : undefined,
    };

    const updateData: Partial<PerformanceImprovementPlan> = {
      outcome: outcomeRecord,
      outcomeHistory: [...(pip.outcomeHistory || []), outcomeRecord],
      updatedAt: now,
    };

    if (decision === 'EXTENDED') {
      updateData.status = 'EXTENDED';
      updateData.endDate = outcomeRecord.newEndDate;
      updateData.durationDays = pip.durationDays + additionalDays;
    } else {
      updateData.status = decision; // SUCCEEDED | FAILED
    }

    await pipCol.updateOne({ id: pip.id }, { $set: updateData });
    const updated: PerformanceImprovementPlan = await pipCol.findOne({ id: pip.id });

    const notifCol = getDbCollection('notifications');
    if (decision === 'FAILED') {
      // Broadcast to the whole HR team, not just the acting HR user, so the outcome doesn't
      // depend on one person's memory.
      await notifCol.insertOne({
        id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        userId: 'ALL',
        userRole: 'HR',
        type: 'PIP_FAILED',
        title: `Performance Improvement Plan Failed: ${pip.employeeName}`,
        message: `${pip.employeeName} (${pip.employeeCode}) did not meet the goals of their performance improvement plan. Review and decide next steps.`,
        isRead: false,
        priority: 'HIGH',
        metadata: { pipId: pip.id, employeeId: pip.employeeId },
        createdAt: now,
      });
    } else {
      await notifCol.insertOne({
        id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        userId: pip.employeeId,
        userRole: 'EMPLOYEE',
        type: decision === 'SUCCEEDED' ? 'PIP_SUCCEEDED' : 'PIP_EXTENDED',
        title:
          decision === 'SUCCEEDED'
            ? 'Performance Improvement Plan Completed Successfully'
            : 'Performance Improvement Plan Extended',
        message:
          decision === 'SUCCEEDED'
            ? 'Your performance improvement plan has been marked as successfully completed.'
            : `Your performance improvement plan has been extended to ${new Date(outcomeRecord.newEndDate!).toLocaleDateString()}.`,
        isRead: false,
        metadata: { pipId: pip.id },
        createdAt: now,
      });
    }

    await recordAuditLog(
      currentUser.id,
      currentUser.name,
      currentUser.role,
      'PERFORMANCE_IMPROVEMENT_PLAN',
      `OUTCOME_${decision}`,
      pip.id,
      pip.status,
      updateData.status as string,
      `Recorded outcome "${decision}" for ${pip.employeeName}'s PIP.${notes ? ` Notes: ${notes}` : ''}`
    );

    res.json(updated);
  } catch (error: any) {
    console.error('Error recording PIP outcome:', error);
    res.status(500).json({ error: 'Failed to record outcome.' });
  }
});

// ==========================================
// 6. CANCEL (HR / SUPER_ADMIN only)
// ==========================================

pipRouter.post('/pips/:id/cancel', requireRoles('SUPER_ADMIN', 'HR'), validateBody(PipCancelSchema), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const pipCol = getDbCollection('performanceImprovementPlans');
    const pip: PerformanceImprovementPlan | null = await pipCol.findOne({ id: req.params.id });
    if (!pip) {
      return res.status(404).json({ error: 'Performance improvement plan not found.' });
    }
    if (!ACTIVE_PIP_STATUSES.includes(pip.status) && pip.status !== 'DRAFT') {
      return res.status(400).json({ error: `Plan is already resolved (${pip.status}).` });
    }

    const { reason } = req.body;
    const currentUser = req.user!;
    const now = new Date().toISOString();

    await pipCol.updateOne(
      { id: pip.id },
      {
        $set: {
          status: 'CANCELLED',
          cancelledReason: reason,
          cancelledById: currentUser.id,
          cancelledByName: currentUser.name,
          cancelledAt: now,
          updatedAt: now,
        },
      }
    );

    await recordAuditLog(
      currentUser.id,
      currentUser.name,
      currentUser.role,
      'PERFORMANCE_IMPROVEMENT_PLAN',
      'CANCEL',
      pip.id,
      pip.status,
      'CANCELLED',
      `Cancelled PIP for ${pip.employeeName}. Reason: ${reason}`
    );

    const updated = await pipCol.findOne({ id: pip.id });
    res.json(updated);
  } catch (error: any) {
    console.error('Error cancelling PIP:', error);
    res.status(500).json({ error: 'Failed to cancel performance improvement plan.' });
  }
});

// ==========================================
// 7. FAILURE RESOLUTION (HR / SUPER_ADMIN only)
// ==========================================

/**
 * POST /api/pips/:id/resolve-failure
 * HR/Admin only. Records what HR did next after a FAILED outcome (new PIP, termination,
 * escalation, or no further action) — clears the "Not Successful" alert on the employee's
 * dashboard while keeping a permanent record of the decision.
 */
pipRouter.post(
  '/pips/:id/resolve-failure',
  requireRoles('SUPER_ADMIN', 'HR'),
  validateBody(PipFailureResolutionSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const pipCol = getDbCollection('performanceImprovementPlans');
      const pip: PerformanceImprovementPlan | null = await pipCol.findOne({ id: req.params.id });
      if (!pip) {
        return res.status(404).json({ error: 'Performance improvement plan not found.' });
      }
      if (pip.status !== 'FAILED') {
        return res.status(400).json({ error: 'Only a plan with a FAILED outcome can be resolved this way.' });
      }

      const { action, notes } = req.body;
      const currentUser = req.user!;
      const now = new Date().toISOString();

      const failureResolution = {
        action,
        notes: notes || undefined,
        resolvedById: currentUser.id,
        resolvedByName: currentUser.name,
        resolvedAt: now,
      };

      await pipCol.updateOne({ id: pip.id }, { $set: { failureResolution, updatedAt: now } });

      await recordAuditLog(
        currentUser.id,
        currentUser.name,
        currentUser.role,
        'PERFORMANCE_IMPROVEMENT_PLAN',
        'RESOLVE_FAILURE',
        pip.id,
        '',
        action,
        `Recorded next-step decision "${action}" for ${pip.employeeName}'s failed PIP.${notes ? ` Notes: ${notes}` : ''}`
      );

      const updated = await pipCol.findOne({ id: pip.id });
      res.json(updated);
    } catch (error: any) {
      console.error('Error resolving PIP failure:', error);
      res.status(500).json({ error: 'Failed to record failure resolution.' });
    }
  }
);

// ==========================================
// Helpers
// ==========================================

async function notifyPipPublished(pip: PerformanceImprovementPlan) {
  const notifCol = getDbCollection('notifications');
  const now = new Date().toISOString();

  await notifCol.insertOne({
    id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    userId: pip.employeeId,
    userRole: 'EMPLOYEE',
    type: 'PIP_ASSIGNED',
    title: 'Performance Improvement Plan Started',
    message: `A performance improvement plan has been started for you, running from ${new Date(pip.startDate).toLocaleDateString()} to ${new Date(pip.endDate).toLocaleDateString()}. Please review and acknowledge it.`,
    isRead: false,
    priority: 'HIGH',
    metadata: { pipId: pip.id },
    createdAt: now,
  });

  const notifyTargets = [pip.managerId, pip.hodId].filter(Boolean) as string[];
  for (const targetId of notifyTargets) {
    await notifCol.insertOne({
      id: `notif_${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${targetId}`,
      userId: targetId,
      type: 'PIP_ASSIGNED',
      title: `Improvement Plan Started: ${pip.employeeName}`,
      message: `A performance improvement plan has been started for ${pip.employeeName} (${pip.employeeCode}), running until ${new Date(pip.endDate).toLocaleDateString()}.`,
      isRead: false,
      metadata: { pipId: pip.id },
      createdAt: now,
    });
  }
}
