import cron from 'node-cron';
import { getDbCollection } from '../db.js';
import { ReviewPeriod, EmployeeReview, Employee, Cycle } from '../../src/types/index.js';

/**
 * Production Background Scheduler using node-cron
 * Handles automated workflow execution, reminder dispatches, and deadline escalations
 */
export function startBackgroundScheduler(): void {
  console.log('[Scheduler] Initializing automated background cron tasks...');

  // 1. Daily at 08:00 AM: Check and send evaluation reminders to managers for pending reviews
  cron.schedule('0 8 * * *', async () => {
    try {
      console.log('[Scheduler] Running daily manager review reminder job...');
      const reviewCol = getDbCollection('employeeReviews');
      const notifCol = getDbCollection('notifications');
      const periodCol = getDbCollection('reviewPeriods');

      const activePeriod: ReviewPeriod | null = await periodCol.findOne({ status: 'ACTIVE' });
      if (!activePeriod) return;

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

      console.log(`[Scheduler] Reminders sent to ${managerMap.size} managers for ${pendingReviews.length} pending reviews.`);
    } catch (err: any) {
      console.error('[Scheduler] Error in manager reminder job:', err.message);
    }
  });

  // Daily at 08:30 AM: Send self-assessment reminders to employees for pending reviews in active periods
  cron.schedule('30 8 * * *', async () => {
    try {
      console.log('[Scheduler] Running daily employee self-assessment reminder job...');
      const reviewCol = getDbCollection('employeeReviews');
      const notifCol = getDbCollection('notifications');
      const periodCol = getDbCollection('reviewPeriods');

      const activePeriod: ReviewPeriod | null = await periodCol.findOne({ status: 'ACTIVE' });
      if (!activePeriod) return;

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
      console.log(`[Scheduler] Dispatched ${sentCount} employee self-assessment reminders.`);
    } catch (err: any) {
      console.error('[Scheduler] Error in employee self-assessment reminder job:', err.message);
    }
  });

  // 2. Daily at 09:00 AM: Check for overdue reviews past dueDate and escalate to HR / HOD
  cron.schedule('0 9 * * *', async () => {
    try {
      console.log('[Scheduler] Checking for overdue reviews past submission deadline...');
      const reviewCol = getDbCollection('employeeReviews');
      const periodCol = getDbCollection('reviewPeriods');
      const notifCol = getDbCollection('notifications');

      const activePeriod: ReviewPeriod | null = await periodCol.findOne({ status: 'ACTIVE' });
      if (!activePeriod || !activePeriod.dueDate) return;

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
          console.warn(`[Scheduler] Detected ${overdueReviews.length} overdue reviews past deadline ${activePeriod.dueDate}!`);
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
      }
    } catch (err: any) {
      console.error('[Scheduler] Error in overdue escalation job:', err.message);
    }
  });

  // 3. Monthly on the 1st at 06:00 AM: Notify HR and managers of employees due for annual appraisal
  cron.schedule('0 6 1 * *', async () => {
    try {
      console.log('[Scheduler] Running monthly appraisal cohort eligibility check...');
      const currentMonth = new Date().getMonth() + 1;
      const currentYear = new Date().getFullYear();

      const cycleCol = getDbCollection('cycles');
      const empCol = getDbCollection('employees');
      const notifCol = getDbCollection('notifications');

      const cycles: Cycle[] = await (
        await cycleCol.find({ appraisalMonth: currentMonth, active: { $ne: false } })
      ).toArray();
      if (cycles.length === 0) return;

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
        console.log(`[Scheduler] Appraisal cohort notification sent for ${dueEmployees.length} employees due in month ${currentMonth}.`);
      }
    } catch (err: any) {
      console.error('[Scheduler] Error in monthly appraisal check:', err.message);
    }
  });

  console.log('[Scheduler] All background jobs scheduled successfully.');
}
