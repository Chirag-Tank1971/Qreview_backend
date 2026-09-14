import { initDatabase, getDbCollection } from '../server/db.js';

async function run() {
  await initDatabase();
  const periodsCol = getDbCollection('reviewPeriods');
  const reviewsCol = getDbCollection('employeeReviews');
  const appraisalsCol = getDbCollection('appraisals');
  const empCol = getDbCollection('employees');

  const periods = await (await periodsCol.find({})).toArray();
  const reviews = await (await reviewsCol.find({})).toArray();
  const appraisals = await (await appraisalsCol.find({})).toArray();
  const employees = await (await empCol.find({})).toArray();

  console.log('=== 1. REVIEW PERIODS ===');
  for (const p of periods) {
    const revs = reviews.filter((r: any) => r.reviewPeriodId === p.id);
    console.log(`Period: ${p.id} | ${p.name} | Status: ${p.status} | Year: ${p.year} Q${p.quarter} | Total Reviews: ${revs.length}`);
  }

  console.log('\n=== 2. ALL REVIEWS GROUPED BY EMPLOYEE ===');
  for (const emp of employees) {
    const empRevs = reviews.filter((r: any) => r.employeeId === emp.id);
    console.log(`\nEmployee: ${emp.id} | ${emp.employeeCode} | ${emp.name} | Dept: ${emp.departmentName} | Cycle: ${emp.cycleCode} | Status: ${emp.status}`);
    for (const r of empRevs) {
      const p = periods.find((p: any) => p.id === r.reviewPeriodId);
      console.log(`   Review: ${r.id} | Period: ${r.reviewPeriodId} (${p?.name || 'UNKNOWN'}) [PeriodStatus: ${p?.status}] | Status: ${r.status} | Score: ${r.finalScore} | Mgr: ${r.managerName || r.managerId}`);
    }
  }

  console.log('\n=== 3. ALL APPRAISALS ===');
  for (const a of appraisals) {
    const emp = employees.find((e: any) => e.id === a.employeeId);
    console.log(`Appraisal: ${a.id} | Emp: ${a.employeeId} (${a.employeeName || emp?.name}) | Year: ${a.appraisalYear} | Month: ${a.appraisalMonth} | Status: ${a.status} | Locked: ${a.isLocked} | Q_Count: ${a.quarterlyHistory?.length || 0} | AvgScore: ${a.averageQuarterlyScore} | Rating: ${a.finalRating || a.recommendedRating} | Inc%: ${a.approvedIncrementPercentage || a.proposedIncrementPercentage}`);
    if (a.quarterlyHistory && a.quarterlyHistory.length > 0) {
      console.log('   Quarters:', a.quarterlyHistory.map((q: any) => `${q.periodId || q.periodName}:${q.status}(score=${q.score})`).join(', '));
    }
  }

  process.exit(0);
}

run().catch(console.error);
