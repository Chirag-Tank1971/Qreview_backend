import cron from 'node-cron';
import { getDbCollection } from '../db.js';
import { ReviewPeriod, EmployeeReview, Employee, Cycle, PerformanceImprovementPlan } from '../../src/types/index.js';
import { syncAllActiveEmployees } from '../syncHelpers.js';

// Captured before server.ts's production log-silencing override runs (ES module imports
// evaluate before the importing module's own top-level code), so these stay callable even
// though console.log/warn get monkey-patched to a noop in production for everything else.
const rawLog = console.log.bind(console);
const rawWarn = console.warn.bind(console);
const rawError = console.error.bind(console);

// Scheduler logs are intentionally the inverse of the app-wide convention: silent in
// development, visible in production (so cron activity is auditable in prod without
// cluttering local dev output).
const isProductionEnv = process.env.NODE_ENV === 'production';

function logJob(job: string, message: string): void {
  if (!isProductionEnv) return;
  rawLog(`[${new Date().toISOString()}] [Scheduler:${job}] ${message}`);
}

function warnJob(job: string, message: string): void {
  if (!isProductionEnv) return;
  rawWarn(`[${new Date().toISOString()}] [Scheduler:${job}] ${message}`);
}

function errorJob(job: string, message: string, err: any): void {
  if (!isProductionEnv) return;
  rawError(`[${new Date().toISOString()}] [Scheduler:${job}] ${message}:`, err?.message ?? err);
}

/**
 * Production Background Scheduler using node-cron
 * Handles automated workflow execution, reminder dispatches, and deadline escalations
 */
export function startBackgroundScheduler(): void {
  logJob('Init', 'Initializing automated background cron tasks...');

  // 0. Daily at 07:00 AM: Auto-generate quarterly reviews for any employee who has newly
  // become eligible (KRA assigned, tenure now met, manager assigned, etc.) without requiring
  // HR to save their record or click "Sync" manually. Runs before the 08:00/08:30 reminder
  // jobs below so anyone picked up today is included in those same-day reminders.
  cron.schedule('0 7 * * *', async () => {
    const job = 'DailyEligibilitySync';
    const startedAt = Date.now();
    logJob(job, 'Started — running daily automatic review/appraisal eligibility sync...');
    try {
      const { employeesProcessed } = await syncAllActiveEmployees();
      logJob(job, `Completed in ${Date.now() - startedAt}ms — re-evaluated ${employeesProcessed} active/probation employees.`);
    } catch (err: any) {
      errorJob(job, `Failed after ${Date.now() - startedAt}ms`, err);
    }
  });

  // 1. Daily at 08:00 AM: Check and send evaluation reminders to managers for pending reviews
  cron.schedule('0 8 * * *', async () => {
    const job = 'ManagerReviewReminder';
    const startedAt = Date.now();
    logJob(job, 'Started — running daily manager review reminder job...');
    try {
      const reviewCol = getDbCollection('employeeReviews');
      const notifCol = getDbCollection('notifications');
      const periodCol = getDbCollection('reviewPeriods');

      const activePeriod: ReviewPeriod | null = await periodCol.findOne({ status: 'ACTIVE' });
      if (!activePeriod) {
        logJob(job, `Skipped in ${Date.now() - startedAt}ms — no active review period.`);
        return;
      }

      const pendingReviews: EmployeeReview[] = await (
        await reviewCol.find({
          reviewPeriodId: activePeriod.id,
          status: 'MANAGER_PENDING',
        })
      ).toArray();

      const managerMap = new Map<string, number>();
      pendingReviews.forEach((r) => {
        if (r.managerId) {
          managerMap.set(r.managerId, (managerMap.get(r.managerId) || 0) + 1);
        }
      });

      const now = new Date().toISOString();
      for (const [managerId, count] of managerMap.entries()) {
        await notifCol.insertOne({
          id: `notif_remind_${managerId}_${Date.now()}`,
          userId: managerId,
          userRole: 'MANAGER',
          type: 'REMINDER',
          title: `Action Required: ${count} Pending Reviews for ${activePeriod.name}`,
          message: `You have ${count} pending quarterly performance reviews awaiting evaluation in ${activePeriod.name}. Please submit before the deadline.`,
          isRead: false,
          priority: 'HIGH',
          metadata: { periodId: activePeriod.id, pendingCount: count },
          createdAt: now,
        });
      }

      logJob(job, `Completed in ${Date.now() - startedAt}ms — reminders sent to ${managerMap.size} managers for ${pendingReviews.length} pending reviews.`);
    } catch (err: any) {
      errorJob(job, `Failed after ${Date.now() - startedAt}ms`, err);
    }
  });

  // Daily at 08:30 AM: Send self-assessment reminders to employees for pending reviews in active periods
  cron.schedule('30 8 * * *', async () => {
    const job = 'EmployeeSelfAssessmentReminder';
    const startedAt = Date.now();
    logJob(job, 'Started — running daily employee self-assessment reminder job...');
    try {
      const reviewCol = getDbCollection('employeeReviews');
      const notifCol = getDbCollection('notifications');
      const periodCol = getDbCollection('reviewPeriods');

      const activePeriod: ReviewPeriod | null = await periodCol.findOne({ status: 'ACTIVE' });
      if (!activePeriod) {
        logJob(job, `Skipped in ${Date.now() - startedAt}ms — no active review period.`);
        return;
      }

      const pendingReviews: EmployeeReview[] = await (
        await reviewCol.find({
          reviewPeriodId: activePeriod.id,
          isClosed: { $ne: true },
          status: { $in: ['ASSIGNED', 'DRAFT', 'MANAGER_PENDING', 'SELF_ASSESSMENT_DUE', 'OPEN'] },
          isSelfSubmitted: { $ne: true },
        })
      ).toArray();

      const now = new Date().toISOString();
      let sentCount = 0;
      for (const rev of pendingReviews) {
        if (!rev.employeeId) continue;
        const notifId = `notif_self_remind_${rev.id}`;
        const existing = await notifCol.findOne({
          $or: [
            { id: notifId },
            { 'metadata.reviewId': rev.id, userId: rev.employeeId, type: 'REVIEW_ASSIGNED' },
          ],
        });
        if (!existing) {
          await notifCol.insertOne({
            id: notifId,
            userId: rev.employeeId,
            userRole: 'EMPLOYEE',
            type: 'REVIEW_ASSIGNED',
            title: `Action Required: Self-Assessment Due for ${activePeriod.name}`,
            message: `Your quarterly self-evaluation for ${activePeriod.name} is awaiting completion. Please submit your KRA self-ratings.`,
            isRead: false,
            priority: 'HIGH',
            metadata: { reviewId: rev.id, periodId: activePeriod.id, subTab: 'reviews', openSelfAssess: true },
            createdAt: now,
          });
          sentCount++;
        }
      }
      logJob(job, `Completed in ${Date.now() - startedAt}ms — dispatched ${sentCount} employee self-assessment reminders.`);
    } catch (err: any) {
      errorJob(job, `Failed after ${Date.now() - startedAt}ms`, err);
    }
  });

  // 2. Daily at 09:00 AM: Check for overdue reviews past dueDate and escalate to HR / HOD
  cron.schedule('0 9 * * *', async () => {
    const job = 'OverdueReviewEscalation';
    const startedAt = Date.now();
    logJob(job, 'Started — checking for overdue reviews past submission deadline...');
    try {
      const reviewCol = getDbCollection('employeeReviews');
      const periodCol = getDbCollection('reviewPeriods');
      const notifCol = getDbCollection('notifications');

      const activePeriod: ReviewPeriod | null = await periodCol.findOne({ status: 'ACTIVE' });
      if (!activePeriod || !activePeriod.dueDate) {
        logJob(job, `Skipped in ${Date.now() - startedAt}ms — no active review period or due date set.`);
        return;
      }

      const dueDate = new Date(activePeriod.dueDate).getTime();
      const now = Date.now();

      if (now > dueDate) {
        const overdueReviews: EmployeeReview[] = await (
          await reviewCol.find({
            reviewPeriodId: activePeriod.id,
            status: { $in: ['MANAGER_PENDING', 'DRAFT', 'RETURNED', 'HOD_PENDING'] },
          })
        ).toArray();

        if (overdueReviews.length > 0) {
          warnJob(job, `Detected ${overdueReviews.length} overdue reviews past deadline ${activePeriod.dueDate}!`);
          await notifCol.insertOne({
            id: `notif_escalation_${Date.now()}`,
            userId: 'ALL',
            userRole: 'HR',
            type: 'ESCALATION',
            title: `Deadline Passed: ${overdueReviews.length} Overdue Reviews`,
            message: `${overdueReviews.length} employee evaluations for ${activePeriod.name} remain unsubmitted past the due date (${new Date(activePeriod.dueDate).toLocaleDateString()}). HR intervention recommended.`,
            isRead: false,
            priority: 'HIGH',
            metadata: { periodId: activePeriod.id, overdueCount: overdueReviews.length },
            createdAt: new Date().toISOString(),
          });

          // Escalate overdue HOD-stage reviews directly to the specific HOD, not just HR.
          const overdueHodReviews = overdueReviews.filter((r) => r.status === 'HOD_PENDING' && r.hodId);
          for (const r of overdueHodReviews) {
            await notifCol.updateOne(
              { 'metadata.reviewId': r.id, type: 'ESCALATION', userId: r.hodId },
              {
                $set: {
                  id: `notif_escalation_hod_${r.id}`,
                  userId: r.hodId,
                  userRole: 'HOD',
                  type: 'ESCALATION',
                  title: `Overdue: HOD Review Pending for ${r.employeeName}`,
                  message: `The ${activePeriod.name} review for ${r.employeeName} has been awaiting your approval past the due date (${new Date(activePeriod.dueDate).toLocaleDateString()}).`,
                  isRead: false,
                  priority: 'HIGH',
                  metadata: { reviewId: r.id, periodId: activePeriod.id, status: 'HOD_PENDING' },
                  createdAt: new Date().toISOString(),
                },
              },
              { upsert: true }
            );
          }
        }
        logJob(job, `Completed in ${Date.now() - startedAt}ms — ${overdueReviews.length} overdue reviews escalated.`);
      } else {
        logJob(job, `Completed in ${Date.now() - startedAt}ms — due date not yet passed.`);
      }
    } catch (err: any) {
      errorJob(job, `Failed after ${Date.now() - startedAt}ms`, err);
    }
  });

  // 3. Monthly on the 1st at 06:00 AM: Notify HR and managers of employees due for annual appraisal
  cron.schedule('0 6 1 * *', async () => {
    const job = 'MonthlyAppraisalCohortCheck';
    const startedAt = Date.now();
    logJob(job, 'Started — running monthly appraisal cohort eligibility check...');
    try {
      const currentMonth = new Date().getMonth() + 1;
      const currentYear = new Date().getFullYear();

      const cycleCol = getDbCollection('cycles');
      const empCol = getDbCollection('employees');
      const notifCol = getDbCollection('notifications');

      const cycles: Cycle[] = await (
        await cycleCol.find({ appraisalMonth: currentMonth, active: { $ne: false } })
      ).toArray();
      if (cycles.length === 0) {
        logJob(job, `Skipped in ${Date.now() - startedAt}ms — no cycles due for appraisal this month.`);
        return;
      }

      const cycleIds = new Set(cycles.map((c) => c.id));
      const cycleCodes = new Set(cycles.map((c) => c.code));

      const employees: Employee[] = await (await empCol.find({ status: 'ACTIVE' })).toArray();
      const dueEmployees = employees.filter(
        (e) => (e.cycleId && cycleIds.has(e.cycleId)) || (e.cycleCode && cycleCodes.has(e.cycleCode))
      );

      if (dueEmployees.length > 0) {
        const cycleNames = cycles.map((c) => c.name).join(', ');
        await notifCol.insertOne({
          id: `notif_appraisal_cohort_${currentMonth}_${Date.now()}`,
          userId: 'ALL',
          userRole: 'HR',
          type: 'APPRAISAL_DUE',
          title: `Annual Appraisal Due: ${dueEmployees.length} Employees (${cycleNames})`,
          message: `${dueEmployees.length} active employees in ${cycleNames} are due for annual salary appraisals this month (Month ${currentMonth}). Cohort review is ready to be initiated.`,
          isRead: false,
          priority: 'HIGH',
          metadata: { month: currentMonth, year: currentYear, count: dueEmployees.length },
          createdAt: new Date().toISOString(),
        });
        logJob(job, `Completed in ${Date.now() - startedAt}ms — appraisal cohort notification sent for ${dueEmployees.length} employees due in month ${currentMonth}.`);
      } else {
        logJob(job, `Completed in ${Date.now() - startedAt}ms — no employees due in month ${currentMonth}.`);
      }
    } catch (err: any) {
      errorJob(job, `Failed after ${Date.now() - startedAt}ms`, err);
    }
  });

  // 4. Daily at 08:45 AM: Remind the manager/HOD of any employee on an active PIP if no
  // check-in has been logged in the last 7 days — keeps the plan from going silently stale.
  cron.schedule('45 8 * * *', async () => {
    const job = 'PipCheckInReminder';
    const startedAt = Date.now();
    logJob(job, 'Started — running daily PIP check-in reminder job...');
    try {
      const pipCol = getDbCollection('performanceImprovementPlans');
      const notifCol = getDbCollection('notifications');

      const activePips: PerformanceImprovementPlan[] = await (
        await pipCol.find({ status: { $in: ['ACTIVE', 'EXTENDED'] } })
      ).toArray();

      const CHECKIN_REMINDER_THRESHOLD_DAYS = 7;
      const now = Date.now();
      const todayKey = new Date().toISOString().slice(0, 10);
      let remindersSent = 0;

      for (const pip of activePips) {
        const lastCheckIn = pip.checkIns.length > 0 ? pip.checkIns[pip.checkIns.length - 1] : null;
        const lastActivityDate = new Date(lastCheckIn ? lastCheckIn.date : pip.startDate).getTime();
        const daysSinceLastCheckIn = (now - lastActivityDate) / (1000 * 60 * 60 * 24);
        if (daysSinceLastCheckIn < CHECKIN_REMINDER_THRESHOLD_DAYS) continue;

        const recipients = [
          pip.managerId ? { id: pip.managerId, role: 'MANAGER' as const } : null,
          pip.hodId && pip.hodId !== pip.managerId ? { id: pip.hodId, role: 'HOD' as const } : null,
        ].filter((r): r is { id: string; role: 'MANAGER' | 'HOD' } => !!r);

        for (const recipient of recipients) {
          const notifId = `notif_pip_checkin_${pip.id}_${recipient.id}_${todayKey}`;
          const existing = await notifCol.findOne({ id: notifId });
          if (existing) continue;
          await notifCol.insertOne({
            id: notifId,
            userId: recipient.id,
            userRole: recipient.role,
            type: 'REMINDER',
            title: `Check-In Overdue: ${pip.employeeName}'s Performance Plan`,
            message: `No check-in has been logged for ${pip.employeeName}'s performance improvement plan in ${Math.floor(daysSinceLastCheckIn)} days. Regular check-ins are required to track progress.`,
            isRead: false,
            priority: 'HIGH',
            metadata: { pipId: pip.id, employeeId: pip.employeeId, subTab: 'pip' },
            createdAt: new Date().toISOString(),
          });
          remindersSent++;
        }
      }
      logJob(job, `Completed in ${Date.now() - startedAt}ms — dispatched ${remindersSent} PIP check-in reminders (${activePips.length} active PIPs checked).`);
    } catch (err: any) {
      errorJob(job, `Failed after ${Date.now() - startedAt}ms`, err);
    }
  });

  // 5. Daily at 09:15 AM: Escalate to HR any PIP that has passed its end date without a
  // recorded outcome (SUCCEEDED/FAILED/EXTENDED) — prevents plans from silently expiring
  // unresolved, which matters if a later termination is ever challenged.
  cron.schedule('15 9 * * *', async () => {
    const job = 'PipOutcomeEscalation';
    const startedAt = Date.now();
    logJob(job, 'Started — checking for PIPs past end date with no recorded outcome...');
    try {
      const pipCol = getDbCollection('performanceImprovementPlans');
      const notifCol = getDbCollection('notifications');

      const activePips: PerformanceImprovementPlan[] = await (
        await pipCol.find({ status: { $in: ['ACTIVE', 'EXTENDED'] } })
      ).toArray();

      const now = Date.now();
      const overduePips = activePips.filter((p) => new Date(p.endDate).getTime() < now);

      if (overduePips.length > 0) {
        const todayKey = new Date().toISOString().slice(0, 10);
        const notifId = `notif_pip_outcome_escalation_${todayKey}`;
        const existing = await notifCol.findOne({ id: notifId });
        if (!existing) {
          await notifCol.insertOne({
            id: notifId,
            userId: 'ALL',
            userRole: 'HR',
            type: 'ESCALATION',
            title: `Action Required: ${overduePips.length} Performance Plan(s) Past End Date`,
            message: `${overduePips.length} performance improvement plan(s) have passed their scheduled end date without a recorded outcome: ${overduePips.map((p) => p.employeeName).join(', ')}. Please review and record Succeeded/Failed/Extended.`,
            isRead: false,
            priority: 'HIGH',
            metadata: { pipIds: overduePips.map((p) => p.id), overdueCount: overduePips.length, subTab: 'pip' },
            createdAt: new Date().toISOString(),
          });
          warnJob(job, `Escalated ${overduePips.length} PIPs past end date with no outcome to HR.`);
          logJob(job, `Completed in ${Date.now() - startedAt}ms — ${overduePips.length} PIPs escalated.`);
        } else {
          logJob(job, `Completed in ${Date.now() - startedAt}ms — escalation already sent today.`);
        }
      } else {
        logJob(job, `Completed in ${Date.now() - startedAt}ms — no overdue PIPs found.`);
      }
    } catch (err: any) {
      errorJob(job, `Failed after ${Date.now() - startedAt}ms`, err);
    }
  });

  logJob('Init', 'All background jobs scheduled successfully.');
}
