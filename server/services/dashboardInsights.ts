import { getDbCollection } from '../db.js';
import { recordAuditLog } from '../auth.js';
import { checkEmployeeReviewEligibility } from './reviewEligibility.js';
import { computeAppraisalMatrix, BELL_CURVE_TARGETS } from './appraisalScoring.js';
import { resolveRecipient, sendNotificationEmail } from './emailService.js';
import { renderReviewReminderEmail } from './emailTemplates.js';
import {
  DashboardCalibration,
  DashboardCoverage,
  DashboardDataHealthItem,
  DashboardEmailDelivery,
  DashboardReviewerBacklog,
  EmailLog,
  Employee,
  EmployeeReview,
  KraTemplate,
  Notification,
  ReviewPeriod,
  SystemConfig,
  User,
} from '../../src/types/index.js';

/*
 * Live HR / Admin dashboard insights. Every figure here is computed from stored records
 * (employees, reviews, KRA templates, users, notifications, email logs) — nothing is
 * estimated or hardcoded.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const SAMPLE = 5;
const MANAGER_STAGE = ['DRAFT', 'ASSIGNED', 'MANAGER_PENDING', 'RETURNED'];
const REMINDER_COOLDOWN_HOURS = 12;

/**
 * True when the employee has their own usable KRA scorecard — the rule review generation uses
 * (checkEmployeeReviewEligibility): no department/designation fallback.
 */
export function hasScorecardCheck(templates: KraTemplate[]): (e: Employee) => boolean {
  const usable = new Set(templates.filter((t) => t.active !== false && (t.items?.length || 0) > 0).map((t) => t.id));
  return (e) => Boolean(e.currentKraTemplateId && usable.has(e.currentKraTemplateId));
}

const isClosedReview = (r: EmployeeReview) => Boolean(r.isClosed) || r.status === 'CLOSED' || r.status === 'HR_COMPLETED';
const sample = (names: string[]) => names.slice(0, SAMPLE);

async function loadConfig(): Promise<SystemConfig | null> {
  const col = getDbCollection('systemConfig');
  try {
    return (await col.findOne({ id: 'global_config' })) || (await col.findOne({ id: 'default' }));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ 1. Review coverage */

/**
 * Employees in scope for the active period who have no review, grouped by the first
 * eligibility check that blocks them (the same checks review generation uses).
 */
export async function buildCoverage(
  activePeriod: ReviewPeriod | undefined,
  allEmployees: Employee[],
  periodReviews: EmployeeReview[]
): Promise<DashboardCoverage | null> {
  if (!activePeriod) return null;
  const config = await loadConfig();
  const includeProbation = config?.includeProbationInReviews ?? true;
  const inScope = allEmployees.filter((e) => e.status === 'ACTIVE' || (includeProbation && e.status === 'PROBATION'));
  const reviewed = new Set(periodReviews.map((r) => r.employeeId));
  const missing = inScope.filter((e) => !reviewed.has(e.id));

  type Key = DashboardCoverage['reasons'][number]['key'];
  const buckets = new Map<Key, string[]>();
  let minTenureDays = config?.minTenureDaysForReview ?? 30;
  // Load templates and periods once and hand them to the eligibility check, which otherwise
  // makes 2–3 database round-trips per employee.
  const [templates, periods]: [KraTemplate[], ReviewPeriod[]] = await Promise.all([
    (await getDbCollection('kraTemplates').find({})).toArray(),
    (await getDbCollection('reviewPeriods').find({})).toArray(),
  ]);
  const preload = {
    reviewedEmployeeIds: reviewed,
    templatesById: new Map(templates.map((t) => [t.id, t])),
    periodsById: new Map(periods.map((p) => [p.id, p])),
  };
  for (const emp of missing) {
    // An empty config means "use the defaults" — the same outcome as no stored config, without
    // the eligibility check re-querying for it on every call.
    const result = await checkEmployeeReviewEligibility(emp, activePeriod, config ?? ({} as SystemConfig), preload);
    minTenureDays = result.minTenureDays;
    const c = result.checks;
    const key: Key = !c.hasManager
      ? 'NO_MANAGER'
      : !c.hasKraTemplate
      ? 'NO_KRA'
      : !c.startingPeriodMet
      ? 'START_LATER'
      : !c.tenureMet
      ? 'TENURE'
      : result.eligible
      ? 'READY'
      : 'OTHER';
    buckets.set(key, [...(buckets.get(key) || []), emp.name]);
  }

  const meta: Record<Key, { label: string; hint: string; link: DashboardCoverage['reasons'][number]['link'] }> = {
    NO_KRA: { label: 'No KRA scorecard', hint: 'Assign a KRA template to these employees', link: { view: 'kras' } },
    NO_MANAGER: { label: 'No manager or HOD', hint: 'Set a reporting manager in the directory', link: { view: 'employees' } },
    START_LATER: { label: 'Reviews start in a later quarter', hint: 'Configured on the employee record', link: { view: 'employees' } },
    TENURE: {
      label: `Joined too recently (< ${minTenureDays} days this quarter)`,
      hint: 'A review can still be started manually with a reason',
      link: { view: 'reviews' },
    },
    READY: { label: 'Eligible, review not created yet', hint: 'Created by the next daily sync, or start it now', link: { view: 'reviews' } },
    OTHER: { label: 'Not eligible (other reason)', hint: 'Check the employee record', link: { view: 'employees' } },
  };
  const order: Key[] = ['NO_KRA', 'NO_MANAGER', 'READY', 'TENURE', 'START_LATER', 'OTHER'];

  return {
    periodName: activePeriod.name,
    inScope: inScope.length,
    withReview: inScope.length - missing.length,
    missing: missing.length,
    reasons: order
      .filter((k) => (buckets.get(k) || []).length > 0)
      .map((k) => ({ key: k, ...meta[k], count: buckets.get(k)!.length, people: sample(buckets.get(k)!) })),
  };
}

/* ------------------------------------------------------------------ 2. Reviewers behind */

interface BacklogEntry extends DashboardReviewerBacklog {
  reviewIds: string[];
}

/** Active-period reviews currently waiting on a Manager or HOD, grouped by that person. */
export async function computeReviewerBacklog(
  periodReviews: EmployeeReview[],
  activePeriod: ReviewPeriod | undefined,
  now: number = Date.now()
): Promise<BacklogEntry[]> {
  const dueMs = activePeriod?.dueDate ? new Date(activePeriod.dueDate).getTime() : NaN;
  const overdueDays = Number.isFinite(dueMs) && now > dueMs ? Math.floor((now - dueMs) / DAY_MS) : 0;
  const map = new Map<string, BacklogEntry>();

  for (const r of periodReviews) {
    if (isClosedReview(r)) continue;
    const role: 'MANAGER' | 'HOD' | null = MANAGER_STAGE.includes(r.status) ? 'MANAGER' : r.status === 'HOD_PENDING' ? 'HOD' : null;
    if (!role) continue;
    const reviewerId = role === 'MANAGER' ? r.managerId : r.hodId;
    if (!reviewerId) continue;
    // Waiting since the last workflow step that put the review where it is now.
    const lastStep = [...(r.actionHistory || [])].reverse().find((a) => a.action !== 'DRAFT_SAVED');
    const since = new Date(lastStep?.performedAt || r.createdAt).getTime();
    const waitingDays = Number.isFinite(since) ? Math.max(0, Math.floor((now - since) / DAY_MS)) : 0;

    const key = `${role}:${reviewerId}`;
    const entry =
      map.get(key) ||
      ({
        reviewerId,
        reviewerName: (role === 'MANAGER' ? r.managerName : r.hodName) || 'Unknown',
        role,
        pending: 0,
        employees: [],
        oldestWaitingDays: 0,
        overdueDays,
        reviewIds: [],
      } as BacklogEntry);
    entry.pending++;
    entry.employees.push(r.employeeName);
    entry.reviewIds.push(r.id);
    entry.oldestWaitingDays = Math.max(entry.oldestWaitingDays, waitingDays);
    map.set(key, entry);
  }

  const entries = [...map.values()];
  if (entries.length) {
    const reminders: Notification[] = await (await getDbCollection('notifications').find({ type: 'REMINDER' })).toArray();
    for (const e of entries) {
      const last = reminders
        .filter((n) => n.userId === e.reviewerId && n.metadata?.source === 'dashboard')
        .map((n) => n.createdAt)
        .sort()
        .pop();
      if (last) e.lastRemindedAt = last;
    }
  }
  return entries.sort((a, b) => b.pending - a.pending || b.oldestWaitingDays - a.oldestWaitingDays);
}

/** Strips internal ids before the backlog goes to the browser. */
export const publicBacklog = (entries: BacklogEntry[]): DashboardReviewerBacklog[] =>
  entries.map(({ reviewIds: _ids, ...rest }) => ({ ...rest, employees: sample(rest.employees) }));

/** HR / Super Admin nudge: in-app notification + email to one reviewer about their pending reviews. */
export async function sendReviewerReminder(
  reviewerId: string,
  role: 'MANAGER' | 'HOD',
  sender: { id: string; name: string; role: any }
): Promise<{ sentAt: string; pending: number; emailStatus: string }> {
  const periods: ReviewPeriod[] = await (await getDbCollection('reviewPeriods').find({})).toArray();
  const activePeriod = periods.find((p) => p.status === 'ACTIVE');
  if (!activePeriod) throw Object.assign(new Error('There is no active review period.'), { status: 400 });

  const periodReviews: EmployeeReview[] = await (await getDbCollection('employeeReviews').find({ reviewPeriodId: activePeriod.id })).toArray();
  const entry = (await computeReviewerBacklog(periodReviews, activePeriod)).find((e) => e.reviewerId === reviewerId && e.role === role);
  if (!entry) throw Object.assign(new Error('This reviewer has no pending reviews.'), { status: 400 });

  if (entry.lastRemindedAt) {
    const hoursSince = (Date.now() - new Date(entry.lastRemindedAt).getTime()) / (60 * 60 * 1000);
    if (hoursSince < REMINDER_COOLDOWN_HOURS) {
      throw Object.assign(
        new Error(`A reminder was already sent ${Math.max(1, Math.floor(hoursSince))}h ago. You can send another after ${REMINDER_COOLDOWN_HOURS} hours.`),
        { status: 429 }
      );
    }
  }

  const nowIso = new Date().toISOString();
  const dueText = activePeriod.dueDate ? new Date(activePeriod.dueDate).toLocaleDateString() : '';
  await getDbCollection('notifications').insertOne({
    id: `notif_remind_dash_${reviewerId}_${Date.now()}`,
    userId: reviewerId,
    userRole: role === 'HOD' ? 'HOD' : 'MANAGER',
    type: 'REMINDER',
    title: `Reminder: ${entry.pending} review${entry.pending === 1 ? '' : 's'} waiting for you`,
    message: `${sender.name} (HR) is reminding you that ${entry.employees.join(', ')} ${entry.pending === 1 ? 'is' : 'are'} waiting for your ${
      role === 'HOD' ? 'HOD scoring' : 'evaluation'
    } in ${activePeriod.name}${dueText ? ` (due ${dueText})` : ''}.`,
    isRead: false,
    priority: 'HIGH',
    metadata: { source: 'dashboard', periodId: activePeriod.id, reviewIds: entry.reviewIds, sentBy: sender.id },
    createdAt: nowIso,
  });

  let emailStatus = 'NOT_SENT';
  const recipient = await resolveRecipient(reviewerId);
  if (recipient) {
    const { subject, html } = renderReviewReminderEmail({
      reviewerName: recipient.name,
      senderName: sender.name,
      periodName: activePeriod.name,
      dueDate: dueText,
      employees: entry.employees,
      reviewUrl: `${process.env.APP_URL || 'http://localhost:5173'}/#reviews`,
    });
    const log = await sendNotificationEmail({
      recipientId: reviewerId,
      recipientEmail: recipient.email,
      recipientName: recipient.name,
      subject,
      html,
      templateType: 'REVIEW_REMINDER',
      metadata: { periodId: activePeriod.id, reviewIds: entry.reviewIds, sentBy: sender.id },
    });
    emailStatus = log.status;
  }

  await recordAuditLog(
    sender.id,
    sender.name,
    sender.role,
    'EMPLOYEE_REVIEWS',
    'REVIEW_REMINDER_SENT',
    reviewerId,
    '',
    String(entry.pending),
    `Reminder sent to ${entry.reviewerName} (${role}) for ${entry.pending} pending review(s) in ${activePeriod.name}. Email: ${emailStatus}`
  );

  return { sentAt: nowIso, pending: entry.pending, emailStatus };
}

/* ------------------------------------------------------------------ 3. Calibration health */

const BAND_LABELS: Record<DashboardCalibration['bands'][number]['key'], string> = {
  OUTSTANDING: 'Outstanding',
  EXCEEDS_EXPECTATIONS: 'Exceeds',
  MEETS_EXPECTATIONS: 'Meets',
  NEEDS_IMPROVEMENT: 'Needs improvement',
};

export function buildCalibration(periodReviews: EmployeeReview[], now: number = Date.now()): DashboardCalibration {
  const counts: Record<string, number> = { OUTSTANDING: 0, EXCEEDS_EXPECTATIONS: 0, MEETS_EXPECTATIONS: 0, NEEDS_IMPROVEMENT: 0 };
  let scored = 0;
  let krasCompared = 0;
  let krasDisagreeing = 0;
  let reviewsWithDisagreement = 0;
  const returnGroups = new Set<string>();
  let returnsOpen = 0;
  let returnsOverdue = 0;

  for (const r of periodReviews) {
    const score = r.finalScore || r.managerScore || 0;
    if (score > 0) {
      counts[computeAppraisalMatrix(score).recommendedRating]++;
      scored++;
    }
    let disagreesHere = false;
    for (const k of r.kraSnapshot || []) {
      const mgr = Number(k.rating) || 0;
      const hod = Number(k.hodRating) || 0;
      if (mgr > 0 && hod > 0) {
        krasCompared++;
        if (Math.abs(mgr - hod) >= 2) {
          krasDisagreeing++;
          disagreesHere = true;
        }
      }
    }
    if (disagreesHere) reviewsWithDisagreement++;
    for (const req of r.returnRequests || []) {
      returnGroups.add(req.groupId || req.id);
      if (req.status === 'OPEN') {
        returnsOpen++;
        if (req.dueAt && new Date(req.dueAt).getTime() < now) returnsOverdue++;
      }
    }
  }

  const pct = (n: number) => (scored > 0 ? Math.round((n / scored) * 100) : 0);
  return {
    scored,
    bands: (Object.keys(BAND_LABELS) as DashboardCalibration['bands'][number]['key'][]).map((key) => ({
      key,
      label: BAND_LABELS[key],
      count: counts[key],
      percent: pct(counts[key]),
      targetPercent: BELL_CURVE_TARGETS[key],
    })),
    krasCompared,
    krasDisagreeing,
    reviewsWithDisagreement,
    returnsThisCycle: returnGroups.size,
    returnsOpen,
    returnsOverdue,
  };
}

/* ------------------------------------------------------------------ 6. Data health (admin) */

export async function buildDataHealth(allEmployees: Employee[], allTemplates: KraTemplate[], users: User[]): Promise<DashboardDataHealthItem[]> {
  const isCurrent = (e: Employee) => !(e as any).isPastEmployee && e.status !== 'INACTIVE';
  const current = allEmployees.filter(isCurrent);
  const employeeById = new Map(allEmployees.map((e) => [e.id, e]));
  const hasScorecard = hasScorecardCheck(allTemplates);
  const names = (list: { name: string }[]) => sample(list.map((x) => x.name));

  const noManager = current.filter((e) => !e.managerId);
  const noHod = current.filter((e) => !e.hodId);
  const noDept = current.filter((e) => !e.departmentId);
  const noKra = current.filter((e) => !hasScorecard(e));
  // Admin / leadership accounts don't need an employee record; everyone else does.
  const linkedRoles = ['EMPLOYEE', 'MANAGER', 'REPORTING_MANAGER', 'HOD', 'HR'];
  const unlinkedUsers = users.filter(
    (u) => linkedRoles.includes(u.role) && (!u.employeeId || !employeeById.has(u.employeeId))
  );
  const openReviews: EmployeeReview[] = (await (await getDbCollection('employeeReviews').find({})).toArray()).filter(
    (r: EmployeeReview) => !isClosedReview(r)
  );
  const leaversWithOpenReviews = openReviews.filter((r) => {
    const emp = employeeById.get(r.employeeId);
    return !emp || !isCurrent(emp);
  });

  return [
    { key: 'NO_MANAGER', label: 'Employees without a reporting manager', count: noManager.length, people: names(noManager), link: { view: 'employees' } },
    { key: 'NO_HOD', label: 'Employees without an HOD', count: noHod.length, people: names(noHod), link: { view: 'hierarchy' } },
    { key: 'NO_DEPARTMENT', label: 'Employees without a department', count: noDept.length, people: names(noDept), link: { view: 'employees' } },
    { key: 'NO_KRA', label: 'Employees without a KRA scorecard', count: noKra.length, people: names(noKra), link: { view: 'kras' } },
    { key: 'UNLINKED_USERS', label: 'User accounts not linked to an employee', count: unlinkedUsers.length, people: names(unlinkedUsers), link: { view: 'employees' } },
    {
      key: 'LEAVER_REVIEWS',
      label: 'Open reviews for inactive employees',
      count: leaversWithOpenReviews.length,
      people: sample(leaversWithOpenReviews.map((r) => r.employeeName)),
      link: { view: 'reviews' },
    },
  ];
}

/* ------------------------------------------------------------------ 7. Email delivery (admin) */

export async function buildEmailDelivery(days = 7, now: number = Date.now()): Promise<DashboardEmailDelivery> {
  const since = now - days * DAY_MS;
  const logs: EmailLog[] = (await (await getDbCollection('emailLogs').find({})).toArray()).filter((l: EmailLog) => {
    const t = new Date(l.sentAt || l.createdAt || '').getTime();
    return Number.isFinite(t) && t >= since;
  });
  const count = (s: EmailLog['status']) => logs.filter((l) => l.status === s).length;
  const failures = logs
    .filter((l) => l.status === 'FAILED')
    .sort((a, b) => String(b.sentAt || b.createdAt).localeCompare(String(a.sentAt || a.createdAt)))
    .slice(0, 3)
    .map((l) => ({ recipientName: l.recipientName, subject: l.subject, error: l.errorMessage, at: String(l.sentAt || l.createdAt) }));
  return {
    days,
    providerConfigured: Boolean(process.env.RESEND_API_KEY?.trim()),
    sent: count('SENT'),
    failed: count('FAILED'),
    skipped: count('SKIPPED'),
    queued: count('QUEUED'),
    recentFailures: failures,
  };
}
