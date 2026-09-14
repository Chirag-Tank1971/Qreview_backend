import { initDatabase, getDbCollection } from '../server/db.js';

async function checkUserAndNotifs() {
  await initDatabase();
  const usersCol = getDbCollection('users');
  const empCol = getDbCollection('employees');
  const notifsCol = getDbCollection('notifications');
  const reviewsCol = getDbCollection('employeeReviews');

  const users = await (await usersCol.find({})).toArray();
  const chiragUser = users.find((u: any) => u.name?.toLowerCase().includes('chirag_emp') || u.email?.toLowerCase().includes('chiragemp'));
  console.log('Chirag User:', chiragUser);

  if (chiragUser) {
    const emp = await empCol.findOne({ id: chiragUser.employeeId });
    console.log('Chirag Employee:', emp);

    const userNotifs = await (await notifsCol.find({
      $or: [
        { userId: chiragUser.id },
        { userId: chiragUser.employeeId },
        { userRole: chiragUser.role },
        { userId: 'ALL' },
      ]
    })).toArray();
    console.log(`Notifications matching Chirag User (${userNotifs.length}):`, userNotifs);

    const chiragReviews = await (await reviewsCol.find({ employeeId: chiragUser.employeeId })).toArray();
    console.log('Chirag Reviews:', chiragReviews.map((r: any) => ({
      id: r.id,
      period: r.reviewPeriodId,
      status: r.status,
      isSelfSubmitted: r.isSelfSubmitted,
    })));
  }

  process.exit(0);
}

checkUserAndNotifs().catch(console.error);
