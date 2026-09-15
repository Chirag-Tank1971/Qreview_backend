import dotenv from 'dotenv';
dotenv.config();
import { initDatabase, getDbCollection } from '../server/db.js';

async function main() {
  await initDatabase();
  const reviewCol = getDbCollection('employeeReviews');
  const res = await reviewCol.deleteMany({ employeeId: 'emp_1789450720526_bpjl0k' });
  console.log('Successfully deleted reviews for EMP-115:', res.deletedCount);
  process.exit(0);
}

main().catch(console.error);
