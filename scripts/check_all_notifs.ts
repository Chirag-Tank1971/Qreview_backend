import { initDatabase, getDbCollection } from '../server/db.js';

async function checkAllNotifs() {
  await initDatabase();
  const notifsCol = getDbCollection('notifications');
  const allNotifs = await (await notifsCol.find({})).toArray();
  console.log(`Total notifications in DB: ${allNotifs.length}`);

  const byType: Record<string, number> = {};
  const byRole: Record<string, number> = {};
  allNotifs.forEach((n: any) => {
    byType[n.type] = (byType[n.type] || 0) + 1;
    byRole[n.userRole || 'NONE'] = (byRole[n.userRole || 'NONE'] || 0) + 1;
  });
  console.log('Notifications by Type:', byType);
  console.log('Notifications by Role:', byRole);

  const employeeNotifs = allNotifs.filter((n: any) => n.userRole === 'EMPLOYEE');
  console.log(`Notifications specifically for EMPLOYEE role (${employeeNotifs.length}):`);
  employeeNotifs.forEach((n: any) => {
    console.log(`  - ${n.id} | userId: ${n.userId} | type: ${n.type} | title: ${n.title}`);
  });

  process.exit(0);
}

checkAllNotifs().catch(console.error);
