import express, { Response } from 'express';
import { getDbCollection } from '../db.js';
import { AuthenticatedRequest, authenticateToken, requireRoles } from '../auth.js';
import {
  buildCalibration,
  buildCoverage,
  buildDataHealth,
  buildEmailDelivery,
  computeReviewerBacklog,
  hasScorecardCheck,
  publicBacklog,
  sendReviewerReminder,
} from '../services/dashboardInsights.js';
import {
  Appraisal,
  Cycle,
  DashboardAdminOverview,
  DashboardDepartmentProgress,
  DashboardHodOverview,
  DashboardHrOverview,
  DashboardMyReview,
  DashboardPeriod,
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
import { ACTIVE_PIP_STATUSES, getActivePipForEmployee } from '../services/pipService.js';
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

function toPeriod(p: ReviewPeriod): DashboardPeriod {
  return {
    id: p.id,
    name: p.name,
    status: p.status,
    startDate: p.startDate,
    endDate: p.endDate,
    dueDate: p.dueDate,
  };
}

/** 1–5 rating band for a weighted score (same thresholds across the HR and HOD views). */
function ratingFor(score: number): 1 | 2 | 3 | 4 | 5 {
  if (score >= 4.5) return 5;
  if (score >= 3.8) return 4;
  if (score >= 2.8) return 3;
  if (score >= 1.8) return 2;
  return 1;
}

const periodOrder = (p: ReviewPeriod) => Number(p.year) * 4 + Number(p.quarter);
// PIP reviews have synthetic periods with no ReviewPeriod record; quarterly views must skip them.
const isQuarterly = (r: EmployeeReview) => !r.reviewType || r.reviewType === 'QUARTERLY';

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
      link: { view: 'reviews', params: { reviewId: review.id, openSelfAssess: true } },
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
      link: { view: 'dashboard', params: { appraisalId: appraisal.id, openLetter: true } },
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
          view: 'dashboard',
          params: {
            ...(meta.appraisalId ? { appraisalId: meta.appraisalId } : {}),
            openLetter: true,
          },
        };
      } else if (meta.subTab === 'reviews' || meta.reviewId) {
        link = {
          view: 'reviews',
          params: {
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
  myAppraisals: Appraisal[],
  periodMap: Map<string, ReviewPeriod>,
  cycles: Cycle[],
  now: Date
): Promise<DashboardMyReview> {
  const byPeriod = (r: EmployeeReview) => {
    const p = periodMap.get(r.reviewPeriodId);
    return p ? periodOrder(p) : new Date(r.createdAt).getTime();
  };
  const reviews = myReviews
    .filter((r) => isQuarterly(r) && periodMap.get(r.reviewPeriodId)?.status !== 'UPCOMING')
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

  // Build active appraisal snapshot from already-fetched myAppraisals (no extra DB query)
  const activeAppraisalRaw = myAppraisals
    .sort((a, b) => {
      // Prefer most recent year/month
      const aTime = (a.appraisalYear || 0) * 12 + (a.appraisalMonth || 0);
      const bTime = (b.appraisalYear || 0) * 12 + (b.appraisalMonth || 0);
      return bTime - aTime;
    })[0] || null;

  const activeAppraisal: DashboardMyReview['activeAppraisal'] = activeAppraisalRaw
    ? (() => {
        const score = activeAppraisalRaw.averageQuarterlyScore || 0;
        const matrix = score > 0 ? computeAppraisalMatrix(score) : null;
        const currentCTC = activeAppraisalRaw.currentCtc || (activeAppraisalRaw as any).currentCTC || (activeAppraisalRaw as any).ctcBreakdown?.currentCTC;
        const hrApproved = activeAppraisalRaw.approvedIncrementPercentage ?? (activeAppraisalRaw as any).hrApprovedIncrement;
        const mgrRecommended = activeAppraisalRaw.proposedIncrementPercentage ?? (activeAppraisalRaw as any).managerRecommendedIncrement;
        const incrementAmount = hrApproved || mgrRecommended;
        const newCTC = currentCTC && incrementAmount
          ? Math.round(currentCTC * (1 + incrementAmount / 100))
          : undefined;
        return {
          id: activeAppraisalRaw.id,
          appraisalYear: activeAppraisalRaw.appraisalYear,
          appraisalMonth: activeAppraisalRaw.appraisalMonth,
          status: activeAppraisalRaw.status,
          isLocked: Boolean(activeAppraisalRaw.isLocked),
          averageQuarterlyScore: score > 0 ? score : undefined,
          suggestedIncrementMin: matrix?.suggestedIncrementMin,
          suggestedIncrementMax: matrix?.suggestedIncrementMax,
          recommendedRating: matrix?.recommendedRating,
          managerRecommendedIncrement: mgrRecommended,
          hrApprovedIncrement: hrApproved,
          ctcBreakdown: currentCTC ? {
            currentCTC,
            newCTC,
            incrementAmount,
          } : undefined,
          acknowledged: Boolean(activeAppraisalRaw.employeeAcknowledgement?.acknowledged),
        };
      })()
    : null;

  return {
    employee: {
      id: employee.id,
      name: employee.name,
      employeeCode: employee.employeeCode,
      designationName: employee.designationName,
      departmentName: employee.departmentName,
      managerName: employee.managerName,
      hodName: employee.hodName,
      cycleName: cycle?.name || employee.cycleName,
      email: employee.email,
      phone: employee.phone,
      joiningDate: employee.joiningDate,
      status: employee.status,
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
    activeAppraisal,
    rollingScore: rollup.avgScore,
    evaluatedQuarters: rollup.evaluatedCount,
    ratingBand: bandOf(rollup.avgScore),
    scoreHistory: evaluated.slice(-6).map((r) => ({ periodName: r.reviewPeriodName, score: r.finalScore || 0 })),
    kras,
    nextAppraisal,
    activePip: await getActivePipForEmployee(employee.id),
  };
}

function buildTeam(
  members: Employee[],
  teamReviews: EmployeeReview[],
  managedPips: PerformanceImprovementPlan[],
  periodMap: Map<string, ReviewPeriod>
): DashboardTeam {
  const visibleReviews = teamReviews.filter((r) => isQuarterly(r) && periodMap.get(r.reviewPeriodId)?.status !== 'UPCOMING');
  const teamPeriods = [...new Set(visibleReviews.map((r) => r.reviewPeriodId))]
    .map((id) => periodMap.get(id))
    .filter((p): p is ReviewPeriod => Boolean(p))
    .sort((a, b) => periodOrder(a) - periodOrder(b));
  // Focus on the oldest period with unfinished work; once everything is closed, show the latest.
  const focus =
    teamPeriods.find((p) => visibleReviews.some((r) => r.reviewPeriodId === p.id && !isClosed(r))) ||
    teamPeriods[teamPeriods.length - 1];
  const focusReviews = focus ? visibleReviews.filter((r) => r.reviewPeriodId === focus.id) : [];
  const activeManagedPips = managedPips.filter((p) => ACTIVE_PIP_STATUSES.includes(p.status));
  const pipByEmpId = new Map(activeManagedPips.map((p) => [p.employeeId, p]));

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

    const empPip = pipByEmpId.get(member.id);

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
      onPip: Boolean(empPip),
      pipId: empPip?.id,
      pipStatus: empPip?.status,
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

  if (activeManagedPips.length > 0) {
    alerts.push({
      id: 'mgr_pips',
      type: 'warn',
      title: `${activeManagedPips.length} active PIP${activeManagedPips.length > 1 ? 's' : ''} in your team`,
      detail: `Performance milestones in progress for ${activeManagedPips.map((p) => p.employeeName).join(', ')}`,
      actionLabel: 'View PIP',
      link: { view: 'pip' },
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
    activePips: activeManagedPips,
  };
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

  // Employees without their own KRA scorecard (same rule as review generation)
  const hasScorecard = hasScorecardCheck(allTemplates);
  const activeEmps = allEmployees.filter((e) => e.status === 'ACTIVE');
  const employeesWithoutKras = activeEmps.filter((e) => !hasScorecard(e)).length;

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
  allEmployees: Employee[]
): Promise<DashboardHodOverview> {
  const reviewsCol = getDbCollection('employeeReviews');
  const appraisalsCol = getDbCollection('appraisals');
  const pipsCol = getDbCollection('performanceImprovementPlans');

  // Find HOD's employee record to get their departmentId
  const hodEmployee = allEmployees.find((e) => e.id === hodEmployeeId);
  const deptId = hodEmployee?.departmentId;

  // Get all employees in HOD's department
  const deptEmployees = deptId
    ? allEmployees.filter((e) => e.departmentId === deptId && e.status === 'ACTIVE')
    : [];
  const deptEmployeeIds = deptEmployees.map((e) => e.id);

  const [deptReviews, deptAppraisals, deptPips]: [
    EmployeeReview[],
    Appraisal[],
    PerformanceImprovementPlan[]
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
  ]);

  const visibleReviews = deptReviews.filter((r) => isQuarterly(r) && periodMap.get(r.reviewPeriodId)?.status !== 'UPCOMING');

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
  const withKra = deptEmployees.filter(hasScorecardCheck(allTemplates)).length;
  const kraCoverageRate = deptEmployees.length > 0 ? Math.round((withKra / deptEmployees.length) * 100) : 0;

  // Rating/performance computation
  const activeDeptPips = deptPips.filter((p) => ACTIVE_PIP_STATUSES.includes(p.status));
  const pipByEmpId = new Map(activeDeptPips.map((p) => [p.employeeId, p]));

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

  employeeScores.forEach((score) => {
    const rating = ratingFor(score);
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
  // Department member rows
  const departmentMembers = deptEmployees.map((emp) => {
    const review = employeeReviewMap.get(emp.id);
    const score = employeeScores.get(emp.id);
    const empPip = pipByEmpId.get(emp.id);
    return {
      employeeId: emp.id,
      name: emp.name,
      designationName: emp.designationName,
      managerId: emp.managerId,
      managerName: emp.managerName,
      reviewStatus: review?.status,
      stage: review ? stageOf(review) : undefined,
      lastScore: score,
      onPip: Boolean(empPip),
      pipId: empPip?.id,
      pipStatus: empPip?.status,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));

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
  if (activeDeptPips.length > 0) {
    alerts.push({
      id: 'hod_active_pips',
      type: 'warn',
      title: `${activeDeptPips.length} active PIP${activeDeptPips.length > 1 ? 's' : ''} in your department`,
      detail: `Performance milestones in progress for ${activeDeptPips.map((p) => p.employeeName).join(', ')}`,
      actionLabel: 'View PIPs',
      link: { view: 'pip' },
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
    totalEmployees: deptEmployees.length,
    reviewsTotal,
    reviewsCompleted,
    reviewsPendingHod,
    completionRate,
    averageScore,
    highPerformersCount: highCount,
    ratingSpread,
    departmentMembers,
    alerts,
    activePips: activeDeptPips,
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

    // A return to the HOD puts the review back in HOD_PENDING, so tell the HOD it came back
    // (with the returner's note and the return's own deadline) instead of "Manager submitted".
    const openReturn = [...(review.returnRequests || [])]
      .reverse()
      .find((r) => r.status === 'OPEN' && r.target === 'HOD');
    if (openReturn) {
      const returnDue = openReturn.dueAt || dueDate;
      const scope = openReturn.isFullReturn
        ? 'the full review'
        : `${openReturn.kraIds.length} KRA${openReturn.kraIds.length === 1 ? '' : 's'}`;
      tasks.push({
        id: `hod_revise_${review.id}`,
        type: 'REVISE_RETURNED_REVIEW',
        title: `Revise returned review · ${review.employeeName}`,
        detail: openReturn.reason
          ? `${openReturn.returnedByRole} note: “${openReturn.reason}”`
          : `${openReturn.returnedByRole} sent ${scope} back for re-evaluation.`,
        employeeId: review.employeeId,
        employeeName: review.employeeName,
        dueDate: returnDue,
        urgency: urgencyFor(returnDue, now),
        priority: 'High',
        link: { view: 'reviews', params: { reviewId: review.id } },
      });
      continue;
    }

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
  allTemplates: KraTemplate[]
): Promise<DashboardHrOverview> {
  const reviewsCol = getDbCollection('employeeReviews');
  const appraisalsCol = getDbCollection('appraisals');

  const activeEmployees = allEmployees.filter((e) => e.status === 'ACTIVE');
  const periodId = activePeriod?.id;

  const [currentReviews, allAppraisals]: [EmployeeReview[], Appraisal[]] = await Promise.all([
    periodId
      ? (await reviewsCol.find({ reviewPeriodId: periodId })).toArray()
      : (await reviewsCol.find({})).toArray(),
    (await appraisalsCol.find({})).toArray(),
  ]);

  const reviewsCompleted = currentReviews.filter((r) => isClosed(r)).length;
  const reviewsPendingHr = currentReviews.filter((r) => r.status === 'HR_PENDING' || r.status === 'MANAGER_COMPLETED').length;
  const reviewsPendingHod = currentReviews.filter((r) => r.status === 'HOD_PENDING').length;
  const reviewsPendingManager = currentReviews.filter((r) => MANAGER_OPEN_STATUSES.includes(r.status)).length;
  const reviewsTotal = currentReviews.length;
  const completionRate = reviewsTotal > 0 ? Math.round((reviewsCompleted / reviewsTotal) * 100) : 0;

  const pendingAppraisals = allAppraisals.filter((a) => !a.isLocked).length;

  // Employees without their own KRA scorecard (same rule as review generation)
  const hasScorecard = hasScorecardCheck(allTemplates);
  const employeesWithoutKras = activeEmployees.filter((e) => !hasScorecard(e)).length;

  const kraCoverageCount = activeEmployees.length - employeesWithoutKras;
  const kraCoverageRate = activeEmployees.length > 0
    ? Math.round((kraCoverageCount / activeEmployees.length) * 100)
    : 0;

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
      const deptsEmpsWithKra = activeEmployees.filter((e) => e.departmentId === d.id && hasScorecard(e)).length;
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


  // Upcoming Deadlines & Events — derived from the active period and appraisal cycles.
  const nowMs = Date.now();
  const toEvent = (id: string, title: string, category: string, iso: string): DashboardUpcomingEvent | null => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const startOfToday = new Date(nowMs);
    startOfToday.setHours(0, 0, 0, 0);
    const day = new Date(d);
    day.setHours(0, 0, 0, 0);
    const days = Math.round((day.getTime() - startOfToday.getTime()) / DAY_MS);
    if (days < 0) return null;
    return {
      id,
      title,
      category,
      timeRange: 'All day',
      dateMonth: MONTHS[d.getMonth()].toUpperCase(),
      dateDay: String(d.getDate()),
      daysRemaining: days,
      daysText: days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`,
    };
  };
  const eventCandidates: (DashboardUpcomingEvent | null)[] = [];
  if (activePeriod) {
    if (activePeriod.dueDate) eventCandidates.push(toEvent('event_review_due', 'Reviews due', activePeriod.name, activePeriod.dueDate));
    if (activePeriod.endDate && activePeriod.endDate !== activePeriod.dueDate) {
      eventCandidates.push(toEvent('event_period_end', 'Quarter ends', activePeriod.name, activePeriod.endDate));
    }
  }
  const today = new Date(nowMs);
  for (const c of cycles.filter((c) => c.active !== false && c.appraisalMonth)) {
    const month = Number(c.appraisalMonth);
    const year = month - 1 >= today.getMonth() ? today.getFullYear() : today.getFullYear() + 1;
    eventCandidates.push(
      toEvent(`event_appraisal_${c.id}`, 'Annual appraisals', c.name || c.code || 'Appraisal cycle', new Date(year, month - 1, 1).toISOString())
    );
  }
  const upcomingEvents: DashboardUpcomingEvent[] = eventCandidates
    .filter((e): e is DashboardUpcomingEvent => Boolean(e))
    .sort((x, y) => x.daysRemaining - y.daysRemaining)
    .slice(0, 5);

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

  if (activePeriod?.dueDate) {
    const openReviews = currentReviews.filter((r) => !isClosed(r)).length;
    const daysToDue = Math.ceil((new Date(activePeriod.dueDate).getTime() - nowMs) / DAY_MS);
    if (openReviews > 0 && daysToDue <= 7) {
      alerts.push({
        id: 'alert_approaching_deadlines',
        type: daysToDue < 0 ? 'crit' : 'warn',
        title:
          daysToDue < 0
            ? `${openReviews} review${openReviews === 1 ? '' : 's'} past the due date`
            : `${openReviews} review${openReviews === 1 ? '' : 's'} still open — due in ${daysToDue} day${daysToDue === 1 ? '' : 's'}`,
        detail: `${activePeriod.name} reviews are due ${new Date(activePeriod.dueDate).toLocaleDateString()}.`,
        actionLabel: 'View',
        link: { view: 'reviews' },
      });
    }
  }

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

  const [coverage, backlog] = await Promise.all([
    buildCoverage(activePeriod, allEmployees, activePeriod ? currentReviews : []),
    activePeriod ? computeReviewerBacklog(currentReviews, activePeriod) : Promise.resolve([]),
  ]);

  return {
    totalEmployees: activeEmployees.length,
    totalDepartments: allDepartments.length,
    reviewsTotal,
    reviewsCompleted,
    reviewsPendingHr,
    reviewsPendingHod,
    reviewsPendingManager,
    completionRate,
    pendingAppraisals,
    employeesWithoutKras,
    kraCoverageRate,
    departmentProgress,
    upcomingEvents,
    coverage,
    reviewerBacklog: publicBacklog(backlog),
    calibration: buildCalibration(activePeriod ? currentReviews : []),
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
  const appraisalsCol = getDbCollection('appraisals');
  const reviewsCol = getDbCollection('employeeReviews');

  const users: User[] = await (await usersCol.find({})).toArray();

  const activeUsers = users.filter((u: any) => u.isActive !== false).length;
  const activePeriod = periods.find((p) => p.status === 'ACTIVE');

  // --- Date helpers ---
  const nowDate = new Date(now);
  const thisMonthStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1);

  // Active employees only (no past employees)
  const activeEmps = allEmployees.filter((e: any) => !e.isPastEmployee && e.status !== 'INACTIVE');
  const pastEmps = allEmployees.filter((e: any) => e.isPastEmployee === true);

  // New joiners this month
  const newJoinersThisMonth = activeEmps.filter((e: any) => {
    const d = new Date(e.joiningDate || e.createdAt || '');
    return d >= thisMonthStart;
  }).length;

  // Exits this month (past employees, by last update)
  const exitsThisMonth = pastEmps.filter((e: any) => {
    const d = new Date(e.updatedAt || e.createdAt || '');
    return d >= thisMonthStart;
  }).length;

  // --- Employees per department (drives the per-department review progress) ---
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

  // --- Review Cycle Progress per Department ---
  // Get all reviews for the active period
  const reviewsByDept = new Map<string, { reviewed: number; total: number; name: string }>();

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
  const hasScorecard = hasScorecardCheck(allTemplates);
  const cnt = activeEmps.filter((e) => !hasScorecard(e)).length;
  if (cnt > 0) {
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

  const [dataHealth, emailDelivery] = await Promise.all([buildDataHealth(allEmployees, allTemplates, users), buildEmailDelivery(7, now)]);

  return {
    totalUsers: users.length,
    activeUsers,
    totalEmployees: activeEmps.length,
    totalDepartments: allDepartments.length,
    activePeriodName: activePeriod?.name,
    newJoinersThisMonth,
    exitsThisMonth,
    reviewCycleProgress,
    attentionItems,
    dataHealth,
    emailDelivery,
  };
}

/**
 * GET /api/dashboard/summary

 * The signed-in user's dashboard: their open tasks, their own review, and — when they have
 * direct reports — their team's review status. For HR and Admins, it also provides the
 * organization overview, department breakdown, and company-wide approval queues.
 */
/**
 * POST /api/dashboard/reviewer-reminder
 * HR / Super Admin nudge a Manager or HOD about their pending reviews (in-app + email).
 * Limited to one reminder per reviewer per 12 hours.
 */
dashboardRouter.post(
  '/dashboard/reviewer-reminder',
  requireRoles('HR', 'SUPER_ADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { reviewerId, role } = req.body || {};
      if (!reviewerId || (role !== 'MANAGER' && role !== 'HOD')) {
        return res.status(400).json({ error: 'reviewerId and role (MANAGER or HOD) are required.' });
      }
      const result = await sendReviewerReminder(String(reviewerId), role, {
        id: req.user!.id,
        name: req.user!.name,
        role: req.user!.role,
      });
      res.json(result);
    } catch (error: any) {
      res.status(error.status || 500).json({ error: error.message || 'Failed to send reminder.' });
    }
  }
);

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

    // The role sections are independent — build them in parallel.
    const [hrOverview, hodOverview, adminOverview] = await Promise.all([
      isHrOrAdmin ? buildHrOverview(activePeriod, allEmployees, allDepartments, cycles, allTemplates) : Promise.resolve(null),
      isHod && myEmployeeId
        ? (async () =>
            buildHodOverview(
              myEmployeeId,
              periodMap,
              isHrOrAdmin ? allEmployees : await (await getDbCollection('employees').find({})).toArray()
            ))()
        : Promise.resolve(null),
      isAdmin ? buildAdminOverview(allEmployees, allDepartments, cycles, allTemplates, periods, now) : Promise.resolve(null),
    ]);

    const summary: DashboardSummary = {
      generatedAt: nowDate.toISOString(),
      period: activePeriod ? toPeriod(activePeriod) : null,
      tasks,
      me: me ? await buildMyReview(me, myReviews, myAppraisals, periodMap, cycles, nowDate) : null,
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
