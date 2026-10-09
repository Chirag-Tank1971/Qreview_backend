import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PerformanceImprovementPlan, EmployeeReview, Employee } from '../../src/types/index.js';

const store: Record<string, Map<string, any>> = {};
function fakeCollection(name: string) {
  store[name] ||= new Map();
  const items = store[name];
  return {
    findOne: async (f: any) => {
      if (f?.id) return items.get(f.id) ?? null;
      for (const item of items.values()) {
        const matches = Object.entries(f).every(([k, v]) => {
          if (v && typeof v === 'object' && '$in' in v) {
            return (v as any).$in.includes(item[k]);
          }
          return item[k] === v;
        });
        if (matches) return item;
      }
      return null;
    },
    find: (f: any = {}) => ({
      toArray: async () => {
        return Array.from(items.values()).filter((item) => {
          return Object.entries(f).every(([k, v]) => {
            if (v && typeof v === 'object' && '$in' in v) {
              return (v as any).$in.includes(item[k]);
            }
            return item[k] === v;
          });
        });
      },
    }),
    insertOne: async (doc: any) => {
      items.set(doc.id, doc);
      return { insertedId: doc.id };
    },
    updateOne: async (f: any, u: any) => {
      const cur = items.get(f.id);
      if (cur) items.set(f.id, { ...cur, ...(u.$set || u) });
      return { matchedCount: cur ? 1 : 0 };
    },
    deleteOne: async (f: any) => ({ deletedCount: items.delete(f.id) ? 1 : 0 }),
  };
}

vi.mock('../db.js', () => ({ getDbCollection: (name: string) => fakeCollection(name) }));

const { generatePipReviewForPlan, generateDuePipReviews } = await import('./pipReviewService.js');
const { buildQuarterlyRollup } = await import('./appraisalScoring.js');

describe('pipReviewService', () => {
  const samplePip: PerformanceImprovementPlan = {
    id: 'pip_123',
    employeeId: 'emp_1',
    employeeName: 'John Doe',
    employeeCode: 'EMP001',
    departmentId: 'dept_eng',
    departmentName: 'Engineering',
    designationName: 'Software Engineer',
    managerId: 'mgr_1',
    managerName: 'Manager Jane',
    hodId: 'hod_1',
    hodName: 'HOD Bob',
    startDate: '2026-10-01T00:00:00.000Z',
    endDate: '2026-10-31T00:00:00.000Z',
    status: 'ACTIVE',
    reason: 'Missed sprint deliverables',
    goals: [
      { id: 'g1', description: 'Deliver ticket queue within SLA', targetMetric: 'SLA >= 95%', status: 'PENDING' },
      { id: 'g2', description: 'Zero regression defects in production', targetMetric: '0 defects', status: 'PENDING' },
    ],
    durationDays: 30,
    initiatedById: 'u_mgr',
    initiatedByName: 'Manager Jane',
    initiatedAt: '2026-10-01T00:00:00.000Z',
    checkIns: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };

  const sampleEmployee: Employee = {
    id: 'emp_1',
    employeeCode: 'EMP001',
    name: 'John Doe',
    email: 'john@example.com',
    departmentId: 'dept_eng',
    departmentName: 'Engineering',
    designationId: 'des_eng',
    designationName: 'Software Engineer',
    cycleId: 'c1',
    cycleCode: 'SEP',
    startingReviewPeriodId: 'p1',
    managerId: 'mgr_1',
    managerName: 'Manager Jane',
    hodId: 'hod_1',
    hodName: 'HOD Bob',
    status: 'ACTIVE',
    joiningDate: '2025-01-01',
  };

  beforeEach(() => {
    Object.keys(store).forEach((k) => store[k].clear());
    store['performanceImprovementPlans'] ||= new Map();
    store['performanceImprovementPlans'].set(samplePip.id, { ...samplePip });
    store['employees'] ||= new Map();
    store['employees'].set(sampleEmployee.id, { ...sampleEmployee });
    store['employeeReviews'] ||= new Map();
    store['notifications'] ||= new Map();
    store['reviewPeriods'] ||= new Map();
  });

  it('generates a 7-day weekly PIP review with goals mapped to KRA snapshots', async () => {
    const result = await generatePipReviewForPlan('pip_123', { forceCycleNumber: 1 });
    expect(result.created).toBe(true);
    expect(result.review).toBeDefined();

    const rev = result.review!;
    expect(rev.reviewType).toBe('PIP_WEEKLY');
    expect(rev.pipId).toBe('pip_123');
    expect(rev.pipCycleNumber).toBe(1);
    expect(rev.reviewPeriodName).toBe('PIP Week 1 Review');
    expect(rev.kraSnapshot).toHaveLength(2);
    expect(rev.kraSnapshot[0].kraName).toBe('Deliver ticket queue within SLA');
    expect(rev.kraSnapshot[0].targetSnapshot).toBe('SLA >= 95%');
    expect(rev.kraSnapshot[0].weight + rev.kraSnapshot[1].weight).toBe(100);

    // Notification generated for employee
    const notifs = Array.from(store['notifications'].values());
    expect(notifs.some((n) => n.userId === 'emp_1' && n.title.includes('PIP Week 1 Review Ready'))).toBe(true);
  });

  it('prevents generating duplicate review for the same weekly cycle', async () => {
    await generatePipReviewForPlan('pip_123', { forceCycleNumber: 1 });
    const duplicate = await generatePipReviewForPlan('pip_123', { forceCycleNumber: 1 });

    expect(duplicate.created).toBe(false);
    expect(duplicate.skipped).toBe(true);
    expect(duplicate.reason).toContain('Week 1 PIP review already exists');
  });

  it('implements overlap protection: prevents creating week 2 review if week 1 review is still pending', async () => {
    await generatePipReviewForPlan('pip_123', { forceCycleNumber: 1 });

    // Week 1 review is still ASSIGNED (open)
    const week2Attempt = await generatePipReviewForPlan('pip_123', { forceCycleNumber: 2 });
    expect(week2Attempt.created).toBe(false);
    expect(week2Attempt.skipped).toBe(true);
    expect(week2Attempt.reason).toContain('Review stacking prevented');

    // Manager is told once, even if the runner retries the same week
    await generatePipReviewForPlan('pip_123', { forceCycleNumber: 2 });
    const skipNotifs = Array.from(store['notifications'].values()).filter((n) => n.userId === 'mgr_1');
    expect(skipNotifs).toHaveLength(1);
    expect(skipNotifs[0].title).toContain('Week 2');
  });

  it('numbers weeks from 1: day 0-6 is week 1, day 7-13 is week 2', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-03T00:00:00.000Z'));
      expect((await generatePipReviewForPlan('pip_123')).review?.pipCycleNumber).toBe(1);

      store['employeeReviews'].clear();
      vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'));
      expect((await generatePipReviewForPlan('pip_123')).review?.pipCycleNumber).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('generates a PIP_FINAL review when forced or past end date', async () => {
    const result = await generatePipReviewForPlan('pip_123', { forceType: 'PIP_FINAL' });
    expect(result.created).toBe(true);
    expect(result.review?.reviewType).toBe('PIP_FINAL');
    expect(result.review?.reviewPeriodName).toBe('PIP Final Review');

    // Trying again returns existing final
    const again = await generatePipReviewForPlan('pip_123', { forceType: 'PIP_FINAL' });
    expect(again.created).toBe(false);
    expect(again.skipped).toBe(true);
  });

  it('excludes PIP reviews from annual appraisal quarterly rolling score rollup', async () => {
    // Add two regular quarterly reviews
    const q1: EmployeeReview = {
      id: 'rev_q1',
      employeeId: 'emp_1',
      reviewPeriodId: 'p1',
      reviewPeriodName: '2026-Q1',
      reviewType: 'QUARTERLY',
      status: 'CLOSED',
      finalScore: 4.0,
      kraSnapshot: [],
      createdAt: '2026-03-31T00:00:00.000Z',
    } as any;

    const q2: EmployeeReview = {
      id: 'rev_q2',
      employeeId: 'emp_1',
      reviewPeriodId: 'p2',
      reviewPeriodName: '2026-Q2',
      reviewType: 'QUARTERLY',
      status: 'CLOSED',
      finalScore: 3.0,
      kraSnapshot: [],
      createdAt: '2026-06-30T00:00:00.000Z',
    } as any;

    // Add a closed weekly PIP review with a low score
    const pipRev: EmployeeReview = {
      id: 'rev_pip_w1',
      employeeId: 'emp_1',
      reviewPeriodId: 'pip_p1',
      reviewPeriodName: 'PIP Week 1 Review',
      reviewType: 'PIP_WEEKLY',
      status: 'CLOSED',
      finalScore: 1.5,
      kraSnapshot: [],
      createdAt: '2026-10-08T00:00:00.000Z',
    } as any;

    store['employeeReviews'].set(q1.id, q1);
    store['employeeReviews'].set(q2.id, q2);
    store['employeeReviews'].set(pipRev.id, pipRev);

    const rollup = await buildQuarterlyRollup('emp_1');
    // Avg score must be (4.0 + 3.0) / 2 = 3.5, NOT pulled down by the PIP review 1.5
    expect(rollup.quarterlyHistory).toHaveLength(2);
    expect(rollup.avgScore).toBe(3.5);
  });
});
