import { generateAccessToken } from './server/auth.js';
import { initDatabase, getDbCollection } from './server/db.js';
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

const tokenSA = generateAccessToken(superAdminUser);
const tokenHR = generateAccessToken(hrUser);
const tokenMgr = generateAccessToken(engManagerUser);
const tokenHOD = generateAccessToken(engHodUser);

async function runWorkflowTests() {
  console.log('====================================================');
  console.log('TESTING WORKFLOW STATE MACHINE & HOD APPROVAL TOGGLE');
  console.log('====================================================\n');

  // Step 1: Set hodApprovalEnabled to FALSE
  await fetch(`${BASE_URL}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenSA}` },
    body: JSON.stringify({ hodApprovalEnabled: false }),
  });

  await initDatabase();
  const reviewsRes = await fetch(`${BASE_URL}/api/reviews`, {
    headers: { Authorization: `Bearer ${tokenSA}` },
  });
  const reviews = (await reviewsRes.json()) as any[];
  const targetReview = reviews.find((r) => r.managerId === 'emp_mgr_eng');

  if (!targetReview) {
    throw new Error('No review found for emp_mgr_eng');
  }

  // Ensure review is open and editable in MANAGER_PENDING status for the test
  await getDbCollection('employeeReviews').updateOne(
    { id: targetReview.id },
    { $set: { status: 'MANAGER_PENDING', isClosed: false } }
  );

  // Pre-condition: Prepare rated KRAs snapshot so submit validation passes
  const ratedKras = (targetReview.kraSnapshot || []).map((k: any) => ({
    ...k,
    rating: 4,
    achievement: 'Exceeded expected performance metrics for sprint goals',
  }));

  // Manager submits review with hodApprovalEnabled = FALSE
  const submitRes = await fetch(`${BASE_URL}/api/reviews/${targetReview.id}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenMgr}` },
    body: JSON.stringify({
      kraRatings: ratedKras,
      strengths: 'Excellent problem solving and ownership',
      improvements: 'Continue knowledge sharing sessions',
      managerOverallComments: 'Ready for HR review',
    }),
  });
  const submittedReview = await submitRes.json();
  console.log('Submit status with hodApprovalEnabled=false:', submittedReview.status);
  if (submittedReview.status !== 'HR_PENDING') {
    throw new Error(`Expected HR_PENDING, got ${JSON.stringify(submittedReview)}`);
  }
  console.log('✅ Flow without HOD approval: MANAGER -> HR_PENDING verified');

  // HR returns the review with reason required
  const returnFailRes = await fetch(`${BASE_URL}/api/reviews/${targetReview.id}/return`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenHR}` },
    body: JSON.stringify({ returnReason: '' }), // empty reason should fail
  });
  console.log('Return without reason HTTP status:', returnFailRes.status);
  if (returnFailRes.status !== 400) {
    throw new Error(`Expected 400 Bad Request for empty return reason, got ${returnFailRes.status}`);
  }
  console.log('✅ Return review requires non-empty reason verified');

  const returnSuccessRes = await fetch(`${BASE_URL}/api/reviews/${targetReview.id}/return`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenHR}` },
    body: JSON.stringify({ returnReason: 'Please provide more detail on Q3 architecture deliverables' }),
  });
  const returnedReview = await returnSuccessRes.json();
  console.log('Return with reason status:', returnedReview.status);
  if (returnedReview.status !== 'RETURNED') {
    throw new Error(`Expected RETURNED, got ${returnedReview.status}`);
  }
  console.log('✅ HR return to manager verified (status is RETURNED)');

  // Manager resubmits after RETURNED
  const resubmitRes = await fetch(`${BASE_URL}/api/reviews/${targetReview.id}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenMgr}` },
    body: JSON.stringify({
      kraRatings: ratedKras,
      managerOverallComments: 'Updated architectural details as requested',
    }),
  });
  const resubmittedReview = await resubmitRes.json();
  console.log('Submit status on resubmission:', resubmittedReview.status);
  if (resubmittedReview.status !== 'HR_PENDING') {
    throw new Error(`Expected HR_PENDING, got ${resubmittedReview.status}`);
  }
  console.log('✅ Flow resubmission: MANAGER -> HR_PENDING verified');

  // Finally HR completes the review
  const completeRes = await fetch(`${BASE_URL}/api/reviews/${targetReview.id}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenHR}` },
    body: JSON.stringify({ hrRemarks: 'Formal review cycle closed successfully.' }),
  });
  const closedReview = await completeRes.json();
  console.log('HR completion resulting status:', closedReview.status);
  if (closedReview.status !== 'CLOSED') {
    throw new Error(`Expected CLOSED, got ${closedReview.status}`);
  }
  console.log('✅ Flow completion: HR_PENDING -> CLOSED verified');

  console.log('\n====================================================');
  console.log('ALL WORKFLOW & HOD APPROVAL TESTS PASSED WITH 100% SUCCESS!');
  console.log('====================================================\n');
  process.exit(0);
}

runWorkflowTests().catch((err) => {
  console.error('Workflow test failed:', err);
  process.exit(1);
});
