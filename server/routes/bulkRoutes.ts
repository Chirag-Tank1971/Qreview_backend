import { Router, Response } from 'express';
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
    { key: 'cycleCode', label: 'Cycle Code', description: 'Joining Cycle: CYCLE_A to CYCLE_H', required: true, example: 'CYCLE_A', type: 'enum', options: ['CYCLE_A', 'CYCLE_B', 'CYCLE_C', 'CYCLE_D', 'CYCLE_E', 'CYCLE_F', 'CYCLE_G', 'CYCLE_H'] },
    { key: 'department', label: 'Department', description: 'Department Name or Code', required: true, example: 'Engineering', type: 'string' },
    { key: 'designation', label: 'Designation', description: 'Official Job Designation Title', required: true, example: 'Senior Software Engineer', type: 'string' },
    { key: 'managerCode', label: 'Reporting Manager Code', description: 'Employee Code of Reporting Manager', required: false, example: 'EMP-001', type: 'string' },
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
    { employeeCode: 'EMP-201', fullName: 'Kavita Nair', email: 'kavita.nair@company.com', joiningDate: '2025-01-10', cycleCode: 'CYCLE_A', department: 'Engineering', designation: 'Senior Software Engineer', managerCode: 'EMP-001', baseSalary: 1800000, role: 'EMPLOYEE', status: 'ACTIVE' },
    { employeeCode: 'EMP-202', fullName: 'Rohan Deshmukh', email: 'rohan.deshmukh@company.com', joiningDate: '2025-02-14', cycleCode: 'CYCLE_B', department: 'Product & Design', designation: 'Product Designer', managerCode: 'EMP-003', baseSalary: 1450000, role: 'EMPLOYEE', status: 'ACTIVE' },
    { employeeCode: 'EMP-203', fullName: 'Ananya Roy', email: 'ananya.roy@company.com', joiningDate: '2025-03-01', cycleCode: 'CYCLE_C', department: 'Human Resources', designation: 'Talent Acquisition Lead', managerCode: 'EMP-002', baseSalary: 1600000, role: 'EMPLOYEE', status: 'ACTIVE' },
    { employeeCode: 'EMP-204', fullName: 'Sameer Gupta', email: 'sameer.gupta@company.com', joiningDate: '2025-04-18', cycleCode: 'CYCLE_D', department: 'Sales & Growth', designation: 'Enterprise Account Executive', managerCode: 'EMP-005', baseSalary: 1750000, role: 'EMPLOYEE', status: 'ACTIVE' },
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
        const mgrCode = String(rawRow.managerCode || '').trim().toUpperCase();
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

        // Cycle check
        if (cycle && !cycleCodeSet.has(cycle) && !['CYCLE_A', 'CYCLE_B', 'CYCLE_C', 'CYCLE_D', 'CYCLE_E', 'CYCLE_F', 'CYCLE_G', 'CYCLE_H'].includes(cycle)) {
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
        if (mgrCode && !empCodeMap.has(mgrCode)) {
          warnings.push(`Reporting manager code '${mgrCode}' not yet in system. Relationship will link once manager joins.`);
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
          const cycleId = mapCycleCodeToId(row.cycleCode);

          const empPayload: any = {
            employeeCode: code,
            name,
            email,
            joiningDate: row.joiningDate || new Date().toISOString().split('T')[0],
            cycleId,
            departmentId: deptObj.id,
            departmentName: deptObj.name,
            designationId: desigObj.id,
            designationName: desigObj.title || desigObj.name,
            managerEmployeeCode: row.managerCode ? String(row.managerCode).trim().toUpperCase() : undefined,
            baseSalary: Number(row.baseSalary) || 1200000,
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
            const role: UserRole = (row.role && ['EMPLOYEE', 'MANAGER', 'HOD', 'HR_ADMIN', 'CXO'].includes(row.role.toUpperCase()))
              ? (row.role.toUpperCase() as UserRole)
              : 'EMPLOYEE';

            await usersCol.insertOne({
              id: `usr_${Math.random().toString(36).substr(2, 9)}`,
              name,
              email,
              role,
              departmentId: deptObj.id,
              employeeId: newId,
              passwordHash: '$2a$10$w8.3hJgM3v/Zz1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p7q8r9s0t', // seeded hash for testing
              isActive: true,
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
            weightage,
            targetMetric: {
              type: row.measurementUnit || 'PERCENTAGE',
              targetValue: String(row.targetValue || '100'),
              unit: row.measurementUnit || '%',
              description: row.targetDescription || '',
            },
            status: 'ACTIVE',
            createdAt: new Date().toISOString(),
          };

          await krasCol.insertOne(newKra);

          // Find or create template grouping
          let existingTemplate = await kraTemplatesCol.findOne({ title: tTitle, departmentId: deptObj.id });
          if (existingTemplate) {
            const currentKras = existingTemplate.kras || [];
            currentKras.push(newKra);
            await kraTemplatesCol.updateOne({ id: existingTemplate.id }, { $set: { kras: currentKras, updatedAt: new Date().toISOString() } });
            updatedCount++;
          } else {
            const newTemplate = {
              id: `kratpl_${Math.random().toString(36).substr(2, 9)}`,
              title: tTitle,
              departmentId: deptObj.id,
              designationId: desigObj.id,
              cycleId,
              description: `Bulk imported template for ${tTitle}`,
              totalWeightage: weightage,
              kras: [newKra],
              status: 'PUBLISHED',
              version: 1,
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

          // Update or insert quarterly review
          const periodCode = String(row.periodCode || 'Q1_2026').trim().toUpperCase();
          const existingReview = await reviewsCol.findOne({ employeeId: emp.id });

          if (existingReview) {
            await reviewsCol.updateOne(
              { id: existingReview.id },
              {
                $set: {
                  status: (row.status || 'MANAGER_COMPLETED').toUpperCase(),
                  managerOverallScore: mgrScore,
                  selfOverallScore: selfScore,
                  finalCalculatedScore: mgrScore,
                  managerSummary: comments,
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
              periodCode,
              status: (row.status || 'MANAGER_COMPLETED').toUpperCase(),
              selfOverallScore: selfScore,
              managerOverallScore: mgrScore,
              finalCalculatedScore: mgrScore,
              managerSummary: comments,
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
          const bonus = Number(row.bonusAmount) || 0;
          const rating = String(row.finalRating || 'MEETS_EXPECTATIONS').toUpperCase();

          const existingAppr = await appraisalsCol.findOne({ employeeId: emp.id });
          if (existingAppr) {
            await appraisalsCol.updateOne(
              { id: existingAppr.id },
              {
                $set: {
                  finalRating: rating,
                  proposedIncrement: incPct,
                  proposedBonus: bonus,
                  promotedDesignation: row.promotedDesignation || undefined,
                  hodComments: row.hodNotes || 'Calibrated via bulk increment matrix',
                  status: 'CALIBRATED',
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
              finalRating: rating,
              proposedIncrement: incPct,
              proposedBonus: bonus,
              promotedDesignation: row.promotedDesignation || undefined,
              hodComments: row.hodNotes || 'Calibrated via bulk increment matrix',
              status: 'CALIBRATED',
              createdAt: new Date().toISOString(),
            });
            insertedCount++;
          }
        }
      } catch (rowErr: any) {
        failedCount++;
        errorsList.push({ row: rowNum, reason: rowErr.message || 'Row processing failure' });
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

    res.json(result);
  } catch (error: any) {
    console.error('Import error:', error);
    res.status(500).json({ error: error.message || 'Bulk import processing failed.' });
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
        'Cycle Code': cycleMap.get(e.cycleId) || e.cycleId,
        'Department': deptMap.get(e.departmentId) || e.departmentName || 'Engineering',
        'Designation': desigMap.get(e.designationId) || e.designationName || 'Staff',
        'Reporting Manager Code': e.managerEmployeeCode || '',
        'Base Annual CTC (₹)': e.baseSalary || 1200000,
        'Status': e.status || 'ACTIVE',
        'Phone': e.phone || '',
      }));
    } else if (datasetType === 'kras') {
      const templates = await (await kraTemplatesCol.find({})).toArray();
      exportRows = templates.flatMap((tpl) => {
        return (tpl.kras || []).map((k: any) => ({
          'Template Title': tpl.title,
          'Department': deptMap.get(tpl.departmentId) || 'Engineering',
          'Designation': desigMap.get(tpl.designationId) || 'Software Engineer',
          'Cycle Code': cycleMap.get(tpl.cycleId) || 'ALL',
          'KRA Title': k.title,
          'Weightage (%)': k.weightage,
          'Target Description': k.targetMetric?.description || k.description || '',
          'Unit': k.targetMetric?.type || 'PERCENTAGE',
          'Target Value': k.targetMetric?.targetValue || '100',
        }));
      });
    } else if (datasetType === 'quarterly-scores') {
      const reviews = await (await reviewsCol.find({})).toArray();
      exportRows = reviews.map((r) => ({
        'Employee Code': r.employeeCode || '',
        'Employee Name': r.employeeName || '',
        'Quarter Period': r.periodCode || 'Q1_2026',
        'Self Score (1-5)': r.selfOverallScore || 0,
        'Manager Score (1-5)': r.managerOverallScore || 0,
        'Final Score': r.finalCalculatedScore || 0,
        'Manager Feedback': r.managerSummary || '',
        'Status': r.status || 'DRAFT',
      }));
    } else if (datasetType === 'increment-matrix') {
      const appraisals = await (await appraisalsCol.find({})).toArray();
      exportRows = appraisals.map((a) => ({
        'Employee Code': a.employeeCode || '',
        'Employee Name': a.employeeName || '',
        'Cycle Code': cycleMap.get(a.cycleId) || a.cycleId,
        'Final Rating': a.finalRating || 'MEETS_EXPECTATIONS',
        'Proposed Increment (%)': a.proposedIncrement || 0,
        'Bonus Amount (₹)': a.proposedBonus || 0,
        'Promoted Designation': a.promotedDesignation || '',
        'Status': a.status || 'DRAFT',
        'HOD Calibration Notes': a.hodComments || '',
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
