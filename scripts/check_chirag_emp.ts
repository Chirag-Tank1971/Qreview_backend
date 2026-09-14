import { initDatabase, getDbCollection } from '../server/db.js';

async function checkChiragEmp() {
  await initDatabase();
  const usersCol = getDbCollection('users');
  const empCol = getDbCollection('employees');
  const notifsCol = getDbCollection('notifications');
  const reviewsCol = getDbCollection('employeeReviews');

  const users = await (await usersCol.find({})).toArray();
  console.log('All Users with Chirag in name or email:');
  users.filter((u: any) => u.name?.toLowerCase().includes('chirag') || u.email?.toLowerCase().includes('chirag')).forEach((u: any) => {
    console.log(`User: ${u.id} | Name: ${u.name} | Email: ${u.email} | Role: ${u.role} | EmpId: ${u.employeeId}`);
  });

  const emp = await empCol.findOne({ employeeCode: 'EMP-114' });
  console.log('\nEMP-114 (Chirag_EMP):', emp ? { id: emp.id, name: emp.name, email: emp.email, code: emp.employeeCode } : 'Not found');

  if (emp) {
    const revs = await (await reviewsCol.find({ employeeId: emp.id })).toArray();
    console.log(`\nReviews for ${emp.id}:`, revs.map((r: any) => ({
      id: r.id,
      period: r.reviewPeriodId,
      status: r.status,
      isSelfSubmitted: r.isSelfSubmitted,
      selfScore: r.selfScore,
    })));

    const notifs = await (await notifsCol.find({
      $or: [
        { userId: emp.id },
        { userId: emp.email },
      ]
    })).toArray();
    console.log(`\nDirect notifications for emp.id ${emp.id}:`, notifs);
  }

  process.exit(0);
}

checkChiragEmp().catch(console.error);
