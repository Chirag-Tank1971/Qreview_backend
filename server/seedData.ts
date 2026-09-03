import bcrypt from 'bcryptjs';
import {
  User,
  Role,
  Department,
  Designation,
  Cycle,
  Kra,
  Employee,
  KraTemplate,
  ReviewPeriod,
  EmployeeReview,
  Appraisal,
  Notification,
  AuditLog,
  FeedbackEntry,
  PipRecord,
  TalentRecord,
} from '../src/types.js';

const DEFAULT_PASSWORD_HASH = bcrypt.hashSync('password123', 10);

export const SEED_ROLES: Role[] = [
  { id: 'role_super_admin', roleName: 'SUPER_ADMIN', displayName: 'Super Admin', description: 'System configuration, users, roles, cycles, audit, and unrestricted full access', permissions: ['ALL_ACCESS', 'MANAGE_USERS', 'MANAGE_CYCLES', 'MANAGE_MASTERS', 'VIEW_AUDIT'] },
  { id: 'role_hr', roleName: 'HR', displayName: 'HR Manager', description: 'Employee master, KRAs, review monitoring, HR review/approval, appraisal decisions, reports', permissions: ['MANAGE_EMPLOYEES', 'MANAGE_KRAS', 'REVIEW_HR', 'MANAGE_APPRAISALS', 'VIEW_REPORTS'] },
  { id: 'role_manager', roleName: 'MANAGER', displayName: 'Reporting Manager', description: 'Review assigned direct reports, score KRAs, submit reviews, view team history', permissions: ['REVIEW_MANAGER', 'VIEW_TEAM', 'SUBMIT_REVIEWS'] },
  { id: 'role_hod', roleName: 'HOD', displayName: 'Head of Department', description: 'Department-level visibility, review monitoring, department analytics and recommendations', permissions: ['VIEW_DEPARTMENT', 'VIEW_REPORTS_DEPT', 'RECOMMEND_APPRAISALS'] },
  { id: 'role_employee', roleName: 'EMPLOYEE', displayName: 'Employee', description: 'View personal profile, assigned KRAs, review status/history and self-assessment', permissions: ['VIEW_SELF', 'VIEW_SELF_HISTORY'] },
  { id: 'role_management', roleName: 'MANAGEMENT', displayName: 'Executive Management', description: 'Organization-wide dashboards, performance trends, appraisal summaries, strategic reports', permissions: ['VIEW_ALL_DASHBOARDS', 'VIEW_ORG_ANALYTICS', 'APPROVE_APPRAISALS'] },
];

export const SEED_DEPARTMENTS: Department[] = [
  { id: 'dept_eng', name: 'Engineering', code: 'ENG', hodId: 'emp_hod_eng', hodName: 'Alice Engineering HOD', active: true, createdAt: '2024-01-01T00:00:00.000Z' },
  { id: 'dept_sales', name: 'Sales', code: 'SLS', hodId: 'emp_hod_sales', hodName: 'Bob Sales HOD', active: true, createdAt: '2024-01-01T00:00:00.000Z' },
  { id: 'dept_hr', name: 'Human Resources', code: 'HR', hodId: 'emp_hod_hr', hodName: 'Carol HR HOD', active: true, createdAt: '2024-01-01T00:00:00.000Z' }
];

export const SEED_DESIGNATIONS: Designation[] = [
  { id: 'des_eng_hod', name: 'VP of Engineering', departmentId: 'dept_eng', departmentName: 'Engineering', level: 3, active: true },
  { id: 'des_eng_mgr', name: 'Engineering Manager', departmentId: 'dept_eng', departmentName: 'Engineering', level: 2, active: true },
  { id: 'des_eng_sr', name: 'Senior Software Engineer', departmentId: 'dept_eng', departmentName: 'Engineering', level: 2, active: true },
  { id: 'des_eng_emp', name: 'Software Engineer', departmentId: 'dept_eng', departmentName: 'Engineering', level: 1, active: true },

  { id: 'des_sales_hod', name: 'VP of Sales', departmentId: 'dept_sales', departmentName: 'Sales', level: 3, active: true },
  { id: 'des_sales_mgr', name: 'Sales Manager', departmentId: 'dept_sales', departmentName: 'Sales', level: 2, active: true },
  { id: 'des_sales_sr', name: 'Senior Sales Representative', departmentId: 'dept_sales', departmentName: 'Sales', level: 2, active: true },
  { id: 'des_sales_emp', name: 'Sales Representative', departmentId: 'dept_sales', departmentName: 'Sales', level: 1, active: true },

  { id: 'des_hr_hod', name: 'VP of HR', departmentId: 'dept_hr', departmentName: 'Human Resources', level: 3, active: true },
  { id: 'des_hr_mgr', name: 'HR Manager', departmentId: 'dept_hr', departmentName: 'Human Resources', level: 2, active: true },
  { id: 'des_hr_emp', name: 'HR Specialist', departmentId: 'dept_hr', departmentName: 'Human Resources', level: 1, active: true },
];

export const SEED_CYCLES: Cycle[] = [
  { id: 'cycle_a', code: 'A', name: 'Cycle A (Jan)', appraisalMonth: 1, colorHex: '#1e3a8a', description: 'January Appraisal Cohort', active: true },
  { id: 'cycle_b', code: 'B', name: 'Cycle B (Feb)', appraisalMonth: 2, colorHex: '#0d9488', description: 'February Appraisal Cohort', active: true },
  { id: 'cycle_c', code: 'C', name: 'Cycle C (Apr)', appraisalMonth: 4, colorHex: '#059669', description: 'April Appraisal Cohort', active: true },
  { id: 'cycle_d', code: 'D', name: 'Cycle D (May)', appraisalMonth: 5, colorHex: '#7c3aed', description: 'May Appraisal Cohort', active: true },
  { id: 'cycle_e', code: 'E', name: 'Cycle E (Jul)', appraisalMonth: 7, colorHex: '#e11d48', description: 'July Appraisal Cohort', active: true },
  { id: 'cycle_f', code: 'F', name: 'Cycle F (Aug)', appraisalMonth: 8, colorHex: '#ea580c', description: 'August Appraisal Cohort', active: true },
  { id: 'cycle_g', code: 'G', name: 'Cycle G (Oct)', appraisalMonth: 10, colorHex: '#0891b2', description: 'October Appraisal Cohort', active: true },
  { id: 'cycle_h', code: 'H', name: 'Cycle H (Nov)', appraisalMonth: 11, colorHex: '#4f46e5', description: 'November Appraisal Cohort', active: true },
];

export const SEED_EMPLOYEES: Employee[] = [
  // HODs
  { id: 'emp_hod_eng', employeeCode: 'EMP-001', name: 'Alice Engineering HOD', email: 'alice.hod@company.com', departmentId: 'dept_eng', departmentName: 'Engineering', designationId: 'des_eng_hod', designationName: 'VP of Engineering', joiningDate: '2022-01-01T00:00:00.000Z', cycleId: 'cycle_a', cycleCode: 'A', currentCtc: 3500000, currency: '₹', lastAppraisalDate: '2025-01-15', status: 'ACTIVE', createdAt: '2022-01-01T00:00:00.000Z' },
  { id: 'emp_hod_sales', employeeCode: 'EMP-002', name: 'Bob Sales HOD', email: 'bob.hod@company.com', departmentId: 'dept_sales', departmentName: 'Sales', designationId: 'des_sales_hod', designationName: 'VP of Sales', joiningDate: '2022-01-01T00:00:00.000Z', cycleId: 'cycle_c', cycleCode: 'C', currentCtc: 3200000, currency: '₹', lastAppraisalDate: '2025-04-15', status: 'ACTIVE', createdAt: '2022-01-01T00:00:00.000Z' },
  { id: 'emp_hod_hr', employeeCode: 'EMP-003', name: 'Carol HR HOD', email: 'carol.hod@company.com', departmentId: 'dept_hr', departmentName: 'Human Resources', designationId: 'des_hr_hod', designationName: 'VP of HR', joiningDate: '2022-01-01T00:00:00.000Z', cycleId: 'cycle_e', cycleCode: 'E', currentCtc: 3000000, currency: '₹', lastAppraisalDate: '2025-07-15', status: 'ACTIVE', createdAt: '2022-01-01T00:00:00.000Z' },

  // Managers
  { id: 'emp_mgr_eng', employeeCode: 'EMP-004', name: 'Dave Eng Manager', email: 'dave.mgr@company.com', departmentId: 'dept_eng', departmentName: 'Engineering', designationId: 'des_eng_mgr', designationName: 'Engineering Manager', managerId: 'emp_hod_eng', managerName: 'Alice Engineering HOD', hodId: 'emp_hod_eng', hodName: 'Alice Engineering HOD', joiningDate: '2023-01-01T00:00:00.000Z', cycleId: 'cycle_a', cycleCode: 'A', currentCtc: 2400000, currency: '₹', lastAppraisalDate: '2025-01-15', status: 'ACTIVE', createdAt: '2023-01-01T00:00:00.000Z' },
  { id: 'emp_mgr_sales', employeeCode: 'EMP-005', name: 'Eve Sales Manager', email: 'eve.mgr@company.com', departmentId: 'dept_sales', departmentName: 'Sales', designationId: 'des_sales_mgr', designationName: 'Sales Manager', managerId: 'emp_hod_sales', managerName: 'Bob Sales HOD', hodId: 'emp_hod_sales', hodName: 'Bob Sales HOD', joiningDate: '2023-01-01T00:00:00.000Z', cycleId: 'cycle_c', cycleCode: 'C', currentCtc: 2200000, currency: '₹', lastAppraisalDate: '2025-04-15', status: 'ACTIVE', createdAt: '2023-01-01T00:00:00.000Z' },
  { id: 'emp_mgr_hr', employeeCode: 'EMP-006', name: 'Frank HR Manager', email: 'frank.mgr@company.com', departmentId: 'dept_hr', departmentName: 'Human Resources', designationId: 'des_hr_mgr', designationName: 'HR Manager', managerId: 'emp_hod_hr', managerName: 'Carol HR HOD', hodId: 'emp_hod_hr', hodName: 'Carol HR HOD', joiningDate: '2023-01-01T00:00:00.000Z', cycleId: 'cycle_e', cycleCode: 'E', currentCtc: 2000000, currency: '₹', lastAppraisalDate: '2025-07-15', status: 'ACTIVE', createdAt: '2023-01-01T00:00:00.000Z' },

  // Employees (5 common employees distributed across cycles)
  { id: 'emp_com_1', employeeCode: 'EMP-007', name: 'Grace Engineer', email: 'grace@company.com', departmentId: 'dept_eng', departmentName: 'Engineering', designationId: 'des_eng_emp', designationName: 'Software Engineer', managerId: 'emp_mgr_eng', managerName: 'Dave Eng Manager', hodId: 'emp_hod_eng', hodName: 'Alice Engineering HOD', joiningDate: '2024-01-01T00:00:00.000Z', cycleId: 'cycle_a', cycleCode: 'A', currentCtc: 1500000, currency: '₹', currentKraTemplateId: 'tmpl_eng_ic', lastAppraisalDate: '2025-01-15', status: 'ACTIVE', createdAt: '2024-01-01T00:00:00.000Z' },
  { id: 'emp_com_2', employeeCode: 'EMP-008', name: 'Hank Engineer', email: 'hank@company.com', departmentId: 'dept_eng', departmentName: 'Engineering', designationId: 'des_eng_emp', designationName: 'Software Engineer', managerId: 'emp_mgr_eng', managerName: 'Dave Eng Manager', hodId: 'emp_hod_eng', hodName: 'Alice Engineering HOD', joiningDate: '2024-01-01T00:00:00.000Z', cycleId: 'cycle_b', cycleCode: 'B', currentCtc: 1400000, currency: '₹', currentKraTemplateId: 'tmpl_eng_ic', lastAppraisalDate: '2025-02-15', status: 'ACTIVE', createdAt: '2024-01-01T00:00:00.000Z' },
  { id: 'emp_com_3', employeeCode: 'EMP-009', name: 'Ivy Sales Rep', email: 'ivy@company.com', departmentId: 'dept_sales', departmentName: 'Sales', designationId: 'des_sales_emp', designationName: 'Sales Representative', managerId: 'emp_mgr_sales', managerName: 'Eve Sales Manager', hodId: 'emp_hod_sales', hodName: 'Bob Sales HOD', joiningDate: '2024-01-01T00:00:00.000Z', cycleId: 'cycle_c', cycleCode: 'C', currentCtc: 1200000, currency: '₹', currentKraTemplateId: 'tmpl_sales_ic', lastAppraisalDate: '2025-04-15', status: 'ACTIVE', createdAt: '2024-01-01T00:00:00.000Z' },
  { id: 'emp_com_4', employeeCode: 'EMP-010', name: 'Jack Sales Rep', email: 'jack@company.com', departmentId: 'dept_sales', departmentName: 'Sales', designationId: 'des_sales_emp', designationName: 'Sales Representative', managerId: 'emp_mgr_sales', managerName: 'Eve Sales Manager', hodId: 'emp_hod_sales', hodName: 'Bob Sales HOD', joiningDate: '2024-01-01T00:00:00.000Z', cycleId: 'cycle_d', cycleCode: 'D', currentCtc: 1100000, currency: '₹', currentKraTemplateId: 'tmpl_sales_ic', lastAppraisalDate: '2025-05-15', status: 'ACTIVE', createdAt: '2024-01-01T00:00:00.000Z' },
  { id: 'emp_com_5', employeeCode: 'EMP-011', name: 'Karen HR Spec', email: 'karen@company.com', departmentId: 'dept_hr', departmentName: 'Human Resources', designationId: 'des_hr_emp', designationName: 'HR Specialist', managerId: 'emp_mgr_hr', managerName: 'Frank HR Manager', hodId: 'emp_hod_hr', hodName: 'Carol HR HOD', joiningDate: '2024-01-01T00:00:00.000Z', cycleId: 'cycle_e', cycleCode: 'E', currentCtc: 1000000, currency: '₹', currentKraTemplateId: 'tmpl_hr_ic', lastAppraisalDate: '2025-07-15', status: 'ACTIVE', createdAt: '2024-01-01T00:00:00.000Z' },
];

export const SEED_USERS: (User & { passwordHash: string })[] = [
  // Super Admin
  { id: 'usr_sa', roleId: 'role_sa', createdAt: '2024-01-01T00:00:00.000Z', email: 'admin@company.com', name: 'System Admin', role: 'SUPER_ADMIN', active: true, passwordHash: DEFAULT_PASSWORD_HASH },

  // HR Manager (Single HR Manager: Frank HR Manager)
  { id: 'usr_mgr_hr', roleId: 'role_hr', createdAt: '2024-01-01T00:00:00.000Z', employeeId: 'emp_mgr_hr', email: 'frank.mgr@company.com', name: 'Frank HR Manager', role: 'HR', active: true, passwordHash: DEFAULT_PASSWORD_HASH },

  // Management Persona
  { id: 'usr_mgmt_persona', roleId: 'role_mgmt', createdAt: '2024-01-01T00:00:00.000Z', employeeId: 'emp_hod_eng', email: 'executive@company.com', name: 'Executive Management', role: 'MANAGEMENT', active: true, passwordHash: DEFAULT_PASSWORD_HASH },

  // HODs
  { id: 'usr_hod_eng', roleId: 'role_hod', createdAt: '2024-01-01T00:00:00.000Z', employeeId: 'emp_hod_eng', email: 'alice.hod@company.com', name: 'Alice Engineering HOD', role: 'HOD', active: true, passwordHash: DEFAULT_PASSWORD_HASH },
  { id: 'usr_hod_sales', roleId: 'role_hod', createdAt: '2024-01-01T00:00:00.000Z', employeeId: 'emp_hod_sales', email: 'bob.hod@company.com', name: 'Bob Sales HOD', role: 'HOD', active: true, passwordHash: DEFAULT_PASSWORD_HASH },
  { id: 'usr_hod_hr', roleId: 'role_hod', createdAt: '2024-01-01T00:00:00.000Z', employeeId: 'emp_hod_hr', email: 'carol.hod@company.com', name: 'Carol HR HOD', role: 'HOD', active: true, passwordHash: DEFAULT_PASSWORD_HASH },

  // Managers
  { id: 'usr_mgr_eng', roleId: 'role_mgr', createdAt: '2024-01-01T00:00:00.000Z', employeeId: 'emp_mgr_eng', email: 'dave.mgr@company.com', name: 'Dave Eng Manager', role: 'MANAGER', active: true, passwordHash: DEFAULT_PASSWORD_HASH },
  { id: 'usr_mgr_sales', roleId: 'role_mgr', createdAt: '2024-01-01T00:00:00.000Z', employeeId: 'emp_mgr_sales', email: 'eve.mgr@company.com', name: 'Eve Sales Manager', role: 'MANAGER', active: true, passwordHash: DEFAULT_PASSWORD_HASH },

  // Employees
  { id: 'usr_emp_1', roleId: 'role_emp', createdAt: '2024-01-01T00:00:00.000Z', employeeId: 'emp_com_1', email: 'grace@company.com', name: 'Grace Engineer', role: 'EMPLOYEE', active: true, passwordHash: DEFAULT_PASSWORD_HASH },
  { id: 'usr_emp_2', roleId: 'role_emp', createdAt: '2024-01-01T00:00:00.000Z', employeeId: 'emp_com_2', email: 'hank@company.com', name: 'Hank Engineer', role: 'EMPLOYEE', active: true, passwordHash: DEFAULT_PASSWORD_HASH },
  { id: 'usr_emp_3', roleId: 'role_emp', createdAt: '2024-01-01T00:00:00.000Z', employeeId: 'emp_com_3', email: 'ivy@company.com', name: 'Ivy Sales Rep', role: 'EMPLOYEE', active: true, passwordHash: DEFAULT_PASSWORD_HASH },
  { id: 'usr_emp_4', roleId: 'role_emp', createdAt: '2024-01-01T00:00:00.000Z', employeeId: 'emp_com_4', email: 'jack@company.com', name: 'Jack Sales Rep', role: 'EMPLOYEE', active: true, passwordHash: DEFAULT_PASSWORD_HASH },
  { id: 'usr_emp_5', roleId: 'role_emp', createdAt: '2024-01-01T00:00:00.000Z', employeeId: 'emp_com_5', email: 'karen@company.com', name: 'Karen HR Spec', role: 'EMPLOYEE', active: true, passwordHash: DEFAULT_PASSWORD_HASH },
];

export { SEED_KRAS, SEED_KRA_TEMPLATES, SEED_REVIEW_PERIODS } from './seedKrasAndPeriods.js';
export { SEED_EMPLOYEE_REVIEWS } from './seedReviewsData.js';
export {
  SEED_APPRAISALS,
  SEED_NOTIFICATIONS,
  SEED_AUDIT_LOGS,
  SEED_FEEDBACK,
  SEED_PIPS,
  SEED_TALENT_RECORDS,
} from './seedAppraisalsData.js';

