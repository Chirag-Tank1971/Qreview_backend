import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EmployeeReview } from '../../src/types/index.js';

const store: Record<string, any[]> = {};
vi.mock('../db.js', () => ({
  getDbCollection: (name: string) => ({
    find: async () => ({ toArray: async () => store[name] || [] }),
    findOne: async () => null,
    insertOne: async (doc: any) => {
      (store[name] ||= []).push(doc);
    },
  }),
}));
vi.mock('../auth.js', () => ({ recordAuditLog: async () => {} }));
vi.mock('./emailService.js', () => ({ resolveRecipient: async () => null, sendNotificationEmail: async () => ({ status: 'SKIPPED' }) }));

const { buildCalibration, computeReviewerBacklog, hasScorecardCheck, buildDataHealth, buildEmailDelivery } = await import('./dashboardInsights.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-07T12:00:00Z');

function review(over: Partial<EmployeeReview>): EmployeeReview {
  return {
    id: over.id || 'r',
    employeeId: 'e',
    employeeCode: 'E1',
    employeeName: 'Emp',
    departmentId: 'd',
    departmentName: 'D',
    designationName: 'X',
    reviewPeriodId: 'p',
    reviewPeriodName: 'Q4',
    cycleId: 'c',
    cycleCode: 'C',
    managerId: 'm1',
    managerName: 'Mira Manager',
    hodId: 'h1',
    hodName: 'Hari HOD',
    status: 'MANAGER_PENDING',
    kraSnapshot: [],
    createdAt: new Date(NOW - 10 * DAY).toISOString(),
    ...over,
  } as EmployeeReview;
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe('computeReviewerBacklog', () => {
  it('groups waiting reviews by the Manager or HOD who holds them', async () => {
    const period = { id: 'p', dueDate: new Date(NOW - 2 * DAY).toISOString() } as any;
    const reviews = [
      review({ id: 'a', employeeName: 'A', status: 'MANAGER_PENDING' }),
      review({ id: 'b', employeeName: 'B', status: 'RETURNED', actionHistory: [{ action: 'RETURNED', performedAt: new Date(NOW - 3 * DAY).toISOString() } as any] }),
      review({ id: 'c', employeeName: 'C', status: 'HOD_PENDING' }),
      review({ id: 'd', employeeName: 'D', status: 'HR_PENDING' }),
      review({ id: 'e', employeeName: 'E', status: 'CLOSED', isClosed: true }),
    ];
    store.notifications = [{ type: 'REMINDER', userId: 'm1', metadata: { source: 'dashboard' }, createdAt: '2026-10-06T00:00:00Z' }];
    const backlog = await computeReviewerBacklog(reviews, period, NOW);
    expect(backlog).toHaveLength(2);
    expect(backlog[0]).toMatchObject({ reviewerId: 'm1', role: 'MANAGER', pending: 2, employees: ['A', 'B'], oldestWaitingDays: 10, overdueDays: 2, lastRemindedAt: '2026-10-06T00:00:00Z' });
    expect(backlog[1]).toMatchObject({ reviewerId: 'h1', role: 'HOD', pending: 1 });
  });
});

describe('buildCalibration', () => {
  it('bands scored reviews against the bell-curve targets and measures disagreement and returns', () => {
    const c = buildCalibration(
      [
        review({ finalScore: 4.6, kraSnapshot: [{ id: 'k', rating: 5, hodRating: 2 } as any, { id: 'k2', rating: 3, hodRating: 3 } as any] }),
        review({ managerScore: 3.0, returnRequests: [{ id: 'x', status: 'OPEN', dueAt: new Date(NOW - DAY).toISOString() } as any] }),
        review({ finalScore: 0 }),
      ],
      NOW
    );
    expect(c.scored).toBe(2);
    expect(c.bands.find((b) => b.key === 'OUTSTANDING')).toMatchObject({ count: 1, percent: 50, targetPercent: 10 });
    expect(c.bands.find((b) => b.key === 'MEETS_EXPECTATIONS')).toMatchObject({ count: 1, percent: 50, targetPercent: 45 });
    expect(c).toMatchObject({ krasCompared: 2, krasDisagreeing: 1, reviewsWithDisagreement: 1, returnsThisCycle: 1, returnsOpen: 1, returnsOverdue: 1 });
  });
});

describe('hasScorecardCheck / buildDataHealth', () => {
  const templates = [
    { id: 't1', active: true, items: [{}] },
    { id: 't2', active: false, items: [{}] },
    { id: 't3', active: true, items: [] },
  ] as any;

  it('only counts an employee’s own, active, non-empty template', () => {
    const has = hasScorecardCheck(templates);
    expect(has({ currentKraTemplateId: 't1' } as any)).toBe(true);
    expect(has({ currentKraTemplateId: 't2' } as any)).toBe(false);
    expect(has({ currentKraTemplateId: 't3' } as any)).toBe(false);
    expect(has({} as any)).toBe(false);
  });

  it('reports each data issue with a count', async () => {
    const employees = [
      { id: 'e1', name: 'Ann', status: 'ACTIVE', managerId: 'm', hodId: 'h', departmentId: 'd', currentKraTemplateId: 't1' },
      { id: 'e2', name: 'Bob', status: 'ACTIVE', currentKraTemplateId: 't2' },
      { id: 'e3', name: 'Cat', status: 'INACTIVE' },
    ] as any;
    store.employeeReviews = [review({ employeeId: 'e3', employeeName: 'Cat', status: 'MANAGER_PENDING' })];
    const users = [
      { id: 'u1', role: 'EMPLOYEE', employeeId: 'e1' },
      { id: 'u2', role: 'MANAGER' },
      { id: 'u3', role: 'SUPER_ADMIN' },
    ] as any;
    const items = Object.fromEntries((await buildDataHealth(employees, templates, users)).map((i) => [i.key, i.count]));
    expect(items).toEqual({ NO_MANAGER: 1, NO_HOD: 1, NO_DEPARTMENT: 1, NO_KRA: 1, UNLINKED_USERS: 1, LEAVER_REVIEWS: 1 });
  });
});

describe('buildEmailDelivery', () => {
  it('counts only the last N days and lists the newest failures', async () => {
    store.emailLogs = [
      { status: 'SENT', createdAt: new Date(NOW - DAY).toISOString() },
      { status: 'FAILED', recipientName: 'Old', subject: 's', createdAt: new Date(NOW - 10 * DAY).toISOString() },
      { status: 'FAILED', recipientName: 'New', subject: 's', errorMessage: 'boom', createdAt: new Date(NOW - 2 * DAY).toISOString() },
      { status: 'SKIPPED', createdAt: new Date(NOW - 3 * DAY).toISOString() },
    ];
    const e = await buildEmailDelivery(7, NOW);
    expect(e).toMatchObject({ sent: 1, failed: 1, skipped: 1, queued: 0 });
    expect(e.recentFailures).toEqual([expect.objectContaining({ recipientName: 'New', error: 'boom' })]);
  });
});
