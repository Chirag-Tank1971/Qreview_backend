import { generateAccessToken } from './server/auth.js';
import { User } from './src/types.js';

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

const engManagerUser: User = {
  id: 'usr_mgr_eng',
  employeeId: 'emp_mgr_eng',
  email: 'dave.mgr@company.com',
  name: 'Dave Eng Manager',
  role: 'REPORTING_MANAGER',
  roleId: 'role_mgr',
  active: true,
  createdAt: '2024-01-01T00:00:00.000Z',
};

const salesManagerUser: User = {
  id: 'usr_mgr_sales',
  employeeId: 'emp_mgr_sales',
  email: 'eve.mgr@company.com',
  name: 'Eve Sales Manager',
  role: 'REPORTING_MANAGER',
  roleId: 'role_mgr',
  active: true,
  createdAt: '2024-01-01T00:00:00.000Z',
};

const engHodUser: User = {
  id: 'usr_hod_eng',
  employeeId: 'emp_hod_eng',
  email: 'alice.hod@company.com',
  name: 'Alice Engineering HOD',
  role: 'HOD',
  roleId: 'role_hod',
  active: true,
  createdAt: '2024-01-01T00:00:00.000Z',
};

const emp1User: User = {
  id: 'usr_emp_1',
  employeeId: 'emp_com_1',
  email: 'grace@company.com',
  name: 'Grace Engineer',
  role: 'EMPLOYEE',
  roleId: 'role_emp',
  active: true,
  createdAt: '2024-01-01T00:00:00.000Z',
};

const emp2User: User = {
  id: 'usr_emp_2',
  employeeId: 'emp_com_2',
  email: 'hank@company.com',
  name: 'Hank Engineer',
  role: 'EMPLOYEE',
  roleId: 'role_emp',
  active: true,
  createdAt: '2024-01-01T00:00:00.000Z',
};

const mgmtUser: User = {
  id: 'usr_mgmt_persona',
  email: 'executive@company.com',
  name: 'Executive Management',
  role: 'MANAGEMENT',
  roleId: 'role_mgmt',
  active: true,
  createdAt: '2024-01-01T00:00:00.000Z',
};

const tokenSA = generateAccessToken(superAdminUser);
const tokenHR = generateAccessToken(hrUser);
const tokenEngMgr = generateAccessToken(engManagerUser);
const tokenSalesMgr = generateAccessToken(salesManagerUser);
const tokenEngHOD = generateAccessToken(engHodUser);
const tokenEmp1 = generateAccessToken(emp1User);
const tokenEmp2 = generateAccessToken(emp2User);
const tokenMgmt = generateAccessToken(mgmtUser);

interface TestResult {
  scenario: string;
  expectedStatus: number;
  actualStatus: number;
  passed: boolean;
  notes?: string;
}

const results: TestResult[] = [];

async function runTests() {
  console.log('====================================================');
  console.log('STARTING RBAC SECURITY TEST SUITE (10 SCENARIOS)');
  console.log('====================================================\n');

  // Helper to fetch reviews first to obtain IDs
  const reviewsRes = await fetch(`${BASE_URL}/api/reviews`, {
    headers: { Authorization: `Bearer ${tokenSA}` },
  });
  const reviews = (await reviewsRes.json()) as any[];

  const engReview = reviews.find((r) => r.managerId === 'emp_mgr_eng') || reviews[0];
  const salesReview = reviews.find((r) => r.managerId === 'emp_mgr_sales') || reviews[1];
  const closedReview = reviews.find((r) => r.status === 'CLOSED' || r.isClosed) || reviews[0];

  // 1. Manager tries to access HR API (e.g. POST /api/employees or POST /api/cycles) -> 403
  {
    const res = await fetch(`${BASE_URL}/api/employees`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenEngMgr}`,
      },
      body: JSON.stringify({
        employeeCode: 'HACK-001',
        name: 'Hacked Employee',
        email: 'hacked@company.com',
        departmentId: 'dept_eng',
      }),
    });
    const passed = res.status === 403;
    results.push({
      scenario: '1. Manager tries to access HR API (POST /api/employees)',
      expectedStatus: 403,
      actualStatus: res.status,
      passed,
    });
  }

  // 2. Manager tries to edit another manager's review -> 403
  {
    // Sales review is managed by Eve (emp_mgr_sales). Dave (emp_mgr_eng) tries to score it.
    const res = await fetch(`${BASE_URL}/api/reviews/${salesReview.id}/score`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenEngMgr}`,
      },
      body: JSON.stringify({
        ratings: { kra_1: 4.5 },
      }),
    });
    const passed = res.status === 403;
    results.push({
      scenario: "2. Manager tries to edit another manager's review (PUT /api/reviews/:id/score)",
      expectedStatus: 403,
      actualStatus: res.status,
      passed,
    });
  }

  // 3. Employee tries to access another employee's review or history -> 403
  {
    // Emp1 (emp_com_1) tries to access Emp2's (emp_com_2) review history
    const res = await fetch(`${BASE_URL}/api/employees/emp_com_2/review-history`, {
      headers: { Authorization: `Bearer ${tokenEmp1}` },
    });
    const passed = res.status === 403;
    results.push({
      scenario: "3. Employee tries to access another employee's review history (GET /api/employees/:id/review-history)",
      expectedStatus: 403,
      actualStatus: res.status,
      passed,
    });
  }

  // 4. Employee tries to access HR dashboard -> 403
  {
    const res = await fetch(`${BASE_URL}/api/dashboard/hr`, {
      headers: { Authorization: `Bearer ${tokenEmp1}` },
    });
    const passed = res.status === 403;
    results.push({
      scenario: '4. Employee tries to access HR dashboard (GET /api/dashboard/hr)',
      expectedStatus: 403,
      actualStatus: res.status,
      passed,
    });
  }

  // 5. HOD tries to access another department's review -> 403
  {
    // Alice is Eng HOD. Sales review belongs to Sales dept.
    const res = await fetch(`${BASE_URL}/api/reviews/${salesReview.id}`, {
      headers: { Authorization: `Bearer ${tokenEngHOD}` },
    });
    const passed = res.status === 403;
    results.push({
      scenario: "5. HOD tries to access another department's review (GET /api/reviews/:salesId)",
      expectedStatus: 403,
      actualStatus: res.status,
      passed,
    });
  }

  // 6. Management tries to modify employee master -> 403
  {
    const res = await fetch(`${BASE_URL}/api/employees/emp_com_1`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenMgmt}`,
      },
      body: JSON.stringify({
        currentCtc: 9999999,
      }),
    });
    const passed = res.status === 403;
    results.push({
      scenario: '6. Management tries to modify employee master (PUT /api/employees/:id)',
      expectedStatus: 403,
      actualStatus: res.status,
      passed,
    });
  }

  // 7. HR tries to access Super Admin-only configuration / role management -> 403
  {
    const res = await fetch(`${BASE_URL}/api/config`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenHR}`,
      },
      body: JSON.stringify({
        hodApprovalEnabled: true,
      }),
    });
    const passed = res.status === 403;
    results.push({
      scenario: '7. HR tries to access Super Admin-only config (PUT /api/config)',
      expectedStatus: 403,
      actualStatus: res.status,
      passed,
    });
  }

  // 8. User without valid JWT -> 401
  {
    const res1 = await fetch(`${BASE_URL}/api/reviews/my-pending`);
    const res2 = await fetch(`${BASE_URL}/api/reviews/my-pending`, {
      headers: { Authorization: 'Bearer invalid.token.signature' },
    });
    const passed = res1.status === 401 && res2.status === 401;
    results.push({
      scenario: '8. Request without valid JWT or malformed token (GET /api/reviews/my-pending)',
      expectedStatus: 401,
      actualStatus: res1.status === 401 ? res2.status : res1.status,
      passed,
    });
  }

  // 9. User tampers with role in frontend payload -> backend ignores frontend claim and rejects with 403
  {
    // An employee sends { role: 'SUPER_ADMIN' } in request body to update cycle
    const res = await fetch(`${BASE_URL}/api/cycles/cycle_a`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenEmp1}`,
      },
      body: JSON.stringify({
        role: 'SUPER_ADMIN',
        appraisalMonth: 5,
      }),
    });
    const passed = res.status === 403;
    results.push({
      scenario: '9. User tampers with role in payload (PUT /api/cycles/:id with role=SUPER_ADMIN)',
      expectedStatus: 403,
      actualStatus: res.status,
      passed,
    });
  }

  // 10. User sends a closed review update -> 400 or 403
  {
    const res = await fetch(`${BASE_URL}/api/reviews/${closedReview.id}/score`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenEngMgr}`,
      },
      body: JSON.stringify({
        ratings: { kra_1: 5.0 },
      }),
    });
    const passed = res.status === 400 || res.status === 403;
    results.push({
      scenario: '10. User sends update to a closed review (PUT /api/reviews/:closedId/score)',
      expectedStatus: 400,
      actualStatus: res.status,
      passed,
      notes: `Returned HTTP ${res.status}`,
    });
  }

  // 11. HOD tries to give/score a review (even for an employee in their department) -> 403 Forbidden
  {
    const res = await fetch(`${BASE_URL}/api/reviews/${engReview.id}/score`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenEngHOD}`,
      },
      body: JSON.stringify({
        ratings: { kra_1: 4.0 },
      }),
    });
    const passed = res.status === 403;
    results.push({
      scenario: '11. HOD tries to score a review (PUT /api/reviews/:id/score) -> 403 Forbidden (Only HR & Manager can review)',
      expectedStatus: 403,
      actualStatus: res.status,
      passed,
    });
  }

  // 12. HOD tries to calibrate / modify an appraisal -> 403 Forbidden
  {
    // Fetch an appraisal
    const appraisalsRes = await fetch(`${BASE_URL}/api/appraisals`, {
      headers: { Authorization: `Bearer ${tokenSA}` },
    });
    const appraisals = (await appraisalsRes.json()) as any[];
    const targetAppraisal = appraisals.find((a: any) => a.departmentId !== 'dept_eng' && !a.departmentName?.toLowerCase().includes('eng')) || appraisals[0];

    if (targetAppraisal) {
      const res = await fetch(`${BASE_URL}/api/appraisals/${targetAppraisal.id}/hod-calibrate`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenEngHOD}`,
        },
        body: JSON.stringify({
          calibratedIncrementPercent: 12,
          promotionApproved: false,
          notes: 'Attempted cross-department HOD review',
        }),
      });
      const passed = res.status === 403;
      results.push({
        scenario: '12. HOD tries to calibrate/modify cross-department appraisal (PUT /api/appraisals/:id/hod-calibrate) -> 403 Forbidden',
        expectedStatus: 403,
        actualStatus: res.status,
        passed,
      });
    }
  }

  // 13. HOD views reviews and appraisals for their department employees -> 200 OK (View-Only)
  {
    const reviewRes = await fetch(`${BASE_URL}/api/reviews/${engReview.id}`, {
      headers: { Authorization: `Bearer ${tokenEngHOD}` },
    });
    const appraisalsRes = await fetch(`${BASE_URL}/api/appraisals`, {
      headers: { Authorization: `Bearer ${tokenEngHOD}` },
    });
    const passed = reviewRes.status === 200 && appraisalsRes.status === 200;
    results.push({
      scenario: '13. HOD views department reviews & appraisals (GET /api/reviews/:id, GET /api/appraisals) -> 200 OK (View Only)',
      expectedStatus: 200,
      actualStatus: reviewRes.status === 200 ? appraisalsRes.status : reviewRes.status,
      passed,
    });
  }

  // 14. Dynamic Appraisal Lifecycle Timeline changes per selected employee
  {
    const tlRes1 = await fetch(`${BASE_URL}/api/audit/timeline/emp_hod_eng`, {
      headers: { Authorization: `Bearer ${tokenSA}` },
    });
    const tl1 = await tlRes1.json();

    const tlRes2 = await fetch(`${BASE_URL}/api/audit/timeline/emp_com_1`, {
      headers: { Authorization: `Bearer ${tokenSA}` },
    });
    const tl2 = await tlRes2.json();

    const isDynamic =
      tlRes1.status === 200 &&
      tlRes2.status === 200 &&
      tl1.employee.id !== tl2.employee.id &&
      tl1.employee.name !== tl2.employee.name &&
      Array.isArray(tl1.timeline) &&
      Array.isArray(tl2.timeline);

    results.push({
      scenario: '14. Dynamic Appraisal Lifecycle: Timelines change dynamically for selected employees',
      expectedStatus: 200,
      actualStatus: isDynamic ? 200 : 500,
      passed: isDynamic,
      notes: `Emp1: ${tl1?.employee?.name}, Emp2: ${tl2?.employee?.name}`,
    });
  }

  // Summary
  console.log('\n--- TEST RESULTS ---');
  let allPassed = true;
  for (const r of results) {
    const icon = r.passed ? '✅ PASS' : '❌ FAIL';
    console.log(`${icon} | ${r.scenario} -> Expected: ${r.expectedStatus}, Got: ${r.actualStatus} ${r.notes ? `(${r.notes})` : ''}`);
    if (!r.passed) allPassed = false;
  }

  console.log('\n====================================================');
  if (allPassed) {
    console.log(`ALL ${results.length} RBAC SECURITY TEST SCENARIOS PASSED PERFECTLY!`);
  } else {
    console.error('SOME TESTS FAILED. PLEASE REVIEW THE LOGS.');
    process.exit(1);
  }
  console.log('====================================================\n');
}

runTests().catch((err) => {
  console.error('Fatal error running test suite:', err);
  process.exit(1);
});
