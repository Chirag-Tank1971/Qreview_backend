import { initDatabase, getDbCollection } from '../server/db.js';

async function audit() {
  await initDatabase();
  const reviewsCol = getDbCollection('employeeReviews');
  const appraisalsCol = getDbCollection('appraisals');
  const empCol = getDbCollection('employees');
  const periodsCol = getDbCollection('reviewPeriods');

  const employees = await (await empCol.find({})).toArray();
  const reviews = await (await reviewsCol.find({})).toArray();
  const appraisals = await (await appraisalsCol.find({})).toArray();
  const periods = await (await periodsCol.find({})).toArray();

  console.log('=== REVIEW PERIODS ===');
  periods.forEach((p: any) => console.log(`${p.id} | ${p.name} | status: ${p.status} | ${p.startDate} -> ${p.endDate}`));

  console.log(`\n=== APPRAISALS (Total: ${appraisals.length}) ===`);
  appraisals.forEach((a: any) => {
    console.log(`${a.id} | empId: ${a.employeeId} | ${a.employeeName} | Year: ${a.appraisalYear} | Cycle: ${a.cycleCode} | Month: ${a.appraisalMonth} | Status: ${a.status} | Locked: ${a.isLocked} | Q_Count: ${a.quarterlyHistory?.length || 0} | AvgScore: ${a.averageQuarterlyScore}`);
  });

  console.log(`\n=== REVIEWS SUMMARY (Total: ${reviews.length}) ===`);
  const byPeriod: Record<string, number> = {};
  reviews.forEach((r: any) => {
    byPeriod[r.reviewPeriodId] = (byPeriod[r.reviewPeriodId] || 0) + 1;
  });
  console.log('Reviews by Period:', byPeriod);

  const byStatus: Record<string, number> = {};
  reviews.forEach((r: any) => {
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  });
  console.log('Reviews by Status:', byStatus);

  console.log('\n=== REVIEWS DETAIL FOR EMPLOYEES ===');
  for (const emp of employees) {
    const empRevs = reviews.filter((r: any) => r.employeeId === emp.id);
    const empAppr = appraisals.filter((a: any) => a.employeeId === emp.id);
    console.log(`Emp: ${emp.id} (${emp.name}) | DOJ: ${emp.dateOfJoining} | Status: ${emp.status} | Cycle: ${emp.cycleCode}`);
    console.log(`   Reviews (${empRevs.length}):`, empRevs.map((r: any) => `${r.reviewPeriodId}[${r.status}|score=${r.finalScore}]`).join(', '));
    console.log(`   Appraisals (${empAppr.length}):`, empAppr.map((a: any) => `${a.id}[${a.status}|avg=${a.averageQuarterlyScore}|Q=${a.quarterlyHistory?.length}]`).join(', '));
  }

  process.exit(0);
}

audit().catch(err => {
  console.error(err);
  process.exit(1);
});
