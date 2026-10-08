import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EmployeeReview } from '../../src/types/index.js';

// Lightweight fake collections — keeps tests off the embedded store's on-disk file.
const store: Record<string, Map<string, any>> = {};
function fakeCollection(name: string) {
  store[name] ||= new Map();
  const items = store[name];
  return {
    findOne: async (f: any) => (f?.id ? items.get(f.id) ?? null : null),
    find: async () => ({ toArray: async () => Array.from(items.values()) }),
    insertOne: async (doc: any) => {
      items.set(doc.id, doc);
      return { insertedId: doc.id };
    },
    updateOne: async (f: any, u: any) => {
      const cur = items.get(f.id);
      if (cur) items.set(f.id, { ...cur, ...(u.$set || u) });
      return { matchedCount: cur ? 1 : 0 };
    },
    updateMany: async () => ({ matchedCount: 0 }),
    deleteOne: async (f: any) => ({ deletedCount: items.delete(f.id) ? 1 : 0 }),
  };
}
vi.mock('../db.js', () => ({ getDbCollection: (name: string) => fakeCollection(name) }));
vi.mock('../auth.js', () => ({ recordAuditLog: async () => {} }));

const { createReviewReturn, applyReturnEdits, runReturnSlaSweep, getReturnCount } = await import('./reviewReturnService.js');

const hod = { id: 'u_hod', name: 'Hina HOD', role: 'HOD' };
const hr = { id: 'u_hr', name: 'Harsh HR', role: 'HR' };
const mgr = { id: 'u_mgr', name: 'Chinmay Parida' };

function makeReview(overrides: Partial<EmployeeReview> = {}): EmployeeReview {
  const review: EmployeeReview = {
    id: 'rev1',
    employeeId: 'e1',
    employeeCode: 'MS1174',
    employeeName: 'Rafe Khan',
    departmentId: 'd1',
    departmentName: 'Retail',
    designationName: 'CSE',
    reviewPeriodId: 'p1',
    reviewPeriodName: '2026-Q4',
    cycleId: 'c1',
    cycleCode: 'SEP',
    managerId: 'emp_mgr',
    managerName: 'Chinmay Parida',
    hodId: 'emp_hod',
    hodName: 'Hina HOD',
    status: 'HOD_PENDING',
    kraSnapshot: [
      { id: 'k1', kraName: 'Purchase orders', targetSnapshot: '', weight: 50, rating: 2, ratingJustification: 'he is not good at this', hodRating: 3 },
      { id: 'k2', kraName: 'Vendor SLA', targetSnapshot: '', weight: 30, rating: 4, hodRating: 4 },
      { id: 'k3', kraName: 'Reporting', targetSnapshot: '', weight: 20, rating: 3, hodRating: 3 },
    ],
    actionHistory: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
  store.employeeReviews ||= new Map();
  store.employeeReviews.set(review.id, review);
  return review;
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe('createReviewReturn', () => {
  it('flags only the selected KRAs and moves an HOD return to the manager', async () => {
    const updated = await createReviewReturn(
      makeReview(),
      { target: 'MANAGER', kraIds: ['k1'], kraComments: { k1: '2★ vs 92% achievement', k2: 'ignored' }, reasonCodes: ['RATING_NOT_SUPPORTED', 'BOGUS'], reason: 'Recheck PO rating' },
      hod,
      'HOD'
    );
    expect(updated.status).toBe('MANAGER_PENDING');
    expect(updated.kraSnapshot.find((k) => k.id === 'k1')?.returnFlag).toMatchObject({ comment: '2★ vs 92% achievement', previousRating: 2, target: 'MANAGER' });
    expect(updated.kraSnapshot.find((k) => k.id === 'k2')?.returnFlag).toBeUndefined();
    const req = updated.returnRequests![0];
    expect(req).toMatchObject({ status: 'OPEN', isFullReturn: false, kraIds: ['k1'], reasonCodes: ['RATING_NOT_SUPPORTED'], round: 1 });
    expect(req.kraComments).toEqual({ k1: '2★ vs 92% achievement' });
    expect(updated.actionHistory!.at(-1)).toMatchObject({ action: 'HOD_RETURNED', returnedKraIds: ['k1'] });
    // recipient was notified with the KRA names
    const notif = Array.from(store.notifications.values()).find((n) => n.type === 'RETURNED');
    expect(notif.userId).toBe('emp_mgr');
    expect(notif.message).toContain('Purchase orders');
  });

  it('treats an empty selection as a full return', async () => {
    const updated = await createReviewReturn(makeReview({ status: 'HR_PENDING' }), { target: 'HOD', reason: 'Recalibrate' }, hr, 'HR');
    expect(updated.status).toBe('HOD_PENDING');
    expect(updated.returnRequests![0].isFullReturn).toBe(true);
    expect(updated.kraSnapshot.every((k) => k.returnFlag?.previousRating === k.hodRating)).toBe(true);
  });

  it('rejects unknown KRA ids and blank reasons', async () => {
    await expect(createReviewReturn(makeReview(), { target: 'MANAGER', kraIds: ['nope'], reason: 'x' }, hod, 'HOD')).rejects.toThrow(/do not belong/);
    await expect(createReviewReturn(makeReview(), { target: 'MANAGER', reason: '  ' }, hod, 'HOD')).rejects.toThrow(/mandatory/);
  });

  it('blocks the HOD past the limit under BLOCK policy but lets HR through', async () => {
    store.systemConfig = new Map([['global_config', { id: 'global_config', maxReturnsPerReview: 1, returnLimitAction: 'BLOCK' }]]);
    const prior = { id: 'a', reviewId: 'rev1', action: 'HOD_RETURNED', performedBy: 'x', performedByName: 'x', performedByRole: 'HOD', remarks: '', performedAt: '' } as any;
    await expect(createReviewReturn(makeReview({ actionHistory: [prior] }), { target: 'MANAGER', reason: 'again' }, hod, 'HOD')).rejects.toThrow(/limit: 1/);
    const viaHr = await createReviewReturn(makeReview({ status: 'HR_PENDING', actionHistory: [prior] }), { target: 'MANAGER', reason: 'again' }, hr, 'HR');
    expect(viaHr.returnRequests!.at(-1)!.overLimit).toBe(true);
    expect(getReturnCount(viaHr)).toBe(2);
  });

  it('escalates to HR when the HOD exceeds the limit under ESCALATE policy', async () => {
    store.systemConfig = new Map([['global_config', { id: 'global_config', maxReturnsPerReview: 1, returnLimitAction: 'ESCALATE' }]]);
    const prior = { id: 'a', action: 'RETURNED' } as any;
    await createReviewReturn(makeReview({ actionHistory: [prior] }), { target: 'MANAGER', reason: 'again' }, hod, 'HOD');
    expect(Array.from(store.notifications.values()).some((n) => n.type === 'REVIEW_ESCALATION')).toBe(true);
  });
});

describe('applyReturnEdits', () => {
  async function returnedToManager() {
    return createReviewReturn(makeReview(), { target: 'MANAGER', kraIds: ['k1'], reason: 'Recheck' }, hod, 'HOD');
  }

  it('locks KRAs that were not returned, whatever the client sends', async () => {
    const existing = await returnedToManager();
    const merged = existing.kraSnapshot.map((k) => (k.id === 'k2' ? { ...k, rating: 1 } : k.id === 'k1' ? { ...k, rating: 3 } : k));
    const { snapshot } = applyReturnEdits({ existing, merged, target: 'MANAGER', isDraft: true, user: mgr });
    expect(snapshot.find((k) => k.id === 'k2')!.rating).toBe(4);
    expect(snapshot.find((k) => k.id === 'k1')!.rating).toBe(3);
  });

  it('refuses to submit while a returned KRA is untouched, unless explicitly kept with a reason', async () => {
    const existing = await returnedToManager();
    expect(() => applyReturnEdits({ existing, merged: existing.kraSnapshot, target: 'MANAGER', isDraft: false, user: mgr })).toThrow(/was returned for re-evaluation/);
    expect(() =>
      applyReturnEdits({ existing, merged: existing.kraSnapshot, target: 'MANAGER', responses: { k1: { keepRating: true, keepReason: 'short' } }, isDraft: false, user: mgr })
    ).toThrow(/give a reason/);
    const kept = applyReturnEdits({
      existing,
      merged: existing.kraSnapshot,
      target: 'MANAGER',
      responses: { k1: { keepRating: true, keepReason: 'Evidence attached in the PO tracker', reply: 'Checked again' } },
      isDraft: false,
      user: mgr,
    });
    expect(kept.changes).toEqual([expect.objectContaining({ kraId: 'k1', kept: true, before: 2, after: 2, reply: 'Checked again' })]);
  });

  it('resolves the return, records the diff and resets only the HOD rating of revised KRAs', async () => {
    const existing = await returnedToManager();
    const merged = existing.kraSnapshot.map((k) => (k.id === 'k1' ? { ...k, rating: 3, ratingJustification: 'Closed 92% of POs on time' } : k));
    const result = applyReturnEdits({ existing, merged, target: 'MANAGER', isDraft: false, user: mgr, routesToHod: true });
    expect(result.resolvedRequest?.status).toBe('RESOLVED');
    expect(result.changes).toEqual([expect.objectContaining({ kraId: 'k1', before: 2, after: 3, justificationChanged: true, kept: false })]);
    const k1 = result.snapshot.find((k) => k.id === 'k1')!;
    expect(k1.returnFlag).toBeUndefined();
    expect(k1.hodRating).toBe(0);
    expect(k1.revisedAfterReturn).toMatchObject({ before: 2, after: 3, previousHodRating: 3 });
    expect(result.snapshot.find((k) => k.id === 'k2')!.hodRating).toBe(4);
    expect(result.clearedHodScore).toBe(true);
  });

  it('passes through when there is no open return', () => {
    const existing = makeReview();
    const out = applyReturnEdits({ existing, merged: existing.kraSnapshot, target: 'MANAGER', isDraft: false, user: mgr });
    expect(out.snapshot).toBe(existing.kraSnapshot);
    expect(out.resolvedRequest).toBeUndefined();
  });
});

describe('return to both (Manager, then HOD)', () => {
  async function returnedToBoth() {
    return createReviewReturn(
      makeReview({ status: 'HR_PENDING' }),
      { target: 'BOTH', kraIds: ['k1'], hodKraIds: ['k1', 'k3'], kraComments: { k1: 'Recheck', k3: 'Too high' }, reason: 'Calibrate' },
      hr,
      'HR'
    );
  }

  it('opens the Manager leg, queues the HOD leg and counts as a single return', async () => {
    const updated = await returnedToBoth();
    expect(updated.status).toBe('RETURNED');
    const [mgrLeg, hodLeg] = updated.returnRequests!;
    expect(mgrLeg).toMatchObject({ target: 'MANAGER', status: 'OPEN', kraIds: ['k1'], kraComments: { k1: 'Recheck' } });
    expect(hodLeg).toMatchObject({ target: 'HOD', status: 'QUEUED', kraIds: ['k1', 'k3'], dueAt: '', kraComments: { k1: 'Recheck', k3: 'Too high' } });
    expect(hodLeg.groupId).toBe(mgrLeg.groupId);
    // only the Manager's KRAs are flagged for now
    expect(updated.kraSnapshot.filter((k) => k.returnFlag).map((k) => k.id)).toEqual(['k1']);
    expect(updated.actionHistory!.at(-1)).toMatchObject({ action: 'RETURNED', hodKraIds: ['k1', 'k3'] });
    expect(getReturnCount(updated)).toBe(1);
  });

  it('activates the HOD leg when the Manager resubmits, without resetting the HOD ratings', async () => {
    const existing = await returnedToBoth();
    const merged = existing.kraSnapshot.map((k) => (k.id === 'k1' ? { ...k, rating: 4, ratingJustification: 'Closed 92% of POs on time' } : k));
    const result = applyReturnEdits({ existing, merged, target: 'MANAGER', isDraft: false, user: mgr, returnSlaDays: 2 });

    expect(result.resolvedRequest?.status).toBe('RESOLVED');
    expect(result.activatedRequest).toMatchObject({ target: 'HOD', status: 'OPEN' });
    expect(Date.parse(result.activatedRequest!.dueAt) - Date.parse(result.activatedRequest!.activatedAt!)).toBe(2 * 24 * 60 * 60 * 1000);
    expect(result.clearedHodScore).toBeFalsy();

    const k1 = result.snapshot.find((k) => k.id === 'k1')!;
    expect(k1.returnFlag).toMatchObject({ target: 'HOD', previousRating: 3, comment: 'Recheck' });
    expect(k1.hodRating).toBe(3);
    expect(result.snapshot.find((k) => k.id === 'k3')!.returnFlag).toMatchObject({ target: 'HOD', comment: 'Too high' });
    expect(result.snapshot.find((k) => k.id === 'k2')!.returnFlag).toBeUndefined();

    // then the HOD leg resolves like a normal HR -> HOD return
    const afterMgr = { ...existing, kraSnapshot: result.snapshot, returnRequests: result.returnRequests, status: 'HOD_PENDING' as const };
    const hodMerged = afterMgr.kraSnapshot.map((k) => (k.id === 'k1' ? { ...k, hodRating: 4 } : k.id === 'k3' ? { ...k, hodRating: 2, hodJustification: 'Reports were often late this quarter' } : k));
    const hodResult = applyReturnEdits({ existing: afterMgr, merged: hodMerged, target: 'HOD', isDraft: false, user: { id: 'u_hod', name: 'Hina HOD' } });
    expect(hodResult.resolvedRequest?.target).toBe('HOD');
    expect(hodResult.activatedRequest).toBeUndefined();
    expect(hodResult.returnRequests!.every((r) => r.status === 'RESOLVED')).toBe(true);
  });

  it('a new return supersedes a queued HOD leg', async () => {
    const both = await returnedToBoth();
    store.employeeReviews.set(both.id, both);
    const again = await createReviewReturn({ ...both, status: 'HR_PENDING' }, { target: 'MANAGER', kraIds: ['k2'], reason: 'Different issue' }, hr, 'HR');
    expect(again.returnRequests!.filter((r) => r.status === 'SUPERSEDED')).toHaveLength(2);
  });
});

describe('runReturnSlaSweep', () => {
  it('reminds once a day after the due date and escalates after a further SLA window', async () => {
    const returned = await createReviewReturn(makeReview(), { target: 'MANAGER', kraIds: ['k1'], reason: 'Recheck' }, hod, 'HOD');
    const due = new Date(returned.returnRequests![0].dueAt).getTime();
    const day = 24 * 60 * 60 * 1000;

    expect(await runReturnSlaSweep(due - 1000)).toEqual({ reminded: 0, escalated: 0 });
    expect(await runReturnSlaSweep(due + 1000)).toEqual({ reminded: 1, escalated: 0 });
    expect(await runReturnSlaSweep(due + 2000)).toEqual({ reminded: 0, escalated: 0 });
    expect(await runReturnSlaSweep(due + 3 * day + 5000)).toEqual({ reminded: 1, escalated: 1 });
    expect(await runReturnSlaSweep(due + 4 * day + 5000)).toEqual({ reminded: 1, escalated: 0 });
  });
});
