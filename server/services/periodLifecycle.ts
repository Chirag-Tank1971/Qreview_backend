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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Builds a standard calendar-quarter period, e.g. "2026-Q4 (Oct - Dec)". Dates use the
 * same defaults as POST /api/review-periods (due on the 15th of the month after the
 * quarter ends), but built in UTC so the stored date never shifts a day with the
 * server's timezone.
 */
function buildQuarterPeriod(year: number, quarter: 1 | 2 | 3 | 4, status: ReviewPeriod['status']): ReviewPeriod {
  const startMonth = (quarter - 1) * 3;
  return {
    id: `period_${year}_q${quarter}_${Date.now().toString(36)}`,
    name: `${year}-Q${quarter} (${MONTHS[startMonth]} - ${MONTHS[startMonth + 2]})`,
    quarter,
    year,
    startDate: new Date(Date.UTC(year, startMonth, 1)).toISOString(),
    endDate: new Date(Date.UTC(year, startMonth + 3, 0, 23, 59, 59)).toISOString(),
    dueDate: new Date(Date.UTC(year, startMonth + 3, 15, 23, 59, 59)).toISOString(),
    status,
  };
}

/**
 * Makes sure the current quarter and the next one have review periods, creating any that
 * are missing as UPCOMING. Keeping the next quarter staged ahead of time lets HR generate
 * reviews for it before the rollover, and means the yearly Q4 -> Q1 transition needs no
 * manual setup. Existing periods are never modified.
 */
async function ensureUpcomingPeriodsExist(now: Date, periods: ReviewPeriod[]): Promise<ReviewPeriod[]> {
  const periodCol = getDbCollection('reviewPeriods');
  const currentIdx = quarterIndex(now.getFullYear(), Math.floor(now.getMonth() / 3) + 1);
  const created: ReviewPeriod[] = [];

  for (const idx of [currentIdx, currentIdx + 1]) {
    if (periods.some((p) => quarterIndex(p.year, p.quarter) === idx)) continue;
    const period = buildQuarterPeriod(Math.floor(idx / 4), ((idx % 4) + 1) as 1 | 2 | 3 | 4, 'UPCOMING');
    await periodCol.insertOne(period);
    await recordAuditLog(
      'system',
      'System Scheduler',
      'SUPER_ADMIN',
      'REVIEW_PERIODS',
      'CREATE',
      period.id,
      '',
      period.name,
      `Auto-created review period ${period.name}`
    );
    created.push(period);
  }
  return created;
}

/**
 * Activates the review period for the calendar quarter containing `now`, and locks any
 * earlier period that is still ACTIVE — the same transition HR performs manually via
 * PUT /api/review-periods/:id, just driven by the calendar.
 *
 * Deliberately conservative so it never fights an explicit HR decision:
 *  - Only an UPCOMING current-quarter period is promoted. If HR has LOCKED it, it stays locked.
 *  - If HR has already activated the current or a later period, nothing changes.
 *
 * Missing current/next-quarter periods are created first (see ensureUpcomingPeriodsExist).
 */
export async function autoActivateCurrentPeriod(now: Date = new Date()): Promise<PeriodAutoActivationResult> {
  const periodCol = getDbCollection('reviewPeriods');
  const periods: ReviewPeriod[] = await (await periodCol.find({})).toArray();
  periods.push(...(await ensureUpcomingPeriodsExist(now, periods)));

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
