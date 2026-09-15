import dotenv from 'dotenv';
dotenv.config();

import { initDatabase, getDbCollection } from '../server/db.js';
import {
  calculatePeriodTenureDays,
  checkEmployeeReviewEligibility,
  createQuarterlyReview,
} from '../server/services/reviewEligibility.js';
import { syncEmployeeAppraisalsAndReviews } from '../server/syncHelpers.js';
import { Employee, ReviewPeriod } from '../src/types.js';

async function runTests() {
  console.log('--- Initializing DB Connection ---');
  await initDatabase();

  console.log('\n--- 1. Testing Tenure Calculation Logic ---');
  const t1 = calculatePeriodTenureDays('2026-09-15', '2026-07-01', '2026-09-30');
  console.log(`Joined 2026-09-15 in Q3 (ends 2026-09-30): ${t1} days (Expected: 16)`);
  if (t1 !== 16) throw new Error(`Expected 16 days tenure, got ${t1}`);

  const t2 = calculatePeriodTenureDays('2026-05-15', '2026-07-01', '2026-09-30');
  console.log(`Joined before Q3 (2026-05-15): ${t2} days (Expected: 92)`);
  if (t2 < 90) throw new Error(`Expected full quarter tenure, got ${t2}`);

  const t3 = calculatePeriodTenureDays('2026-10-01', '2026-07-01', '2026-09-30');
  console.log(`Joined after Q3 (2026-10-01): ${t3} days (Expected: 0)`);
  if (t3 !== 0) throw new Error(`Expected 0 days, got ${t3}`);

  console.log('\n--- 2. Fetching EMP-115 & Active Q3 Period ---');
  const empCol = getDbCollection('employees');
  const periodCol = getDbCollection('reviewPeriods');
  const reviewCol = getDbCollection('employeeReviews');
  const auditCol = getDbCollection('auditLogs');

  const emp115: Employee | null = await empCol.findOne({ employeeCode: 'EMP-115' });
  if (!emp115) throw new Error('EMP-115 not found');
  console.log(`Found EMP-115: ${emp115.name}, Joined: ${emp115.joiningDate}, Status: ${emp115.status}`);

  const q3Period: ReviewPeriod | null = await periodCol.findOne({ year: 2026, quarter: 3 });
  if (!q3Period) throw new Error('Q3 2026 Period not found');
  console.log(`Found Q3 Period: ${q3Period.name} (${q3Period.startDate} to ${q3Period.endDate}), Status: ${q3Period.status}`);

  // Delete any existing review for EMP-115 in Q3 for a clean benchmark test
  await reviewCol.deleteMany({ employeeId: emp115.id, reviewPeriodId: q3Period.id });
  console.log('Cleared existing Q3 reviews for EMP-115 for clean test run.');

  console.log('\n--- 3. Testing Automatic Eligibility Check on New Joiner (< 30 days) ---');
  const eligibility = await checkEmployeeReviewEligibility(emp115, q3Period);
  console.log('Eligibility Result:', {
    eligible: eligibility.eligible,
    canInitiateManually: eligibility.canInitiateManually,
    requiresManualOverride: eligibility.requiresManualOverride,
    tenureDays: eligibility.tenureDays,
    minTenureDays: eligibility.minTenureDays,
    reason: eligibility.reason,
    checks: eligibility.checks,
  });

  if (eligibility.eligible !== false) {
    throw new Error('FAIL: EMP-115 with 16 days tenure should NOT be automatically eligible!');
  }
  if (eligibility.canInitiateManually !== true) {
    throw new Error('FAIL: EMP-115 should be allowed for manual override by HR/Admin!');
  }
  if (eligibility.requiresManualOverride !== true) {
    throw new Error('FAIL: EMP-115 should require manual override flag!');
  }
  console.log('PASS: New joiner is correctly blocked from automatic review generation!');

  console.log('\n--- 4. Testing syncEmployeeAppraisalsAndReviews (Automatic Onboarding Sync) ---');
  await syncEmployeeAppraisalsAndReviews(emp115);
  const reviewsAfterSync = await reviewCol.find({ employeeId: emp115.id, reviewPeriodId: q3Period.id }).toArray();
  console.log(`Review count after sync: ${reviewsAfterSync.length} (Expected: 0)`);
  if (reviewsAfterSync.length !== 0) {
    throw new Error('FAIL: syncEmployeeAppraisalsAndReviews created a review for an employee with < 30 days tenure!');
  }
  console.log('PASS: Automatic sync respected the minimum tenure threshold and did not create a review!');

  console.log('\n--- 5. Testing Manual Review Initiation (Without Justification Reason) ---');
  let reasonErrorCaught = false;
  try {
    await createQuarterlyReview({
      emp: emp115,
      period: q3Period,
      source: 'MANUAL',
      initiatedBy: { id: 'usr_sa', name: 'Super Admin', role: 'SUPER_ADMIN' },
      manualOverrideReason: '', // Empty reason
    });
  } catch (err: any) {
    reasonErrorCaught = true;
    console.log('Successfully caught missing reason error:', err.message);
  }
  if (!reasonErrorCaught) {
    throw new Error('FAIL: createQuarterlyReview should reject manual override without reason when tenure < 30 days!');
  }
  console.log('PASS: Mandatory justification reason was strictly enforced!');

  console.log('\n--- 6. Testing Manual Review Initiation (With Justification Reason) ---');
  const createdReview = await createQuarterlyReview({
    emp: emp115,
    period: q3Period,
    source: 'MANUAL',
    initiatedBy: { id: 'usr_sa', name: 'Super Admin', role: 'SUPER_ADMIN' },
    manualOverrideReason: 'Fast-track probation evaluation agreed upon onboarding',
  });

  console.log('Created Review Details:', {
    id: createdReview.id,
    creationSource: createdReview.creationSource,
    manualOverrideReason: createdReview.manualOverrideReason,
    initiatedBy: createdReview.initiatedBy,
    status: createdReview.status,
    kraItemsCount: createdReview.kraSnapshot?.length,
    actionHistory: createdReview.actionHistory,
  });

  if (createdReview.creationSource !== 'MANUAL') {
    throw new Error('FAIL: creationSource should be MANUAL');
  }
  if (!createdReview.manualOverrideReason) {
    throw new Error('FAIL: manualOverrideReason not preserved');
  }
  if (!createdReview.kraSnapshot || createdReview.kraSnapshot.length === 0) {
    throw new Error('FAIL: KRA snapshot is empty');
  }
  console.log('PASS: Review created successfully with proper snapshot and metadata!');

  console.log('\n--- 7. Testing Duplicate Prevention ---');
  let duplicateCaught = false;
  try {
    await createQuarterlyReview({
      emp: emp115,
      period: q3Period,
      source: 'MANUAL',
      initiatedBy: { id: 'usr_sa', name: 'Super Admin', role: 'SUPER_ADMIN' },
      manualOverrideReason: 'Attempting duplicate',
    });
  } catch (err: any) {
    duplicateCaught = true;
    console.log('Successfully caught duplicate error:', err.message);
  }
  if (!duplicateCaught) {
    throw new Error('FAIL: Duplicate review creation was not prevented!');
  }
  console.log('PASS: Duplicate review prevention verified!');

  console.log('\n--- 8. Testing Audit Trail Recording ---');
  const latestAudit = await auditCol.findOne({
    module: 'QUARTERLY_REVIEW',
    action: 'MANUAL_REVIEW_INITIATED',
    recordId: createdReview.id,
  });

  console.log('Audit Log Entry:', latestAudit);
  if (!latestAudit) {
    throw new Error('FAIL: Audit log entry for MANUAL_REVIEW_INITIATED was not found!');
  }
  console.log('PASS: Audit log verified!');

  console.log('\n=========================================');
  console.log('ALL TENURE & INITIATION TESTS PASSED 100%');
  console.log('=========================================\n');

  process.exit(0);
}

runTests().catch((err) => {
  console.error('TEST ERROR:', err);
  process.exit(1);
});
