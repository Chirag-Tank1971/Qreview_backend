import { initDatabase, getDbCollection } from '../server/db.js';
import { SEED_APPRAISALS } from '../server/seedAppraisalsData.js';
import { syncEmployeeAppraisalsAndReviews } from '../server/syncHelpers.js';

async function cleanup() {
  console.log('=== STARTING REVIEWS & APPRAISALS AUDIT AND CLEANUP ===\n');
  await initDatabase();

  const reviewsCol = getDbCollection('employeeReviews');
  const appraisalsCol = getDbCollection('appraisals');
  const periodsCol = getDbCollection('reviewPeriods');
  const empCol = getDbCollection('employees');

  const allPeriods = await (await periodsCol.find({})).toArray();
  const activePeriod = allPeriods.find((p: any) => p.status === 'ACTIVE');
  console.log(`Active Period: ${activePeriod?.id} (${activePeriod?.name})`);

  const lockedOrUpcomingPeriodIds = allPeriods
    .filter((p: any) => p.status === 'LOCKED' || p.status === 'UPCOMING')
    .map((p: any) => p.id);
  console.log('Locked or Upcoming Periods:', lockedOrUpcomingPeriodIds);

  const seedEmployeesWithHistory = new Set([
    'emp_com_1', // Grace
    'emp_com_2', // Hank
    'emp_com_3', // Ivy
    'emp_com_4', // Jack
    'emp_com_5', // Karen
    'emp_mgr_eng', // Dave
    'emp_mgr_sales', // Eve
    'emp_mgr_hr', // Frank
  ]);

  // ----------------------------------------------------
  // STEP 1: CLEAN UP BOGUS REVIEWS
  // ----------------------------------------------------
  const allReviews = await (await reviewsCol.find({})).toArray();
  const reviewsToDelete = allReviews.filter((r: any) => {
    // If in locked or upcoming period
    if (lockedOrUpcomingPeriodIds.includes(r.reviewPeriodId)) {
      // If not one of the legitimate seed employees with history
      if (!seedEmployeesWithHistory.has(r.employeeId)) {
        return true;
      }
      // If is a seed employee but has no final score and is not closed (e.g. an auto-generated duplicate)
      if (!r.isClosed && r.status !== 'CLOSED' && (!r.finalScore || r.finalScore === 0) && r.id.startsWith('rev_period_')) {
        return true;
      }
    }
    return false;
  });

  console.log(`\nIdentified ${reviewsToDelete.length} bogus reviews to delete:`);
  reviewsToDelete.forEach((r: any) => {
    console.log(`  - Deleting review: ${r.id} | emp: ${r.employeeName || r.employeeId} | period: ${r.reviewPeriodId} | status: ${r.status}`);
  });

  if (reviewsToDelete.length > 0) {
    const idsToDelete = reviewsToDelete.map((r: any) => r.id);
    const delResult = await reviewsCol.deleteMany({ id: { $in: idsToDelete } });
    console.log(`Successfully deleted ${delResult.deletedCount} bogus reviews.`);
  }

  // ----------------------------------------------------
  // STEP 2: CLEAN UP BOGUS / PREMATURE APPRAISALS
  // ----------------------------------------------------
  const allAppraisals = await (await appraisalsCol.find({})).toArray();
  const knownBogusAppraisalIds = new Set([
    'appr_2026_emp_hod_eng',
    'appr_2026_emp_hod_sales',
    'appr_2026_emp_hod_hr',
    'appr_2026_emp_1788502233240_1sxc6v',
    'appr_2026_emp_1788518997168_layodo',
    'appr_2026_emp_1789033516126_pasulq',
    'appr_2026_emp_1789034070004_scfu57',
    'appr_2026_emp_1789035176220_g2rd9u',
    'appr_2026_emp_b5r4tvjgb',
    'appr_2026_emp_1789381440075_fii4wm',
  ]);

  const appraisalsToDelete = allAppraisals.filter((a: any) => {
    if (knownBogusAppraisalIds.has(a.id)) return true;
    if (
      a.status === 'PENDING' &&
      (!a.quarterlyHistory || a.quarterlyHistory.length === 0) &&
      (!a.averageQuarterlyScore || a.averageQuarterlyScore === 0)
    ) {
      return true;
    }
    return false;
  });

  console.log(`\nIdentified ${appraisalsToDelete.length} premature/bogus appraisals to delete:`);
  appraisalsToDelete.forEach((a: any) => {
    console.log(`  - Deleting appraisal: ${a.id} | emp: ${a.employeeName} (${a.employeeId}) | status: ${a.status} | avg: ${a.averageQuarterlyScore}`);
  });

  if (appraisalsToDelete.length > 0) {
    const apprIdsToDelete = appraisalsToDelete.map((a: any) => a.id);
    const delApprResult = await appraisalsCol.deleteMany({ id: { $in: apprIdsToDelete } });
    console.log(`Successfully deleted ${delApprResult.deletedCount} premature appraisals.`);
  }

  // ----------------------------------------------------
  // STEP 3: RESTORE DAVE ENG MANAGER SEED APPRAISAL
  // ----------------------------------------------------
  const seedDave = SEED_APPRAISALS.find((a: any) => a.id === 'app_2026_dave');
  if (seedDave) {
    await appraisalsCol.deleteOne({ id: 'app_2026_dave' });
    await appraisalsCol.insertOne({ ...seedDave });
    console.log('\nRestored seed appraisal for Dave Eng Manager (app_2026_dave) with complete 4-quarter history.');
  }

  // ----------------------------------------------------
  // STEP 4: ENSURE ACTIVE EMPLOYEES HAVE ACTIVE REVIEW IN Q3
  // ----------------------------------------------------
  const activeEmployees = await (await empCol.find({ status: { $in: ['ACTIVE', 'PROBATION'] } })).toArray();
  console.log(`\nVerifying active period reviews for ${activeEmployees.length} active/probation employees...`);
  for (const emp of activeEmployees) {
    await syncEmployeeAppraisalsAndReviews(emp);
  }

  // ----------------------------------------------------
  // STEP 5: FINAL AUDIT VERIFICATION SUMMARY
  // ----------------------------------------------------
  const finalReviews = await (await reviewsCol.find({})).toArray();
  const finalAppraisals = await (await appraisalsCol.find({})).toArray();

  console.log('\n=== FINAL AUDIT SUMMARY ===');
  console.log(`Total Reviews in DB: ${finalReviews.length}`);
  const finalByPeriod: Record<string, number> = {};
  finalReviews.forEach((r: any) => {
    finalByPeriod[r.reviewPeriodId] = (finalByPeriod[r.reviewPeriodId] || 0) + 1;
  });
  console.log('Reviews by Period:', finalByPeriod);

  console.log(`\nTotal Appraisals in DB: ${finalAppraisals.length}`);
  finalAppraisals.forEach((a: any) => {
    console.log(`  + Appraisal: ${a.id} | ${a.employeeName} | Year: ${a.appraisalYear} | Month: ${a.appraisalMonth} | Status: ${a.status} | Locked: ${a.isLocked} | Q_Count: ${a.quarterlyHistory?.length || 0} | AvgScore: ${a.averageQuarterlyScore}`);
  });

  console.log('\n=== DATABASE AUDIT AND CLEANUP COMPLETE ===\n');
  process.exit(0);
}

cleanup().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
