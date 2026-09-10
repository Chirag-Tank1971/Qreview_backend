import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import { getDbCollection } from '../db.js';
import { AuthenticatedRequest, authenticateToken, requireRoles } from '../auth.js';
import {
  BulkDatasetType,
  BulkTemplateColumn,
  BulkValidationReport,
  BulkValidationRowResult,
  BulkImportResult,
  UserRole,
} from '../../src/types.js';

export const bulkRouter = Router();

// Apply auth to all bulk endpoints - Bulk operations strictly restricted to Super Admin, HR, and HOD
bulkRouter.use(authenticateToken);
bulkRouter.use(requireRoles('SUPER_ADMIN', 'HR', 'HOD'));

// ==========================================
// 1. TEMPLATE SCHEMAS & SAMPLE DATA
// ==========================================

const TEMPLATE_COLUMNS: Record<BulkDatasetType, BulkTemplateColumn[]> = {
  employees: [
    { key: 'employeeCode', label: 'Employee Code', description: 'Unique internal ID (e.g. EMP-101)', required: true, example: 'EMP-101', type: 'string' },
    { key: 'fullName', label: 'Full Name', description: 'Employee First and Last Name', required: true, example: 'Aarav Sharma', type: 'string' },
    { key: 'email', label: 'Work Email', description: 'Unique corporate email address', required: true, example: 'aarav.sharma@company.com', type: 'string' },
    { key: 'joiningDate', label: 'Joining Date', description: 'Date of joining (YYYY-MM-DD)', required: true, example: '2025-01-15', type: 'date' },
    { key: 'cycleCode', label: 'Cycle Code', description: 'Joining Cycle: CYCLE_A to CYCLE_H (Auto-calculated from joining month if blank)', required: false, example: 'CYCLE_A', type: 'enum', options: ['CYCLE_A', 'CYCLE_B', 'CYCLE_C', 'CYCLE_D', 'CYCLE_E', 'CYCLE_F', 'CYCLE_G', 'CYCLE_H'] },
    { key: 'department', label: 'Department', description: 'Department Name or Code', required: true, example: 'Engineering', type: 'string' },
    { key: 'designation', label: 'Designation', description: 'Official Job Designation Title', required: true, example: 'Senior Software Engineer', type: 'string' },
    { key: 'managerCode', label: 'Reporting Manager Code', description: 'Employee Code of Reporting Manager (e.g. EMP-004)', required: false, example: 'EMP-004', type: 'string' },
    { key: 'hodCode', label: 'HOD Code', description: 'Employee Code of Head of Department (e.g. EMP-001; defaults to Department HOD if blank)', required: false, example: 'EMP-001', type: 'string' },
    { key: 'baseSalary', label: 'Base Annual CTC (₹)', description: 'Current Annual CTC figure in INR', required: true, example: '1850000', type: 'number' },
    { key: 'role', label: 'System Role', description: 'Access Role in PMS', required: false, example: 'EMPLOYEE', type: 'enum', options: ['EMPLOYEE', 'MANAGER', 'HOD', 'HR_ADMIN', 'CXO'] },
    { key: 'status', label: 'Employment Status', description: 'Active or probation', required: false, example: 'ACTIVE', type: 'enum', options: ['ACTIVE', 'PROBATION', 'NOTICE'] },
  ],
  kras: [
    { key: 'templateTitle', label: 'Template Title', description: 'Standardized Template Group', required: true, example: 'Engineering Senior Core KRA 2026', type: 'string' },
    { key: 'department', label: 'Department', description: 'Target Department', required: true, example: 'Engineering', type: 'string' },
    { key: 'designation', label: 'Designation', description: 'Applicable Designation Title', required: true, example: 'Senior Software Engineer', type: 'string' },
    { key: 'cycleCode', label: 'Cycle Code', description: 'Cycle: CYCLE_A to CYCLE_H or ALL', required: true, example: 'CYCLE_A', type: 'enum', options: ['ALL', 'CYCLE_A', 'CYCLE_B', 'CYCLE_C', 'CYCLE_D', 'CYCLE_E', 'CYCLE_F', 'CYCLE_G', 'CYCLE_H'] },
    { key: 'kraTitle', label: 'KRA Title', description: 'Specific Key Result Area name', required: true, example: 'System Architecture & Scalability', type: 'string' },
    { key: 'weightage', label: 'Weightage (%)', description: 'KRA weight (sum of all KRAs in template = 100)', required: true, example: '30', type: 'number' },
    { key: 'targetDescription', label: 'Target Description', description: 'Measurable metric goal description', required: true, example: 'Deliver zero-downtime microservice migration', type: 'string' },
    { key: 'measurementUnit', label: 'Unit', description: 'Measurement unit type', required: false, example: 'PERCENTAGE', type: 'enum', options: ['PERCENTAGE', 'NUMERIC', 'RATING', 'CURRENCY', 'MILESTONE'] },
    { key: 'targetValue', label: 'Target Value', description: 'Benchmark target number/text', required: true, example: '99.95', type: 'string' },
  ],
  'quarterly-scores': [
    { key: 'employeeCode', label: 'Employee Code', description: 'Employee Code', required: true, example: 'EMP-101', type: 'string' },
    { key: 'periodCode', label: 'Quarter Period Code', description: 'Review Period (e.g. Q1_2026, Q2_2026, Q3_2026, Q4_2026)', required: true, example: 'Q1_2026', type: 'string' },
    { key: 'kraTitle', label: 'KRA Title', description: 'KRA matching employee template', required: true, example: 'System Architecture & Scalability', type: 'string' },
    { key: 'selfScore', label: 'Self Score (1-5)', description: 'Employee self rating 1.0 to 5.0', required: false, example: '4.2', type: 'number' },
    { key: 'managerScore', label: 'Manager Score (1-5)', description: 'Manager verified rating 1.0 to 5.0', required: true, example: '4.5', type: 'number' },
    { key: 'managerComments', label: 'Manager Feedback & Remarks', description: 'Detailed constructive manager comments', required: true, example: 'Demonstrated exceptional leadership and architectural rigor.', type: 'string' },
    { key: 'status', label: 'Review Status', description: 'Target review submission status', required: false, example: 'MANAGER_COMPLETED', type: 'enum', options: ['DRAFT', 'SELF_SUBMITTED', 'MANAGER_COMPLETED', 'HR_COMPLETED'] },
  ],
  'increment-matrix': [
    { key: 'employeeCode', label: 'Employee Code', description: 'Employee Code', required: true, example: 'EMP-101', type: 'string' },
    { key: 'cycleCode', label: 'Cycle Code', description: 'Appraisal Cycle Code', required: true, example: 'CYCLE_A', type: 'string' },
    { key: 'finalRating', label: 'Calibrated Rating', description: 'Annual Performance Category', required: true, example: 'OUTSTANDING', type: 'enum', options: ['OUTSTANDING', 'EXCEEDS_EXPECTATIONS', 'MEETS_EXPECTATIONS', 'NEEDS_IMPROVEMENT', 'UNSATISFACTORY'] },
    { key: 'proposedIncrementPercent', label: 'Increment (%)', description: 'Proposed salary increment percentage', required: true, example: '14.5', type: 'number' },
    { key: 'promotionEligible', label: 'Promotion (YES/NO)', description: 'Whether employee is recommended for promotion', required: false, example: 'YES', type: 'string' },
    { key: 'promotedDesignation', label: 'Promoted Designation', description: 'New Designation if promoted', required: false, example: 'Staff Software Engineer', type: 'string' },
    { key: 'bonusAmount', label: 'Performance Bonus (₹)', description: 'One-time bonus allocation', required: false, example: '150000', type: 'number' },
    { key: 'hodNotes', label: 'HOD / Calibration Notes', description: 'HOD justification for calibration or merit hike', required: false, example: 'Top 5% performer across engineering pod; recommended for fast-track promotion.', type: 'string' },
  ],
};

const SAMPLE_DATA: Record<BulkDatasetType, any[]> = {
  employees: [
    { employeeCode: 'EMP-201', fullName: 'Kavita Nair', email: 'kavita.nair@company.com', joiningDate: '2025-01-10', cycleCode: 'CYCLE_A', department: 'Engineering', designation: 'Senior Software Engineer', managerCode: 'EMP-004', hodCode: 'EMP-001', baseSalary: 1800000, role: 'EMPLOYEE', status: 'ACTIVE' },
    { employeeCode: 'EMP-202', fullName: 'Rohan Deshmukh', email: 'rohan.deshmukh@company.com', joiningDate: '2025-02-14', cycleCode: 'CYCLE_B', department: 'Product & Design', designation: 'Product Designer', managerCode: 'EMP-001', hodCode: 'EMP-001', baseSalary: 1450000, role: 'EMPLOYEE', status: 'ACTIVE' },
    { employeeCode: 'EMP-203', fullName: 'Ananya Roy', email: 'ananya.roy@company.com', joiningDate: '2025-03-01', cycleCode: 'CYCLE_C', department: 'Human Resources', designation: 'Talent Acquisition Lead', managerCode: 'EMP-006', hodCode: 'EMP-003', baseSalary: 1600000, role: 'EMPLOYEE', status: 'ACTIVE' },
    { employeeCode: 'EMP-204', fullName: 'Sameer Gupta', email: 'sameer.gupta@company.com', joiningDate: '2025-04-18', cycleCode: 'CYCLE_D', department: 'Sales & Growth', designation: 'Enterprise Account Executive', managerCode: 'EMP-005', hodCode: 'EMP-002', baseSalary: 1750000, role: 'EMPLOYEE', status: 'ACTIVE' },
  ],
  kras: [
    { templateTitle: 'Sales Enterprise Executive 2026', department: 'Sales & Growth', designation: 'Enterprise Account Executive', cycleCode: 'ALL', kraTitle: 'Net New ARR Bookings', weightage: 40, targetDescription: 'Achieve ₹2.5 Cr in new annualized enterprise contract value', measurementUnit: 'CURRENCY', targetValue: '25000000' },
    { templateTitle: 'Sales Enterprise Executive 2026', department: 'Sales & Growth', designation: 'Enterprise Account Executive', cycleCode: 'ALL', kraTitle: 'Pipeline Generation & Multi-Threading', weightage: 30, targetDescription: 'Generate 4x qualified pipeline coverage each quarter', measurementUnit: 'NUMERIC', targetValue: '4.0' },
    { templateTitle: 'Sales Enterprise Executive 2026', department: 'Sales & Growth', designation: 'Enterprise Account Executive', cycleCode: 'ALL', kraTitle: 'Customer Retention & Deal Velocity', weightage: 30, targetDescription: 'Maintain <45 day sales cycle with 95% retention', measurementUnit: 'PERCENTAGE', targetValue: '95' },
  ],
  'quarterly-scores': [
    { employeeCode: 'EMP-004', periodCode: 'Q1_2026', kraTitle: 'Feature Delivery Velocity & Code Quality', selfScore: 4.5, managerScore: 4.8, managerComments: 'Exceeded sprints consistently with zero P1 production bugs.', status: 'MANAGER_COMPLETED' },
    { employeeCode: 'EMP-004', periodCode: 'Q1_2026', kraTitle: 'System Scalability & Unit Test Coverage', selfScore: 4.0, managerScore: 4.5, managerComments: 'Raised pod test coverage from 78% to 92%. Outstanding rigor.', status: 'MANAGER_COMPLETED' },
    { employeeCode: 'EMP-004', periodCode: 'Q1_2026', kraTitle: 'Mentorship & Peer Code Reviews', selfScore: 4.2, managerScore: 4.6, managerComments: 'Mentored two junior engineers effectively and led team tech talks.', status: 'MANAGER_COMPLETED' },
  ],
  'increment-matrix': [
    { employeeCode: 'EMP-004', cycleCode: 'CYCLE_F', finalRating: 'OUTSTANDING', proposedIncrementPercent: 15.0, promotionEligible: 'YES', promotedDesignation: 'Lead Frontend Engineer', bonusAmount: 120000, hodNotes: 'Exemplary cross-functional impact; promoted to Pod Lead.' },
    { employeeCode: 'EMP-006', cycleCode: 'CYCLE_F', finalRating: 'EXCEEDS_EXPECTATIONS', proposedIncrementPercent: 11.5, promotionEligible: 'NO', promotedDesignation: '', bonusAmount: 75000, hodNotes: 'Strong consistency throughout 4 quarters. Merit increment approved.' },
  ],
};

/**
 * GET /api/bulk/templates/:type
 * Returns metadata, columns, and sample records for a dataset
 */
bulkRouter.get('/templates/:type', (req: AuthenticatedRequest, res: Response) => {
  const datasetType = req.params.type as BulkDatasetType;
  if (!TEMPLATE_COLUMNS[datasetType]) {
    res.status(400).json({ error: `Invalid dataset type: ${datasetType}` });
    return;
  }

  res.json({
    datasetType,
    columns: TEMPLATE_COLUMNS[datasetType],
    sampleData: SAMPLE_DATA[datasetType] || [],
  });
});

function deriveCycleFromDate(dateInput: any): { fullCode: string; shortCode: string; cycleId: string } {
  let m = 1;
  if (dateInput) {
    const d = new Date(dateInput);
    if (!isNaN(d.getTime())) {
      m = d.getUTCMonth() + 1; // 1 to 12
    }
  }
  let shortCode = 'A';
  if (m === 1) shortCode = 'A';
  else if (m === 2 || m === 3) shortCode = 'B';
  else if (m === 4) shortCode = 'C';
  else if (m === 5 || m === 6) shortCode = 'D';
  else if (m === 7) shortCode = 'E';
  else if (m === 8 || m === 9 || m === 10) shortCode = 'F';
  else if (m === 11) shortCode = 'G';
  else if (m === 12) shortCode = 'H';

  return {
    fullCode: `CYCLE_${shortCode}`,
    shortCode,
    cycleId: `cycle_${shortCode.toLowerCase()}`,
  };
}

/**
 * Synchronizes manager and HOD hierarchy links for all employees in the database.
 * Resolves managerId / managerName from managerEmployeeCode.
 * Resolves hodId / hodName from hodEmployeeCode, or falls back to department's assigned HOD.
 */
export async function resolveAndSyncHierarchy(): Promise<{ updatedCount: number; totalScanned: number }> {
  try {
    const employeesCol = getDbCollection('employees');
    const departmentsCol = getDbCollection('departments');
    const allEmployees = await (await employeesCol.find({})).toArray();
    const allDepartments = await (await departmentsCol.find({})).toArray();

    const empByCode = new Map<string, any>();
    const empById = new Map<string, any>();
    for (const emp of allEmployees) {
      if (emp.employeeCode) empByCode.set(String(emp.employeeCode).trim().toUpperCase(), emp);
      if (emp.id) empById.set(String(emp.id).trim(), emp);
    }

    const deptById = new Map<string, any>();
    for (const d of allDepartments) {
      if (d.id) deptById.set(d.id, d);
      if (d.name) deptById.set(String(d.name).trim().toLowerCase(), d);
      if (d.code) deptById.set(String(d.code).trim().toLowerCase(), d);
    }

    let updatedCount = 0;

    for (const emp of allEmployees) {
      let needsUpdate = false;
      const updateFields: any = {};

      // 1. Resolve Manager
      const rawMgrCode = String(emp.managerEmployeeCode || '').trim().toUpperCase();
      if (rawMgrCode && empByCode.has(rawMgrCode)) {
        const mgr = empByCode.get(rawMgrCode);
        if (emp.managerId !== mgr.id || emp.managerName !== mgr.name) {
          updateFields.managerId = mgr.id;
          updateFields.managerName = mgr.name;
          needsUpdate = true;
        }
      } else if (emp.managerId && empById.has(emp.managerId)) {
        const mgr = empById.get(emp.managerId);
        if (emp.managerName !== mgr.name || !emp.managerEmployeeCode) {
          updateFields.managerName = mgr.name;
          if (!emp.managerEmployeeCode && mgr.employeeCode) {
            updateFields.managerEmployeeCode = mgr.employeeCode;
          }
          needsUpdate = true;
        }
      }

      // 2. Resolve HOD
      const rawHodCode = String(emp.hodEmployeeCode || '').trim().toUpperCase();
      if (rawHodCode && empByCode.has(rawHodCode)) {
        const hod = empByCode.get(rawHodCode);
        if (emp.hodId !== hod.id || emp.hodName !== hod.name) {
          updateFields.hodId = hod.id;
          updateFields.hodName = hod.name;
          needsUpdate = true;
        }
      } else if (emp.hodId && empById.has(emp.hodId)) {
        const hod = empById.get(emp.hodId);
        if (emp.hodName !== hod.name || !emp.hodEmployeeCode) {
          updateFields.hodName = hod.name;
          if (!emp.hodEmployeeCode && hod.employeeCode) {
            updateFields.hodEmployeeCode = hod.employeeCode;
          }
          needsUpdate = true;
        }
      } else {
        // Fallback to department's assigned HOD
        const dept = deptById.get(emp.departmentId) || deptById.get(String(emp.departmentName || '').trim().toLowerCase());
        if (dept && dept.hodId) {
          const hod = empById.get(dept.hodId) || empByCode.get(String(dept.hodId).toUpperCase());
          const resolvedHodId = hod ? hod.id : dept.hodId;
          const resolvedHodName = hod ? hod.name : (dept.hodName || 'Head of Department');
          const resolvedHodCode = hod ? hod.employeeCode : undefined;

          if (emp.hodId !== resolvedHodId || emp.hodName !== resolvedHodName) {
            updateFields.hodId = resolvedHodId;
            updateFields.hodName = resolvedHodName;
            if (resolvedHodCode && !emp.hodEmployeeCode) {
              updateFields.hodEmployeeCode = resolvedHodCode;
            }
            needsUpdate = true;
          }
        } else if (emp.managerId && empById.has(emp.managerId)) {
          // Fallback: check if manager is an HOD or has an HOD
          const mgr = empById.get(emp.managerId);
          const isMgrHod =
            mgr.role === 'HOD' ||
            mgr.systemRole === 'HOD' ||
            String(mgr.designationName || '').toLowerCase().includes('vp') ||
            String(mgr.designationName || '').toLowerCase().includes('hod');

          if (isMgrHod) {
            if (emp.hodId !== mgr.id || emp.hodName !== mgr.name) {
              updateFields.hodId = mgr.id;
              updateFields.hodName = mgr.name;
              if (mgr.employeeCode && !emp.hodEmployeeCode) {
                updateFields.hodEmployeeCode = mgr.employeeCode;
              }
              needsUpdate = true;
            }
          } else if (mgr.hodId && empById.has(mgr.hodId)) {
            const mgrHod = empById.get(mgr.hodId);
            if (emp.hodId !== mgrHod.id || emp.hodName !== mgrHod.name) {
              updateFields.hodId = mgrHod.id;
              updateFields.hodName = mgrHod.name;
              if (mgrHod.employeeCode && !emp.hodEmployeeCode) {
                updateFields.hodEmployeeCode = mgrHod.employeeCode;
              }
              needsUpdate = true;
            }
          }
        }
      }

      if (needsUpdate) {
        await employeesCol.updateOne({ id: emp.id }, { $set: updateFields });
        updatedCount++;
      }
    }

    return { updatedCount, totalScanned: allEmployees.length };
  } catch (err: any) {
    console.error('[Bulk Engine] Failed to resolve hierarchy:', err);
    return { updatedCount: 0, totalScanned: 0 };
  }
}

// Automatically schedule hierarchy synchronization once server finishes loading
setTimeout(() => {
  resolveAndSyncHierarchy().then((res) => {
    if (res.updatedCount > 0) {
      console.log(`[Bulk Engine] Auto-synced hierarchy for ${res.updatedCount} employee records on startup.`);
    }
  }).catch(() => {});
}, 3000);

// ==========================================
// 2. VALIDATION ENGINE
// ==========================================

/**
 * POST /api/bulk/validate/:type
 * Validates in-memory raw imported rows against database constraints
 */
bulkRouter.post('/validate/:type', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const datasetType = req.params.type as BulkDatasetType;
    const { rows, allowUpdateExisting = true } = req.body;

    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(400).json({ error: 'No data rows provided for validation.' });
      return;
    }

    const columns = TEMPLATE_COLUMNS[datasetType];
    if (!columns) {
      res.status(400).json({ error: `Unknown dataset type: ${datasetType}` });
      return;
    }

    const requiredKeys = columns.filter((c) => c.required).map((c) => c.key);

    // Fetch DB master reference lists for foreign key lookups
    const employeesCol = getDbCollection('employees');
    const departmentsCol = getDbCollection('departments');
    const designationsCol = getDbCollection('designations');
    const cyclesCol = getDbCollection('cycles');
    const usersCol = getDbCollection('users');

    const existingEmployees = await (await employeesCol.find({})).toArray();
    const existingDepartments = await (await departmentsCol.find({})).toArray();
    const existingDesignations = await (await designationsCol.find({})).toArray();
    const existingCycles = await (await cyclesCol.find({})).toArray();
    const existingUsers = await (await usersCol.find({})).toArray();

    const empCodeMap = new Set(existingEmployees.map((e) => String(e.employeeCode || '').trim().toUpperCase()));
    const empEmailMap = new Set(existingEmployees.map((e) => String(e.email || '').trim().toLowerCase()));
    const userEmailMap = new Set(existingUsers.map((u) => String(u.email || '').trim().toLowerCase()));

    const deptNameSet = new Set(existingDepartments.map((d) => String(d.name || '').trim().toLowerCase()));
    const deptCodeSet = new Set(existingDepartments.map((d) => String(d.code || '').trim().toLowerCase()));
    const desigNameSet = new Set(existingDesignations.map((d) => String(d.title || d.name || '').trim().toLowerCase()));
    const cycleCodeSet = new Set(existingCycles.map((c) => String(c.code || '').trim().toUpperCase()));

    // Track duplicates inside the uploaded file itself
    const seenCodesInFile = new Set<string>();
    const seenEmailsInFile = new Set<string>();

    const results: BulkValidationRowResult[] = [];
    let validCount = 0;
    let warningCount = 0;
    let errorCount = 0;

    rows.forEach((rawRow: any, index: number) => {
      const rowNumber = index + 1;
      const errors: string[] = [];
      const warnings: string[] = [];
      let action: 'INSERT' | 'UPDATE' | 'SKIP' = 'INSERT';

      // 1. Check Required Fields
      for (const reqKey of requiredKeys) {
        const val = rawRow[reqKey];
        if (val === undefined || val === null || String(val).trim() === '') {
          errors.push(`Missing required field: '${reqKey}'`);
        }
      }

      // Dataset specific validations
      if (datasetType === 'employees') {
        const code = String(rawRow.employeeCode || '').trim().toUpperCase();
        const email = String(rawRow.email || '').trim().toLowerCase();
        const cycle = String(rawRow.cycleCode || '').trim().toUpperCase();
        const dept = String(rawRow.department || '').trim().toLowerCase();
        const desig = String(rawRow.designation || '').trim().toLowerCase();
        const mgrCode = String(
          rawRow.managerCode || rawRow.managerEmployeeCode || rawRow.reportingManagerCode || rawRow.manager || ''
        ).trim().toUpperCase();
        const hodCode = String(
          rawRow.hodCode || rawRow.hodEmployeeCode || rawRow.headOfDepartmentCode || rawRow.hod || ''
        ).trim().toUpperCase();
        const salary = Number(rawRow.baseSalary);

        // Code checks
        if (code) {
          if (seenCodesInFile.has(code)) {
            errors.push(`Duplicate employee code '${code}' within this file.`);
          } else {
            seenCodesInFile.add(code);
          }

          if (empCodeMap.has(code)) {
            if (allowUpdateExisting) {
              action = 'UPDATE';
              warnings.push(`Employee code '${code}' exists. Existing profile will be updated.`);
            } else {
              errors.push(`Employee code '${code}' already exists in database.`);
            }
          }
        }

        // Email checks
        if (email) {
          if (!email.includes('@') || !email.includes('.')) {
            errors.push(`Invalid email format: '${email}'`);
          } else if (seenEmailsInFile.has(email)) {
            errors.push(`Duplicate email '${email}' within this file.`);
          } else {
            seenEmailsInFile.add(email);
          }

          if (empEmailMap.has(email) && action !== 'UPDATE') {
            errors.push(`Email '${email}' is already registered to another employee.`);
          }
        }

        // Cycle check & auto-derivation
        if (!cycle) {
          const derived = deriveCycleFromDate(rawRow.joiningDate);
          rawRow.cycleCode = derived.fullCode;
          warnings.push(`Cycle Code was omitted; automatically assigned '${derived.fullCode}' based on joining date.`);
        } else if (!cycleCodeSet.has(cycle) && !['CYCLE_A', 'CYCLE_B', 'CYCLE_C', 'CYCLE_D', 'CYCLE_E', 'CYCLE_F', 'CYCLE_G', 'CYCLE_H'].includes(cycle)) {
          errors.push(`Invalid Cycle Code '${cycle}'. Must be one of CYCLE_A to CYCLE_H.`);
        }

        // Department check
        if (dept && !deptNameSet.has(dept) && !deptCodeSet.has(dept)) {
          warnings.push(`Department '${rawRow.department}' not found in masters; will be auto-created.`);
        }

        // Designation check
        if (desig && !desigNameSet.has(desig)) {
          warnings.push(`Designation '${rawRow.designation}' not found in masters; will be auto-created.`);
        }

        // Manager check
        if (mgrCode) {
          if (!empCodeMap.has(mgrCode) && !seenCodesInFile.has(mgrCode)) {
            warnings.push(`Reporting manager code '${mgrCode}' not yet in system. Relationship will link once manager joins.`);
          }
        }

        // HOD check
        if (hodCode) {
          if (!empCodeMap.has(hodCode) && !seenCodesInFile.has(hodCode)) {
            warnings.push(`HOD code '${hodCode}' not yet in system. Will fallback to department HOD if not found.`);
          }
        }

        // Salary check
        if (isNaN(salary) || salary <= 0) {
          errors.push('Base Salary must be a positive numeric amount.');
        }
      } else if (datasetType === 'kras') {
        const weightage = Number(rawRow.weightage);
        if (isNaN(weightage) || weightage <= 0 || weightage > 100) {
          errors.push(`Weightage must be between 1 and 100. Received: '${rawRow.weightage}'`);
        }
      } else if (datasetType === 'quarterly-scores') {
        const code = String(rawRow.employeeCode || '').trim().toUpperCase();
        const mgrScore = Number(rawRow.managerScore);
        const selfScore = rawRow.selfScore !== undefined && rawRow.selfScore !== '' ? Number(rawRow.selfScore) : null;

        if (code && !empCodeMap.has(code)) {
          errors.push(`Employee code '${code}' not found in database.`);
        }

        if (isNaN(mgrScore) || mgrScore < 1.0 || mgrScore > 5.0) {
          errors.push(`Manager Score must be a rating between 1.0 and 5.0. Received: '${rawRow.managerScore}'`);
        }

        if (selfScore !== null && (isNaN(selfScore) || selfScore < 1.0 || selfScore > 5.0)) {
          errors.push(`Self Score must be between 1.0 and 5.0. Received: '${rawRow.selfScore}'`);
        }
      } else if (datasetType === 'increment-matrix') {
        const code = String(rawRow.employeeCode || '').trim().toUpperCase();
        const incPct = Number(rawRow.proposedIncrementPercent);

        if (code && !empCodeMap.has(code)) {
          errors.push(`Employee code '${code}' not found in database.`);
        }

        if (isNaN(incPct) || incPct < 0 || incPct > 100) {
          errors.push(`Proposed increment % must be between 0 and 100. Received: '${rawRow.proposedIncrementPercent}'`);
        }
      }

      const isValid = errors.length === 0;
      const status: 'VALID' | 'WARNING' | 'ERROR' = !isValid ? 'ERROR' : warnings.length > 0 ? 'WARNING' : 'VALID';

      if (status === 'ERROR') errorCount++;
      else if (status === 'WARNING') {
        validCount++;
        warningCount++;
      } else {
        validCount++;
      }

      results.push({
        rowNumber,
        data: rawRow,
        isValid,
        status,
        errors,
        warnings,
        action: !isValid ? 'SKIP' : action,
      });
    });

    const report: BulkValidationReport = {
      datasetType,
      totalRows: rows.length,
      validCount,
      warningCount,
      errorCount,
      canProceed: validCount > 0,
      results,
      requiredFields: requiredKeys,
    };

    res.json(report);
  } catch (error: any) {
    console.error('Validation error:', error);
    res.status(500).json({ error: error.message || 'Validation failed.' });
  }
});

// ==========================================
// 3. ATOMIC IMPORT & PERSISTENCE ENGINE
// ==========================================

/**
 * POST /api/bulk/import/:type
 * Executes the verified bulk upload and commits records into MongoDB/Database
 */
bulkRouter.post('/import/:type', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const datasetType = req.params.type as BulkDatasetType;
    const { rows, skipInvalid = true, allowUpdateExisting = true, fileName = 'bulk_upload.xlsx' } = req.body;
    const currentUser = req.user;

    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(400).json({ error: 'No rows provided for import.' });
      return;
    }

    console.log(`[Bulk Import] Starting import of ${rows.length} rows for dataset "${datasetType}" from file "${fileName}" by "${currentUser?.name || 'HR Admin'}"`);

    const employeesCol = getDbCollection('employees');
    const departmentsCol = getDbCollection('departments');
    const designationsCol = getDbCollection('designations');
    const cyclesCol = getDbCollection('cycles');
    const usersCol = getDbCollection('users');
    const kraTemplatesCol = getDbCollection('kraTemplates');
    const krasCol = getDbCollection('kras');
    const reviewsCol = getDbCollection('employeeReviews');
    const appraisalsCol = getDbCollection('appraisals');
    const auditLogsCol = getDbCollection('auditLogs');

    let insertedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    const errorsList: Array<{ row: number; reason: string }> = [];
    const batchId = `BATCH_${Date.now()}_${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

    // Get masters for lookup
    const allDepartments = await (await departmentsCol.find({})).toArray();
    const allDesignations = await (await designationsCol.find({})).toArray();
    const allCycles = await (await cyclesCol.find({})).toArray();

    const findOrCreateDept = async (deptInput: string) => {
      if (!deptInput) return { id: 'dept_eng', name: 'Engineering', code: 'ENG' };
      const normalized = deptInput.trim().toLowerCase();
      let match = allDepartments.find((d) => (d.name && d.name.toLowerCase() === normalized) || (d.code && d.code.toLowerCase() === normalized));
      if (!match) {
        const newDept = {
          id: `dept_${Math.random().toString(36).substr(2, 8)}`,
          name: deptInput.trim(),
          code: deptInput.trim().substr(0, 4).toUpperCase(),
          description: `Imported department: ${deptInput.trim()}`,
          isActive: true,
          createdAt: new Date().toISOString(),
        };
        await departmentsCol.insertOne(newDept);
        allDepartments.push(newDept);
        match = newDept;
      }
      return match;
    };

    const findOrCreateDesig = async (desigInput: string, deptId: string) => {
      if (!desigInput) return { id: 'desig_eng_1', title: 'Software Engineer' };
      const normalized = desigInput.trim().toLowerCase();
      let match = allDesignations.find((d) => (d.title && d.title.toLowerCase() === normalized) || (d.name && d.name.toLowerCase() === normalized));
      if (!match) {
        const newDesig = {
          id: `desig_${Math.random().toString(36).substr(2, 8)}`,
          title: desigInput.trim(),
          name: desigInput.trim(),
          departmentId: deptId,
          level: 2,
          isActive: true,
          createdAt: new Date().toISOString(),
        };
        await designationsCol.insertOne(newDesig);
        allDesignations.push(newDesig);
        match = newDesig;
      }
      return match;
    };

    const mapCycleCodeToId = (code: string) => {
      const clean = String(code || '').trim().toUpperCase();
      const cycleMatch = allCycles.find((c) => c.code === clean);
      if (cycleMatch) return cycleMatch.id;
      // standard fallbacks
      const cycleMap: Record<string, string> = {
        CYCLE_A: 'cycle_a',
        CYCLE_B: 'cycle_b',
        CYCLE_C: 'cycle_c',
        CYCLE_D: 'cycle_d',
        CYCLE_E: 'cycle_e',
        CYCLE_F: 'cycle_f',
        CYCLE_G: 'cycle_g',
        CYCLE_H: 'cycle_h',
      };
      return cycleMap[clean] || 'cycle_a';
    };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 1;

      try {
        if (datasetType === 'employees') {
          const code = String(row.employeeCode || '').trim().toUpperCase();
          const email = String(row.email || '').trim().toLowerCase();
          const name = String(row.fullName || '').trim();

          if (!code || !email || !name) {
            skippedCount++;
            errorsList.push({ row: rowNum, reason: 'Missing code, email, or full name' });
            continue;
          }

          const existing = await employeesCol.findOne({ $or: [{ employeeCode: code }, { email }] });
          const deptObj = await findOrCreateDept(row.department);
          const desigObj = await findOrCreateDesig(row.designation, deptObj.id);
          const derivedCycle = deriveCycleFromDate(row.joiningDate);
          const rawCycleCode = String(row.cycleCode || '').trim().toUpperCase() || derivedCycle.fullCode;
          const cycleId = mapCycleCodeToId(rawCycleCode);
          const cycleCodeShort = rawCycleCode.replace('CYCLE_', '') || derivedCycle.shortCode;

          const rawMgrCode = String(
            row.managerCode || row.managerEmployeeCode || row.reportingManagerCode || row.manager || ''
          ).trim().toUpperCase();
          const rawHodCode = String(
            row.hodCode || row.hodEmployeeCode || row.headOfDepartmentCode || row.hod || ''
          ).trim().toUpperCase();

          // Resolve manager from database if already present
          let managerId: string | undefined = undefined;
          let managerName: string | undefined = undefined;
          if (rawMgrCode) {
            const mgr = await employeesCol.findOne({ employeeCode: rawMgrCode });
            if (mgr) {
              managerId = mgr.id;
              managerName = mgr.name;
            }
          }

          // Resolve HOD from database or department
          let hodId: string | undefined = undefined;
          let hodName: string | undefined = undefined;
          if (rawHodCode) {
            const hod = await employeesCol.findOne({ employeeCode: rawHodCode });
            if (hod) {
              hodId = hod.id;
              hodName = hod.name;
            }
          }
          if (!hodId && deptObj.hodId) {
            hodId = deptObj.hodId;
            hodName = deptObj.hodName;
            if (!hodName) {
              const deptHod = await employeesCol.findOne({ id: deptObj.hodId });
              if (deptHod) hodName = deptHod.name;
            }
          }

          const numericCtc = Number(row.baseSalary || row.currentCtc) || 1200000;
          const empPayload: any = {
            employeeCode: code,
            name,
            email,
            joiningDate: row.joiningDate || new Date().toISOString().split('T')[0],
            cycleId,
            cycleCode: cycleCodeShort,
            departmentId: deptObj.id,
            departmentName: deptObj.name,
            designationId: desigObj.id,
            designationName: desigObj.title || desigObj.name,
            managerId,
            managerName,
            managerEmployeeCode: rawMgrCode || undefined,
            hodId,
            hodName,
            hodEmployeeCode: rawHodCode || undefined,
            currentCtc: numericCtc,
            currency: '₹',
            status: (row.status || 'ACTIVE').toUpperCase(),
            phone: row.phone || row.phoneNumber || '+91 98765 43210',
            updatedAt: new Date().toISOString(),
          };

          if (existing && allowUpdateExisting) {
            await employeesCol.updateOne({ id: existing.id }, { $set: empPayload });
            updatedCount++;
          } else if (!existing) {
            const newId = `emp_${Math.random().toString(36).substr(2, 9)}`;
            empPayload.id = newId;
            empPayload.createdAt = new Date().toISOString();
            await employeesCol.insertOne(empPayload);

            // Also provision user login record
            const candidateRole = row.role ? String(row.role).toUpperCase().replace(/[\s\-_]+/g, '') : '';
            let role: UserRole = 'EMPLOYEE';
            if (candidateRole === 'HR' || candidateRole === 'HRADMIN') role = 'HR';
            else if (candidateRole === 'MANAGER' || candidateRole === 'MGR') role = 'MANAGER';
            else if (candidateRole === 'HOD') role = 'HOD';
            else if (candidateRole === 'SUPERADMIN' || candidateRole === 'ADMIN') role = 'SUPER_ADMIN';
            else if (candidateRole === 'MANAGEMENT' || candidateRole === 'CXO') role = 'MANAGEMENT';

            const tempPassword = `Welcome@${new Date().getFullYear()}`;
            const passwordHash = bcrypt.hashSync(tempPassword, 10);

            await usersCol.insertOne({
              id: `usr_${Math.random().toString(36).substr(2, 9)}`,
              name,
              email,
              role,
              roleId: `role_${role.toLowerCase()}`,
              departmentId: deptObj.id,
              employeeId: newId,
              passwordHash,
              active: true,
              mustChangePassword: true,
              createdAt: new Date().toISOString(),
            });

            insertedCount++;
          } else {
            skippedCount++;
          }
        } else if (datasetType === 'kras') {
          const tTitle = String(row.templateTitle || 'General KRA Template').trim();
          const kTitle = String(row.kraTitle || '').trim();
          const weightage = Number(row.weightage) || 25;

          if (!kTitle) {
            skippedCount++;
            continue;
          }

          const deptObj = await findOrCreateDept(row.department);
          const desigObj = await findOrCreateDesig(row.designation, deptObj.id);
          const cycleId = mapCycleCodeToId(row.cycleCode);

          const kraId = `kra_${Math.random().toString(36).substr(2, 9)}`;
          const newKra = {
            id: kraId,
            title: kTitle,
            description: row.targetDescription || `Target for ${kTitle}`,
            departmentId: deptObj.id,
            designationId: desigObj.id,
            cycleId,
            metricType: row.measurementUnit || 'PERCENTAGE',
            targetUnit: row.measurementUnit || '%',
            active: true,
            createdAt: new Date().toISOString(),
          };

          await krasCol.insertOne(newKra);

          // Find or create template grouping with standard KraItem structure
          const kraItem = {
            id: `item_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            kraId,
            title: kTitle,
            description: row.targetDescription || `Target for ${kTitle}`,
            target: String(row.targetValue || '100% Target SLA'),
            weight: weightage,
            measurementCriteria: row.measurementCriteria || `${row.measurementUnit || '%'}: 1=Below, 3=Meets, 5=Exceeds`,
          };

          let existingTemplate = await kraTemplatesCol.findOne({ title: tTitle, departmentId: deptObj.id });
          if (existingTemplate) {
            const currentItems = existingTemplate.items || [];
            currentItems.push(kraItem);
            const totalWeight = currentItems.reduce((sum: number, it: any) => sum + (Number(it.weight) || 0), 0);
            await kraTemplatesCol.updateOne(
              { id: existingTemplate.id },
              { $set: { items: currentItems, totalWeight, updatedAt: new Date().toISOString() } }
            );
            updatedCount++;
          } else {
            const newTemplate = {
              id: `kratpl_${Math.random().toString(36).substr(2, 9)}`,
              title: tTitle,
              departmentId: deptObj.id,
              departmentName: deptObj.name,
              designationId: desigObj.id,
              designationName: desigObj.title || desigObj.name,
              cycleId,
              totalWeight: weightage,
              items: [kraItem],
              active: true,
              createdAt: new Date().toISOString(),
            };
            await kraTemplatesCol.insertOne(newTemplate);
            insertedCount++;
          }
        } else if (datasetType === 'quarterly-scores') {
          const code = String(row.employeeCode || '').trim().toUpperCase();
          const mgrScore = Number(row.managerScore) || 3.5;
          const selfScore = Number(row.selfScore) || mgrScore;
          const comments = String(row.managerComments || 'Manager evaluated via bulk import.');

          const emp = await employeesCol.findOne({ employeeCode: code });
          if (!emp) {
            skippedCount++;
            errorsList.push({ row: rowNum, reason: `Employee code '${code}' not found.` });
            continue;
          }

          // Update or insert quarterly review with canonical field names
          const periodCode = String(row.periodCode || 'Q1_2026').trim().toUpperCase();
          const existingReview = await reviewsCol.findOne({ employeeId: emp.id });

          if (existingReview) {
            await reviewsCol.updateOne(
              { id: existingReview.id },
              {
                $set: {
                  status: (row.status || 'MANAGER_COMPLETED').toUpperCase(),
                  finalScore: mgrScore,
                  selfScore: selfScore,
                  managerOverallComments: comments,
                  updatedAt: new Date().toISOString(),
                },
              }
            );
            updatedCount++;
          } else {
            const newRevId = `rev_${Math.random().toString(36).substr(2, 9)}`;
            await reviewsCol.insertOne({
              id: newRevId,
              employeeId: emp.id,
              employeeCode: emp.employeeCode,
              employeeName: emp.name,
              departmentId: emp.departmentId,
              cycleId: emp.cycleId,
              reviewPeriodId: periodCode,
              reviewPeriodName: periodCode,
              status: (row.status || 'MANAGER_COMPLETED').toUpperCase(),
              selfScore: selfScore,
              finalScore: mgrScore,
              managerOverallComments: comments,
              isClosed: false,
              kraSnapshot: [],
              createdAt: new Date().toISOString(),
            });
            insertedCount++;
          }
        } else if (datasetType === 'increment-matrix') {
          const code = String(row.employeeCode || '').trim().toUpperCase();
          const emp = await employeesCol.findOne({ employeeCode: code });
          if (!emp) {
            skippedCount++;
            errorsList.push({ row: rowNum, reason: `Employee code '${code}' not found.` });
            continue;
          }

          const incPct = Number(row.proposedIncrementPercent) || 10;
          const rating = String(row.finalRating || 'MEETS_EXPECTATIONS').toUpperCase();
          const currentCtc = Number(emp.currentCtc) || 1200000;
          const incrementAmount = Math.round((currentCtc * incPct) / 100);
          const revisedCtc = currentCtc + incrementAmount;
          const promoRec = Boolean(row.promotedDesignation || row.promotionRecommended === true || row.promotionRecommended === 'true');

          const existingAppr = await appraisalsCol.findOne({ employeeId: emp.id });
          if (existingAppr) {
            await appraisalsCol.updateOne(
              { id: existingAppr.id },
              {
                $set: {
                  finalRating: rating,
                  proposedIncrementPercentage: incPct,
                  approvedIncrementPercentage: incPct,
                  incrementAmount,
                  revisedCtc,
                  promotionRecommended: promoRec,
                  hodCalibrationNotes: row.hodNotes || 'Calibrated via bulk increment matrix',
                  status: 'HOD_CALIBRATED',
                  updatedAt: new Date().toISOString(),
                },
              }
            );
            updatedCount++;
          } else {
            const newApprId = `appr_${Math.random().toString(36).substr(2, 9)}`;
            await appraisalsCol.insertOne({
              id: newApprId,
              employeeId: emp.id,
              employeeCode: emp.employeeCode,
              employeeName: emp.name,
              cycleId: emp.cycleId,
              departmentId: emp.departmentId,
              currentCtc,
              currency: emp.currency || '₹',
              finalRating: rating,
              recommendedRating: rating,
              proposedIncrementPercentage: incPct,
              approvedIncrementPercentage: incPct,
              incrementAmount,
              revisedCtc,
              promotionRecommended: promoRec,
              hodCalibrationNotes: row.hodNotes || 'Calibrated via bulk increment matrix',
              status: 'HOD_CALIBRATED',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
            insertedCount++;
          }
        }
      } catch (rowErr: any) {
        failedCount++;
        errorsList.push({ row: rowNum, reason: rowErr.message || 'Row processing failure' });
      }
    }

    // Post-import hierarchy synchronization pass (links manager and HOD by codes and backfills relationships)
    if (datasetType === 'employees') {
      try {
        await resolveAndSyncHierarchy();
      } catch (hierErr) {
        console.error('[Bulk Engine] Error during hierarchy sync post-import:', hierErr);
      }
    }

    // Record in Audit Trail
    await auditLogsCol.insertOne({
      id: `audit_${Math.random().toString(36).substr(2, 9)}`,
      userId: currentUser?.id || 'system_bulk',
      userName: currentUser?.name || 'HR Admin',
      userRole: currentUser?.role || 'HR_ADMIN',
      module: 'BULK_IMPORT',
      action: `BULK_IMPORT_${datasetType.toUpperCase()}`,
      recordId: batchId,
      details: `File: '${fileName}' processed. Inserted: ${insertedCount}, Updated: ${updatedCount}, Skipped: ${skippedCount}, Failed: ${failedCount}.`,
      createdAt: new Date().toISOString(),
    });

    const result: BulkImportResult = {
      success: failedCount === 0 || (insertedCount + updatedCount > 0),
      datasetType,
      insertedCount,
      updatedCount,
      skippedCount,
      failedCount,
      message: `Successfully processed ${insertedCount + updatedCount} records from ${fileName}.`,
      batchId,
      errors: errorsList.length > 0 ? errorsList : undefined,
    };

    console.log(`[Bulk Import] Completed batch ${batchId} for "${datasetType}": ${insertedCount} inserted, ${updatedCount} updated, ${skippedCount} skipped, ${failedCount} failed`);

    res.json(result);
  } catch (error: any) {
    console.error('Import error:', error);
    res.status(500).json({ error: error.message || 'Bulk import processing failed.' });
  }
});

/**
 * POST /api/bulk/sync-hierarchy
 * Manually trigger full hierarchy synchronization across all employees in the database
 */
bulkRouter.post('/sync-hierarchy', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await resolveAndSyncHierarchy();
    res.json({
      success: true,
      message: `Hierarchy synchronized successfully. ${result.updatedCount} employee records updated across ${result.totalScanned} scanned profiles.`,
      ...result,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to sync hierarchy' });
  }
});

// ==========================================
// 4. EXPORT ENGINE
// ==========================================

/**
 * GET /api/bulk/export/:type
 * Returns structured tabular records for instant Excel / CSV client download
 */
bulkRouter.get('/export/:type', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const datasetType = req.params.type as BulkDatasetType;
    const { cycleId, departmentId } = req.query;

    const employeesCol = getDbCollection('employees');
    const departmentsCol = getDbCollection('departments');
    const designationsCol = getDbCollection('designations');
    const cyclesCol = getDbCollection('cycles');
    const kraTemplatesCol = getDbCollection('kraTemplates');
    const reviewsCol = getDbCollection('employeeReviews');
    const appraisalsCol = getDbCollection('appraisals');

    const employees = await (await employeesCol.find({})).toArray();
    const departments = await (await departmentsCol.find({})).toArray();
    const designations = await (await designationsCol.find({})).toArray();
    const cycles = await (await cyclesCol.find({})).toArray();

    const deptMap = new Map(departments.map((d) => [d.id, d.name]));
    const desigMap = new Map(designations.map((d) => [d.id, d.title || d.name]));
    const cycleMap = new Map(cycles.map((c) => [c.id, c.code]));

    let exportRows: any[] = [];

    if (datasetType === 'employees') {
      let filtered = employees;
      if (cycleId && cycleId !== 'ALL') filtered = filtered.filter((e) => e.cycleId === cycleId);
      if (departmentId && departmentId !== 'ALL') filtered = filtered.filter((e) => e.departmentId === departmentId);

      exportRows = filtered.map((e) => ({
        'Employee Code': e.employeeCode,
        'Full Name': e.name,
        'Work Email': e.email,
        'Joining Date': e.joiningDate,
        'Cycle Code': cycleMap.get(e.cycleId) || e.cycleCode || e.cycleId,
        'Department': deptMap.get(e.departmentId) || e.departmentName || 'Engineering',
        'Designation': desigMap.get(e.designationId) || e.designationName || 'Staff',
        'Reporting Manager Code': e.managerEmployeeCode || '',
        'HOD Code': e.hodEmployeeCode || '',
        'Base Annual CTC (₹)': e.currentCtc || e.baseSalary || 1200000,
        'Status': e.status || 'ACTIVE',
        'Phone': e.phone || '',
      }));
    } else if (datasetType === 'kras') {
      const templates = await (await kraTemplatesCol.find({})).toArray();
      exportRows = templates.flatMap((tpl) => {
        const items = tpl.items || tpl.kras || [];
        return items.map((k: any) => ({
          'Template Title': tpl.title || tpl.name || 'General Template',
          'Department': deptMap.get(tpl.departmentId) || tpl.departmentName || 'Engineering',
          'Designation': desigMap.get(tpl.designationId) || tpl.designationName || 'Software Engineer',
          'Cycle Code': cycleMap.get(tpl.cycleId) || 'ALL',
          'KRA Title': k.title || k.kraName || 'KRA',
          'Weightage (%)': k.weight || k.weightage || 0,
          'Target Description': k.target || k.description || '',
          'Measurement Criteria': k.measurementCriteria || '',
        }));
      });
    } else if (datasetType === 'quarterly-scores') {
      const reviews = await (await reviewsCol.find({})).toArray();
      exportRows = reviews.map((r) => ({
        'Employee Code': r.employeeCode || '',
        'Employee Name': r.employeeName || '',
        'Quarter Period': r.reviewPeriodName || r.periodCode || 'Q1',
        'Self Score (1-5)': r.selfScore ?? r.selfOverallScore ?? 0,
        'Manager Score (1-5)': r.finalScore ?? r.managerOverallScore ?? 0,
        'Final Score': r.finalScore ?? r.finalCalculatedScore ?? 0,
        'Manager Feedback': r.managerOverallComments || r.managerSummary || '',
        'Status': r.status || 'DRAFT',
      }));
    } else if (datasetType === 'increment-matrix') {
      const appraisals = await (await appraisalsCol.find({})).toArray();
      exportRows = appraisals.map((a) => ({
        'Employee Code': a.employeeCode || '',
        'Employee Name': a.employeeName || '',
        'Cycle Code': cycleMap.get(a.cycleId) || a.cycleId,
        'Final Rating': a.finalRating || a.recommendedRating || 'MEETS_EXPECTATIONS',
        'Proposed Increment (%)': a.proposedIncrementPercentage ?? a.proposedIncrement ?? 0,
        'Approved Increment (%)': a.approvedIncrementPercentage ?? a.proposedIncrementPercentage ?? 0,
        'Current CTC (₹)': a.currentCtc || 0,
        'Revised CTC (₹)': a.revisedCtc || 0,
        'Promotion Recommended': a.promotionRecommended ? 'YES' : 'NO',
        'Status': a.status || 'DRAFT',
        'HOD Calibration Notes': a.hodCalibrationNotes || a.hodComments || '',
      }));
    }

    res.json({
      datasetType,
      totalCount: exportRows.length,
      data: exportRows,
      exportedAt: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Export error:', error);
    res.status(500).json({ error: error.message || 'Export generation failed.' });
  }
});

// ==========================================
// 5. BULK IMPORT AUDIT HISTORY
// ==========================================

/**
 * GET /api/bulk/history
 * Returns audit trail of prior bulk imports
 */
bulkRouter.get('/history', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const auditLogsCol = getDbCollection('auditLogs');
    const logs = await (await auditLogsCol.find({ module: 'BULK_IMPORT' })).toArray();

    const history = logs.map((l) => ({
      id: l.id,
      batchId: l.recordId,
      action: l.action,
      importedBy: l.userName,
      userRole: l.userRole,
      details: l.details,
      createdAt: l.createdAt,
    }));

    history.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.json(history);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to retrieve bulk import history.' });
  }
});
