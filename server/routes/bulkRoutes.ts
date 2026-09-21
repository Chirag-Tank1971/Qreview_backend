import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import { getDbCollection } from '../db.js';
import { AuthenticatedRequest, authenticateToken, requireRoles } from '../auth.js';
import { resyncUnscoredReviewKraSnapshots, syncEmployeeAppraisalsAndReviews } from '../syncHelpers.js';
import {
  BulkDatasetType,
  BulkTemplateColumn,
  BulkValidationReport,
  BulkValidationRowResult,
  BulkImportResult,
  UserRole,
} from '../../src/types/index.js';

export const bulkRouter = Router();

// Apply auth to all bulk endpoints - Bulk operations strictly restricted to Super Admin and HR
bulkRouter.use(authenticateToken);
bulkRouter.use(requireRoles('SUPER_ADMIN', 'HR'));

// ==========================================
// 1. TEMPLATE SCHEMAS & SAMPLE DATA
// ==========================================

const TEMPLATE_COLUMNS: Record<BulkDatasetType, BulkTemplateColumn[]> = {
  employees: [
    { key: 'employeeCode', label: 'Employee Code', description: 'Unique internal ID (e.g. MS0001 or MS1445)', required: true, example: 'MS0001', type: 'string' },
    { key: 'fullName', label: 'Full Name', description: 'Employee First and Last Name', required: true, example: 'Aarav Sharma', type: 'string' },
    { key: 'email', label: 'Work Email', description: 'Unique corporate email address', required: true, example: 'aarav.sharma@company.com', type: 'string' },
    { key: 'joiningDate', label: 'Joining Date', description: 'Date of joining (YYYY-MM-DD)', required: true, example: '2025-01-15', type: 'date' },
    { key: 'confirmationDate', label: 'Confirmation Date', description: 'Date of permanent confirmation (YYYY-MM-DD)', required: false, example: '2025-05-15', type: 'date' },
    { key: 'gender', label: 'Gender', description: 'Gender identity', required: false, example: 'Male', type: 'enum', options: ['Male', 'Female', 'Other'] },
    { key: 'employmentType', label: 'Employment Type', description: 'Permanent, Contract, or Intern', required: false, example: 'Permanent', type: 'string' },
    { key: 'cycleCode', label: 'Cycle Code', description: 'Appraisal Cycle: CYCLE_JUN or CYCLE_SEP (optional - auto-derived from Joining Date if omitted)', required: false, example: 'CYCLE_JUN', type: 'enum', options: ['CYCLE_JUN', 'CYCLE_SEP'] },
    { key: 'department', label: 'Department', description: 'Department Name or Code', required: true, example: 'Engineering', type: 'string' },
    { key: 'designation', label: 'Designation', description: 'Official Job Designation Title', required: true, example: 'Senior Software Engineer', type: 'string' },
    { key: 'managerCode', label: 'Reporting Manager Code', description: 'Employee Code or Name of Reporting Manager (e.g. MS0001 or MS0034)', required: false, example: 'MS0001', type: 'string' },
    { key: 'hodCode', label: 'HOD Code', description: 'Employee Code or Name of Head of Department (e.g. MS0016)', required: false, example: 'MS0016', type: 'string' },
    { key: 'probationPeriodDays', label: 'Probation Period In Days', description: 'Probation period in days', required: false, example: '120', type: 'number' },
    { key: 'companyName', label: 'Company', description: 'Company or Legal Entity Name', required: false, example: 'M INTERGRAPH SYSTEMS PRIVATE LIMITED', type: 'string' },
    { key: 'location', label: 'Location', description: 'Work office location / city', required: false, example: 'Delhi', type: 'string' },
    { key: 'baseSalary', label: 'Base Annual CTC (₹)', description: 'Current Annual CTC figure in INR', required: true, example: '1850000', type: 'number' },
    { key: 'role', label: 'System Role', description: 'Access Role in PMS', required: true, example: 'EMPLOYEE', type: 'enum', options: ['EMPLOYEE', 'MANAGER', 'HOD', 'HR_ADMIN', 'CXO'] },
    { key: 'status', label: 'Employment Status', description: 'Active or probation', required: false, example: 'ACTIVE', type: 'enum', options: ['ACTIVE', 'PROBATION', 'NOTICE'] },
  ],
  kras: [
    { key: 'employeeCode', label: 'Employee Code', description: 'Target Employee Code (e.g. MS1184 or MS0038). Optional - leave blank for general library template.', required: false, example: 'MS1184', type: 'string' },
    { key: 'employeeName', label: 'Employee Name', description: 'Employee Full Name (optional)', required: false, example: 'Akshay Tyagi', type: 'string' },
    { key: 'templateTitle', label: 'Template Title', description: 'Scorecard Name / Template Group', required: false, example: 'Akshay Tyagi - 2026 KRAs', type: 'string' },
    { key: 'department', label: 'Department', description: 'Target Department (optional if Employee Code given)', required: false, example: 'Engineering', type: 'string' },
    { key: 'designation', label: 'Designation', description: 'Applicable Designation Title (optional if Employee Code given)', required: false, example: 'Senior Software Engineer', type: 'string' },
    { key: 'cycleCode', label: 'Cycle Code', description: 'Cycle: CYCLE_JUN, CYCLE_SEP, or ALL', required: false, example: 'CYCLE_JUN', type: 'enum', options: ['ALL', 'CYCLE_JUN', 'CYCLE_SEP'] },
    { key: 'kraTitle', label: 'KRA Title', description: 'Specific Key Result Area name', required: true, example: 'System Architecture & Scalability', type: 'string' },
    { key: 'weightage', label: 'Weightage (%)', description: 'KRA weight (sum of all KRAs for employee/template = 100)', required: true, example: '30', type: 'number' },
    { key: 'targetDescription', label: 'Target / Description', description: 'Measurable metric goal description or SLA', required: true, example: 'Deliver zero-downtime microservice migration', type: 'string' },
    { key: 'measurementUnit', label: 'Unit', description: 'Measurement unit type', required: false, example: 'PERCENTAGE', type: 'enum', options: ['PERCENTAGE', 'NUMERIC', 'RATING', 'CURRENCY', 'MILESTONE'] },
    { key: 'targetValue', label: 'Target Value', description: 'Benchmark target number/text', required: false, example: '99.95', type: 'string' },
  ],
};

const SAMPLE_DATA: Record<BulkDatasetType, any[]> = {
  employees: [
    { employeeCode: 'EMP-201', fullName: 'Kavita Nair', email: 'kavita.nair@company.com', joiningDate: '2025-01-10', cycleCode: 'CYCLE_JUN', department: 'Engineering', designation: 'Senior Software Engineer', managerCode: 'EMP-004', hodCode: 'EMP-001', baseSalary: 1800000, role: 'EMPLOYEE', status: 'ACTIVE' },
    { employeeCode: 'EMP-202', fullName: 'Rohan Deshmukh', email: 'rohan.deshmukh@company.com', joiningDate: '2025-02-14', cycleCode: 'CYCLE_SEP', department: 'Product & Design', designation: 'Product Designer', managerCode: 'EMP-001', hodCode: 'EMP-001', baseSalary: 1450000, role: 'EMPLOYEE', status: 'ACTIVE' },
    { employeeCode: 'EMP-203', fullName: 'Ananya Roy', email: 'ananya.roy@company.com', joiningDate: '2025-03-01', cycleCode: 'CYCLE_JUN', department: 'Human Resources', designation: 'Talent Acquisition Lead', managerCode: 'EMP-006', hodCode: 'EMP-003', baseSalary: 1600000, role: 'EMPLOYEE', status: 'ACTIVE' },
    { employeeCode: 'EMP-204', fullName: 'Sameer Gupta', email: 'sameer.gupta@company.com', joiningDate: '2025-04-18', cycleCode: 'CYCLE_SEP', department: 'Sales & Growth', designation: 'Enterprise Account Executive', managerCode: 'EMP-005', hodCode: 'EMP-002', baseSalary: 1750000, role: 'EMPLOYEE', status: 'ACTIVE' },
  ],
  kras: [
    { employeeCode: 'MS1184', employeeName: 'Akshay Tyagi', department: 'Service', designation: 'Field Engineer', cycleCode: 'CYCLE_JUN', kraTitle: 'Ownership of breakdown calls, reaching timely at customer place', weightage: 15, targetDescription: 'Prompt resolution of breakdown tickets within SLA', measurementUnit: 'PERCENTAGE', targetValue: '100' },
    { employeeCode: 'MS1184', employeeName: 'Akshay Tyagi', department: 'Service', designation: 'Field Engineer', cycleCode: 'CYCLE_JUN', kraTitle: 'Defective Spares returned to HO weekly/Claim Submission', weightage: 10, targetDescription: 'Weekly return of defective inventory and bi-weekly claim submission', measurementUnit: 'PERCENTAGE', targetValue: '100' },
    { employeeCode: 'MS1184', employeeName: 'Akshay Tyagi', department: 'Service', designation: 'Field Engineer', cycleCode: 'CYCLE_JUN', kraTitle: 'Daily attendance sharing latest by morning 10 AM', weightage: 10, targetDescription: 'Timely daily check-in by 10 AM', measurementUnit: 'PERCENTAGE', targetValue: '100' },
    { employeeCode: 'MS1184', employeeName: 'Akshay Tyagi', department: 'Service', designation: 'Field Engineer', cycleCode: 'CYCLE_JUN', kraTitle: 'Willingness to attend customer site as needed during off days', weightage: 20, targetDescription: 'Emergency client support availability', measurementUnit: 'PERCENTAGE', targetValue: '100' },
    { employeeCode: 'MS1184', employeeName: 'Akshay Tyagi', department: 'Service', designation: 'Field Engineer', cycleCode: 'CYCLE_JUN', kraTitle: 'Problem diagnosis & 1st Visit call closure ability', weightage: 15, targetDescription: 'First-time right diagnosis and swift call closure', measurementUnit: 'PERCENTAGE', targetValue: '100' },
    { employeeCode: 'MS1184', employeeName: 'Akshay Tyagi', department: 'Service', designation: 'Field Engineer', cycleCode: 'CYCLE_JUN', kraTitle: 'Improvement during the FY in technical terms', weightage: 15, targetDescription: 'Skill enhancement and technical certifications', measurementUnit: 'PERCENTAGE', targetValue: '100' },
    { employeeCode: 'MS1184', employeeName: 'Akshay Tyagi', department: 'Service', designation: 'Field Engineer', cycleCode: 'CYCLE_JUN', kraTitle: 'Customer feedback on performance', weightage: 5, targetDescription: 'Positive client CSAT feedback', measurementUnit: 'PERCENTAGE', targetValue: '100' },
    { employeeCode: 'MS1184', employeeName: 'Akshay Tyagi', department: 'Service', designation: 'Field Engineer', cycleCode: 'CYCLE_JUN', kraTitle: 'Low Consumption of Spares', weightage: 5, targetDescription: 'Optimal spare utilization', measurementUnit: 'PERCENTAGE', targetValue: '100' },
    { employeeCode: 'MS1184', employeeName: 'Akshay Tyagi', department: 'Service', designation: 'Field Engineer', cycleCode: 'CYCLE_JUN', kraTitle: 'Attitude to learn & grow/Skill Upgradation', weightage: 5, targetDescription: 'Active participation in upskilling programs', measurementUnit: 'PERCENTAGE', targetValue: '100' },
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

export function cleanCode(val: any): string {
  const str = String(val || '').trim();
  if (str.includes(' - ')) {
    return str.split(' - ')[0].trim().toUpperCase();
  }
  return str.toUpperCase();
}

export function parseExcelDateStr(val: any): string {
  if (!val) return '';
  if (typeof val === 'number') {
    const d = new Date(Math.round((val - 25569) * 86400 * 1000));
    return isNaN(d.getTime()) ? String(val) : d.toISOString().split('T')[0];
  }
  const str = String(val).trim();
  if (/^\d{5}$/.test(str)) {
    const num = Number(str);
    const d = new Date(Math.round((num - 25569) * 86400 * 1000));
    return isNaN(d.getTime()) ? str : d.toISOString().split('T')[0];
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    return str.split('T')[0];
  }
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().split('T')[0];
  }
  return str;
}

export function normalizeEmployeeInputRow(raw: any): any {
  if (!raw || typeof raw !== 'object') return raw;
  const row = { ...raw };

  // Employee Code
  if (!row.employeeCode) {
    row.employeeCode =
      row['Emp Code'] ||
      row['emp_code'] ||
      row['Employee Code'] ||
      row['employee_code'] ||
      row['Employee ID'] ||
      row['emp_id'] ||
      row.code ||
      '';
  }

  // Full Name
  if (!row.fullName) {
    row.fullName =
      row['Full Name'] ||
      row['full_name'] ||
      row['Employee Name'] ||
      row['employee_name'] ||
      row.name ||
      row['Name'] ||
      '';
  }

  // Email
  if (!row.email) {
    row.email =
      row['Official Email'] ||
      row['official_email'] ||
      row['Work Email'] ||
      row['work_email'] ||
      row['Email'] ||
      row['email_id'] ||
      '';
  }

  // Joining Date
  const rawJoin = row.joiningDate || row['Joining Date'] || row['joining_date'] || row.doj || '';
  if (rawJoin) {
    row.joiningDate = parseExcelDateStr(rawJoin);
  }

  // Confirmation Date
  const rawConf = row.confirmationDate || row['Confirmation Date'] || row['confirmation_date'] || row.doc || '';
  if (rawConf) {
    row.confirmationDate = parseExcelDateStr(rawConf);
  }

  // Gender
  if (!row.gender && (row['Gender'] || row['gender'])) {
    row.gender = row['Gender'] || row['gender'];
  }

  // Employment Type
  if (!row.employmentType && (row['Employment Type'] || row['employment_type'])) {
    row.employmentType = row['Employment Type'] || row['employment_type'];
  }

  // Probation Period In Days
  if (row.probationPeriodDays === undefined && (row['Probation Period In Days'] !== undefined || row['probation_period'] !== undefined)) {
    row.probationPeriodDays = row['Probation Period In Days'] ?? row['probation_period'];
  }

  // Company
  if (!row.companyName && (row['Company'] || row['company'] || row['company_name'])) {
    row.companyName = row['Company'] || row['company'] || row['company_name'];
  }

  // Location
  if (!row.location && (row['Location'] || row['location'])) {
    row.location = row['Location'] || row['location'];
  }

  // Department
  if (!row.department && (row['Department'] || row['department'])) {
    row.department = row['Department'] || row['department'];
  }

  // Designation
  if (!row.designation && (row['Designation'] || row['designation'])) {
    row.designation = row['Designation'] || row['designation'];
  }

  // Manager Code & Name
  const rawMgr =
    row.managerCode ||
    row['Reporting Manager'] ||
    row['reporting_manager'] ||
    row['Reporting Manager Code'] ||
    row.manager ||
    row.managerEmployeeCode ||
    '';
  if (rawMgr) {
    row.managerCode = cleanCode(rawMgr);
    if (String(rawMgr).includes(' - ') && !row.managerName) {
      row.managerName = String(rawMgr).split(' - ').slice(1).join(' - ').trim();
    }
  }

  // HOD Code & Name
  const rawHod =
    row.hodCode ||
    row['HOD'] ||
    row['hod'] ||
    row['HOD Code'] ||
    row['head_of_department'] ||
    row.hodEmployeeCode ||
    '';
  if (rawHod) {
    row.hodCode = cleanCode(rawHod);
    if (String(rawHod).includes(' - ') && !row.hodName) {
      row.hodName = String(rawHod).split(' - ').slice(1).join(' - ').trim();
    }
  }

  // Base Salary
  if (row.baseSalary === undefined || row.baseSalary === null || row.baseSalary === '') {
    row.baseSalary =
      row['CTC TOTAL'] ??
      row['ctc_total'] ??
      row['Base Annual CTC (₹)'] ??
      row['base_salary'] ??
      row['currentCtc'] ??
      row['ctc'] ??
      row['salary'];
  }

  // Cycle Code
  if (!row.cycleCode && (row['Cycle Code'] || row['cycle_code'])) {
    row.cycleCode = row['Cycle Code'] || row['cycle_code'];
  }

  // System Role
  if (!row.role && (row['System Role'] || row['system_role'] || row['Role'] || row['role'] || row['systemRole'] || row['accessRole'] || row['Access Role'])) {
    row.role = row['System Role'] || row['system_role'] || row['Role'] || row['role'] || row['systemRole'] || row['accessRole'] || row['Access Role'];
  }
  if (row.role) {
    row.role = String(row.role).trim();
  }

  // Employment Status
  if (!row.status && (row['Employment Status'] || row['employment_status'] || row['Status'] || row['status'])) {
    row.status = row['Employment Status'] || row['employment_status'] || row['Status'] || row['status'];
  }

  return row;
}

export function normalizeKraInputRow(raw: any): any {
  if (!raw || typeof raw !== 'object') return raw;
  const row = { ...raw };

  // Employee Code
  if (!row.employeeCode) {
    row.employeeCode =
      row['Employee Code'] ||
      row['employee_code'] ||
      row['Emp Code'] ||
      row['emp_code'] ||
      row['Emp Id'] ||
      row['emp_id'] ||
      row['Employee ID'] ||
      row['Code'] ||
      row['code'] ||
      '';
  }
  if (row.employeeCode) {
    row.employeeCode = cleanCode(row.employeeCode);
  }

  // Employee Name
  if (!row.employeeName) {
    row.employeeName =
      row['Employee Name'] ||
      row['employee_name'] ||
      row['Full Name'] ||
      row['full_name'] ||
      row['Name'] ||
      row['name'] ||
      '';
  }

  // KRA Title
  if (!row.kraTitle) {
    row.kraTitle =
      row['KRA Title'] ||
      row['kra_title'] ||
      row['KEY RESULT AREA'] ||
      row['Key Result Area'] ||
      row['key_result_area'] ||
      row['KRA'] ||
      row['kra'] ||
      row['Title'] ||
      row['title'] ||
      '';
  }

  // Weightage
  if (row.weightage === undefined || row.weightage === null || row.weightage === '') {
    row.weightage =
      row['Weightage (%)'] ??
      row['Weightage'] ??
      row['weightage'] ??
      row['WEIGHTAGE'] ??
      row['Weight (%)'] ??
      row['Weight'] ??
      row['weight'] ??
      row['Weight %'];
  }

  // Target Description / Target
  if (!row.targetDescription) {
    row.targetDescription =
      row['Target Description'] ||
      row['target_description'] ||
      row['TARGET'] ||
      row['Target'] ||
      row['target'] ||
      row['Targets'] ||
      row['Description'] ||
      row['description'] ||
      (row.kraTitle ? `Target for ${row.kraTitle}` : '');
  }

  // Target Value
  if (!row.targetValue) {
    row.targetValue =
      row['Target Value'] ||
      row['target_value'] ||
      row['Value'] ||
      row['value'] ||
      '100';
  }

  // Template Title
  if (!row.templateTitle) {
    row.templateTitle =
      row['Template Title'] ||
      row['template_title'] ||
      row['Template Name'] ||
      row['template_name'] ||
      (row.employeeName ? `${row.employeeName} - Performance Scorecard` : row.employeeCode ? `${row.employeeCode} - Performance Scorecard` : 'General KRA Template');
  }

  // Department
  if (!row.department) {
    row.department =
      row['Department'] ||
      row['department'] ||
      row['Dept'] ||
      row['dept'] ||
      '';
  }

  // Designation
  if (!row.designation) {
    row.designation =
      row['Designation'] ||
      row['designation'] ||
      row['Role'] ||
      row['role'] ||
      '';
  }

  // Cycle Code
  if (!row.cycleCode) {
    row.cycleCode =
      row['Cycle Code'] ||
      row['cycle_code'] ||
      row['Cycle'] ||
      row['cycle'] ||
      'ALL';
  }

  return row;
}

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
    const existingCycles = await (await cyclesCol.find({ active: { $ne: false } })).toArray();
    const existingUsers = await (await usersCol.find({})).toArray();

    const empCodeMap = new Set(existingEmployees.map((e) => String(e.employeeCode || '').trim().toUpperCase()));
    const empObjMap = new Map<string, any>();
    existingEmployees.forEach((e) => {
      if (e.employeeCode) empObjMap.set(String(e.employeeCode).trim().toUpperCase(), e);
    });
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

    // Pre-calculate KRA weightage sums per employee or template
    const kraWeightsByTarget = new Map<string, number>();
    if (datasetType === 'kras') {
      for (const r of rows) {
        const norm = normalizeKraInputRow(r);
        const targetKey = norm.employeeCode ? `EMP:${norm.employeeCode}` : `TPL:${norm.templateTitle || 'General'}`;
        const w = Number(norm.weightage) || 0;
        kraWeightsByTarget.set(targetKey, (kraWeightsByTarget.get(targetKey) || 0) + w);
      }
    }

    rows.forEach((rawRow: any, index: number) => {
      const rowNumber = index + 1;
      const errors: string[] = [];
      const warnings: string[] = [];
      let action: 'INSERT' | 'UPDATE' | 'SKIP' = 'INSERT';

      const row = datasetType === 'employees' ? normalizeEmployeeInputRow(rawRow) : datasetType === 'kras' ? normalizeKraInputRow(rawRow) : rawRow;

      // 1. Check Required Fields
      for (const reqKey of requiredKeys) {
        if (datasetType === 'employees' && reqKey === 'cycleCode') {
          // Handled below: can be auto-derived from joiningDate if omitted
          continue;
        }
        const val = row[reqKey];
        if (val === undefined || val === null || String(val).trim() === '') {
          errors.push(`Missing required field: '${reqKey}'`);
        }
      }

      // Dataset specific validations
      if (datasetType === 'employees') {
        const code = String(row.employeeCode || '').trim().toUpperCase();
        const email = String(row.email || '').trim().toLowerCase();
        const cycle = String(row.cycleCode || '').trim().toUpperCase();
        const dept = String(row.department || '').trim().toLowerCase();
        const desig = String(row.designation || '').trim().toLowerCase();
        const mgrCode = cleanCode(
          row.managerCode || row.managerEmployeeCode || row.reportingManagerCode || row.manager || ''
        );
        const hodCode = cleanCode(
          row.hodCode || row.hodEmployeeCode || row.headOfDepartmentCode || row.hod || ''
        );
        const salary = Number(row.baseSalary);

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

        // Cycle check — validate if present, or auto-derive from joiningDate if omitted
        if (cycle) {
          if (!cycleCodeSet.has(cycle) && !['CYCLE_JUN', 'CYCLE_SEP'].includes(cycle)) {
            errors.push(`Invalid Cycle Code '${cycle}'. Must be CYCLE_JUN or CYCLE_SEP.`);
          }
        } else {
          if (row.joiningDate) {
            const pDate = new Date(row.joiningDate);
            if (!isNaN(pDate.getTime())) {
              const m = pDate.getMonth() + 1;
              const derived = m >= 1 && m <= 7 ? 'CYCLE_JUN' : 'CYCLE_SEP';
              warnings.push(`Cycle Code was not specified; will auto-derive as ${derived} from Joining Date.`);
            } else {
              errors.push("Missing required field: 'cycleCode' (Joining Date is invalid).");
            }
          } else {
            errors.push("Missing required field: 'cycleCode' (or provide a valid Joining Date).");
          }
        }

        // Department check
        if (dept && !deptNameSet.has(dept) && !deptCodeSet.has(dept)) {
          warnings.push(`Department '${row.department}' not found in masters; will be auto-created.`);
        }

        // Designation check
        if (desig && !desigNameSet.has(desig)) {
          warnings.push(`Designation '${row.designation}' not found in masters; will be auto-created.`);
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

        // System Role check
        if (row.role) {
          const cleanRole = String(row.role).toUpperCase().replace(/[\s\-_]+/g, '');
          const validRoles = ['EMPLOYEE', 'MANAGER', 'MGR', 'HOD', 'HR', 'HRADMIN', 'CXO', 'SUPERADMIN', 'ADMIN', 'MANAGEMENT'];
          if (!validRoles.includes(cleanRole)) {
            errors.push(`Invalid System Role '${row.role}'. Allowed: EMPLOYEE, MANAGER, HOD, HR_ADMIN, CXO`);
          }
        }
      } else if (datasetType === 'kras') {
        const weightage = Number(row.weightage);
        if (isNaN(weightage) || weightage <= 0 || weightage > 100) {
          errors.push(`Weightage must be between 1 and 100. Received: '${row.weightage}'`);
        }

        const code = String(row.employeeCode || '').trim().toUpperCase();
        if (code) {
          if (!empCodeMap.has(code)) {
            // A KRA scorecard must be linked to a real employee at upload time — nothing
            // in the system retroactively links an orphan template to an employee created
            // later, so allowing this through would silently create dead, never-assigned data.
            errors.push(`Employee code '${code}' not found in database. Register the employee first, then upload their KRA scorecard.`);
          } else {
            const emp = empObjMap.get(code);
            if (emp) {
              if (!row.employeeName && emp.name) row.employeeName = emp.name;
              if (!row.department && emp.departmentName) row.department = emp.departmentName;
              if (!row.designation && emp.designationName) row.designation = emp.designationName;
              // Every employee's KRA scorecard is exclusive to them — a bulk upload must
              // never silently overwrite one that's already assigned.
              if (emp.currentKraTemplateId) {
                errors.push(
                  `Employee '${code}' already has a KRA scorecard assigned (${emp.currentKraTemplateName || emp.currentKraTemplateId}). Remove or reassign their existing scorecard before uploading a new one.`
                );
              } else {
                action = 'INSERT';
              }
            }
          }
          const targetKey = `EMP:${code}`;
          const sumWeight = kraWeightsByTarget.get(targetKey) || 0;
          if (sumWeight !== 100) {
            warnings.push(`Total KRA weightage for employee '${code}' in this upload sums to ${sumWeight}% (Recommended: 100%).`);
          }
        } else {
          const targetKey = `TPL:${row.templateTitle || 'General'}`;
          const sumWeight = kraWeightsByTarget.get(targetKey) || 0;
          if (sumWeight !== 100) {
            warnings.push(`Total KRA weightage for template '${row.templateTitle || 'General'}' in this upload sums to ${sumWeight}% (Recommended: 100%).`);
          }
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
        data: row,
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
    const allCycles = await (await cyclesCol.find({ active: { $ne: false } })).toArray();

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

    const mapCycleCodeToId = (code: string, joiningDate?: string) => {
      const clean = String(code || '').trim().toUpperCase();
      const cycleMatch = allCycles.find((c) => c.code === clean || c.id === clean);
      if (cycleMatch) return cycleMatch.id;
      // Auto-derive from joining date: Jan-Jul (1-7) -> June, Aug-Dec (8-12) -> September
      if (joiningDate) {
        const parsed = new Date(joiningDate);
        if (!isNaN(parsed.getTime())) {
          const month = parsed.getMonth() + 1;
          return month >= 1 && month <= 7 ? 'cycle_d' : 'cycle_f';
        }
      }
      return clean.includes('SEP') ? 'cycle_f' : 'cycle_d';
    };

    const initializedTemplates = new Set<string>();
    // Snapshots whether each employee already had a KRA scorecard assigned BEFORE this
    // batch started, captured once on first encounter. A multi-row scorecard upload sends
    // one row per KRA item for the same employee — rows 2..N legitimately assign the
    // employee's currentKraTemplateId from row 1, so re-querying live DB state on every
    // row would misidentify the employee's own in-progress scorecard as a pre-existing
    // conflict. Only the pre-batch snapshot may block a row.
    const preBatchKraAssignment = new Map<string, boolean>();
    // Employees whose currentKraTemplateId was (re)assigned during this batch — their
    // not-yet-scored reviews get their kraSnapshot resynced once, after the loop.
    const employeesToResyncReviews = new Set<string>();
    // A multi-row KRA upload sends several rows per employee — cache each employee lookup
    // by code so a 50-row file for 50 employees doesn't re-query the same employee document
    // once per row it already has cached from an earlier row.
    const employeeLookupCache = new Map<string, any>();
    // Mirrors, in-memory, the template document each employee's rows are accumulating into
    // this batch — avoids re-querying kraTemplatesCol on every subsequent row for the same
    // employee (rows 2..N would otherwise re-fetch a document this same batch just wrote).
    const templateStateCache = new Map<string, { id: string; title: string; items: any[] }>();

    for (let i = 0; i < rows.length; i++) {
      const rawRow = rows[i];
      const rowNum = i + 1;

      try {
        const row = datasetType === 'employees' ? normalizeEmployeeInputRow(rawRow) : datasetType === 'kras' ? normalizeKraInputRow(rawRow) : rawRow;

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
          const rawCycleCode = String(row.cycleCode || '').trim().toUpperCase();
          const cycleId = mapCycleCodeToId(rawCycleCode, row.joiningDate);
          const resolvedCycle = allCycles.find((c) => c.id === cycleId);
          const cycleCodeShort = resolvedCycle?.code || (cycleId === 'cycle_f' ? 'SEP' : 'JUN');

          const cleanMgrCode = cleanCode(
            row.managerCode || row.managerEmployeeCode || row.reportingManagerCode || row.manager || ''
          );
          const cleanHodCode = cleanCode(
            row.hodCode || row.hodEmployeeCode || row.headOfDepartmentCode || row.hod || ''
          );

          // Resolve manager from database if already present
          let managerId: string | undefined = undefined;
          let managerName: string | undefined = row.managerName || undefined;
          if (cleanMgrCode) {
            const mgr = await employeesCol.findOne({ employeeCode: cleanMgrCode });
            if (mgr) {
              managerId = mgr.id;
              managerName = mgr.name;
            }
          }

          // Resolve HOD from database or department
          let hodId: string | undefined = undefined;
          let hodName: string | undefined = row.hodName || undefined;
          if (cleanHodCode) {
            const hod = await employeesCol.findOne({ employeeCode: cleanHodCode });
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

          const rawCtc = row.baseSalary ?? row.currentCtc;
          const numericCtc = rawCtc !== undefined && rawCtc !== null && rawCtc !== '' ? Number(rawCtc) : 0;
          const empPayload: any = {
            employeeCode: code,
            name,
            email,
            joiningDate: row.joiningDate || new Date().toISOString().split('T')[0],
            confirmationDate: row.confirmationDate || undefined,
            gender: row.gender || undefined,
            employmentType: row.employmentType || undefined,
            probationPeriodDays: row.probationPeriodDays !== undefined && row.probationPeriodDays !== '' ? Number(row.probationPeriodDays) : undefined,
            companyName: row.companyName || undefined,
            location: row.location || undefined,
            cycleId,
            cycleCode: cycleCodeShort,
            departmentId: deptObj.id,
            departmentName: deptObj.name,
            designationId: desigObj.id,
            designationName: desigObj.title || desigObj.name,
            managerId,
            managerName,
            managerEmployeeCode: cleanMgrCode || undefined,
            hodId,
            hodName,
            hodEmployeeCode: cleanHodCode || undefined,
            currentCtc: numericCtc,
            currency: '₹',
            status: (row.status || 'ACTIVE').toUpperCase(),
            phone: row.phone || row.phoneNumber || '+91 98765 43210',
            updatedAt: new Date().toISOString(),
          };

          if (existing && allowUpdateExisting) {
            await employeesCol.updateOne({ id: existing.id }, { $set: empPayload });
            if (row.role) {
              const candidateRole = String(row.role).toUpperCase().replace(/[\s\-_]+/g, '');
              let role: UserRole = 'EMPLOYEE';
              if (candidateRole === 'HR' || candidateRole === 'HRADMIN') role = 'HR';
              else if (candidateRole === 'MANAGER' || candidateRole === 'MGR') role = 'MANAGER';
              else if (candidateRole === 'HOD') role = 'HOD';
              else if (candidateRole === 'SUPERADMIN' || candidateRole === 'ADMIN') role = 'SUPER_ADMIN';
              else if (candidateRole === 'MANAGEMENT' || candidateRole === 'CXO') role = 'MANAGEMENT';

              await usersCol.updateOne(
                { $or: [{ employeeId: existing.id }, { email: existing.email }] },
                { $set: { role, roleId: `role_${role.toLowerCase()}`, updatedAt: new Date().toISOString() } }
              );
            }
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
          const empCode = String(row.employeeCode || '').trim().toUpperCase();
          const tTitle = String(row.templateTitle || (empCode ? `${empCode} - Performance Scorecard` : 'General KRA Template')).trim();
          const kTitle = String(row.kraTitle || '').trim();
          const weightage = Number(row.weightage) || 25;

          if (!kTitle) {
            skippedCount++;
            continue;
          }

          let matchedEmp: any = null;
          if (empCode) {
            if (employeeLookupCache.has(empCode)) {
              matchedEmp = employeeLookupCache.get(empCode);
            } else {
              matchedEmp = await employeesCol.findOne({ employeeCode: empCode });
              employeeLookupCache.set(empCode, matchedEmp);
            }
          }

          // A KRA scorecard must be linked to a real employee — reject rows for employee
          // codes that don't exist rather than creating an orphaned template that nothing
          // ever links up later.
          if (empCode && !matchedEmp) {
            failedCount++;
            errorsList.push({
              row: rowNum,
              reason: `Employee code '${empCode}' not found in database. Register the employee first, then upload their KRA scorecard.`,
            });
            continue;
          }

          // Snapshot this employee's pre-batch assignment state the first time they're
          // seen in this file. Rows 2..N of a multi-KRA-item upload for the same employee
          // legitimately see currentKraTemplateId already set (by row 1, earlier in this
          // same batch) — only a snapshot taken before the batch touched them can tell
          // that apart from a genuine pre-existing scorecard.
          if (empCode && !preBatchKraAssignment.has(empCode)) {
            preBatchKraAssignment.set(empCode, Boolean(matchedEmp?.currentKraTemplateId));
          }

          // Every employee's KRA scorecard is exclusive to them — a bulk upload must
          // never silently overwrite one that already existed before this upload.
          if (empCode && preBatchKraAssignment.get(empCode)) {
            failedCount++;
            errorsList.push({
              row: rowNum,
              reason: `Employee '${empCode}' already has a KRA scorecard assigned (${matchedEmp?.currentKraTemplateName || matchedEmp?.currentKraTemplateId || 'existing scorecard'}). Remove or reassign it first.`,
            });
            continue;
          }

          const deptName = row.department || (matchedEmp ? matchedEmp.departmentName : '') || 'General';
          const desigName = row.designation || (matchedEmp ? matchedEmp.designationName : '') || 'General';
          const deptObj = await findOrCreateDept(deptName);
          const desigObj = await findOrCreateDesig(desigName, deptObj.id);
          const cycleId = matchedEmp?.cycleId || mapCycleCodeToId(row.cycleCode);

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

          // Standard KraItem structure
          const kraItem = {
            id: `item_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            kraId,
            title: kTitle,
            description: row.targetDescription || `Target for ${kTitle}`,
            target: String(row.targetValue || '100% Target SLA'),
            weight: weightage,
            measurementCriteria: row.measurementCriteria || `${row.measurementUnit || '%'}: 1=Below, 3=Meets, 5=Exceeds`,
          };

          if (matchedEmp || empCode) {
            // Find existing employee template — reuse this batch's in-memory record of it if
            // an earlier row for this same employee already read or created it.
            const targetKey = `EMP:${empCode}`;
            let existingTemplate: any = templateStateCache.get(targetKey);
            if (!existingTemplate) {
              const templateQuery: any = {
                $or: [
                  ...(matchedEmp ? [{ employeeId: matchedEmp.id }] : []),
                  { employeeCode: empCode },
                ],
              };
              existingTemplate = await kraTemplatesCol.findOne(templateQuery);
            }

            if (existingTemplate) {
              const isFirstTouchThisBatch = !initializedTemplates.has(targetKey);
              let currentItems = existingTemplate.items || [];
              if (isFirstTouchThisBatch) {
                initializedTemplates.add(targetKey);
                if (allowUpdateExisting) {
                  currentItems = [];
                }
              }
              currentItems.push(kraItem);
              const totalWeight = currentItems.reduce((sum: number, it: any) => sum + (Number(it.weight) || 0), 0);
              await kraTemplatesCol.updateOne(
                { id: existingTemplate.id },
                {
                  $set: {
                    items: currentItems,
                    totalWeight,
                    employeeId: matchedEmp?.id || existingTemplate.employeeId,
                    employeeCode: empCode,
                    employeeName: matchedEmp?.name || row.employeeName || existingTemplate.employeeName,
                    departmentId: deptObj.id,
                    departmentName: deptObj.name,
                    designationId: desigObj.id,
                    designationName: desigObj.title || desigObj.name,
                    cycleId,
                    updatedAt: new Date().toISOString(),
                  },
                }
              );
              templateStateCache.set(targetKey, { id: existingTemplate.id, title: existingTemplate.title, items: currentItems });

              // Auto-assign to employee — only needs writing once per employee per batch,
              // since the template id/title this batch settles on doesn't change afterward.
              if (matchedEmp && isFirstTouchThisBatch) {
                await employeesCol.updateOne(
                  { id: matchedEmp.id },
                  { $set: { currentKraTemplateId: existingTemplate.id, currentKraTemplateName: existingTemplate.title } }
                );
              }
              if (matchedEmp) {
                employeesToResyncReviews.add(matchedEmp.id);
              }
              updatedCount++;
            } else {
              const templateTitle = tTitle || `${matchedEmp?.name || row.employeeName || empCode} - Performance Scorecard`;
              const newTemplate = {
                id: `kratpl_${Math.random().toString(36).substr(2, 9)}`,
                title: templateTitle,
                employeeId: matchedEmp ? matchedEmp.id : undefined,
                employeeCode: empCode,
                employeeName: matchedEmp ? matchedEmp.name : row.employeeName,
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
              initializedTemplates.add(targetKey);
              templateStateCache.set(targetKey, { id: newTemplate.id, title: newTemplate.title, items: newTemplate.items });

              // Auto-assign to employee!
              if (matchedEmp) {
                await employeesCol.updateOne(
                  { id: matchedEmp.id },
                  { $set: { currentKraTemplateId: newTemplate.id, currentKraTemplateName: newTemplate.title } }
                );
                employeesToResyncReviews.add(matchedEmp.id);
              }
              insertedCount++;
            }
          } else {
            // General template library grouping by title and department
            const targetKey = `TPL:${tTitle}_${deptObj.id}`;
            const existingTemplate = await kraTemplatesCol.findOne({ title: tTitle, departmentId: deptObj.id });
            if (existingTemplate) {
              let currentItems = existingTemplate.items || [];
              if (!initializedTemplates.has(targetKey)) {
                initializedTemplates.add(targetKey);
                if (allowUpdateExisting) {
                  currentItems = [];
                }
              }
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
              initializedTemplates.add(targetKey);
              insertedCount++;
            }
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

    // Newly (re)assigned KRA scorecards should take effect immediately: generate a
    // quarterly review for any employee who just became eligible (rather than waiting for
    // the next employee save, manual sync, or the daily sync job), and push the fresh KRA
    // into any not-yet-scored review that was created before this import.
    if (datasetType === 'kras' && employeesToResyncReviews.size > 0) {
      // Each employee's sync only touches their own review/appraisal records (keyed by their
      // own id), so these are independent and safe to run concurrently — sequentially awaiting
      // one employee at a time here is what made large multi-employee batches slow.
      await Promise.all(
        Array.from(employeesToResyncReviews).map(async (empId) => {
          const assignedEmp = await employeesCol.findOne({ id: empId });
          if (assignedEmp) {
            await syncEmployeeAppraisalsAndReviews(assignedEmp);
          }
          await resyncUnscoredReviewKraSnapshots(empId);
        })
      );
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
