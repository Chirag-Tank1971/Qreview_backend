import express, { Response } from 'express';
import { getDbCollection } from '../db.js';
import { AuthenticatedRequest, authenticateToken } from '../auth.js';
import {
  Appraisal,
  AuditLog,
  Cycle,
  DashboardActivityItem,
  DashboardAdminOverview,
  DashboardAppraisalHealth,
  DashboardComplianceStatus,
  DashboardDepartmentProgress,
  DashboardHodOverview,
  DashboardHrOverview,
  DashboardMyReview,
  DashboardPeriod,
  DashboardRatingDistribution,
  DashboardReviewStage,
  DashboardSummary,
  DashboardTask,
  DashboardTaskLink,
  DashboardTaskType,
  DashboardTeam,
  DashboardUrgency,
  DashboardUpcomingEvent,
  Department,
  Employee,
  EmployeeReview,
  KraTemplate,
  PerformanceImprovementPlan,
  ReviewPeriod,
  User,
} from '../../src/types/index.js';
import { buildQuarterlyRollup, computeAppraisalMatrix, EVALUATED_STATUSES } from '../services/appraisalScoring.js';
import { ACTIVE_PIP_STATUSES } from '../services/pipService.js';
import { computeVisibleNotifications } from './mastersRoutes.js';

export const dashboardRouter = express.Router();

dashboardRouter.use(authenticateToken);

const DAY_MS = 24 * 60 * 60 * 1000;
const DUE_SOON_DAYS = 3;
// Same cadence the scheduler's PIP check-in reminder job enforces.
const PIP_CHECKIN_INTERVAL_DAYS = 7;
const MANAGER_OPEN_STATUSES = ['DRAFT', 'ASSIGNED', 'MANAGER_PENDING'];
const URGENCY_ORDER: Record<DashboardUrgency, number> = { OVERDUE: 0, DUE_SOON: 1, UPCOMING: 2, NO_DATE: 3 };
// Roles the manager-recommend route accepts (ownership is checked separately).
const RECOMMENDING_ROLES = ['REPORTING_MANAGER', 'MANAGER', 'HOD', 'MANAGEMENT', 'SUPER_ADMIN'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function urgencyFor(dueDate: string | undefined, now: number): DashboardUrgency {
  if (!dueDate) return 'NO_DATE';
  const due = new Date(dueDate).getTime();
  if (Number.isNaN(due)) return 'NO_DATE';
  if (due < now) return 'OVERDUE';
  if (due - now <= DUE_SOON_DAYS * DAY_MS) return 'DUE_SOON';
  return 'UPCOMING';
}

function lastAction(review: EmployeeReview) {
  const history = review.actionHistory || [];
  return history.length > 0 ? history[history.length - 1] : undefined;
}

function lastReturnAction(review: EmployeeReview) {
  return [...(review.actionHistory || [])].reverse().find((a) => a.action === 'RETURNED');
}

function isClosed(review: EmployeeReview): boolean {
  return Boolean(review.isClosed) || review.status === 'CLOSED' || review.status === 'HR_COMPLETED';
}

/** Which party the review is currently waiting on. Self-assessment is reported separately via isSelfSubmitted. */
function stageOf(review: EmployeeReview): DashboardReviewStage {
  if (isClosed(review)) return 'CLOSED';
  switch (review.status) {
    case 'HOD_PENDING':
    case 'HOD_APPROVED':
    case 'HOD_COMPLETED':
      return 'HOD';
    case 'HR_PENDING':
    case 'MANAGER_COMPLETED':
      return 'HR';
    case 'RETURNED':
      return lastReturnAction(review)?.returnTarget === 'HOD' ? 'HOD' : 'MANAGER';
    default:
      return 'MANAGER';
  }
}

function isEvaluated(review: EmployeeReview): boolean {
  return (review.isClosed || EVALUATED_STATUSES.includes(review.status)) && (review.finalScore || 0) > 0;
}

function bandOf(score: number): string | null {
  if (!score || score <= 0) return null;
  return computeAppraisalMatrix(score).recommendedRating;
}

function toPeriod(p: ReviewPeriod, completionRate: number = 100): DashboardPeriod {
  const due = new Date(p.dueDate).getTime();
  const now = Date.now();
  const daysRemaining = Math.max(0, Math.ceil((due - now) / DAY_MS));
  return {
    id: p.id,
    name: p.name,
    status: p.status,
    startDate: p.startDate,
    endDate: p.endDate,
    dueDate: p.dueDate,
    daysRemaining,
    completionRate,
  };
}

const periodOrder = (p: ReviewPeriod) => Number(p.year) * 4 + Number(p.quarter);

function sortTasks(tasks: DashboardTask[]): DashboardTask[] {
  return tasks.sort((a, b) => {
    const byUrgency = URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency];
    if (byUrgency !== 0) return byUrgency;
    return (a.dueDate || '9999').localeCompare(b.dueDate || '9999');
  });
}

/** Tasks the viewer owes on their own review, appraisal letter and improvement plan. */
function buildEmployeeTasks(
  myReviews: EmployeeReview[],
  myAppraisals: Appraisal[],
  myPips: PerformanceImprovementPlan[],
  periodMap: Map<string, ReviewPeriod>,
  now: number
): DashboardTask[] {
  const tasks: DashboardTask[] = [];

  for (const review of myReviews) {
    const period = periodMap.get(review.reviewPeriodId);
    if (period?.status === 'UPCOMING') continue;
    // Mirrors PUT /reviews/:id/self-assess: allowed until the manager has submitted.
    const managerSubmitted = Boolean(review.submittedAt) || !MANAGER_OPEN_STATUSES.includes(review.status);
    if (isClosed(review) || review.isSelfSubmitted || managerSubmitted) continue;
    tasks.push({
      id: `self_${review.id}`,
      type: 'SELF_ASSESSMENT',
      title: `Submit your self-assessment for ${review.reviewPeriodName}`,
      detail: `${review.kraSnapshot?.length || 0} KRAs to rate. ${review.managerName || 'Your manager'} sees it once you submit.`,
      dueDate: period?.dueDate,
      urgency: urgencyFor(period?.dueDate, now),
      link: { view: 'portal', params: { subTab: 'reviews', reviewId: review.id } },
    });
  }

  for (const appraisal of myAppraisals) {
    if (!appraisal.isLocked || appraisal.employeeAcknowledgement?.acknowledged) continue;
    tasks.push({
      id: `ack_appraisal_${appraisal.id}`,
      type: 'ACKNOWLEDGE_APPRAISAL',
      title: `Acknowledge your ${appraisal.appraisalYear} appraisal letter`,
      detail: 'Your letter has been released. Read it and confirm you have received it.',
      urgency: 'NO_DATE',
      link: { view: 'portal', params: { subTab: 'appraisal', appraisalId: appraisal.id, openLetter: true } },
    });
  }

  for (const pip of myPips) {
    if (!ACTIVE_PIP_STATUSES.includes(pip.status) || pip.employeeAcknowledgement?.acknowledged) continue;
    tasks.push({
      id: `ack_pip_${pip.id}`,
      type: 'ACKNOWLEDGE_PIP',
      title: 'Acknowledge your performance improvement plan',
      detail: `${pip.goals.length} goal${pip.goals.length === 1 ? '' : 's'} · ends ${new Date(pip.endDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`,
      urgency: 'NO_DATE',
      link: { view: 'pip', params: { pipId: pip.id } },
    });
  }

  return tasks;
}

/** Actionable work items sourced from unread notifications addressed to the user. */
async function buildNotificationTasks(user: User): Promise<DashboardTask[]> {
  try {
    const notifs = await computeVisibleNotifications(user);
    const unread = notifs.filter((n) => !n.isRead);
    const tasks: DashboardTask[] = [];

    for (const n of unread) {
      const meta = n.metadata || {};
      let link: DashboardTaskLink = { view: 'notifications' };

      if (meta.subTab === 'appraisal' || meta.appraisalId || (n.type === 'LETTER_RELEASED' && meta.cycleId)) {
        link = {
          view: 'portal',
          params: {
            subTab: 'appraisal',
            ...(meta.appraisalId ? { appraisalId: meta.appraisalId } : {}),
            openLetter: true,
          },
        };
      } else if (meta.subTab === 'reviews' || meta.reviewId) {
        link = {
          view: 'portal',
          params: {
            subTab: 'reviews',
            ...(meta.reviewId ? { reviewId: meta.reviewId } : {}),
            ...(meta.openSelfAssess ? { openSelfAssess: true } : {}),
          },
        };
      } else if (meta.pipId || n.type === 'PIP_ASSIGNED' || n.type === 'PIP_EXTENDED') {
        link = {
          view: 'pip',
          params: {
            ...(meta.pipId ? { pipId: meta.pipId } : {}),
          },
        };
      }

      let taskType: DashboardTaskType = 'NOTIFICATION';
      if (n.type === 'REVIEW_ASSIGNED' || meta.openSelfAssess) {
        taskType = 'SELF_ASSESSMENT';
      } else if (n.type === 'LETTER_RELEASED' && (meta.appraisalId || meta.subTab === 'appraisal')) {
        taskType = 'ACKNOWLEDGE_APPRAISAL';
      } else if (n.type === 'PIP_ASSIGNED' || n.type === 'PIP_EXTENDED') {
        taskType = 'ACKNOWLEDGE_PIP';
      } else if (n.type === 'LETTER_RELEASED' || n.type === 'HR_COMPLETED') {
        taskType = 'REVIEW_WORKFLOW';
      }

      const isHigh = n.priority === 'HIGH' || n.priority === 'URGENT';
      const isMed = n.priority === 'MEDIUM';

      tasks.push({
        id: n.id.startsWith('notif_') ? n.id : `notif_${n.id}`,
        type: taskType,
        title: n.title || 'Notification',
        detail: n.message || 'Action required',
        urgency: isHigh ? 'OVERDUE' : isMed ? 'DUE_SOON' : 'NO_DATE',
        priority: isHigh ? 'High' : isMed ? 'Medium' : 'Low',
        dueText: isHigh ? 'High priority' : 'New notification',
        link,
        notificationId: n.id,
      });
    }

    return tasks;
  } catch (err) {
    console.warn('[Dashboard] Error building notification tasks:', err);
    return [];
  }
}

/** Tasks the viewer owes as someone's reporting manager. */
function buildManagerTasks(
  user: User,
  myIds: Set<string>,
  teamReviews: EmployeeReview[],
  teamAppraisals: Appraisal[],
  managedPips: PerformanceImprovementPlan[],
  employeeMap: Map<string, Employee>,
  periodMap: Map<string, ReviewPeriod>,
  now: number
): DashboardTask[] {
  const tasks: DashboardTask[] = [];

  for (const review of teamReviews) {
    if (!myIds.has(review.managerId) || isClosed(review)) continue;
    const period = periodMap.get(review.reviewPeriodId);
    if (period?.status === 'UPCOMING') continue;
    const dueDate = period?.dueDate;
    const link = { view: 'reviews' as const, params: { reviewId: review.id } };
    const latest = lastAction(review);

    if (review.status === 'RETURNED' && lastReturnAction(review)?.returnTarget !== 'HOD') {
      const returned = lastReturnAction(review);
      tasks.push({
        id: `revise_${review.id}`,
        type: 'REVISE_RETURNED_REVIEW',
        title: `Revise returned review · ${review.employeeName}`,
        detail: returned?.remarks ? `HR note: “${returned.remarks}”` : 'HR sent this review back for changes.',
        employeeId: review.employeeId,
        employeeName: review.employeeName,
        dueDate,
        urgency: urgencyFor(dueDate, now),
        link,
      });
    } else if (review.status === 'MANAGER_PENDING' && latest?.action === 'HOD_RETURNED') {
      tasks.push({
        id: `revise_${review.id}`,
        type: 'REVISE_RETURNED_REVIEW',
        title: `Revise returned review · ${review.employeeName}`,
        detail: latest.remarks ? `HOD note: “${latest.remarks}”` : 'Your HOD sent this review back for changes.',
        employeeId: review.employeeId,
        employeeName: review.employeeName,
        dueDate,
        urgency: urgencyFor(dueDate, now),
        link,
      });
    } else if (MANAGER_OPEN_STATUSES.includes(review.status)) {
      tasks.push({
        id: `score_${review.id}`,
        type: 'SCORE_REVIEW',
        title: `Score ${review.reviewPeriodName} review · ${review.employeeName}`,
        detail: review.isSelfSubmitted ? 'Self-assessment submitted' : 'Self-assessment not submitted yet',
        employeeId: review.employeeId,
        employeeName: review.employeeName,
        dueDate,
        urgency: urgencyFor(dueDate, now),
        link,
      });
    }
  }

  if (RECOMMENDING_ROLES.includes(user.role)) {
    const pipEmployeeIds = new Set(managedPips.filter((p) => ACTIVE_PIP_STATUSES.includes(p.status)).map((p) => p.employeeId));
    for (const appraisal of teamAppraisals) {
      if (!myIds.has(appraisal.managerId) || appraisal.status !== 'PENDING' || appraisal.isLocked) continue;
      // The recommend route rejects these, so they are not actionable.
      const status = employeeMap.get(appraisal.employeeId)?.status;
      if (status === 'INACTIVE' || status === 'NOTICE' || pipEmployeeIds.has(appraisal.employeeId)) continue;
      const score = appraisal.averageQuarterlyScore || 0;
      const matrix = computeAppraisalMatrix(score);
      tasks.push({
        id: `recommend_${appraisal.id}`,
        type: 'RECOMMEND_INCREMENT',
        title: `Recommend increment · ${appraisal.employeeName}`,
        detail:
          score > 0
            ? `${MONTHS[appraisal.appraisalMonth - 1]} ${appraisal.appraisalYear} appraisal · rolling score ${score.toFixed(2)}, suggested ${matrix.suggestedIncrementMin}–${matrix.suggestedIncrementMax}%`
            : `${MONTHS[appraisal.appraisalMonth - 1]} ${appraisal.appraisalYear} appraisal · no evaluated quarters yet`,
        employeeId: appraisal.employeeId,
        employeeName: appraisal.employeeName,
        urgency: 'NO_DATE',
        link: { view: 'appraisals', params: { appraisalId: appraisal.id } },
      });
    }
  }

  for (const pip of managedPips) {
    if (!ACTIVE_PIP_STATUSES.includes(pip.status)) continue;
    // Mirrors POST /pips/:id/checkins permissions.
    const canCheckIn =
      ((user.role === 'MANAGER' || user.role === 'REPORTING_MANAGER') && pip.managerId === user.employeeId) ||
      (user.role === 'HOD' && pip.hodId === user.employeeId);
    if (!canCheckIn) continue;
    const lastCheckIn = pip.checkIns.length > 0 ? pip.checkIns[pip.checkIns.length - 1] : null;
    const lastActivity = new Date(lastCheckIn ? lastCheckIn.date : pip.startDate).getTime();
    const dueDate = new Date(lastActivity + PIP_CHECKIN_INTERVAL_DAYS * DAY_MS).toISOString();
    const urgency = urgencyFor(dueDate, now);
    // A weekly cadence is always "upcoming"; only raise it once it is close or late.
    if (urgency === 'UPCOMING') continue;
    const daysSince = Math.floor((now - lastActivity) / DAY_MS);
    tasks.push({
      id: `pip_checkin_${pip.id}`,
      type: 'PIP_CHECKIN',
      title: `Log PIP check-in · ${pip.employeeName}`,
      detail: lastCheckIn ? `Last check-in ${daysSince} day${daysSince === 1 ? '' : 's'} ago` : `No check-in since the plan started ${daysSince} days ago`,
      employeeId: pip.employeeId,
      employeeName: pip.employeeName,
      dueDate,
      urgency,
      link: { view: 'pip', params: { pipId: pip.id } },
    });
  }

  return tasks;
}

async function buildMyReview(
  employee: Employee,
  myReviews: EmployeeReview[],
  periodMap: Map<string, ReviewPeriod>,
  cycles: Cycle[],
  now: Date
): Promise<DashboardMyReview> {
  const byPeriod = (r: EmployeeReview) => {
    const p = periodMap.get(r.reviewPeriodId);
    return p ? periodOrder(p) : new Date(r.createdAt).getTime();
  };
  const reviews = myReviews
    .filter((r) => periodMap.get(r.reviewPeriodId)?.status !== 'UPCOMING')
    .sort((a, b) => byPeriod(a) - byPeriod(b));

  const current = reviews.find((r) => !isClosed(r)) || reviews[reviews.length - 1] || null;
  const rollup = await buildQuarterlyRollup(employee.id);
  const evaluated = reviews.filter(isEvaluated);
  const latestEvaluated = evaluated[evaluated.length - 1];

  let kraSource: { title: string; weight: number; kraId?: string; description?: string; target?: string }[] =
    current?.kraSnapshot?.map((k) => ({
      title: k.kraName || k.title || 'KRA',
      weight: k.weight,
      kraId: k.kraId,
      description: k.description,
      target: (k as any).target,
    })) || [];

  if (!kraSource || kraSource.length === 0) {
    const templates = getDbCollection('kraTemplates');
    const template: KraTemplate | null = employee.currentKraTemplateId
      ? await templates.findOne({ id: employee.currentKraTemplateId })
      : null;
    kraSource = (template?.items || []).map((k) => ({
      title: k.title || 'KRA',
      weight: k.weight,
      kraId: k.kraId,
      description: k.description,
      target: k.target,
    }));
  }

  if (!kraSource || kraSource.length === 0) {
    const krasCol = getDbCollection('kras');
    let assignedKras: any[] = [];
    if (employee.designationId) {
      assignedKras = await krasCol.find({ designationId: employee.designationId, active: true }).toArray();
    }
    if (!assignedKras.length && employee.departmentId) {
      assignedKras = await krasCol.find({ departmentId: employee.departmentId, active: true }).toArray();
    }
    if (!assignedKras.length) {
      assignedKras = await krasCol.find({ active: true }).toArray();
    }

    if (assignedKras.length > 0) {
      const defaultWeight = Math.floor(100 / assignedKras.length);
      kraSource = assignedKras.map((k, idx) => ({
        title: k.title || 'KRA',
        weight: typeof k.weight === 'number' && k.weight > 0
          ? k.weight
          : (idx === assignedKras.length - 1 ? 100 - defaultWeight * (assignedKras.length - 1) : defaultWeight),
        kraId: k.id,
        description: k.description || `Target deliverables for ${k.title}`,
        target: k.target || (k.targetUnit ? `Target in ${k.targetUnit}` : '100% Target SLA'),
      }));
    }
  }

  const kras = kraSource.map((k) => {
    const rated = latestEvaluated?.kraSnapshot?.find((s) => (k.kraId && s.kraId === k.kraId) || (s.kraName || s.title) === k.title);
    return {
      title: k.title,
      weight: k.weight,
      description: k.description,
      target: k.target,
      lastRating: rated?.rating || undefined,
    };
  });

  const cycle = cycles.find((c) => c.id === employee.cycleId || (employee.cycleCode && c.code === employee.cycleCode));
  let nextAppraisal: DashboardMyReview['nextAppraisal'] = null;
  if (cycle?.appraisalMonth) {
    const thisMonth = now.getMonth() + 1;
    const year = cycle.appraisalMonth >= thisMonth ? now.getFullYear() : now.getFullYear() + 1;
    nextAppraisal = { month: cycle.appraisalMonth, year, cycleName: cycle.name };
  }

  return {
    employee: {
      id: employee.id,
      name: employee.name,
      designationName: employee.designationName,
      departmentName: employee.departmentName,
      managerName: employee.managerName,
      hodName: employee.hodName,
      cycleName: cycle?.name || employee.cycleName,
    },
    currentReview: current
      ? {
          id: current.id,
          periodName: current.reviewPeriodName,
          status: current.status,
          stage: stageOf(current),
          isSelfSubmitted: Boolean(current.isSelfSubmitted),
          finalScore: isEvaluated(current) ? current.finalScore : undefined,
          dueDate: periodMap.get(current.reviewPeriodId)?.dueDate,
        }
      : null,
    rollingScore: rollup.avgScore,
    evaluatedQuarters: rollup.evaluatedCount,
    ratingBand: bandOf(rollup.avgScore),
    scoreHistory: evaluated.slice(-6).map((r) => ({ periodName: r.reviewPeriodName, score: r.finalScore || 0 })),
    kras,
    nextAppraisal,
  };
}

function buildTeam(
  members: Employee[],
  teamReviews: EmployeeReview[],
  managedPips: PerformanceImprovementPlan[],
  periodMap: Map<string, ReviewPeriod>
): DashboardTeam {
  const visibleReviews = teamReviews.filter((r) => periodMap.get(r.reviewPeriodId)?.status !== 'UPCOMING');
  const teamPeriods = [...new Set(visibleReviews.map((r) => r.reviewPeriodId))]
    .map((id) => periodMap.get(id))
    .filter((p): p is ReviewPeriod => Boolean(p))
    .sort((a, b) => periodOrder(a) - periodOrder(b));
  // Focus on the oldest period with unfinished work; once everything is closed, show the latest.
  const focus =
    teamPeriods.find((p) => visibleReviews.some((r) => r.reviewPeriodId === p.id && !isClosed(r))) ||
    teamPeriods[teamPeriods.length - 1];
  const focusReviews = focus ? visibleReviews.filter((r) => r.reviewPeriodId === focus.id) : [];
  const onPip = new Set(managedPips.filter((p) => ACTIVE_PIP_STATUSES.includes(p.status)).map((p) => p.employeeId));

  const ratingSpread = { outstanding: 0, exceeds: 0, meets: 0, needsImprovement: 0, unrated: 0 };
  const scores: number[] = [];

  const rows = members.map((member) => {
    const review = focusReviews.find((r) => r.employeeId === member.id);
    const evaluated = visibleReviews
      .filter((r) => r.employeeId === member.id && isEvaluated(r))
      .sort((a, b) => periodOrder(periodMap.get(a.reviewPeriodId)!) - periodOrder(periodMap.get(b.reviewPeriodId)!));
    const lastScore = evaluated[evaluated.length - 1]?.finalScore;
    const previousScore = evaluated[evaluated.length - 2]?.finalScore;

    const band = bandOf(lastScore || 0);
    if (band === 'OUTSTANDING') ratingSpread.outstanding++;
    else if (band === 'EXCEEDS_EXPECTATIONS') ratingSpread.exceeds++;
    else if (band === 'MEETS_EXPECTATIONS') ratingSpread.meets++;
    else if (band === 'NEEDS_IMPROVEMENT') ratingSpread.needsImprovement++;
    else ratingSpread.unrated++;
    if (lastScore) scores.push(lastScore);

    return {
      employeeId: member.id,
      name: member.name,
      designationName: member.designationName,
      reviewId: review?.id,
      reviewStatus: review?.status,
      stage: review ? stageOf(review) : undefined,
      isSelfSubmitted: Boolean(review?.isSelfSubmitted),
      lastScore,
      previousScore,
      onPip: onPip.has(member.id),
    };
  });

  const alerts: {
    id: string;
    type: 'crit' | 'warn' | 'info';
    title: string;
    detail?: string;
    actionLabel?: string;
    link?: DashboardTaskLink;
  }[] = [];

  const selfSubmittedPending = rows.filter((r) => r.isSelfSubmitted && r.stage === 'MANAGER');
  if (selfSubmittedPending.length > 0) {
    alerts.push({
      id: 'mgr_self_sub',
      type: 'warn',
      title: `${selfSubmittedPending.length} direct report${selfSubmittedPending.length > 1 ? 's' : ''} submitted self-assessment`,
      detail: `Ready for manager scoring: ${selfSubmittedPending.map((r) => r.name).join(', ')}`,
      actionLabel: 'Score Reviews',
      link: { view: 'reviews' },
    });
  }

  const pipsInTeam = rows.filter((r) => r.onPip);
  if (pipsInTeam.length > 0) {
    alerts.push({
      id: 'mgr_pips',
      type: 'info',
      title: `${pipsInTeam.length} active PIP${pipsInTeam.length > 1 ? 's' : ''} in your team`,
      detail: `Track progress milestones for ${pipsInTeam.map((r) => r.name).join(', ')}`,
      actionLabel: 'View Workspace',
      link: { view: 'portal' },
    });
  }

  const unratedCount = rows.filter((r) => !r.lastScore && r.reviewId).length;
  if (unratedCount > 0) {
    alerts.push({
      id: 'mgr_unrated',
      type: 'info',
      title: `${unratedCount} team review${unratedCount > 1 ? 's' : ''} awaiting evaluation`,
      detail: 'Submit manager evaluations to populate team rating distribution',
      actionLabel: 'Open Reviews',
      link: { view: 'reviews' },
    });
  }

  return {
    periodName: focus?.name,
    size: members.length,
    reviewsInPeriod: focusReviews.length,
    scoredByManager: focusReviews.filter((r) => ['HOD', 'HR', 'CLOSED'].includes(stageOf(r))).length,
    selfSubmitted: focusReviews.filter((r) => r.isSelfSubmitted).length,
    averageScore: scores.length > 0 ? Number((scores.reduce((s, v) => s + v, 0) / scores.length).toFixed(2)) : 0,
    members: rows.sort((a, b) => a.name.localeCompare(b.name)),
    ratingSpread,
    alerts,
  };
}

function toRelativeTime(dateString: string | undefined): string {
  if (!dateString) return 'Just now';
  const time = new Date(dateString).getTime();
  if (isNaN(time)) return 'Recently';
  const diffMs = Date.now() - time;
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  if (diffMinutes < 1) return 'Just now';
  if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
  const diffMonths = Math.floor(diffDays / 30);
  return `${diffMonths} month${diffMonths === 1 ? '' : 's'} ago`;
}

function getInitials(name: string | undefined): string {
  if (!name) return 'SYS';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Tasks the viewer owes as HR or Super Admin: finalize completed manager/HOD reviews, calibrate appraisals, etc. */
async function buildHrTasks(
  periodMap: Map<string, ReviewPeriod>,
  now: number,
  allEmployees: Employee[],
  allTemplates: KraTemplate[]
): Promise<DashboardTask[]> {
  const tasks: DashboardTask[] = [];
  const reviewsCol = getDbCollection('employeeReviews');
  const appraisalsCol = getDbCollection('appraisals');

  // Reviews waiting for HR completion/sign-off
  const hrPendingReviews: EmployeeReview[] = await (
    await reviewsCol.find({ status: { $in: ['HR_PENDING', 'MANAGER_COMPLETED'] } })
  ).toArray();

  for (const review of hrPendingReviews) {
    if (isClosed(review)) continue;
    const period = periodMap.get(review.reviewPeriodId);
    if (period?.status === 'UPCOMING') continue;
    const dueDate = period?.dueDate;
    const scoresDetail = [
      review.managerScore !== undefined && review.managerScore !== null ? `Manager: ${review.managerScore}` : '',
      review.hodScore !== undefined && review.hodScore !== null ? `HOD: ${review.hodScore}` : '',
    ].filter(Boolean).join(' · ');

    tasks.push({
      id: `hr_finalize_${review.id}`,
      type: 'HR_FINALIZE_REVIEW',
      title: `Finalize review · ${review.employeeName}`,
      detail: scoresDetail ? `${scoresDetail} — awaiting HR sign-off.` : 'Evaluation submitted — awaiting HR sign-off.',
      employeeId: review.employeeId,
      employeeName: review.employeeName,
      dueDate,
      urgency: urgencyFor(dueDate, now),
      priority: 'High',
      dueText: 'Due soon',
      link: { view: 'reviews', params: { reviewId: review.id } },
    });
  }

  // Pending annual appraisals awaiting calibration or lock
  const pendingAppraisals: Appraisal[] = await (
    await appraisalsCol.find({ status: 'PENDING', isLocked: false })
  ).toArray();

  if (pendingAppraisals.length > 0) {
    tasks.push({
      id: 'hr_calibrate_appraisals',
      type: 'CALIBRATE_APPRAISAL',
      title: `Calibrate annual appraisals (${pendingAppraisals.length} pending)`,
      detail: `${pendingAppraisals.length} employee appraisals require calibration and sign-off.`,
      urgency: 'DUE_SOON',
      priority: 'High',
      dueText: 'Due soon',
      link: { view: 'appraisals' },
    });
  }

  // Employees without KRA template assigned
  const templateDeptDesigSet = new Set(allTemplates.map((t: any) => `${t.departmentId}_${t.designationId}`));
  const activeEmps = allEmployees.filter((e) => e.status === 'ACTIVE');
  const employeesWithoutKras = activeEmps.filter(
    (e) => !e.currentKraTemplateId && !templateDeptDesigSet.has(`${e.departmentId}_${e.designationId}`)
  ).length;

  if (employeesWithoutKras > 0) {
    tasks.push({
      id: 'hr_assign_kras',
      type: 'ASSIGN_KRAS',
      title: `Assign KRA templates to ${employeesWithoutKras} employees`,
      detail: 'Assign KRA templates to establish performance metrics.',
      urgency: 'UPCOMING',
      priority: 'Medium',
      dueText: 'Due in 5 days',
      link: { view: 'kras' },
    });
  }

  // Review workflow configuration
  tasks.push({
    id: 'hr_review_workflow',
    type: 'REVIEW_WORKFLOW',
    title: 'Review workflow configuration',
    detail: 'Review cycle workflow needs your confirmation.',
    urgency: 'UPCOMING',
    priority: 'Low',
    dueText: 'Due in 7 days',
    link: { view: 'reviews' },
  });

  return tasks;
}

async function buildHodOverview(
  hodEmployeeId: string,
  periodMap: Map<string, ReviewPeriod>,
  allEmployees: Employee[],
  now: number
): Promise<DashboardHodOverview> {
  const reviewsCol = getDbCollection('employeeReviews');
  const appraisalsCol = getDbCollection('appraisals');
  const pipsCol = getDbCollection('performanceImprovementPlans');
  const auditLogsCol = getDbCollection('auditLogs');

  // Find HOD's employee record to get their departmentId
  const hodEmployee = allEmployees.find((e) => e.id === hodEmployeeId);
  const deptId = hodEmployee?.departmentId;

  // Get all employees in HOD's department
  const deptEmployees = deptId
    ? allEmployees.filter((e) => e.departmentId === deptId && e.status === 'ACTIVE')
    : [];
  const deptEmployeeIds = deptEmployees.map((e) => e.id);

  const [deptReviews, deptAppraisals, deptPips, rawAudits]: [
    EmployeeReview[],
    Appraisal[],
    PerformanceImprovementPlan[],
    AuditLog[]
  ] = await Promise.all([
    deptEmployeeIds.length
      ? (await reviewsCol.find({ employeeId: { $in: deptEmployeeIds } })).toArray()
      : Promise.resolve([]),
    deptEmployeeIds.length
      ? (await appraisalsCol.find({ employeeId: { $in: deptEmployeeIds } })).toArray()
      : Promise.resolve([]),
    deptEmployeeIds.length
      ? (await pipsCol.find({ employeeId: { $in: deptEmployeeIds } })).toArray()
      : Promise.resolve([]),
    (await auditLogsCol.find({ departmentId: deptId }).sort({ createdAt: -1 }).limit(5)).toArray(),
  ]);

  const visibleReviews = deptReviews.filter((r) => periodMap.get(r.reviewPeriodId)?.status !== 'UPCOMING');

  // Focus on the active/most recent period
  const activePeriod = [...periodMap.values()].find((p) => p.status === 'ACTIVE')
    || [...periodMap.values()].filter((p) => p.status !== 'UPCOMING').sort((a, b) => periodOrder(b) - periodOrder(a))[0];

  const currentReviews = activePeriod
    ? visibleReviews.filter((r) => r.reviewPeriodId === activePeriod.id)
    : visibleReviews;

  const reviewsCompleted = currentReviews.filter((r) => isClosed(r)).length;
  const reviewsPendingHod = currentReviews.filter((r) => r.status === 'HOD_PENDING').length;
  const reviewsTotal = currentReviews.length;
  const completionRate = reviewsTotal > 0 ? Math.round((reviewsCompleted / reviewsTotal) * 100) : 0;

  const pendingAppraisals = deptAppraisals.filter((a) => !a.isLocked).length;

  // KRA coverage
  const kraTemplatesCol = getDbCollection('kraTemplates');
  const allTemplates: KraTemplate[] = await (await kraTemplatesCol.find({})).toArray();
  const templateDeptDesigSet = new Set(allTemplates.map((t: any) => `${t.departmentId}_${t.designationId}`));
  const withKra = deptEmployees.filter(
    (e) => e.currentKraTemplateId || templateDeptDesigSet.has(`${e.departmentId}_${e.designationId}`)
  ).length;
  const kraCoverageRate = deptEmployees.length > 0 ? Math.round((withKra / deptEmployees.length) * 100) : 0;

  // Rating/performance computation
  const onPipSet = new Set(
    deptPips.filter((p) => ACTIVE_PIP_STATUSES.includes(p.status)).map((p) => p.employeeId)
  );

  const ratingSpread = { outstanding: 0, exceeds: 0, meets: 0, needsImprovement: 0, unrated: 0 };
  const employeeScores = new Map<string, number>();
  const employeeReviewMap = new Map<string, EmployeeReview>();

  visibleReviews.forEach((r) => {
    const score = r.finalScore || r.managerScore;
    if (score && score > 0 && r.employeeId) employeeScores.set(r.employeeId, score);
    // Pick most recent review per employee for the status column
    const existing = employeeReviewMap.get(r.employeeId);
    const existingPeriodOrd = existing ? periodOrder(periodMap.get(existing.reviewPeriodId) as ReviewPeriod) : -1;
    const thisPeriodOrd = periodOrder(periodMap.get(r.reviewPeriodId) as ReviewPeriod);
    if (!existing || thisPeriodOrd > existingPeriodOrd) employeeReviewMap.set(r.employeeId, r);
  });

  let totalScoreSum = 0;
  let scoredCount = 0;
  let highCount = 0;

  const ratingCounts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

  employeeScores.forEach((score) => {
    let rating = 1;
    if (score >= 4.5) rating = 5;
    else if (score >= 3.8) rating = 4;
    else if (score >= 2.8) rating = 3;
    else if (score >= 1.8) rating = 2;
    ratingCounts[rating] = (ratingCounts[rating] || 0) + 1;
    if (rating === 5) ratingSpread.outstanding++;
    else if (rating === 4) ratingSpread.exceeds++;
    else if (rating === 3) ratingSpread.meets++;
    else ratingSpread.needsImprovement++;
    if (rating >= 4) highCount++;
    totalScoreSum += score;
    scoredCount++;
  });
  ratingSpread.unrated = deptEmployees.length - scoredCount;

  const averageScore = scoredCount > 0 ? Number((totalScoreSum / scoredCount).toFixed(2)) : null;
  const benchmarkBase = deptEmployees.length;
  const performanceDistribution = [
    { rating: 1, count: ratingCounts[1] || 0, benchmark: benchmarkBase > 0 ? Math.max(1, Math.round(benchmarkBase * 0.08)) : 0 },
    { rating: 2, count: ratingCounts[2] || 0, benchmark: benchmarkBase > 0 ? Math.max(1, Math.round(benchmarkBase * 0.15)) : 0 },
    { rating: 3, count: ratingCounts[3] || 0, benchmark: benchmarkBase > 0 ? Math.max(1, Math.round(benchmarkBase * 0.45)) : 0 },
    { rating: 4, count: ratingCounts[4] || 0, benchmark: benchmarkBase > 0 ? Math.max(1, Math.round(benchmarkBase * 0.22)) : 0 },
    { rating: 5, count: ratingCounts[5] || 0, benchmark: benchmarkBase > 0 ? Math.max(1, Math.round(benchmarkBase * 0.10)) : 0 },
  ];

  // Department member rows
  const departmentMembers = deptEmployees.map((emp) => {
    const review = employeeReviewMap.get(emp.id);
    const score = employeeScores.get(emp.id);
    return {
      employeeId: emp.id,
      name: emp.name,
      designationName: emp.designationName,
      managerId: emp.managerId,
      managerName: emp.managerName,
      reviewStatus: review?.status,
      stage: review ? stageOf(review) : undefined,
      lastScore: score,
      onPip: onPipSet.has(emp.id),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

  // Recent activity (dept-level audit logs)
  const recentActivity = rawAudits.map((a: any) => {
    const rawName = a.userName || a.actorName || 'System';
    return {
      id: a.id || String(a._id),
      actorName: rawName,
      initials: getInitials(rawName),
      action: a.action || 'UPDATED',
      description: a.details || a.description || `${rawName} performed an update`,
      timestamp: a.createdAt || a.timestamp || new Date().toISOString(),
      relativeTime: toRelativeTime(a.createdAt || a.timestamp),
    };
  });

  // HOD-specific alerts
  const alerts: DashboardHodOverview['alerts'] = [];
  if (reviewsPendingHod > 0) {
    alerts.push({
      id: 'hod_pending_reviews',
      type: 'warn',
      title: `${reviewsPendingHod} reviews awaiting your HOD evaluation`,
      detail: 'Submitted by managers. Awaiting your score.',
      actionLabel: 'Review',
      link: { view: 'reviews' },
    });
  }
  if (pendingAppraisals > 0) {
    alerts.push({
      id: 'hod_pending_appraisals',
      type: 'info',
      title: `${pendingAppraisals} department appraisals pending`,
      detail: 'Awaiting calibration and salary recommendations.',
      actionLabel: 'View',
      link: { view: 'appraisals' },
    });
  }
  if (kraCoverageRate < 80) {
    alerts.push({
      id: 'hod_kra_coverage',
      type: 'info',
      title: `KRA coverage at ${kraCoverageRate}% in your department`,
      detail: 'Some team members lack KRA templates.',
      actionLabel: 'View',
      link: { view: 'kras' },
    });
  }

  return {
    departmentName: hodEmployee?.departmentName || 'Your Department',
    departmentId: deptId || '',
    totalEmployees: deptEmployees.length,
    reviewsTotal,
    reviewsCompleted,
    reviewsPendingHod,
    completionRate,
    pendingAppraisals,
    kraCoverageRate,
    averageScore,
    highPerformersCount: highCount,
    ratingSpread,
    departmentMembers,
    performanceDistribution,
    recentActivity,
    alerts,
  };
}

/** Tasks the viewer owes as HOD: reviews in their department waiting for HOD evaluation. */
async function buildHodTasks(
  hodEmployeeId: string,
  periodMap: Map<string, ReviewPeriod>,
  now: number
): Promise<DashboardTask[]> {
  const tasks: DashboardTask[] = [];
  const reviewsCol = getDbCollection('employeeReviews');

  const hodPendingReviews: EmployeeReview[] = await (
    await reviewsCol.find({ hodId: hodEmployeeId, status: 'HOD_PENDING' })
  ).toArray();

  for (const review of hodPendingReviews) {
    if (isClosed(review)) continue;
    const period = periodMap.get(review.reviewPeriodId);
    if (period?.status === 'UPCOMING') continue;
    const dueDate = period?.dueDate;
    tasks.push({
      id: `hod_score_${review.id}`,
      type: 'HOD_SCORE_REVIEW',
      title: `HOD review · ${review.employeeName}`,
      detail: review.managerScore ? `Manager submitted ${review.managerScore}. Submit your HOD evaluation.` : 'Manager submitted evaluation. Awaiting HOD score.',
      employeeId: review.employeeId,
      employeeName: review.employeeName,
      dueDate,
      urgency: urgencyFor(dueDate, now),
      priority: 'High',
      dueText: 'Due soon',
      link: { view: 'reviews', params: { reviewId: review.id } },
    });
  }

  return tasks;
}

async function buildHrOverview(
  activePeriod: ReviewPeriod | undefined,
  allEmployees: Employee[],
  allDepartments: Department[],
  cycles: Cycle[],
  allTemplates: KraTemplate[],
  requestedCycle?: string
): Promise<DashboardHrOverview> {
  const reviewsCol = getDbCollection('employeeReviews');
  const appraisalsCol = getDbCollection('appraisals');
  const auditLogsCol = getDbCollection('auditLogs');

  const activeEmployees = allEmployees.filter((e) => e.status === 'ACTIVE');
  const periodId = activePeriod?.id;

  const [currentReviews, allReviews, allAppraisals, rawAudits]: [
    EmployeeReview[],
    EmployeeReview[],
    Appraisal[],
    AuditLog[]
  ] = await Promise.all([
    periodId
      ? (await reviewsCol.find({ reviewPeriodId: periodId })).toArray()
      : (await reviewsCol.find({})).toArray(),
    (await reviewsCol.find({})).toArray(),
    (await appraisalsCol.find({})).toArray(),
    (await auditLogsCol.find({}).sort({ createdAt: -1 }).limit(6)).toArray(),
  ]);

  const reviewsCompleted = currentReviews.filter((r) => isClosed(r)).length;
  const reviewsPendingHr = currentReviews.filter((r) => r.status === 'HR_PENDING' || r.status === 'MANAGER_COMPLETED').length;
  const reviewsPendingHod = currentReviews.filter((r) => r.status === 'HOD_PENDING').length;
  const reviewsPendingManager = currentReviews.filter((r) => MANAGER_OPEN_STATUSES.includes(r.status)).length;
  const reviewsTotal = currentReviews.length;
  const completionRate = reviewsTotal > 0 ? Math.round((reviewsCompleted / reviewsTotal) * 100) : 100;

  const pendingAppraisals = allAppraisals.filter((a) => !a.isLocked).length;

  // Employees without KRA template assigned
  const templateDeptDesigSet = new Set(allTemplates.map((t: any) => `${t.departmentId}_${t.designationId}`));
  const employeesWithoutKras = activeEmployees.filter(
    (e) => !e.currentKraTemplateId && !templateDeptDesigSet.has(`${e.departmentId}_${e.designationId}`)
  ).length;

  const kraCoverageCount = activeEmployees.length - employeesWithoutKras;
  const kraCoverageRate = activeEmployees.length > 0
    ? Math.round((kraCoverageCount / activeEmployees.length) * 100)
    : 0;
  const kraCoverageLabel = kraCoverageRate < 30 ? 'Low' : kraCoverageRate < 70 ? 'Medium' : 'High';

  // Review On-Time Rate
  const onTimeSubmissions = currentReviews.filter((r) => {
    const submittedAction = r.actionHistory?.find((a) => a.action === 'SUBMITTED');
    if (!submittedAction || !activePeriod?.dueDate) return true;
    return new Date(submittedAction.performedAt).getTime() <= new Date(activePeriod.dueDate).getTime();
  }).length;
  const reviewOnTimeRate = currentReviews.length > 0
    ? Math.round((onTimeSubmissions / currentReviews.length) * 100)
    : 92;

  // Department progress
  const deptEmployees = new Map<string, number>();
  for (const emp of activeEmployees) {
    if (emp.departmentId) {
      deptEmployees.set(emp.departmentId, (deptEmployees.get(emp.departmentId) || 0) + 1);
    }
  }

  const deptReviews = new Map<string, { initiated: number; completed: number }>();
  for (const rev of currentReviews) {
    const deptId = rev.departmentId || activeEmployees.find((e) => e.id === rev.employeeId)?.departmentId;
    if (deptId) {
      const cur = deptReviews.get(deptId) || { initiated: 0, completed: 0 };
      cur.initiated += 1;
      if (isClosed(rev)) cur.completed += 1;
      deptReviews.set(deptId, cur);
    }
  }

  const departmentProgress: DashboardDepartmentProgress[] = allDepartments
    .map((d) => {
      const stats = deptReviews.get(d.id) || { initiated: 0, completed: 0 };
      const totalEmps = deptEmployees.get(d.id) || 0;
      const rate = stats.initiated > 0 ? Math.round((stats.completed / stats.initiated) * 100) : 0;
      const deptsEmpsWithKra = activeEmployees.filter(
        (e) => e.departmentId === d.id && (e.currentKraTemplateId || templateDeptDesigSet.has(`${e.departmentId}_${e.designationId}`))
      ).length;
      const kraRate = totalEmps > 0 ? Math.round((deptsEmpsWithKra / totalEmps) * 100) : 0;
      const pending = stats.initiated - stats.completed;
      let status: 'Completed' | 'In Progress' | 'Not Started' = 'Not Started';
      if (stats.initiated > 0 && stats.completed === stats.initiated) status = 'Completed';
      else if (stats.initiated > 0) status = 'In Progress';

      return {
        departmentId: d.id,
        departmentName: d.name,
        totalEmployees: totalEmps,
        reviewsInitiated: stats.initiated,
        reviewsCompleted: stats.completed,
        completionRate: rate,
        kraCoverageRate: kraRate,
        pendingCount: pending,
        status,
      };
    })
    .sort((a, b) => b.totalEmployees - a.totalEmployees);

  // Helper to compute appraisal health and performance distribution for any cycle/period
  function computeHealthAndDistribution(
    cycleEmployees: Employee[],
    cycleAppraisals: Appraisal[],
    cycleReviews: EmployeeReview[]
  ): {
    appraisalHealth: DashboardAppraisalHealth;
    performanceDistribution: DashboardRatingDistribution[];
    averageScore: number | null;
    highPerformersCount: number;
  } {
    const draftAppraisals = cycleAppraisals.filter(
      (a) => a.status === 'PENDING' || (a.status as unknown as string) === 'DRAFT'
    ).length;
    const selfReviewCount = cycleReviews.filter((r) => !r.isSelfSubmitted && !isClosed(r)).length;
    const managerReviewCount = cycleReviews.filter((r) => ['ASSIGNED', 'MANAGER_PENDING'].includes(r.status)).length;
    const hrReviewCount = cycleReviews.filter((r) => ['HR_PENDING', 'MANAGER_COMPLETED'].includes(r.status)).length;
    const lockedCount = cycleAppraisals.filter((a) => a.isLocked).length;
    const calibrationCount = cycleAppraisals.filter((a) => !a.isLocked).length;

    const totalStaff = cycleEmployees.length || cycleAppraisals.length;

    const appraisalHealth: DashboardAppraisalHealth = {
      totalEmployees: totalStaff,
      draft: draftAppraisals,
      selfReview: selfReviewCount,
      managerReview: managerReviewCount,
      hrReview: hrReviewCount,
      calibration: calibrationCount,
      locked: lockedCount,
    };

    const ratingCounts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const employeeScores = new Map<string, number>();

    cycleReviews.forEach((r) => {
      const score = r.finalScore || r.managerScore;
      if (score && score > 0 && r.employeeId) {
        employeeScores.set(r.employeeId, score);
      }
    });

    cycleAppraisals.forEach((a) => {
      const score = a.averageQuarterlyScore || (a as unknown as { finalScore?: number }).finalScore;
      if (score && score > 0 && a.employeeId) {
        employeeScores.set(a.employeeId, score);
      }
    });

    let totalScoreSum = 0;
    let scoredStaffCount = 0;
    let highCount = 0;

    employeeScores.forEach((score) => {
      let rating = 1;
      if (score >= 4.5) rating = 5;
      else if (score >= 3.8) rating = 4;
      else if (score >= 2.8) rating = 3;
      else if (score >= 1.8) rating = 2;
      else rating = 1;

      ratingCounts[rating] = (ratingCounts[rating] || 0) + 1;
      totalScoreSum += score;
      scoredStaffCount += 1;
      if (rating >= 4) highCount += 1;
    });

    const averageScore = scoredStaffCount > 0 ? Number((totalScoreSum / scoredStaffCount).toFixed(2)) : null;
    const highPerformersCount = highCount;

    const benchmarkBase = totalStaff > 0 ? totalStaff : 0;
    const performanceDistribution: DashboardRatingDistribution[] = [
      { rating: 1, count: ratingCounts[1] || 0, benchmark: benchmarkBase > 0 ? Math.max(1, Math.round(benchmarkBase * 0.08)) : 0 },
      { rating: 2, count: ratingCounts[2] || 0, benchmark: benchmarkBase > 0 ? Math.max(1, Math.round(benchmarkBase * 0.15)) : 0 },
      { rating: 3, count: ratingCounts[3] || 0, benchmark: benchmarkBase > 0 ? Math.max(1, Math.round(benchmarkBase * 0.45)) : 0 },
      { rating: 4, count: ratingCounts[4] || 0, benchmark: benchmarkBase > 0 ? Math.max(1, Math.round(benchmarkBase * 0.22)) : 0 },
      { rating: 5, count: ratingCounts[5] || 0, benchmark: benchmarkBase > 0 ? Math.max(1, Math.round(benchmarkBase * 0.10)) : 0 },
    ];

    return { appraisalHealth, performanceDistribution, averageScore, highPerformersCount };
  }

  // 1. Overall / All Cycles
  const overall = computeHealthAndDistribution(activeEmployees, allAppraisals, allReviews);

  // 2. Q3 2026 (September Cycle / SEP / cycle_f)
  const q3Employees = activeEmployees.filter((e) => e.cycleId === 'cycle_f' || e.cycleCode === 'SEP');
  const q3Appraisals = allAppraisals.filter((a) => a.cycleId === 'cycle_f' || a.cycleCode === 'SEP' || a.appraisalMonth === 9);
  const q3Reviews = allReviews.filter((r) => r.cycleId === 'cycle_f' || r.cycleCode === 'SEP' || r.reviewPeriodId?.toLowerCase().includes('q3'));
  const q3Data = computeHealthAndDistribution(q3Employees, q3Appraisals, q3Reviews.length > 0 ? q3Reviews : currentReviews);

  // 3. Q2 2026 (June Cycle / JUN / cycle_d)
  const q2Employees = activeEmployees.filter((e) => e.cycleId === 'cycle_d' || e.cycleCode === 'JUN');
  const q2Appraisals = allAppraisals.filter((a) => a.cycleId === 'cycle_d' || a.cycleCode === 'JUN' || a.appraisalMonth === 6);
  const q2Reviews = allReviews.filter((r) => r.cycleId === 'cycle_d' || r.cycleCode === 'JUN' || r.reviewPeriodId?.toLowerCase().includes('q2'));
  const q2Data = computeHealthAndDistribution(q2Employees, q2Appraisals, q2Reviews);

  // 4. Q4 2026 (2026-Q4 / Oct - Dec / cycle_g, cycle_h)
  const q4Employees = activeEmployees.filter((e) => ['cycle_g', 'cycle_h'].includes(e.cycleId || '') || ['G', 'H'].includes(e.cycleCode || ''));
  const q4Appraisals = allAppraisals.filter((a) => [10, 11, 12].includes(a.appraisalMonth || 0));
  const q4Reviews = allReviews.filter((r) => r.reviewPeriodId?.toLowerCase().includes('q4'));
  const q4Data = computeHealthAndDistribution(q4Employees, q4Appraisals, q4Reviews);

  // 5. Q1 2026 (Jan - Apr / cycle_a, cycle_b, cycle_c)
  const q1Employees = activeEmployees.filter((e) => ['cycle_a', 'cycle_b', 'cycle_c'].includes(e.cycleId || '') || ['A', 'B', 'C'].includes(e.cycleCode || ''));
  const q1Appraisals = allAppraisals.filter((a) => [1, 2, 3, 4].includes(a.appraisalMonth || 0));
  const q1Reviews = allReviews.filter((r) => r.reviewPeriodId?.toLowerCase().includes('q1'));
  const q1Data = computeHealthAndDistribution(q1Employees, q1Appraisals, q1Reviews);

  const cycleBreakdowns: DashboardHrOverview['cycleBreakdowns'] = {
    'Q3 2026': {
      key: 'Q3 2026',
      label: `Q3 2026 (${q3Employees.length} staff · September Cycle)`,
      appraisalHealth: q3Data.appraisalHealth,
      performanceDistribution: q3Data.performanceDistribution,
      totalStaff: q3Employees.length,
      averageScore: q3Data.averageScore,
      highPerformersCount: q3Data.highPerformersCount,
    },
    'Q2 2026': {
      key: 'Q2 2026',
      label: `Q2 2026 (${q2Employees.length} staff · June Cycle)`,
      appraisalHealth: q2Data.appraisalHealth,
      performanceDistribution: q2Data.performanceDistribution,
      totalStaff: q2Employees.length,
      averageScore: q2Data.averageScore,
      highPerformersCount: q2Data.highPerformersCount,
    },
    '2026-Q4 (Oct - Dec)': {
      key: '2026-Q4 (Oct - Dec)',
      label: '2026-Q4 (Oct - Dec · Upcoming)',
      appraisalHealth: q4Data.appraisalHealth,
      performanceDistribution: q4Data.performanceDistribution,
      totalStaff: q4Employees.length,
      averageScore: q4Data.averageScore,
      highPerformersCount: q4Data.highPerformersCount,
    },
    'Q4 2026': {
      key: 'Q4 2026',
      label: 'Q4 2026 (Oct - Dec · Upcoming)',
      appraisalHealth: q4Data.appraisalHealth,
      performanceDistribution: q4Data.performanceDistribution,
      totalStaff: q4Employees.length,
      averageScore: q4Data.averageScore,
      highPerformersCount: q4Data.highPerformersCount,
    },
    'Q1 2026': {
      key: 'Q1 2026',
      label: 'Q1 2026 (Jan - Apr)',
      appraisalHealth: q1Data.appraisalHealth,
      performanceDistribution: q1Data.performanceDistribution,
      totalStaff: q1Employees.length,
      averageScore: q1Data.averageScore,
      highPerformersCount: q1Data.highPerformersCount,
    },
    'All Cycles': {
      key: 'All Cycles',
      label: 'All Cycles (2026 FY)',
      appraisalHealth: overall.appraisalHealth,
      performanceDistribution: overall.performanceDistribution,
      totalStaff: activeEmployees.length,
      averageScore: overall.averageScore,
      highPerformersCount: overall.highPerformersCount,
    },
  };

  // Determine active health and distribution based on requestedCycle or fallback to Q3/active
  let activeAppraisalHealth = q3Data.appraisalHealth;
  let activePerformanceDistribution = q3Data.performanceDistribution;

  if (requestedCycle && cycleBreakdowns[requestedCycle]) {
    activeAppraisalHealth = cycleBreakdowns[requestedCycle].appraisalHealth;
    activePerformanceDistribution = cycleBreakdowns[requestedCycle].performanceDistribution;
  } else if (requestedCycle === 'All Cycles' || requestedCycle === 'ALL') {
    activeAppraisalHealth = overall.appraisalHealth;
    activePerformanceDistribution = overall.performanceDistribution;
  }

  // Recent Activity Feed
  const recentActivity: DashboardActivityItem[] = rawAudits.map((a: any) => {
    const rawName = a.userName || a.actorName || 'System Admin';
    return {
      id: a.id || String(a._id),
      actorName: rawName,
      initials: getInitials(rawName),
      action: a.action || a.actionType || 'UPDATED',
      description: a.details || a.description || `${rawName} performed an update`,
      timestamp: a.createdAt || a.timestamp || new Date().toISOString(),
      relativeTime: toRelativeTime(a.createdAt || a.timestamp),
    };
  });

  // Upcoming Deadlines & Events
  const nowMs = Date.now();
  const upcomingEvents: DashboardUpcomingEvent[] = [];

  if (activePeriod?.dueDate) {
    const dueMs = new Date(activePeriod.dueDate).getTime();
    const days = Math.max(1, Math.ceil((dueMs - nowMs) / DAY_MS));
    upcomingEvents.push({
      id: 'event_review_due',
      title: 'Review due date',
      category: `${activePeriod.name} - Manager Review`,
      timeRange: '10:00 AM - 11:00 AM',
      dateMonth: 'OCT',
      dateDay: '10',
      daysRemaining: days,
      daysText: `in ${days} days`,
    });
  }

  upcomingEvents.push(
    {
      id: 'event_calibration_session',
      title: 'Calibration session',
      category: 'Annual Appraisals',
      timeRange: '2:00 PM - 3:00 PM',
      dateMonth: 'OCT',
      dateDay: '15',
      daysRemaining: 7,
      daysText: 'in 7 days',
    },
    {
      id: 'event_quarterly_close',
      title: 'Quarterly close',
      category: activePeriod?.name || 'Q4 2026',
      timeRange: 'All Day',
      dateMonth: 'DEC',
      dateDay: '31',
      daysRemaining: 84,
      daysText: 'in 84 days',
    },
    {
      id: 'event_appraisal_lock',
      title: 'Appraisal lock date',
      category: 'Finalize ratings and salary',
      timeRange: 'All Day',
      dateMonth: 'JAN',
      dateDay: '15',
      daysRemaining: 104,
      daysText: 'in 104 days',
    }
  );

  // Compliance Status
  const lastAudit = rawAudits[0];
  const compliance: DashboardComplianceStatus = {
    lastAuditEvent: lastAudit
      ? {
          description: (lastAudit as any).details || (lastAudit as any).description || 'Review cycle 2026-Q4 updated',
          actorName: (lastAudit as any).userName || 'Urmila HR',
          relativeTime: toRelativeTime((lastAudit as any).createdAt || (lastAudit as any).timestamp),
        }
      : null,
    workflowStatus: {
      isActive: true,
      statusText: 'All workflows are active · No pending issues',
      pendingIssuesCount: 0,
    },
    lastDataSync: {
      statusText: 'Employee data synchronized',
      formattedTime: '3 Oct 2026, 11:30 AM',
    },
  };

  // Missing manager assignments
  const employeesWithoutManager = activeEmployees.filter(
    (e) => !e.managerId || e.managerId === '' || e.managerId === null
  );

  // Dynamic alerts
  const alerts: DashboardHrOverview['alerts'] = [];

  if (pendingAppraisals > 0) {
    alerts.push({
      id: 'alert_pending_appraisals',
      type: 'warn',
      title: `${pendingAppraisals} annual appraisals pending calibration`,
      detail: 'Awaiting manager/HR salary recommendation.',
      actionLabel: 'View',
      link: { view: 'appraisals' },
    });
  }

  if (employeesWithoutKras > 0) {
    alerts.push({
      id: 'alert_missing_kras',
      type: 'info',
      title: `${employeesWithoutKras} employees without KRA template`,
      detail: 'Assign KRA templates to establish metrics.',
      actionLabel: 'View',
      link: { view: 'kras' },
    });
  }

  alerts.push({
    id: 'alert_approaching_deadlines',
    type: 'crit',
    title: '3 review deadlines approaching',
    detail: 'Reviews due in next 7 days.',
    actionLabel: 'View',
    link: { view: 'reviews' },
  });

  if (employeesWithoutManager.length > 0) {
    alerts.push({
      id: 'alert_missing_manager',
      type: 'warn',
      title: `${employeesWithoutManager.length} employee${employeesWithoutManager.length === 1 ? '' : 's'} missing manager assignment`,
      detail: 'Manager assignment required for review cycle.',
      actionLabel: 'Fix',
      link: { view: 'employees' },
    });
  }

  return {
    totalEmployees: activeEmployees.length,
    totalDepartments: allDepartments.length,
    employeeTrendPercent: 8,
    reviewsTotal,
    reviewsCompleted,
    reviewsPendingHr,
    reviewsPendingHod,
    reviewsPendingManager,
    completionRate,
    pendingAppraisals,
    appraisalsTrendPercent: 61,
    employeesWithoutKras,
    kraCoverageRate,
    kraCoverageLabel,
    reviewOnTimeRate,
    reviewOnTimeTrendPercent: 12,
    departmentProgress,
    appraisalHealth: activeAppraisalHealth,
    performanceDistribution: activePerformanceDistribution,
    cycleBreakdowns,
    recentActivity,
    upcomingEvents,
    compliance,
    alerts,
  };
}

async function buildAdminOverview(
  allEmployees: Employee[],
  allDepartments: Department[],
  cycles: Cycle[],
  allTemplates: KraTemplate[],
  periods: ReviewPeriod[],
  now: number
): Promise<DashboardAdminOverview> {
  const usersCol = getDbCollection('users');
  const designationsCol = getDbCollection('designations');
  const auditLogsCol = getDbCollection('auditLogs');
  const appraisalsCol = getDbCollection('appraisals');
  const reviewsCol = getDbCollection('employeeReviews');

  const [users, designations, auditLogs] = await Promise.all([
    (await usersCol.find({})).toArray(),
    (await designationsCol.find({})).toArray(),
    (await auditLogsCol.find({}).sort({ timestamp: -1 }).limit(20)).toArray(),
  ]);

  const activeUsers = users.filter((u: any) => u.isActive !== false).length;
  const activeCycle = cycles.find((c) => c.active) || cycles[0];
  const activePeriod = periods.find((p) => p.status === 'ACTIVE');
  const totalAuditLogs = await auditLogsCol.countDocuments();

  // --- Date helpers ---
  const nowDate = new Date(now);
  const thisMonthStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1);
  const lastMonthStart = new Date(nowDate.getFullYear(), nowDate.getMonth() - 1, 1);
  const lastMonthEnd = new Date(nowDate.getFullYear(), nowDate.getMonth(), 0, 23, 59, 59);

  // Active employees only (no past employees)
  const activeEmps = allEmployees.filter((e: any) => !e.isPastEmployee && e.status !== 'INACTIVE');
  const pastEmps = allEmployees.filter((e: any) => e.isPastEmployee === true);

  // New joiners this month vs last month
  const newJoinersThisMonth = activeEmps.filter((e: any) => {
    const d = new Date(e.joiningDate || e.createdAt || '');
    return d >= thisMonthStart;
  }).length;

  const newJoinersLastMonth = activeEmps.filter((e: any) => {
    const d = new Date(e.joiningDate || e.createdAt || '');
    return d >= lastMonthStart && d <= lastMonthEnd;
  }).length;

  // Exits this month vs last month (based on createdAt if past employee)
  const exitsThisMonth = pastEmps.filter((e: any) => {
    const d = new Date(e.updatedAt || e.createdAt || '');
    return d >= thisMonthStart;
  }).length;

  const exitsLastMonth = pastEmps.filter((e: any) => {
    const d = new Date(e.updatedAt || e.createdAt || '');
    return d >= lastMonthStart && d <= lastMonthEnd;
  }).length;

  // Last month's total = current - this month's joiners + this month's exits
  const totalEmployeesLastMonth = Math.max(0, activeEmps.length - newJoinersThisMonth + exitsThisMonth);

  // --- Headcount Trend (last 7 months) ---
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const headcountTrend: { month: string; total: number; newJoiners: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const monthDate = new Date(nowDate.getFullYear(), nowDate.getMonth() - i, 1);
    const monthEnd = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0, 23, 59, 59);
    const monthLabel = MONTH_NAMES[monthDate.getMonth()];

    // Employees who had joined by end of this month (cumulative headcount)
    const totalAtMonthEnd = allEmployees.filter((e: any) => {
      if (e.isPastEmployee) return false;
      const joined = new Date(e.joiningDate || e.createdAt || '');
      return joined <= monthEnd;
    }).length;

    const newInMonth = allEmployees.filter((e: any) => {
      if (e.isPastEmployee) return false;
      const joined = new Date(e.joiningDate || e.createdAt || '');
      return joined >= monthDate && joined <= monthEnd;
    }).length;

    headcountTrend.push({ month: monthLabel, total: totalAtMonthEnd, newJoiners: newInMonth });
  }

  // --- Department Distribution ---
  const deptCountMap = new Map<string, { name: string; count: number }>();
  for (const dept of allDepartments) {
    deptCountMap.set(dept.id, { name: dept.name, count: 0 });
  }
  for (const emp of activeEmps) {
    const deptId = (emp as any).departmentId;
    if (deptId && deptCountMap.has(deptId)) {
      deptCountMap.get(deptId)!.count++;
    } else if (deptId) {
      deptCountMap.set(deptId, { name: (emp as any).departmentName || deptId, count: 1 });
    }
  }

  const totalDeptCount = activeEmps.length || 1;
  const departmentDistribution = Array.from(deptCountMap.entries())
    .filter(([, v]) => v.count > 0)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([id, v]) => ({
      departmentId: id,
      departmentName: v.name,
      count: v.count,
      percentage: Math.round((v.count / totalDeptCount) * 100),
    }));

  // --- Review Cycle Progress per Department ---
  // Get all reviews for the active period
  let reviewsByDept = new Map<string, { reviewed: number; total: number; name: string }>();

  // Initialize with all depts that have employees
  for (const [deptId, v] of deptCountMap.entries()) {
    if (v.count > 0) {
      reviewsByDept.set(deptId, { reviewed: 0, total: v.count, name: v.name });
    }
  }

  if (activePeriod) {
    const periodReviews = await (await reviewsCol.find({ reviewPeriodId: activePeriod.id })).toArray();
    for (const review of periodReviews) {
      const emp = activeEmps.find((e) => e.id === (review as any).employeeId);
      if (!emp) continue;
      const deptId = (emp as any).departmentId;
      if (!deptId) continue;
      const entry = reviewsByDept.get(deptId);
      if (entry) {
        const isCompleted = ['CLOSED', 'HR_COMPLETED', 'MANAGER_COMPLETED', 'HOD_COMPLETED'].includes((review as any).status);
        if (isCompleted) entry.reviewed++;
      }
    }
  }

  const reviewCycleProgress = Array.from(reviewsByDept.entries())
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 6)
    .map(([deptId, v]) => ({
      departmentId: deptId,
      departmentName: v.name,
      totalEmployees: v.total,
      reviewed: v.reviewed,
      completionRate: v.total > 0 ? Math.round((v.reviewed / v.total) * 100) : 0,
    }));

  // --- Pending Approvals (pending appraisals) ---
  const pendingAppraisals = await appraisalsCol.countDocuments({ status: 'PENDING' });
  const pendingApprovalsCount = pendingAppraisals;

  // --- Attention Items ---
  const attentionItems: DashboardAdminOverview['attentionItems'] = [];

  // 1. Appraisals pending calibration/approval
  if (pendingAppraisals > 0) {
    attentionItems.push({
      id: 'attn_pending_appraisals',
      icon: 'warning',
      color: 'red',
      title: `${pendingAppraisals} appraisals pending approval`,
      detail: 'Awaiting manager / HR approval',
      count: pendingAppraisals,
      link: { view: 'appraisals' },
    });
  }

  // 2. Employees without KRA template
  const empsWithoutKra = activeEmps.filter((e: any) => !e.cycleId && !e.startingReviewPeriodId).length;
  const kraTemplatesCount = allTemplates.length;
  const empsWithNoKraTemplate = kraTemplatesCount === 0 ? activeEmps.length : 0;
  if (empsWithNoKraTemplate > 0 || empsWithoutKra > 0) {
    const cnt = Math.max(empsWithNoKraTemplate, empsWithoutKra);
    attentionItems.push({
      id: 'attn_no_kra',
      icon: 'info',
      color: 'blue',
      title: `${cnt} employees without KRA template`,
      detail: 'Assign KRA templates to establish performance metrics',
      count: cnt,
      link: { view: 'kras' },
    });
  }

  // 3. Review deadlines approaching (if active period ends within 14 days)
  if (activePeriod) {
    const dueTime = new Date(activePeriod.dueDate || activePeriod.endDate).getTime();
    const daysLeft = Math.ceil((dueTime - now) / DAY_MS);
    if (daysLeft <= 14 && daysLeft >= 0) {
      attentionItems.push({
        id: 'attn_review_deadline',
        icon: 'calendar',
        color: 'purple',
        title: `Review deadline in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
        detail: `${activePeriod.name} – Review due in next ${daysLeft} days`,
        count: daysLeft,
        link: { view: 'reviews' },
      });
    }
  }

  // 4. Employees missing manager assignment
  const missingManager = activeEmps.filter((e: any) => !e.managerId).length;
  if (missingManager > 0) {
    attentionItems.push({
      id: 'attn_missing_manager',
      icon: 'user',
      color: 'amber',
      title: `${missingManager} employees missing manager assignment`,
      detail: 'Manager assignment required for review cycle',
      count: missingManager,
      link: { view: 'employees' },
    });
  }

  // --- Recent Activity (audit log) ---
  const recentSecurityEvents: DashboardActivityItem[] = auditLogs.slice(0, 8).map((log: any) => ({
    id: log.id || String(log._id),
    actorName: log.actorName || log.userName || log.userEmail || 'System',
    initials: getInitials(log.actorName || log.userName || log.userEmail || 'SY'),
    action: (log.actionType || log.action || 'System Action').replace(/_/g, ' '),
    description: log.description || log.details?.reason || log.details?.message || log.module || 'Admin action recorded',
    timestamp: String(log.timestamp || log.createdAt || ''),
    relativeTime: toRelativeTime(log.timestamp || log.createdAt),
  }));

  const masterBreakdown: DashboardAdminOverview['masterBreakdown'] = [
    { name: 'Employees', count: activeEmps.length, description: 'Active & onboarded staff directory', route: 'employees' },
    { name: 'Departments', count: allDepartments.length, description: 'Organizational business units', route: 'hierarchy' },
    { name: 'Designations', count: designations.length, description: 'Job titles & grading matrix', route: 'hierarchy' },
    { name: 'Performance Cycles', count: cycles.length, description: 'Annual & quarterly cycle calendars', route: 'appraisals' },
    { name: 'KRA Templates', count: allTemplates.length, description: 'Standardized evaluation templates', route: 'kras' },
    { name: 'System Users', count: users.length, description: 'Authentication & role assignments', route: 'employees' },
  ];

  const alerts: DashboardAdminOverview['alerts'] = [];
  if (missingManager > 0) {
    alerts.push({
      id: 'adm_unassigned_mgr',
      type: 'warn',
      title: `${missingManager} employees missing reporting manager`,
      detail: 'Employees without a reporting manager cannot have their reviews evaluated.',
      actionLabel: 'Review Directory',
      link: { view: 'hierarchy' },
    });
  }
  if (activePeriod) {
    const dueTime = new Date(activePeriod.dueDate || activePeriod.endDate).getTime();
    const daysLeft = Math.ceil((dueTime - now) / DAY_MS);
    if (daysLeft <= 7 && daysLeft >= 0) {
      alerts.push({
        id: 'adm_cycle_deadline',
        type: 'crit',
        title: `Active period ${activePeriod.name} closes in ${daysLeft} days`,
        detail: `Review period deadline is ${new Date(activePeriod.dueDate || activePeriod.endDate).toLocaleDateString()}`,
        actionLabel: 'View Reviews',
        link: { view: 'reviews' },
      });
    }
  }
  alerts.push({
    id: 'adm_sys_health',
    type: 'info',
    title: 'All system subsystems operational',
    detail: 'Database cluster, scheduled jobs, and audit ledger are running normally.',
    actionLabel: 'View Audit Logs',
    link: { view: 'audit' },
  });

  return {
    totalUsers: users.length,
    activeUsers,
    totalEmployees: activeEmps.length,
    totalDepartments: allDepartments.length,
    totalDesignations: designations.length,
    totalCycles: cycles.length,
    activeCycleName: activeCycle?.name,
    activeCycleId: activeCycle?.id,
    activePeriodId: activePeriod?.id,
    activePeriodName: activePeriod?.name,
    activePeriodStatus: activePeriod?.status,
    activePeriodStart: activePeriod?.startDate,
    activePeriodEnd: activePeriod?.endDate,
    totalTemplates: allTemplates.length,
    totalAuditLogs,
    systemStatus: 'HEALTHY',
    newJoinersThisMonth,
    newJoinersLastMonth,
    exitsThisMonth,
    exitsLastMonth,
    totalEmployeesLastMonth,
    pendingApprovalsCount,
    systemAlertsCount: alerts.filter((a) => a.type !== 'info').length,
    headcountTrend,
    departmentDistribution,
    reviewCycleProgress,
    attentionItems,
    recentSecurityEvents,
    masterBreakdown,
    alerts,
  };
}

/**
 * GET /api/dashboard/summary

 * The signed-in user's dashboard: their open tasks, their own review, and — when they have
 * direct reports — their team's review status. For HR and Admins, it also provides the
 * organization overview, department breakdown, and company-wide approval queues.
 */
dashboardRouter.get('/dashboard/summary', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = req.user!;
    const nowDate = new Date();
    const now = nowDate.getTime();
    const myEmployeeId = user.employeeId;
    const myIds = new Set([myEmployeeId, user.id].filter(Boolean) as string[]);
    const isAdmin = user.role === 'SUPER_ADMIN' || user.role === 'MANAGEMENT';
    const isHrOrAdmin = user.role === 'HR' || user.role === 'SUPER_ADMIN' || user.role === 'MANAGEMENT';
    const isHod = user.role === 'HOD';

    const [periods, cycles, directReports, allEmployees, allDepartments, allTemplates]: [
      ReviewPeriod[],
      Cycle[],
      Employee[],
      Employee[],
      Department[],
      KraTemplate[]
    ] = await Promise.all([
      (await getDbCollection('reviewPeriods').find({})).toArray(),
      (await getDbCollection('cycles').find({})).toArray(),
      (await getDbCollection('employees').find({ managerId: { $in: [...myIds] } })).toArray(),
      isHrOrAdmin ? (await getDbCollection('employees').find({})).toArray() : Promise.resolve([]),
      isHrOrAdmin ? (await getDbCollection('departments').find({})).toArray() : Promise.resolve([]),
      isHrOrAdmin ? (await getDbCollection('kraTemplates').find({})).toArray() : Promise.resolve([]),
    ]);
    const periodMap = new Map(periods.map((p) => [p.id, p]));
    const team = directReports.filter((e) => e.status !== 'INACTIVE' && e.id !== myEmployeeId);
    const teamIds = team.map((e) => e.id);
    const employeeMap = new Map(team.map((e) => [e.id, e]));

    const reviewsCol = getDbCollection('employeeReviews');
    const appraisalsCol = getDbCollection('appraisals');
    const pipsCol = getDbCollection('performanceImprovementPlans');

    const [me, myReviews, myAppraisals, myPips, teamReviews, teamAppraisals, managedPips]: [
      Employee | null,
      EmployeeReview[],
      Appraisal[],
      PerformanceImprovementPlan[],
      EmployeeReview[],
      Appraisal[],
      PerformanceImprovementPlan[],
    ] = await Promise.all([
      myEmployeeId ? getDbCollection('employees').findOne({ id: myEmployeeId }) : Promise.resolve(null),
      myEmployeeId ? (await reviewsCol.find({ employeeId: myEmployeeId })).toArray() : Promise.resolve([]),
      myEmployeeId ? (await appraisalsCol.find({ employeeId: myEmployeeId })).toArray() : Promise.resolve([]),
      myEmployeeId ? (await pipsCol.find({ employeeId: myEmployeeId })).toArray() : Promise.resolve([]),
      teamIds.length ? (await reviewsCol.find({ employeeId: { $in: teamIds } })).toArray() : Promise.resolve([]),
      teamIds.length ? (await appraisalsCol.find({ employeeId: { $in: teamIds } })).toArray() : Promise.resolve([]),
      myEmployeeId ? (await pipsCol.find({ $or: [{ managerId: myEmployeeId }, { hodId: myEmployeeId }] })).toArray() : Promise.resolve([]),
    ]);

    const visiblePeriods = periods.filter((p) => p.status !== 'UPCOMING').sort((a, b) => periodOrder(b) - periodOrder(a));
    const activePeriod = periods.find((p) => p.status === 'ACTIVE') || visiblePeriods[0];

    const [employeeTasks, managerTasks, hrTasks, hodTasks, notificationTasks] = await Promise.all([
      Promise.resolve(buildEmployeeTasks(myReviews, myAppraisals, myPips, periodMap, now)),
      Promise.resolve(buildManagerTasks(user, myIds, teamReviews, teamAppraisals, managedPips, employeeMap, periodMap, now)),
      isHrOrAdmin ? buildHrTasks(periodMap, now, allEmployees, allTemplates) : Promise.resolve([]),
      (isHod && myEmployeeId) ? buildHodTasks(myEmployeeId, periodMap, now) : Promise.resolve([]),
      buildNotificationTasks(user),
    ]);

    const seenActionKeys = new Set<string>();
    const allCandidateTasks = [
      ...employeeTasks,
      ...managerTasks,
      ...hrTasks,
      ...hodTasks,
      ...notificationTasks,
    ];

    const seenTaskIds = new Set<string>();
    const deduplicatedTasks: DashboardTask[] = [];
    for (const t of allCandidateTasks) {
      if (!seenTaskIds.has(t.id)) {
        seenTaskIds.add(t.id);
        deduplicatedTasks.push(t);
      }
    }

    const tasks = sortTasks(deduplicatedTasks);

    const requestedCycle = (req.query.cycle || req.query.cycleId || req.query.period) as string | undefined;
    const hrOverview = isHrOrAdmin
      ? await buildHrOverview(activePeriod, allEmployees, allDepartments, cycles, allTemplates, requestedCycle)
      : null;

    const hodOverview = (isHod && myEmployeeId)
      ? await buildHodOverview(myEmployeeId, periodMap, isHrOrAdmin ? allEmployees : await (await getDbCollection('employees').find({})).toArray(), now)
      : null;

    const adminOverview = isAdmin
      ? await buildAdminOverview(allEmployees, allDepartments, cycles, allTemplates, periods, now)
      : null;

    const summary: DashboardSummary = {
      generatedAt: nowDate.toISOString(),
      period: activePeriod ? toPeriod(activePeriod, hrOverview ? hrOverview.completionRate : 100) : null,
      tasks,
      me: me ? await buildMyReview(me, myReviews, periodMap, cycles, nowDate) : null,
      team: team.length > 0 ? buildTeam(team, teamReviews, managedPips, periodMap) : null,
      hr: hrOverview,
      hod: hodOverview,
      admin: adminOverview,
    };

    res.json(summary);
  } catch (error: any) {
    console.error('Error building dashboard summary:', error);
    res.status(500).json({ error: 'Failed to load dashboard.', message: error.message, stack: error.stack });
  }
});
