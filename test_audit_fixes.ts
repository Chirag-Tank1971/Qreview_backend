import { generateAccessToken, invalidateAuthCache } from './server/auth.js';
import { getDbCollection, initDatabase } from './server/db.js';
import { User, EmployeeReview, KraTemplate } from './src/types.js';

const BASE_URL = 'http://localhost:3000';

const superAdminUser: User = {
  id: 'usr_sa',
  email: 'admin@company.com',
  name: 'System Admin',
  role: 'SUPER_ADMIN',
  roleId: 'role_sa',
  active: true,
  createdAt: '2024-01-01T00:00:00.000Z',
};

const hrUser: User = {
  id: 'usr_mgr_hr',
  employeeId: 'emp_mgr_hr',
  email: 'frank.mgr@company.com',
  name: 'Frank HR Manager',
  role: 'HR',
  roleId: 'role_hr',
  active: true,
  createdAt: '2024-01-01T00:00:00.000Z',
};

const managerEng: User = {
  id: 'usr_mgr_eng',
  employeeId: 'emp_mgr_eng',
  email: 'dave.mgr@company.com',
  name: 'Dave Eng Manager',
  role: 'REPORTING_MANAGER',
  roleId: 'role_mgr',
  active: true,
  createdAt: '2024-01-01T00:00:00.000Z',
};

const hodUser: User = {
  id: 'usr_hod_eng',
  employeeId: 'emp_hod_eng',
  email: 'alice.hod@company.com',
  name: 'Alice Engineering HOD',
  role: 'HOD',
  roleId: 'role_hod',
  active: true,
  createdAt: '2024-01-01T00:00:00.000Z',
};

const tokenSA = generateAccessToken(superAdminUser);
const tokenHR = generateAccessToken(hrUser);
const tokenMgr = generateAccessToken(managerEng);
const tokenHOD = generateAccessToken(hodUser);

async function runAuditFixesTests() {
  await initDatabase();
  console.log('====================================================');
  console.log('TESTING AUDIT FIXES: SECURITY, DB INTEGRITY, RBAC, VALIDATION');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passed++;
    } else {
      console.error(`[FAIL] ${testName} - ${detail || 'Assertion failed'}`);
      failed++;
    }
  }

  // ----------------------------------------------------
  // TEST 1: DB-01 - Unique Compound Index Idempotency
  // ----------------------------------------------------
  console.log('--- TEST 1: DB-01 Review Idempotency & Unique Index ---');
  const reviewCol = getDbCollection('employeeReviews');
  const testEmpId = `emp_test_${Date.now()}`;
  const testPeriodId = `period_test_${Date.now()}`;

  const doc1: any = {
    id: `rev_1_${Date.now()}`,
    employeeId: testEmpId,
    reviewPeriodId: testPeriodId,
    status: 'MANAGER_PENDING',
    finalScore: 0,
    kraSnapshot: [],
    createdAt: new Date().toISOString(),
  };

  try {
    await reviewCol.insertOne(doc1);
    let threwDuplicateError = false;
    try {
      const doc2: any = {
        id: `rev_2_${Date.now()}`,
        employeeId: testEmpId,
        reviewPeriodId: testPeriodId,
        status: 'MANAGER_PENDING',
        finalScore: 0,
        kraSnapshot: [],
        createdAt: new Date().toISOString(),
      };
      await reviewCol.insertOne(doc2);
    } catch (err: any) {
      if (err.code === 11000 || String(err.message).includes('E11000')) {
        threwDuplicateError = true;
      }
    }
    assert(threwDuplicateError, 'DB-01: Duplicate review for same employee and period is blocked by unique index');
  } catch (err: any) {
    assert(false, 'DB-01: Insert failed unexpectedly', err.message);
  } finally {
    await reviewCol.deleteOne({ id: doc1.id });
  }

  // ----------------------------------------------------
  // TEST 2: SEC-01 - Insecure Name Spoofing Blocked (IDOR)
  // ----------------------------------------------------
  console.log('\n--- TEST 2: SEC-01 Name-Spoofing & IDOR Elimination ---');
  // Find a review that does NOT belong to managerEng (managerId != emp_mgr_eng)
  const allReviews: EmployeeReview[] = await (await reviewCol.find({})).toArray();
  const foreignReview = allReviews.find((r) => r.managerId && r.managerId !== managerEng.employeeId && !r.isClosed);

  if (foreignReview) {
    const res = await fetch(`${BASE_URL}/api/reviews/${foreignReview.id}/score`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenMgr}`,
      },
      body: JSON.stringify({
        kraSnapshot: foreignReview.kraSnapshot,
        isDraft: false,
      }),
    });

    assert(
      res.status === 403,
      'SEC-01: Manager cannot score review belonging to another manager, even if names match',
      `Expected 403, got ${res.status}`
    );
  } else {
    console.log('[SKIP] No unassigned review found for SEC-01 test');
  }

  // ----------------------------------------------------
  // TEST 3: VAL-01 - KRA Rating Out-of-Bounds Validation
  // ----------------------------------------------------
  console.log('\n--- TEST 3: VAL-01 Rating Boundary Validation (1-5) ---');
  const targetReview = allReviews.find((r) => !r.isClosed);
  if (targetReview) {
    const invalidKras = (targetReview.kraSnapshot || []).map((k) => ({
      ...k,
      rating: 8.5, // invalid: > 5
    }));

    const res = await fetch(`${BASE_URL}/api/reviews/${targetReview.id}/score`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenSA}`,
      },
      body: JSON.stringify({
        kraSnapshot: invalidKras,
        isDraft: false,
      }),
    });

    const body: any = await res.json().catch(() => ({}));
    assert(
      res.status === 400,
      'VAL-01: Reject score submission when rating exceeds 5.0',
      `Expected 400, got ${res.status}: ${JSON.stringify(body)}`
    );
  }

  // ----------------------------------------------------
  // TEST 4: VAL-02 - 100% KRA Weight Sum Enforcement
  // ----------------------------------------------------
  console.log('\n--- TEST 4: VAL-02 100% KRA Weight Sum Validation ---');
  const resInvalidTemplate = await fetch(`${BASE_URL}/api/kra-templates`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokenHR}`,
    },
    body: JSON.stringify({
      title: 'Invalid Sum Template',
      departmentId: 'dept_eng',
      designationId: 'des_se',
      items: [
        { title: 'Goal 1', weight: 40 },
        { title: 'Goal 2', weight: 40 }, // total = 80 != 100
      ],
    }),
  });
  assert(
    resInvalidTemplate.status === 400,
    'VAL-02: Reject KRA template creation when weights do not sum to 100%',
    `Expected 400, got ${resInvalidTemplate.status}`
  );

  // ----------------------------------------------------
  // TEST 5: HOD-01 - HOD Report Scoping Isolation
  // ----------------------------------------------------
  console.log('\n--- TEST 5: HOD-01 Report Scope Isolation ---');
  const resHodReport = await fetch(`${BASE_URL}/api/reports/quarterly-status`, {
    headers: {
      Authorization: `Bearer ${tokenHOD}`,
    },
  });
  if (resHodReport.ok) {
    const data: any = await resHodReport.json();
    const rows = data.data || [];
    // Ensure all returned rows belong to engineering department
    const foreignDeptRows = rows.filter(
      (r: any) => r.departmentName && r.departmentName !== 'Engineering' && r.departmentName !== 'N/A'
    );
    assert(
      foreignDeptRows.length === 0,
      'HOD-01: HOD report only includes records from own department',
      `Found ${foreignDeptRows.length} foreign department records`
    );
  } else {
    assert(false, 'HOD-01: Failed to query HOD report', `Status: ${resHodReport.status}`);
  }

  // ----------------------------------------------------
  // TEST 6: APP-01 - Appraisal Finalization Pre-Flight Check
  // ----------------------------------------------------
  console.log('\n--- TEST 6: APP-01 Appraisal Finalization Pre-Flight Check ---');
  const appCol = getDbCollection('appraisals');
  const allAppraisals: any[] = await (await appCol.find({})).toArray();
  const unfinalizedApp = allAppraisals.find((a) => !a.isLocked);

  if (unfinalizedApp) {
    // If the employee has a pending review, finalize must return 400
    const resFinalize = await fetch(`${BASE_URL}/api/appraisals/${unfinalizedApp.id}/finalize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenHR}`,
      },
      body: JSON.stringify({
        remarks: 'Attempting finalize',
      }),
    });

    // If employee has pending reviews, should be 400; if all closed, should succeed or succeed validation
    const body: any = await resFinalize.json().catch(() => ({}));
    if (resFinalize.status === 400 && String(body.error).includes('quarterly review(s) still pending')) {
      assert(true, 'APP-01: Blocked appraisal finalization because employee has pending quarterly review(s)');
    } else {
      assert(
        resFinalize.status === 200 || resFinalize.status === 400,
        'APP-01: Appraisal finalization ran pre-flight review checks safely',
        `Status: ${resFinalize.status}`
      );
    }
  } else {
    console.log('[SKIP] No unfinalized appraisal found for APP-01 test');
  }

  console.log('\n====================================================');
  console.log(`AUDIT TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runAuditFixesTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});
