import { getDbCollection } from '../db.js';
import { Appraisal, Department } from '../../src/types/index.js';

// Same fallback the executive analytics budget pools use when a department has no cap set.
const DEFAULT_BUDGET_CAP_PERCENT = 12.0;

export interface DepartmentBudgetSnapshot {
  departmentId?: string;
  departmentName: string;
  appraisalYear: number;
  budgetCapPercent: number;
  /** Sum of current CTC across the department's appraisals for this year (including this one). */
  poolCtc: number;
  /** poolCtc × cap — the total increment spend the department may commit. */
  allocatedAmount: number;
  /** Increment spend already committed by the department's OTHER appraisals this year. */
  spentByOthers: number;
  /** Increment amount currently stored on this appraisal. */
  currentIncrementAmount: number;
  /** Largest increment % this employee can receive without exceeding the cap. */
  maxAllowedIncrementPercent: number;
}

const sameDepartment = (a: Appraisal, target: Appraisal) => {
  if (target.departmentId && a.departmentId) return a.departmentId === target.departmentId;
  return Boolean(
    a.departmentName && target.departmentName &&
    a.departmentName.trim().toLowerCase() === target.departmentName.trim().toLowerCase()
  );
};

/**
 * Department budget pool for an appraisal: the department's cap applies to the combined
 * increment spend of all its appraisals in the same appraisal year (not per employee), the
 * same pool the Bell Curve / Budget analytics reports on.
 */
export async function getDepartmentBudgetSnapshot(appraisal: Appraisal): Promise<DepartmentBudgetSnapshot> {
  const deptCol = getDbCollection('departments');
  const dept: Department | null =
    (appraisal.departmentId ? await deptCol.findOne({ id: appraisal.departmentId }) : null) ||
    (await (await deptCol.find({})).toArray()).find(
      (d: Department) =>
        d.name && appraisal.departmentName &&
        d.name.trim().toLowerCase() === appraisal.departmentName.trim().toLowerCase()
    ) ||
    null;

  const budgetCapPercent =
    typeof dept?.budgetCapPercent === 'number' && dept.budgetCapPercent >= 0
      ? dept.budgetCapPercent
      : DEFAULT_BUDGET_CAP_PERCENT;

  const yearAppraisals: Appraisal[] = await (
    await getDbCollection('appraisals').find({ appraisalYear: appraisal.appraisalYear })
  ).toArray();
  const deptAppraisals = yearAppraisals.filter((a) => a.id === appraisal.id || sameDepartment(a, appraisal));
  if (!deptAppraisals.some((a) => a.id === appraisal.id)) deptAppraisals.push(appraisal);

  const spendOf = (a: Appraisal) => Math.max(0, (a.revisedCtc || a.currentCtc || 0) - (a.currentCtc || 0));

  const poolCtc = deptAppraisals.reduce((sum, a) => sum + (a.currentCtc || 0), 0);
  const allocatedAmount = poolCtc * (budgetCapPercent / 100);
  const spentByOthers = deptAppraisals.filter((a) => a.id !== appraisal.id).reduce((sum, a) => sum + spendOf(a), 0);
  const headroom = Math.max(0, allocatedAmount - spentByOthers);
  const maxAllowedIncrementPercent =
    appraisal.currentCtc > 0 ? Math.floor((headroom / appraisal.currentCtc) * 100 * 100) / 100 : 0;

  return {
    departmentId: dept?.id || appraisal.departmentId,
    departmentName: dept?.name || appraisal.departmentName || 'Department',
    appraisalYear: appraisal.appraisalYear,
    budgetCapPercent,
    poolCtc,
    allocatedAmount,
    spentByOthers,
    currentIncrementAmount: spendOf(appraisal),
    maxAllowedIncrementPercent,
  };
}

/**
 * Hard block: returns an error message if giving this appraisal `newIncrementAmount` would
 * push the department's total spend over its cap, otherwise null. A change that does not
 * raise this appraisal's increment is always allowed, so a department that is already over
 * (e.g. the cap was lowered later) can still be brought back down.
 */
export async function checkDepartmentBudget(appraisal: Appraisal, newIncrementAmount: number): Promise<string | null> {
  const snap = await getDepartmentBudgetSnapshot(appraisal);
  if (newIncrementAmount <= snap.currentIncrementAmount) return null;

  const projectedSpend = snap.spentByOthers + newIncrementAmount;
  if (projectedSpend <= snap.allocatedAmount + 0.5) return null; // tolerate rounding of increment amounts

  const projectedPercent = snap.poolCtc > 0 ? ((projectedSpend / snap.poolCtc) * 100).toFixed(2) : '0';
  return (
    `Department budget cap exceeded: this increment would bring ${snap.departmentName}'s ${snap.appraisalYear} ` +
    `increment spend to ${projectedPercent}% against its ${snap.budgetCapPercent}% cap. ` +
    `The maximum increment allowed for this employee is ${snap.maxAllowedIncrementPercent}%.`
  );
}
