import { getDbCollection } from '../db.js';
import { recordAuditLog } from '../auth.js';
import {
  EmployeeReview,
  ReviewAction,
  ReviewKraSnapshot,
  ReviewReturnRequest,
  ReviewReturnDraft,
  KraRevisionChange,
  ReturnPolicy,
  ReturnReasonCode,
  ReturnTarget,
  ReturnSendTarget,
  ReviewStatus,
  SystemConfig,
  RETURN_REASON_TEMPLATES,
} from '../../src/types/index.js';

/**
 * KRA-level review returns.
 *
 * A return (HOD -> Manager, HR -> Manager, HR -> HOD) now names the KRAs that need
 * re-evaluation. Those KRAs carry a `returnFlag` while the return is open; every other KRA is
 * locked for the recipient (enforced here on the server, not just in the UI). On resubmission
 * each flagged KRA must be either changed or explicitly kept with a reason, and the per-KRA
 * before/after diff is recorded on the request and in the audit trail.
 */

export const DEFAULT_RETURN_POLICY: ReturnPolicy = {
  maxReturnsPerReview: 3,
  returnLimitAction: 'ESCALATE',
  returnSlaDays: 3,
};

const VALID_REASON_CODES = new Set<string>(RETURN_REASON_TEMPLATES.map((t) => t.code));
const MIN_KEEP_REASON_CHARS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

async function loadSystemConfig(): Promise<SystemConfig | null> {
  const configCol = getDbCollection('systemConfig');
  return (await configCol.findOne({ id: 'global_config' })) || (await configCol.findOne({ id: 'default' }));
}

export async function getReturnPolicy(): Promise<ReturnPolicy> {
  const config = await loadSystemConfig().catch(() => null);
  return {
    maxReturnsPerReview: config?.maxReturnsPerReview ?? DEFAULT_RETURN_POLICY.maxReturnsPerReview,
    returnLimitAction: config?.returnLimitAction ?? DEFAULT_RETURN_POLICY.returnLimitAction,
    returnSlaDays: config?.returnSlaDays ?? DEFAULT_RETURN_POLICY.returnSlaDays,
  };
}

export async function updateReturnPolicy(
  patch: Partial<ReturnPolicy>,
  user: { id: string; name: string; role: any }
): Promise<ReturnPolicy> {
  const current = await getReturnPolicy();
  const next: ReturnPolicy = {
    maxReturnsPerReview: clampInt(patch.maxReturnsPerReview, 1, 20) ?? current.maxReturnsPerReview,
    returnLimitAction:
      patch.returnLimitAction === 'BLOCK' || patch.returnLimitAction === 'ESCALATE'
        ? patch.returnLimitAction
        : current.returnLimitAction,
    returnSlaDays: clampInt(patch.returnSlaDays, 1, 60) ?? current.returnSlaDays,
  };

  const configCol = getDbCollection('systemConfig');
  const now = new Date().toISOString();
  const existing = await configCol.findOne({ id: 'global_config' });
  if (existing) {
    await configCol.updateOne({ id: 'global_config' }, { $set: { ...next, updatedAt: now, updatedBy: user.id } });
  } else {
    await configCol.insertOne({
      id: 'global_config',
      hodApprovalEnabled: true,
      selfAssessmentEnabled: true,
      ...next,
      updatedAt: now,
      updatedBy: user.id,
    });
  }

  await recordAuditLog(
    user.id,
    user.name,
    user.role,
    'SYSTEM_CONFIG',
    'RETURN_POLICY_UPDATED',
    'global_config',
    JSON.stringify(current),
    JSON.stringify(next),
    `Review return policy updated by ${user.name}`
  );
  return next;
}

function clampInt(value: unknown, min: number, max: number): number | undefined {
  const n = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Number of times this review has been sent back (legacy returns included via the action log).
 * A "return to both" creates two linked requests but counts once.
 */
export function getReturnCount(review: EmployeeReview): number {
  const fromActions = (review.actionHistory || []).filter(
    (a) => a.action === 'RETURNED' || a.action === 'HOD_RETURNED'
  ).length;
  const groups = new Set((review.returnRequests || []).map((r) => r.groupId || r.id));
  return Math.max(fromActions, groups.size);
}

export function getOpenReturnRequest(
  review: EmployeeReview,
  target?: ReturnTarget
): ReviewReturnRequest | undefined {
  return [...(review.returnRequests || [])]
    .reverse()
    .find((r) => r.status === 'OPEN' && (!target || r.target === target));
}

function kraLabel(k: ReviewKraSnapshot): string {
  return k.kraName || k.title || 'KRA';
}

export interface ReturnInput {
  /** 'BOTH' (HR only): Manager first, then HOD, then back to HR. */
  target: ReturnSendTarget;
  /** Omitted or empty = full return (every KRA). For 'BOTH' these are the Manager's KRAs. */
  kraIds?: string[];
  /** HOD's KRAs for a 'BOTH' return (omitted or empty = every KRA). */
  hodKraIds?: string[];
  kraComments?: Record<string, string>;
  reasonCodes?: string[];
  reason: string;
}

/**
 * Creates a KRA-level return and moves the review to the recipient.
 * Status transitions: HOD -> MANAGER_PENDING; HR->Manager -> RETURNED; HR->HOD -> HOD_PENDING;
 * HR->Both -> RETURNED (Manager leg OPEN, HOD leg QUEUED until the Manager resubmits).
 * Caller is responsible for role/ownership/status authorization.
 */
export async function createReviewReturn(
  review: EmployeeReview,
  input: ReturnInput,
  user: { id: string; name: string; role: any },
  origin: 'HOD' | 'HR'
): Promise<EmployeeReview> {
  const reason = String(input.reason || '').trim();
  if (!reason) {
    throw new Error('Return reason is mandatory. Please provide specific feedback.');
  }
  if (review.isClosed) {
    throw new Error('Cannot return a closed review.');
  }

  const isBoth = origin === 'HR' && input.target === 'BOTH';
  // For a return to both, the first leg goes to the Manager; the HOD leg is queued.
  const target: ReturnTarget = origin === 'HOD' ? 'MANAGER' : input.target === 'HOD' ? 'HOD' : 'MANAGER';
  if ((target === 'HOD' || isBoth) && !review.hodId) {
    throw new Error('Cannot return to HOD: no HOD is configured for this employee.');
  }

  const snapshot = review.kraSnapshot || [];
  if (snapshot.length === 0) {
    throw new Error('This review has no KRAs to return.');
  }

  const knownIds = new Set(snapshot.map((k) => k.id));
  const resolveIds = (list: string[] | undefined): string[] => {
    const requested = Array.isArray(list) ? list.filter(Boolean) : [];
    if (requested.some((id) => !knownIds.has(id))) {
      throw new Error('One or more selected KRAs do not belong to this review. Please refresh and try again.');
    }
    return requested.length > 0 ? Array.from(new Set(requested)) : snapshot.map((k) => k.id);
  };
  const kraIds = resolveIds(input.kraIds);
  const isFullReturn = kraIds.length === snapshot.length;
  const selectedSet = new Set(kraIds);
  const hodKraIds = isBoth ? resolveIds(input.hodKraIds) : [];
  const hodSet = new Set(hodKraIds);

  const reasonCodes = (input.reasonCodes || []).filter((c) => VALID_REASON_CODES.has(c)) as ReturnReasonCode[];
  const commentsFor = (ids: Set<string>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [id, text] of Object.entries(input.kraComments || {})) {
      const trimmed = String(text || '').trim().slice(0, 1000);
      if (trimmed && ids.has(id)) out[id] = trimmed;
    }
    return out;
  };
  const kraComments = commentsFor(selectedSet);

  // Return-count limit
  const policy = await getReturnPolicy();
  const priorReturns = getReturnCount(review);
  const overLimit = priorReturns >= policy.maxReturnsPerReview;
  const isPrivileged = user.role === 'HR' || user.role === 'SUPER_ADMIN';
  if (overLimit && policy.returnLimitAction === 'BLOCK' && !isPrivileged) {
    throw new Error(
      `This review has already been returned ${priorReturns} time${priorReturns === 1 ? '' : 's'} (limit: ${policy.maxReturnsPerReview}). Please submit it and raise your concerns with HR instead.`
    );
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const round = priorReturns + 1;
  const requestId = `ret_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const groupId = isBoth ? `retgrp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}` : undefined;
  const ratingField: 'rating' | 'hodRating' = target === 'MANAGER' ? 'rating' : 'hodRating';

  const updatedSnapshot: ReviewKraSnapshot[] = snapshot.map((k) => {
    // Any markers from a previous round are stale once a new return starts.
    const { returnFlag: _oldFlag, revisedAfterReturn: _oldRevision, ...rest } = k;
    if (!selectedSet.has(k.id)) return rest;
    return {
      ...rest,
      returnFlag: {
        requestId,
        round,
        target,
        returnedByRole: origin,
        returnedByName: user.name,
        returnedAt: nowIso,
        comment: kraComments[k.id],
        previousRating: Number(k[ratingField]) || 0,
        previousJustification: (target === 'MANAGER' ? k.ratingJustification : k.hodJustification) || '',
        previousAchievement: (target === 'MANAGER' ? k.achievement : k.hodAchievement) || '',
      },
    };
  });

  const kraTitles = updatedSnapshot.filter((k) => selectedSet.has(k.id)).map(kraLabel);

  const request: ReviewReturnRequest = {
    id: requestId,
    round,
    target,
    returnedBy: user.id,
    returnedByName: user.name,
    returnedByRole: origin,
    kraIds,
    kraTitles,
    kraComments,
    isFullReturn,
    reasonCodes,
    reason,
    createdAt: nowIso,
    dueAt: new Date(now.getTime() + policy.returnSlaDays * DAY_MS).toISOString(),
    status: 'OPEN',
    remindersSent: 0,
    overLimit: overLimit || undefined,
    groupId,
  };

  // Second leg of a return to both — waits until the Manager resubmits (its SLA starts then).
  const hodKraTitles = snapshot.filter((k) => hodSet.has(k.id)).map(kraLabel);
  const hodRequest: ReviewReturnRequest | undefined = isBoth
    ? {
        ...request,
        id: `ret_${Date.now()}_${Math.random().toString(36).substring(2, 6)}h`,
        target: 'HOD',
        kraIds: hodKraIds,
        kraTitles: hodKraTitles,
        kraComments: commentsFor(hodSet),
        isFullReturn: hodKraIds.length === snapshot.length,
        dueAt: '',
        status: 'QUEUED',
      }
    : undefined;

  const previousRequests = (review.returnRequests || []).map((r) =>
    r.status === 'OPEN' || r.status === 'QUEUED' ? { ...r, status: 'SUPERSEDED' as const, resolvedAt: nowIso } : r
  );

  const scopeOf = (ids: string[], titles: string[]) =>
    ids.length === snapshot.length ? 'all KRAs' : `${ids.length} of ${snapshot.length} KRAs (${titles.join(', ')})`;
  const scopeText = isBoth
    ? `Manager: ${scopeOf(kraIds, kraTitles)}; then HOD: ${scopeOf(hodKraIds, hodKraTitles)}`
    : scopeOf(kraIds, kraTitles);
  const action: ReviewAction = {
    id: `act_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    reviewId: review.id,
    action: origin === 'HOD' ? 'HOD_RETURNED' : 'RETURNED',
    returnTarget: target,
    returnRequestId: requestId,
    returnedKraIds: kraIds,
    returnedKraTitles: kraTitles,
    hodKraIds: isBoth ? hodKraIds : undefined,
    hodKraTitles: isBoth ? hodKraTitles : undefined,
    reasonCodes,
    performedBy: user.id,
    performedByName: user.name,
    performedByRole: user.role,
    remarks: `Returned by ${origin} — ${scopeText}: ${reason}`,
    performedAt: nowIso,
  };

  const nextStatus: ReviewStatus = origin === 'HOD' ? 'MANAGER_PENDING' : target === 'HOD' ? 'HOD_PENDING' : 'RETURNED';

  const updated: EmployeeReview = {
    ...review,
    kraSnapshot: updatedSnapshot,
    status: nextStatus,
    returnRequests: [...previousRequests, request, ...(hodRequest ? [hodRequest] : [])],
    actionHistory: [...(review.actionHistory || []), action],
    updatedAt: nowIso,
  };

  const reviewCol = getDbCollection('employeeReviews');
  await reviewCol.updateOne({ id: review.id }, { $set: updated });
  await getDbCollection('reviewReturnDrafts').deleteOne({ id: draftId(review.id, user.id) });

  // Notifications
  const notifCol = getDbCollection('notifications');
  await notifCol.updateMany(
    {
      'metadata.reviewId': review.id,
      type: { $in: ['HOD_PENDING', 'MANAGER_SUBMITTED', 'HOD_APPROVED', 'HR_PENDING', 'RETURNED'] },
      isRead: false,
    },
    { $set: { isRead: true } }
  );

  const recipientId = target === 'HOD' ? review.hodId : review.managerId;
  const titlePreview = kraTitles.slice(0, 3).join(', ') + (kraTitles.length > 3 ? ` +${kraTitles.length - 3} more` : '');
  if (recipientId) {
    await notifCol.insertOne({
      id: `notif_${review.id}_${requestId}`,
      userId: recipientId,
      userRole: target === 'HOD' ? 'HOD' : 'MANAGER',
      type: 'RETURNED',
      title: `Review Returned by ${origin}: ${review.employeeName}`,
      message:
        (isFullReturn
          ? `${user.name} (${origin}) returned the full ${review.reviewPeriodName} review for ${review.employeeName}. Reason: ${reason}`
          : `${user.name} (${origin}) returned ${kraIds.length} KRA${kraIds.length === 1 ? '' : 's'} for re-evaluation (${titlePreview}) on ${review.employeeName}'s ${review.reviewPeriodName} review. Reason: ${reason}`) +
        (isBoth ? ` After you resubmit, it goes to the HOD to re-evaluate ${hodKraIds.length} KRA${hodKraIds.length === 1 ? '' : 's'}.` : ''),
      isRead: false,
      priority: 'HIGH',
      metadata: {
        reviewId: review.id,
        periodId: review.reviewPeriodId,
        status: nextStatus,
        returnRequestId: requestId,
        kraIds,
        reason,
        dueAt: request.dueAt,
      },
      createdAt: nowIso,
    });
  }

  if (overLimit && policy.returnLimitAction === 'ESCALATE' && origin === 'HOD') {
    await notifCol.insertOne({
      id: `notif_${review.id}_return_limit_${Date.now()}`,
      userId: 'ALL',
      userRole: 'HR',
      type: 'REVIEW_ESCALATION',
      title: `Return Limit Exceeded: ${review.employeeName}`,
      message: `${review.employeeName}'s ${review.reviewPeriodName} review has now been returned ${round} times (limit: ${policy.maxReturnsPerReview}). Latest return by ${user.name}: ${reason}`,
      isRead: false,
      priority: 'HIGH',
      metadata: { reviewId: review.id, periodId: review.reviewPeriodId, returnCount: round },
      createdAt: nowIso,
    });
  }

  await recordAuditLog(
    user.id,
    user.name,
    user.role,
    'EMPLOYEE_REVIEWS',
    origin === 'HOD' ? 'REVIEW_HOD_RETURNED' : 'REVIEW_RETURNED',
    review.id,
    review.status,
    nextStatus,
    `Review for ${review.employeeName} returned to ${isBoth ? `${review.managerName}, then ${review.hodName || 'HOD'}` : target === 'HOD' ? review.hodName || 'HOD' : review.managerName} (round ${round}) — ${scopeText}. Reason: ${reason}`
  );

  return updated;
}

/** Reviewer-side responses sent with a resubmission, keyed by KRA id. */
export type ReturnResponses = Record<string, { reply?: string; keepRating?: boolean; keepReason?: string }>;

/**
 * Applies the recipient's edits to a review with an open return of the matching target.
 *
 * - Only flagged KRAs accept changes to `fields`; all other KRAs keep their stored values,
 *   whatever the client sent.
 * - Reply / keep-rating responses are stored on the flag (also for drafts).
 * - On submit, every flagged KRA must be changed or explicitly kept with a reason; the
 *   request is then resolved, flags are cleared and the diff is returned for the audit log.
 *
 * When there is no open return for `target`, the merged snapshot passes through unchanged.
 */
export function applyReturnEdits(params: {
  existing: EmployeeReview;
  merged: ReviewKraSnapshot[];
  target: ReturnTarget;
  responses?: ReturnResponses;
  isDraft: boolean;
  user: { id: string; name: string };
  /** True when the resubmission will route through the HOD next (Manager edits only). */
  routesToHod?: boolean;
  /** SLA for a queued HOD leg that becomes active on this resubmission. */
  returnSlaDays?: number;
}): {
  snapshot: ReviewKraSnapshot[];
  returnRequests?: ReviewReturnRequest[];
  changes?: KraRevisionChange[];
  resolvedRequest?: ReviewReturnRequest;
  clearedHodScore?: boolean;
  /** Set when resolving the Manager leg of a return to both opened the queued HOD leg. */
  activatedRequest?: ReviewReturnRequest;
} {
  const { existing, merged, target, responses, isDraft, user, returnSlaDays } = params;
  const open = getOpenReturnRequest(existing, target);
  if (!open) return { snapshot: merged };
  const queuedHodLeg =
    target === 'MANAGER' && open.groupId
      ? (existing.returnRequests || []).find((r) => r.groupId === open.groupId && r.status === 'QUEUED' && r.target === 'HOD')
      : undefined;
  // In a return to both, the HOD re-checks only the KRAs HR picked for them, so their other
  // ratings are never reset by the Manager's revision.
  const routesToHod = queuedHodLeg ? false : params.routesToHod;

  const ratingField: 'rating' | 'hodRating' = target === 'MANAGER' ? 'rating' : 'hodRating';
  const ownFields: Array<keyof ReviewKraSnapshot> =
    target === 'MANAGER'
      ? ['rating', 'achievement', 'comments', 'issueReason', 'ratingJustification']
      : ['hodRating', 'hodAchievement', 'hodComments', 'hodJustification'];

  const flagged = new Set(open.kraIds);
  const existingById = new Map((existing.kraSnapshot || []).map((k) => [k.id, k]));

  // 1. Lock un-flagged KRAs and record responses on flagged ones.
  let snapshot: ReviewKraSnapshot[] = merged.map((k) => {
    const stored = existingById.get(k.id);
    if (!flagged.has(k.id)) {
      if (!stored) return k;
      const locked: any = { ...k };
      for (const f of ownFields) locked[f] = (stored as any)[f];
      return locked;
    }
    const baseFlag = stored?.returnFlag || k.returnFlag;
    if (!baseFlag) return k;
    const resp = responses?.[k.id];
    return {
      ...k,
      returnFlag: {
        ...baseFlag,
        reply: resp?.reply !== undefined ? String(resp.reply).slice(0, 1000) : baseFlag.reply,
        keepRating: resp?.keepRating !== undefined ? Boolean(resp.keepRating) : baseFlag.keepRating,
        keepReason: resp?.keepReason !== undefined ? String(resp.keepReason).slice(0, 1000) : baseFlag.keepReason,
      },
    };
  });

  if (isDraft) return { snapshot };

  // 2. Every flagged KRA must be addressed.
  const changes: KraRevisionChange[] = [];
  for (const k of snapshot) {
    if (!flagged.has(k.id)) continue;
    const flag = k.returnFlag;
    const before = Number(flag?.previousRating) || 0;
    const after = Number(k[ratingField]) || 0;
    const justification = (target === 'MANAGER' ? k.ratingJustification : k.hodJustification) || '';
    const achievement = (target === 'MANAGER' ? k.achievement : k.hodAchievement) || '';
    const justificationChanged = justification.trim() !== (flag?.previousJustification || '').trim();
    const achievementChanged = achievement.trim() !== (flag?.previousAchievement || '').trim();
    const ratingChanged = before !== after;
    const kept = Boolean(flag?.keepRating) && !ratingChanged;
    const keepReason = (flag?.keepReason || '').trim();

    const untouched = !ratingChanged && !justificationChanged && !achievementChanged;
    if (untouched && !kept) {
      throw new Error(
        `KRA "${kraLabel(k)}" was returned for re-evaluation. Update its rating/justification, or tick "Keep current rating" and explain why.`
      );
    }
    if (untouched && keepReason.length < MIN_KEEP_REASON_CHARS) {
      throw new Error(
        `Please give a reason (at least ${MIN_KEEP_REASON_CHARS} characters) for keeping the rating on KRA "${kraLabel(k)}".`
      );
    }

    changes.push({
      kraId: k.id,
      kraName: kraLabel(k),
      field: ratingField,
      before,
      after,
      justificationChanged,
      achievementChanged,
      kept: kept && !justificationChanged && !achievementChanged,
      keepReason: kept ? keepReason : undefined,
      reply: flag?.reply?.trim() || undefined,
    });
  }

  // 3. Resolve: clear flags; when a Manager revision goes back to the HOD, reset the HOD's
  //    rating on just those KRAs (their other ratings stand) and leave a "revised" marker.
  const nowIso = new Date().toISOString();
  const changeById = new Map(changes.map((c) => [c.kraId, c]));
  let clearedHodScore = false;
  snapshot = snapshot.map((k) => {
    const { returnFlag: _flag, ...rest } = k;
    const change = changeById.get(k.id);
    if (!change) return rest;
    if (target !== 'MANAGER') return rest;
    const next: ReviewKraSnapshot = {
      ...rest,
      revisedAfterReturn: {
        requestId: open.id,
        before: change.before,
        after: change.after,
        kept: change.kept,
        reply: change.reply,
        previousHodRating: rest.hodRating || undefined,
        revisedAt: nowIso,
      },
    };
    if (routesToHod && (rest.hodRating || 0) > 0) {
      next.hodRating = 0;
      next.hodJustification = '';
      clearedHodScore = true;
    }
    return next;
  });

  const resolvedRequest: ReviewReturnRequest = {
    ...open,
    status: 'RESOLVED',
    resolvedAt: nowIso,
    resolvedBy: user.id,
    resolvedByName: user.name,
    changes,
  };
  let returnRequests = (existing.returnRequests || []).map((r) => (r.id === open.id ? resolvedRequest : r));

  // 4. Return to both: open the HOD leg now and flag the HOD's KRAs.
  let activatedRequest: ReviewReturnRequest | undefined;
  if (queuedHodLeg) {
    const slaDays = returnSlaDays ?? DEFAULT_RETURN_POLICY.returnSlaDays;
    activatedRequest = {
      ...queuedHodLeg,
      status: 'OPEN',
      activatedAt: nowIso,
      dueAt: new Date(Date.parse(nowIso) + slaDays * DAY_MS).toISOString(),
    };
    returnRequests = returnRequests.map((r) => (r.id === queuedHodLeg.id ? activatedRequest! : r));
    const hodSet = new Set(activatedRequest.kraIds);
    snapshot = snapshot.map((k) =>
      hodSet.has(k.id)
        ? {
            ...k,
            returnFlag: {
              requestId: activatedRequest!.id,
              round: activatedRequest!.round,
              target: 'HOD',
              returnedByRole: activatedRequest!.returnedByRole,
              returnedByName: activatedRequest!.returnedByName,
              returnedAt: activatedRequest!.createdAt,
              comment: activatedRequest!.kraComments[k.id],
              previousRating: Number(k.hodRating) || 0,
              previousJustification: k.hodJustification || '',
              previousAchievement: k.hodAchievement || '',
            },
          }
        : k
    );
  }

  return { snapshot, returnRequests, changes, resolvedRequest, clearedHodScore, activatedRequest };
}

/** Human-readable one-liner for a KRA diff, used in action remarks. */
export function describeChanges(changes: KraRevisionChange[]): string {
  return changes
    .map((c) => {
      const parts: string[] = [];
      if (c.before !== c.after) parts.push(`${c.before || '–'}★ → ${c.after}★`);
      else if (c.kept) parts.push(`kept ${c.after}★`);
      else parts.push(`${c.after}★ unchanged`);
      if (c.justificationChanged) parts.push('justification updated');
      if (c.achievementChanged) parts.push('achievement updated');
      return `${c.kraName}: ${parts.join(', ')}`;
    })
    .join('; ');
}

// ---------------------------------------------------------------------------
// SLA sweep (run daily by the scheduler)
// ---------------------------------------------------------------------------

/**
 * For every open return past its due date: send the recipient at most one reminder per day,
 * and escalate to HR once (when overdue by a further full SLA window).
 */
export async function runReturnSlaSweep(nowMs: number = Date.now()): Promise<{ reminded: number; escalated: number }> {
  const policy = await getReturnPolicy();
  const reviewCol = getDbCollection('employeeReviews');
  const notifCol = getDbCollection('notifications');
  const reviews: EmployeeReview[] = await (await reviewCol.find({ isClosed: { $ne: true } })).toArray();

  let reminded = 0;
  let escalated = 0;
  const nowIso = new Date(nowMs).toISOString();

  for (const review of reviews) {
    const open = getOpenReturnRequest(review);
    if (!open) continue;
    const dueMs = new Date(open.dueAt).getTime();
    if (!Number.isFinite(dueMs) || nowMs <= dueMs) continue;

    const daysOverdue = Math.floor((nowMs - dueMs) / DAY_MS) + 1;
    const patch: Partial<ReviewReturnRequest> = {};

    const lastReminderMs = open.lastReminderAt ? new Date(open.lastReminderAt).getTime() : 0;
    if (nowMs - lastReminderMs >= DAY_MS - 60 * 60 * 1000) {
      const recipientId = open.target === 'HOD' ? review.hodId : review.managerId;
      if (recipientId) {
        await notifCol.insertOne({
          id: `notif_${review.id}_${open.id}_remind_${nowMs}`,
          userId: recipientId,
          userRole: open.target === 'HOD' ? 'HOD' : 'MANAGER',
          type: 'REMINDER',
          title: `Overdue: Returned Review for ${review.employeeName}`,
          message: `${open.kraIds.length} returned KRA${open.kraIds.length === 1 ? '' : 's'} (${open.kraTitles.slice(0, 3).join(', ')}${open.kraTitles.length > 3 ? '…' : ''}) on ${review.employeeName}'s review ${daysOverdue === 1 ? 'is 1 day' : `are ${daysOverdue} days`} past the re-evaluation deadline. Returned by ${open.returnedByName}: ${open.reason}`,
          isRead: false,
          priority: 'HIGH',
          metadata: { reviewId: review.id, periodId: review.reviewPeriodId, returnRequestId: open.id },
          createdAt: nowIso,
        });
        patch.lastReminderAt = nowIso;
        patch.remindersSent = (open.remindersSent || 0) + 1;
        reminded++;
      }
    }

    if (!open.escalatedAt && nowMs > dueMs + policy.returnSlaDays * DAY_MS) {
      await notifCol.insertOne({
        id: `notif_${review.id}_${open.id}_escalate`,
        userId: 'ALL',
        userRole: 'HR',
        type: 'REVIEW_ESCALATION',
        title: `Return SLA Breached: ${review.employeeName}`,
        message: `A return on ${review.employeeName}'s ${review.reviewPeriodName} review is ${daysOverdue} days overdue with ${open.target === 'HOD' ? review.hodName || 'the HOD' : review.managerName}. Returned by ${open.returnedByName} on ${open.createdAt.slice(0, 10)}.`,
        isRead: false,
        priority: 'HIGH',
        metadata: { reviewId: review.id, periodId: review.reviewPeriodId, returnRequestId: open.id, daysOverdue },
        createdAt: nowIso,
      });
      patch.escalatedAt = nowIso;
      escalated++;
    }

    if (Object.keys(patch).length > 0) {
      const returnRequests = (review.returnRequests || []).map((r) => (r.id === open.id ? { ...r, ...patch } : r));
      await reviewCol.updateOne({ id: review.id }, { $set: { returnRequests } });
    }
  }

  return { reminded, escalated };
}

// ---------------------------------------------------------------------------
// Return-selection drafts (per reviewer, per review)
// ---------------------------------------------------------------------------

function draftId(reviewId: string, userId: string): string {
  return `${reviewId}__${userId}`;
}

export async function getReturnDraft(reviewId: string, userId: string): Promise<ReviewReturnDraft | null> {
  return getDbCollection('reviewReturnDrafts').findOne({ id: draftId(reviewId, userId) });
}

export async function saveReturnDraft(
  review: EmployeeReview,
  userId: string,
  input: Partial<ReturnInput>
): Promise<ReviewReturnDraft> {
  const knownIds = new Set((review.kraSnapshot || []).map((k) => k.id));
  const kraIds = (input.kraIds || []).filter((id) => knownIds.has(id));
  const kraComments: Record<string, string> = {};
  for (const [id, text] of Object.entries(input.kraComments || {})) {
    if (knownIds.has(id) && text) kraComments[id] = String(text).slice(0, 1000);
  }
  const draft: ReviewReturnDraft = {
    id: draftId(review.id, userId),
    reviewId: review.id,
    userId,
    target: input.target === 'HOD' || input.target === 'BOTH' ? input.target : 'MANAGER',
    kraIds,
    hodKraIds: input.target === 'BOTH' ? (input.hodKraIds || []).filter((id) => knownIds.has(id)) : undefined,
    kraComments,
    reasonCodes: (input.reasonCodes || []).filter((c) => VALID_REASON_CODES.has(c)) as ReturnReasonCode[],
    reason: String(input.reason || '').slice(0, 3000),
    savedAt: new Date().toISOString(),
  };
  const col = getDbCollection('reviewReturnDrafts');
  const existing = await col.findOne({ id: draft.id });
  if (existing) {
    await col.updateOne({ id: draft.id }, { $set: draft });
  } else {
    await col.insertOne(draft);
  }
  return draft;
}

export async function deleteReturnDraft(reviewId: string, userId: string): Promise<void> {
  await getDbCollection('reviewReturnDrafts').deleteOne({ id: draftId(reviewId, userId) });
}
