import { SEED_EMPLOYEE_REVIEWS } from '../server/seedReviewsData.js';

console.log('Total seed reviews:', SEED_EMPLOYEE_REVIEWS.length);
const seedEmployees = new Set(SEED_EMPLOYEE_REVIEWS.map((r: any) => r.employeeId));
console.log('Seed employees with reviews:', Array.from(seedEmployees));
SEED_EMPLOYEE_REVIEWS.forEach((r: any) => {
  console.log(`${r.id} | emp: ${r.employeeId} | period: ${r.reviewPeriodId} | score: ${r.finalScore} | status: ${r.status}`);
});
