import { getDbCollection } from '../db.js';
import { Appraisal, AppraisalQuarterRecord, EmployeeReview, ReviewPeriod } from '../../src/types/index.js';

// Reviews count toward the rolling score once the manager has evaluated them.
export const EVALUATED_STATUSES = ['MANAGER_COMPLETED', 'HR_PENDING', 'CLOSED'];
const ROLLING_WINDOW = 4;

export const RATING_BANDS = ['OUTSTANDING', 'EXCEEDS_EXPECTATIONS', 'MEETS_EXPECTATIONS', 'NEEDS_IMPROVEMENT'] as const;
export type RatingBand = (typeof RATING_BANDS)[number];

// Compute standard rating and default increment bracket based on rolling 4-quarter score
/**
 * Target share of each rating band (%), as used by the Bell Curve & Budget module's
 * normalisation guidance (appraisalRoutes bell-curve buckets use the same figures).
 */
export const BELL_CURVE_TARGETS = {
  OUTSTANDING: 10,
  EXCEEDS_EXPECTATIONS: 25,
  MEETS_EXPECTATIONS: 45,
  NEEDS_IMPROVEMENT: 20,
} as const;

export function computeAppraisalMatrix(avgScore: number) {
  if (avgScore <= 0) {
    return { recommendedRating: 'PENDING', suggestedIncrementMin: 0, suggestedIncrementMax: 0, defaultIncrement: 0 };
  } else if (avgScore >= 4.5) {
    return { recommendedRating: 'OUTSTANDING', suggestedIncrementMin: 15, suggestedIncrementMax: 20, defaultIncrement: 16.5 };
  } else if (avgScore >= 3.8) {
    return { recommendedRating: 'EXCEEDS_EXPECTATIONS', suggestedIncrementMin: 10, suggestedIncrementMax: 14, defaultIncrement: 12.0 };
  } else if (avgScore >= 2.8) {
    return { recommendedRating: 'MEETS_EXPECTATIONS', suggestedIncrementMin: 5, suggestedIncrementMax: 9, defaultIncrement: 7.0 };
  }
  return { recommendedRating: 'NEEDS_IMPROVEMENT', suggestedIncrementMin: 0, suggestedIncrementMax: 4, defaultIncrement: 2.0 };
}

/**
 * Rating band an appraisal counts under for bell-curve purposes: the HOD/HR-calibrated
 * finalRating when one has been set, otherwise the band implied by the rolling score.
 * Appraisals with no evaluated quarters yet are UNRATED — they must not be counted as
 * "Needs Improvement" just because their score is 0.
 */
export function getRatingBand(a: Pick<Appraisal, 'finalRating' | 'averageQuarterlyScore'>): RatingBand | 'UNRATED' {
  if (a.finalRating && (RATING_BANDS as readonly string[]).includes(a.finalRating)) return a.finalRating as RatingBand;
  const score = a.averageQuarterlyScore || 0;
  if (score <= 0) return 'UNRATED';
  return computeAppraisalMatrix(score).recommendedRating as RatingBand;
}

/**
 * Builds an employee's quarterly history (chronological by review period) and the rolling
 * score: the average of the most recent four manager-evaluated quarters.
 */
export async function buildQuarterlyRollup(employeeId: string) {
  const allReviews: EmployeeReview[] = await (await getDbCollection('employeeReviews').find({ employeeId })).toArray();
  const reviews = allReviews.filter((r) => !r.reviewType || r.reviewType === 'QUARTERLY');
  const periods: ReviewPeriod[] = await (await getDbCollection('reviewPeriods').find({})).toArray();
  const periodOrder = new Map(periods.map((p) => [p.id, Number(p.year) * 4 + Number(p.quarter)]));
  const orderOf = (r: EmployeeReview) => periodOrder.get(r.reviewPeriodId) ?? new Date(r.createdAt).getTime();

  reviews.sort((a, b) => orderOf(a) - orderOf(b));

  const quarterlyHistory: AppraisalQuarterRecord[] = reviews.map((rev) => ({
    periodId: rev.reviewPeriodId,
    periodName: rev.reviewPeriodName,
    score: rev.finalScore || 0,
    reviewId: rev.id,
    strengths: rev.strengths,
    managerComments: rev.managerOverallComments,
    status: rev.status,
  }));

  const evaluated = quarterlyHistory
    .filter((q) => q.status && EVALUATED_STATUSES.includes(q.status) && (q.score || 0) > 0)
    .slice(-ROLLING_WINDOW);
  const avgScore = evaluated.length > 0
    ? Number((evaluated.reduce((sum, q) => sum + q.score, 0) / evaluated.length).toFixed(2))
    : 0;

  return { quarterlyHistory, avgScore, evaluatedCount: evaluated.length };
}

/**
 * Re-derives an unlocked appraisal's score fields from the employee's current reviews, so a
 * quarter closed after the cohort was initiated is reflected. Only system-derived values
 * are refreshed: a manager's increment proposal and an HOD-calibrated rating are kept.
 */
export async function refreshAppraisalScore(appraisal: Appraisal): Promise<void> {
  // Locked records are final. HR_APPROVED is still refreshed (score/history only — its rating
  // is protected below by hodCalibration) so the score is current when it gets locked.
  if (appraisal.isLocked || appraisal.status === 'LOCKED') return;

  const { quarterlyHistory, avgScore, evaluatedCount } = await buildQuarterlyRollup(appraisal.employeeId);
  const matrix = computeAppraisalMatrix(avgScore);

  const update: Partial<Appraisal> = {
    quarterlyHistory,
    averageQuarterlyScore: avgScore,
    evaluatedQuarterCount: evaluatedCount,
    recommendedRating: matrix.recommendedRating,
    suggestedIncrementMin: matrix.suggestedIncrementMin,
    suggestedIncrementMax: matrix.suggestedIncrementMax,
    updatedAt: new Date().toISOString(),
  };
  if (!appraisal.hodCalibration) {
    update.finalRating = matrix.recommendedRating;
  }
  if (appraisal.status === 'PENDING' && !appraisal.managerRecommendation) {
    update.proposedIncrementPercentage = matrix.defaultIncrement;
  }

  await getDbCollection('appraisals').updateOne({ id: appraisal.id }, { $set: update });
}

/** Refreshes every open appraisal in the system; returns how many were checked. */
export async function refreshAllOpenAppraisalScores(): Promise<number> {
  const appraisals: Appraisal[] = await (
    await getDbCollection('appraisals').find({ isLocked: { $ne: true } })
  ).toArray();
  for (const a of appraisals) {
    await refreshAppraisalScore(a);
  }
  return appraisals.length;
}

/** Refreshes every unlocked appraisal belonging to an employee (e.g. after a review closes). */
export async function refreshEmployeeAppraisalScores(employeeId: string): Promise<void> {
  const appraisals: Appraisal[] = await (
    await getDbCollection('appraisals').find({ employeeId, isLocked: { $ne: true } })
  ).toArray();
  for (const a of appraisals) {
    await refreshAppraisalScore(a);
  }
}
