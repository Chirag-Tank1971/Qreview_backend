import { getDbCollection } from '../db.js';
import { PerformanceImprovementPlan } from '../../src/types/index.js';

/** Plan statuses that count as "currently on PIP" for eligibility gating purposes. */
export const ACTIVE_PIP_STATUSES: PerformanceImprovementPlan['status'][] = ['ACTIVE', 'EXTENDED'];

/**
 * Returns the employee's current active/extended PIP, if any. An employee is only blocked
 * from annual appraisal processing while a plan is in one of ACTIVE_PIP_STATUSES — once it
 * resolves to SUCCEEDED, FAILED, or CANCELLED, they're eligible again.
 */
export async function getActivePipForEmployee(employeeId: string): Promise<PerformanceImprovementPlan | null> {
  const pipCol = getDbCollection('performanceImprovementPlans');
  const pip: PerformanceImprovementPlan | null = await pipCol.findOne({
    employeeId,
    status: { $in: ACTIVE_PIP_STATUSES },
  });
  return pip;
}
