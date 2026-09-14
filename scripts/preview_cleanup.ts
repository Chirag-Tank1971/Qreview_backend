import { initDatabase, getDbCollection } from '../server/db.js';
import { SEED_APPRAISALS } from '../server/seedAppraisalsData.js';

async function previewCleanup() {
  await initDatabase();
  const reviewsCol = getDbCollection('employeeReviews');
  const appraisalsCol = getDbCollection('appraisals');
  const periodsCol = getDbCollection('reviewPeriods');

  const allPeriods = await (await periodsCol.find({})).toArray();
  const activePeriod = allPeriods.find((p: any) => p.status === 'ACTIVE');
  console.log('Active Period:', activePeriod?.id, activePeriod?.name);

  const lockedOrUpcomingPeriodIds = allPeriods
    .filter((p: any) => p.status === 'LOCKED' || p.status === 'UPCOMING')
    .map((p: any) => p.id);
  console.log('Locked or Upcoming Periods:', lockedOrUpcomingPeriodIds);

  const reviews = await (await reviewsCol.find({})).toArray();
  const appraisals = await (await appraisalsCol.find({})).toArray();

  const chiragEmps = ['emp_1789033516126_pasulq', 'emp_1789034070004_scfu57', 'emp_1789035176220_g2rd9u', 'emp_hod_eng', 'emp_hod_sales', 'emp_hod_hr'];
  console.log('--- Checking reviews for test/hod employees ---');
  reviews.filter((r: any) => chiragEmps.includes(r.employeeId)).forEach((r: any) => {
    console.log(r.id, '| emp:', r.employeeId, '| period:', r.reviewPeriodId, '| status:', r.status, '| score:', r.finalScore, '| selfScore:', r.selfScore, '| isClosed:', r.isClosed);
  });

  // 1. Identify bogus reviews to remove:
  // Reviews in locked or upcoming periods where finalScore === 0 and isClosed !== true and selfScore === 0
  const bogusReviews = reviews.filter((r: any) => {
    const isLockedOrUpcoming = lockedOrUpcomingPeriodIds.includes(r.reviewPeriodId);
    const isEmptyScore = (!r.finalScore || r.finalScore === 0) && (!r.selfScore || r.selfScore === 0);
    const isNotClosed = !r.isClosed && r.status !== 'CLOSED';
    return isLockedOrUpcoming && isEmptyScore && isNotClosed;
  });

  console.log(`\nFound ${bogusReviews.length} bogus reviews to delete:`);
  bogusReviews.forEach((r: any) => {
    console.log(`  - ${r.id} | emp: ${r.employeeName} (${r.employeeId}) | period: ${r.reviewPeriodId} | status: ${r.status}`);
  });

  // 2. Identify bogus appraisals to remove:
  // Appraisals with Q_count === 0 and status === 'PENDING'
  // Or appraisals created for test employees that have 0 avg score
  const bogusAppraisalIds = [
    'appr_2026_emp_hod_eng',
    'appr_2026_emp_hod_sales',
    'appr_2026_emp_hod_hr',
    'appr_2026_emp_1789033516126_pasulq',
    'appr_2026_emp_1789034070004_scfu57',
    'appr_2026_emp_1789035176220_g2rd9u',
    'appr_2026_emp_1788518997168_layodo',
    'appr_2026_emp_1788502233240_1sxc6v',
    'appr_2026_emp_1789381440075_fii4wm',
    'appr_2026_emp_b5r4tvjgb',
  ];

  const appraisalsToDelete = appraisals.filter((a: any) => bogusAppraisalIds.includes(a.id));
  console.log(`\nFound ${appraisalsToDelete.length} bogus appraisals to delete:`);
  appraisalsToDelete.forEach((a: any) => {
    console.log(`  - ${a.id} | emp: ${a.employeeName} (${a.employeeId}) | status: ${a.status} | avg: ${a.averageQuarterlyScore} | Q: ${a.quarterlyHistory?.length || 0}`);
  });

  // 3. Legitimate appraisals that will remain:
  const remainingAppraisals = appraisals.filter((a: any) => !bogusAppraisalIds.includes(a.id));
  console.log(`\nRemaining legitimate appraisals (${remainingAppraisals.length}):`);
  remainingAppraisals.forEach((a: any) => {
    console.log(`  + ${a.id} | emp: ${a.employeeName} (${a.employeeId}) | status: ${a.status} | avg: ${a.averageQuarterlyScore} | Q: ${a.quarterlyHistory?.length || 0}`);
  });

  // 4. Check Dave's seed appraisal
  const seedDave = SEED_APPRAISALS.find((a: any) => a.id === 'app_2026_dave');
  console.log('\nDave seed appraisal to restore:', seedDave ? 'Found' : 'Not found');

  process.exit(0);
}

previewCleanup().catch(console.error);
