import { getDbCollection } from '../db.js';
import { recordAuditLog } from '../auth.js';
import { ReviewPeriod } from '../../src/types/index.js';

export interface PeriodAutoActivationResult {
  activated: ReviewPeriod | null;
  lockedIds: string[];
  skippedReason?: string;
}

// Single comparable index per quarter (e.g. 2026-Q4 > 2026-Q3 > 2025-Q4).
const quarterIndex = (year: number, quarter: number) => Number(year) * 4 + (Number(quarter) - 1);

/**
 * Activates the review period for the calendar quarter containing `now`, and locks any
 * earlier period that is still ACTIVE — the same transition HR performs manually via
 * PUT /api/review-periods/:id, just driven by the calendar.
 *
 * Deliberately conservative so it never fights an explicit HR decision:
 *  - Only an UPCOMING current-quarter period is promoted. If HR has LOCKED it, it stays locked.
 *  - If HR has already activated the current or a later period, nothing changes.
 *  - If no period exists for the current quarter, nothing changes (periods are not auto-created).
 */
export async function autoActivateCurrentPeriod(now: Date = new Date()): Promise<PeriodAutoActivationResult> {
  const periodCol = getDbCollection('reviewPeriods');
  const periods: ReviewPeriod[] = await (await periodCol.find({})).toArray();

  const currentIdx = quarterIndex(now.getFullYear(), Math.floor(now.getMonth() / 3) + 1);
  const current = periods.find((p) => quarterIndex(p.year, p.quarter) === currentIdx);

  if (!current) {
    return { activated: null, lockedIds: [], skippedReason: 'No review period defined for the current quarter.' };
  }
  if (current.status !== 'UPCOMING') {
    return { activated: null, lockedIds: [], skippedReason: `Current period ${current.name} is already ${current.status}.` };
  }

  const activePeriods = periods.filter((p) => p.status === 'ACTIVE');
  if (activePeriods.some((p) => quarterIndex(p.year, p.quarter) >= currentIdx)) {
    return { activated: null, lockedIds: [], skippedReason: 'A current or later period has already been activated manually.' };
  }

  const lockedIds: string[] = [];
  for (const prev of activePeriods) {
    await periodCol.updateOne({ id: prev.id }, { $set: { status: 'LOCKED' } });
    lockedIds.push(prev.id);
    await recordAuditLog(
      'system',
      'System Scheduler',
      'SUPER_ADMIN',
      'REVIEW_PERIODS',
      'UPDATE',
      prev.id,
      'ACTIVE',
      'LOCKED',
      `Auto-locked review period ${prev.name} at quarter rollover`
    );
  }

  await periodCol.updateOne({ id: current.id }, { $set: { status: 'ACTIVE' } });
  await recordAuditLog(
    'system',
    'System Scheduler',
    'SUPER_ADMIN',
    'REVIEW_PERIODS',
    'UPDATE',
    current.id,
    current.status,
    'ACTIVE',
    `Auto-activated review period ${current.name} for the current quarter`
  );

  await getDbCollection('notifications').insertOne({
    id: `notif_period_auto_activated_${current.id}`,
    userId: 'ALL',
    userRole: 'HR',
    type: 'GENERAL',
    title: `${current.name} is now the active review period`,
    message: `The quarter has rolled over, so ${current.name} was activated automatically${
      lockedIds.length > 0 ? ` and ${activePeriods.map((p) => p.name).join(', ')} was locked` : ''
    }. Locked periods stay viewable and their reviews are unchanged.`,
    isRead: false,
    priority: 'MEDIUM',
    metadata: { periodId: current.id, lockedPeriodIds: lockedIds },
    createdAt: new Date().toISOString(),
  });

  return { activated: { ...current, status: 'ACTIVE' }, lockedIds };
}
