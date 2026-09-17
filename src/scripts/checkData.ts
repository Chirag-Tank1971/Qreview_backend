// Copy this file into backend/src/scripts/ and run with: npx ts-node src/scripts/checkData.ts
// OR: place in backend dir and run: node --loader ts-node/esm src/scripts/checkData.ts

import { getDbCollection } from '../server/db.js';

async function main() {
  const empCol = getDbCollection('employees');
  const deptCol = getDbCollection('departments');
  const reviewCol = getDbCollection('employeeReviews');
  const periodCol = getDbCollection('reviewPeriods');

  const employees = await (await empCol.find({ status: { $ne: 'INACTIVE' } })).toArray();
  const departments = await (await deptCol.find({})).toArray();

  console.log('--- ACTIVE EMPLOYEES ---');
  console.log('Total:', employees.length);

  const byDept: Record<string, number> = {};
  employees.forEach((e: any) => {
    const key = e.departmentId || '__NO_DEPT__';
    byDept[key] = (byDept[key] || 0) + 1;
  });
  console.log('By departmentId:', JSON.stringify(byDept, null, 2));

  console.log('\n--- DEPARTMENTS ---');
  let summed = 0;
  departments.forEach((d: any) => {
    const count = employees.filter((e: any) => e.departmentId === d.id).length;
    summed += count;
    console.log(d.name, ':', count);
  });
  console.log('Sum across all depts:', summed);

  const activePeriod = await periodCol.findOne({ status: 'ACTIVE' });
  if (activePeriod) {
    const q3Reviews = await (await reviewCol.find({ reviewPeriodId: (activePeriod as any).id })).toArray();
    console.log('\n--- Q3 REVIEWS ---');
    console.log('Total:', q3Reviews.length);
    const sc: Record<string, number> = {};
    q3Reviews.forEach((r: any) => { sc[r.status] = (sc[r.status] || 0) + 1; });
    console.log('Status:', JSON.stringify(sc, null, 2));
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
