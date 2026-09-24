import express, { Response } from 'express';
import bcrypt from 'bcryptjs';
import { getDbCollection } from '../db.js';
import {
  authenticateToken,
  requireRoles,
  recordAuditLog,
  AuthenticatedRequest,
  authorizeEmployeeAccess,
  invalidateAuthCache,
  revokeUserSessions,
  generateTempPassword,
} from '../auth.js';
import { Employee, Department, Designation, Cycle, User, UserRole } from '../../src/types/index.js';
import { syncEmployeeAppraisalsAndReviews, resyncUnscoredReviewKraSnapshots } from '../syncHelpers.js';
import { sendNotificationEmail } from '../services/emailService.js';
import { renderEmployeeWelcomeEmail } from '../services/emailTemplates.js';

export const mastersRouter = express.Router();

// Apply auth middleware to all master routes
mastersRouter.use(authenticateToken);

/**
 * Ensures a KRA template assigned to an employee is exclusively theirs.
 *
 * `kraTemplates` can be either a shared library blueprint (no `employeeId`,
 * scoped only by department/designation) or an employee-owned scorecard.
 * When HR picks a library template via "Template Library" mode, we must
 * never let two employees point at the same `kraTemplates` document —
 * otherwise editing one employee's scorecard mutates it for everyone else
 * assigned to that document, and cascade cleanup on employee deletion
 * cannot safely tell which employees still depend on it.
 *
 * This clones the source template (if it isn't already owned by this
 * employee) into a new document with `employeeId` set, and returns the id
 * of the document that should actually be stored as the employee's
 * `currentKraTemplateId`.
 */
async function assignKraTemplateToEmployee(
  sourceTemplateId: string,
  employee: { id: string; employeeCode: string; name: string }
): Promise<{ id: string; name: string } | undefined> {
  const templateCol = getDbCollection('kraTemplates');
  const krasCol = getDbCollection('kras');
  const source = await templateCol.findOne({ id: sourceTemplateId });
  if (!source) return undefined;

  // Already an employee-owned copy belonging to this exact employee.
  if (source.employeeId === employee.id) {
    return { id: source.id, name: source.title };
  }

  // Give the clone its own `kras` rows too (not just its own kraTemplates doc).
  // If two employees both picked the same library template and we reused the
  // source's kraId references, deleting one employee's KRAs (on edit or
  // deletion) would remove `kras` rows the other employee's clone still uses.
  const clonedItems = [];
  for (const it of source.items || []) {
    const kId = `kra_${Math.random().toString(36).substr(2, 9)}`;
    await krasCol.insertOne({
      id: kId,
      title: it.title,
      description: it.description || it.target || `Target for ${it.title}`,
      departmentId: source.departmentId,
      designationId: source.designationId,
      cycleId: source.cycleId,
      metricType: 'PERCENTAGE',
      targetUnit: '%',
      active: true,
      createdAt: new Date().toISOString(),
    });
    clonedItems.push({
      id: `item_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      kraId: kId,
      title: it.title,
      description: it.description,
      target: it.target,
      weight: it.weight,
      measurementCriteria: it.measurementCriteria,
    });
  }

  const clonedId = `kratpl_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const clonedTitle = `${employee.name.trim()} - Performance Scorecard`;
  await templateCol.insertOne({
    id: clonedId,
    title: clonedTitle,
    employeeId: employee.id,
    employeeCode: employee.employeeCode,
    employeeName: employee.name.trim(),
    departmentId: source.departmentId,
    departmentName: source.departmentName,
    designationId: source.designationId,
    designationName: source.designationName,
    cycleId: source.cycleId,
    cycleCode: source.cycleCode,
    totalWeight: source.totalWeight,
    items: clonedItems,
    active: true,
    clonedFromTemplateId: source.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  return { id: clonedId, name: clonedTitle };
}

// ==========================================
// 1. DEPARTMENTS
// ==========================================

/**
 * GET /api/departments
 */
mastersRouter.get('/departments', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const deptCol = getDbCollection('departments');
    const departments = await (await deptCol.find({})).toArray();
    res.json(departments);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch departments.' });
  }
});

/**
 * POST /api/departments
 * Admin/HR only
 */
mastersRouter.post('/departments', requireRoles('SUPER_ADMIN', 'HR'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, code, hodId, hodName, budgetCapPercent } = req.body;
    if (!name || !code) {
      return res.status(400).json({ error: 'Department name and code are required.' });
    }

    const deptCol = getDbCollection('departments');
    const existing = await deptCol.findOne({ code: code.toUpperCase().trim() });
    if (existing) {
      return res.status(400).json({ error: `Department code ${code} already exists.` });
    }

    let parsedBudgetCap = 12.0;
    if (budgetCapPercent !== undefined && budgetCapPercent !== null && budgetCapPercent !== '') {
      const parsed = Number(budgetCapPercent);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) {
        parsedBudgetCap = Number(parsed.toFixed(2));
      }
    }

    const newDept: Department = {
      id: `dept_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      name: name.trim(),
      code: code.toUpperCase().trim(),
      hodId: hodId || undefined,
      hodName: hodName || undefined,
      budgetCapPercent: parsedBudgetCap,
      active: true,
      createdAt: new Date().toISOString(),
    };

    await deptCol.insertOne(newDept);

    if (req.user) {
      await recordAuditLog(
        req.user.id,
        req.user.name,
        req.user.role,
        'ORGANIZATION_MASTER',
        'CREATE_DEPARTMENT',
        newDept.id,
        '',
        newDept.name,
        `Created department ${newDept.name} (${newDept.code}) with budget cap ${parsedBudgetCap}%`
      );
    }

    res.status(201).json(newDept);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to create department.' });
  }
});

/**
 * PUT /api/departments/:id
 */
mastersRouter.put('/departments/:id', requireRoles('SUPER_ADMIN', 'HR'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { name, code, hodId, hodName, active, budgetCapPercent } = req.body;

    const deptCol = getDbCollection('departments');
    const dept = await deptCol.findOne({ id });
    if (!dept) {
      return res.status(404).json({ error: 'Department not found.' });
    }

    const updateData: Partial<Department> = {};
    if (name !== undefined) updateData.name = name.trim();
    if (code !== undefined) updateData.code = code.toUpperCase().trim();
    if (hodId !== undefined) updateData.hodId = hodId;
    if (hodName !== undefined) updateData.hodName = hodName;
    if (active !== undefined) updateData.active = Boolean(active);
    if (budgetCapPercent !== undefined && budgetCapPercent !== null && budgetCapPercent !== '') {
      const parsed = Number(budgetCapPercent);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) {
        updateData.budgetCapPercent = Number(parsed.toFixed(2));
      }
    }

    await deptCol.updateOne({ id }, { $set: updateData });
    const updated = await deptCol.findOne({ id });

    if (req.user) {
      await recordAuditLog(
        req.user.id,
        req.user.name,
        req.user.role,
        'ORGANIZATION_MASTER',
        'UPDATE_DEPARTMENT',
        id,
        JSON.stringify(dept),
        JSON.stringify(updated),
        `Updated department ${dept.name}`
      );
    }

    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update department.' });
  }
});

/**
 * DELETE /api/departments/:id
 * Super Admin & HR only - deletes a department from the database with referential integrity protection
 */
mastersRouter.delete('/departments/:id', requireRoles('SUPER_ADMIN', 'HR'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const deptCol = getDbCollection('departments');
    const employeesCol = getDbCollection('employees');
    const desCol = getDbCollection('designations');

    const dept = await deptCol.findOne({ id });
    if (!dept) {
      return res.status(404).json({ error: 'Department not found.' });
    }

    // Referential integrity check: Cannot delete if active employees are assigned
    const assignedEmployees = await (await employeesCol.find({
      departmentId: id,
      status: { $ne: 'INACTIVE' }
    })).toArray();

    if (assignedEmployees.length > 0) {
      return res.status(400).json({
        error: `Cannot delete department "${dept.name}". There are ${assignedEmployees.length} active employee(s) assigned to this department. Please reassign or deactivate them first.`,
        assignedCount: assignedEmployees.length
      });
    }

    // Cascade: Clean up associated designations for this department
    await desCol.deleteMany({ departmentId: id });

    // Delete the department from the database
    await deptCol.deleteOne({ id });

    if (req.user) {
      await recordAuditLog(
        req.user.id,
        req.user.name,
        req.user.role,
        'ORGANIZATION_MASTER',
        'DELETE_DEPARTMENT',
        id,
        dept.name,
        '',
        `Deleted department ${dept.name} (${dept.code}) from database`
      );
    }

    res.json({
      success: true,
      message: `Department "${dept.name}" (${dept.code}) was deleted from the database successfully.`
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to delete department from database.' });
  }
});

// ==========================================
// 2. DESIGNATIONS
// ==========================================

/**
 * GET /api/designations
 */
mastersRouter.get('/designations', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const desCol = getDbCollection('designations');
    const designations = await (await desCol.find({})).toArray();
    res.json(designations);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch designations.' });
  }
});

/**
 * POST /api/designations
 */
mastersRouter.post('/designations', requireRoles('SUPER_ADMIN', 'HR'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name, departmentId, level } = req.body;
    if (!name || !departmentId) {
      return res.status(400).json({ error: 'Designation name and department ID are required.' });
    }

    const deptCol = getDbCollection('departments');
    const dept = await deptCol.findOne({ id: departmentId });
    if (!dept) {
      return res.status(400).json({ error: 'Invalid department ID specified.' });
    }

    const desCol = getDbCollection('designations');
    const newDes: Designation = {
      id: `des_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      name: name.trim(),
      departmentId,
      departmentName: dept.name,
      level: Number(level) || 1,
      active: true,
    };

    await desCol.insertOne(newDes);

    if (req.user) {
      await recordAuditLog(
        req.user.id,
        req.user.name,
        req.user.role,
        'ORGANIZATION_MASTER',
        'CREATE_DESIGNATION',
        newDes.id,
        '',
        newDes.name,
        `Created designation ${newDes.name} in ${dept.name}`
      );
    }

    res.status(201).json(newDes);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to create designation.' });
  }
});

/**
 * DELETE /api/designations/:id
 * Super Admin & HR only - deletes a designation from the database with referential integrity protection
 */
mastersRouter.delete('/designations/:id', requireRoles('SUPER_ADMIN', 'HR'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const desCol = getDbCollection('designations');
    const employeesCol = getDbCollection('employees');

    const des = await desCol.findOne({ id });
    if (!des) {
      return res.status(404).json({ error: 'Designation not found.' });
    }

    // Referential integrity check: Cannot delete if active employees are assigned
    const assignedEmployees = await (await employeesCol.find({
      designationId: id,
      status: { $ne: 'INACTIVE' }
    })).toArray();

    if (assignedEmployees.length > 0) {
      return res.status(400).json({
        error: `Cannot delete designation "${des.name}". There are ${assignedEmployees.length} active employee(s) assigned this designation. Please reassign them first.`,
        assignedCount: assignedEmployees.length
      });
    }

    // Delete designation from database
    await desCol.deleteOne({ id });

    if (req.user) {
      await recordAuditLog(
        req.user.id,
        req.user.name,
        req.user.role,
        'ORGANIZATION_MASTER',
        'DELETE_DESIGNATION',
        id,
        des.name,
        '',
        `Deleted designation ${des.name} from database`
      );
    }

    res.json({
      success: true,
      message: `Designation "${des.name}" was deleted from the database successfully.`
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to delete designation from database.' });
  }
});

// ==========================================
// 2.5 LOCATIONS (Work Location Registry)
// ==========================================

const DEFAULT_LOCATIONS = [
  'Bangalore HQ', 'Corporate Office', 'Head Office', 'Mumbai Branch',
  'Delhi NCR Hub', 'Hyderabad Tech Center', 'Jaipur Office',
  'Delhi', 'Haryana', 'Uttar Pradesh', 'Rajasthan', 'West Bengal',
  'Patna', 'Jodhpur', 'Jaipur', 'Chennai', 'HYDERABAD', 'LUCKNOW',
  'Remote - India', 'Global Remote',
];

const escapeRegex = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * GET /api/locations
 * Returns list of distinct locations with active employee count
 */
mastersRouter.get('/locations', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const locationsCol = getDbCollection('locations');
    const employeesCol = getDbCollection('employees');

    // 1. Get all stored locations from the locations collection
    let storedLocations = await (await locationsCol.find({})).toArray();

    // If locations collection is empty, seed it with DEFAULT_LOCATIONS and distinct existing employee locations
    if (storedLocations.length === 0) {
      const activeEmps = await (await employeesCol.find({
        status: { $ne: 'INACTIVE' },
        isPastEmployee: { $ne: true }
      })).toArray();
      const existingLocs = new Set<string>();
      DEFAULT_LOCATIONS.forEach((l) => existingLocs.add(l.trim()));
      activeEmps.forEach((e) => {
        if (e.location && typeof e.location === 'string' && e.location.trim()) {
          existingLocs.add(e.location.trim());
        }
      });
      const initialDocs = Array.from(existingLocs).map((name) => ({
        id: `loc_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        name,
        createdAt: new Date().toISOString(),
      }));
      if (initialDocs.length > 0) {
        await locationsCol.insertMany(initialDocs);
        storedLocations = initialDocs;
      }
    }

    // Also check if any active employees have a location not yet in locationsCol, auto-register it
    const activeEmps = await (await employeesCol.find({
      status: { $ne: 'INACTIVE' },
      isPastEmployee: { $ne: true }
    })).toArray();

    const storedNamesLower = new Set(storedLocations.map((l: any) => (l.name || '').trim().toLowerCase()));
    const newLocDocs: any[] = [];
    activeEmps.forEach((e) => {
      const locName = (e.location || '').trim();
      if (locName && !storedNamesLower.has(locName.toLowerCase())) {
        storedNamesLower.add(locName.toLowerCase());
        newLocDocs.push({
          id: `loc_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
          name: locName,
          createdAt: new Date().toISOString(),
        });
      }
    });
    if (newLocDocs.length > 0) {
      await locationsCol.insertMany(newLocDocs);
      storedLocations = [...storedLocations, ...newLocDocs];
    }

    // Aggregate counts for each location
    const result = storedLocations.map((locDoc: any) => {
      const name = (locDoc.name || '').trim();
      const matchingEmps = activeEmps.filter(
        (e) => (e.location || '').trim().toLowerCase() === name.toLowerCase()
      );
      return {
        id: locDoc.id || locDoc._id?.toString(),
        name,
        employeeCount: matchingEmps.length,
        assignedEmployees: matchingEmps.slice(0, 10).map((e) => ({ id: e.id, name: e.name, employeeCode: e.employeeCode })),
      };
    });

    // Sort by employee count desc, then alphabetically by name
    result.sort((a, b) => b.employeeCount - a.employeeCount || a.name.localeCompare(b.name));

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch locations.' });
  }
});

/**
 * POST /api/locations
 * Create a new location
 */
mastersRouter.post('/locations', requireRoles('SUPER_ADMIN', 'HR'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Location name is required.' });
    }
    const locName = name.trim();
    const locationsCol = getDbCollection('locations');
    const existing = await locationsCol.findOne({
      name: { $regex: new RegExp(`^${escapeRegex(locName)}$`, 'i') }
    });
    if (existing) {
      return res.status(400).json({ error: `Location "${locName}" already exists.` });
    }
    const newDoc = {
      id: `loc_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      name: locName,
      createdAt: new Date().toISOString(),
    };
    await locationsCol.insertOne(newDoc);
    if (req.user) {
      await recordAuditLog(
        req.user.id,
        req.user.name,
        req.user.role,
        'ORGANIZATION_MASTER',
        'CREATE_LOCATION',
        newDoc.id,
        locName,
        '',
        `Created location "${locName}"`
      );
    }
    res.status(201).json({ success: true, message: `Location "${locName}" added successfully.`, location: newDoc });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to create location.' });
  }
});

/**
 * DELETE /api/locations/:name
 * Delete a location if no active employees are assigned
 */
mastersRouter.delete('/locations/:name', requireRoles('SUPER_ADMIN', 'HR'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const rawName = req.params.name;
    if (!rawName) {
      return res.status(400).json({ error: 'Location name is required.' });
    }
    const locName = decodeURIComponent(rawName).trim();
    const locationsCol = getDbCollection('locations');
    const employeesCol = getDbCollection('employees');

    // Check for active employees assigned to this location
    const assignedEmployees = await (await employeesCol.find({
      location: { $regex: new RegExp(`^${escapeRegex(locName)}$`, 'i') },
      status: { $ne: 'INACTIVE' },
      isPastEmployee: { $ne: true },
    })).toArray();

    if (assignedEmployees.length > 0) {
      const names = assignedEmployees.map((e) => e.name || e.employeeCode).filter(Boolean);
      return res.status(400).json({
        error: `Cannot delete location "${locName}". ${assignedEmployees.length} active employee(s) are assigned to this location (${names.slice(0, 5).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''}). Please reassign or update them before deleting.`
      });
    }

    // Safe to delete from locations collection
    await locationsCol.deleteMany({
      name: { $regex: new RegExp(`^${escapeRegex(locName)}$`, 'i') }
    });

    if (req.user) {
      await recordAuditLog(
        req.user.id,
        req.user.name,
        req.user.role,
        'ORGANIZATION_MASTER',
        'DELETE_LOCATION',
        locName,
        locName,
        '',
        `Deleted location "${locName}" from database`
      );
    }

    res.json({
      success: true,
      message: `Location "${locName}" was deleted successfully.`
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to delete location.' });
  }
});

// ==========================================
// 3. CYCLES (Appraisal Cycle Framework: June/September)
// ==========================================

/**
 * GET /api/cycles
 */
mastersRouter.get('/cycles', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const cyclesCol = getDbCollection('cycles');
    const filter = req.query.includeInactive === 'true' ? {} : { active: { $ne: false } };
    const cycles = await (await cyclesCol.find(filter)).toArray();
    res.json(cycles);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch appraisal cycles.' });
  }
});

/**
 * PUT /api/cycles/:id
 */
mastersRouter.put('/cycles/:id', requireRoles('SUPER_ADMIN', 'HR'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { name, appraisalMonth, colorHex, description, active } = req.body;

    const cyclesCol = getDbCollection('cycles');
    const cycle = await cyclesCol.findOne({ id });
    if (!cycle) {
      return res.status(404).json({ error: 'Appraisal cycle not found.' });
    }

    const updateData: Partial<Cycle> = {};
    if (name !== undefined) updateData.name = name.trim();
    if (appraisalMonth !== undefined) {
      const monthNum = Number(appraisalMonth);
      if (monthNum < 1 || monthNum > 12) {
        return res.status(400).json({ error: 'Appraisal month must be between 1 and 12.' });
      }
      updateData.appraisalMonth = monthNum;
    }
    if (colorHex !== undefined) updateData.colorHex = colorHex.trim();
    if (description !== undefined) updateData.description = description.trim();
    if (active !== undefined) updateData.active = Boolean(active);

    await cyclesCol.updateOne({ id }, { $set: updateData });
    const updated = await cyclesCol.findOne({ id });

    if (req.user) {
      await recordAuditLog(
        req.user.id,
        req.user.name,
        req.user.role,
        'CYCLE_MASTER',
        'UPDATE_CYCLE',
        id,
        JSON.stringify(cycle),
        JSON.stringify(updated),
        `Updated Appraisal Cycle ${cycle.code} (${cycle.name})`
      );
    }

    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update appraisal cycle.' });
  }
});

// ==========================================
// 4. EMPLOYEES
// ==========================================

/**
 * GET /api/employees
 * Supports query filters: departmentId, cycleId, status, search, managerId
 */
mastersRouter.get('/employees', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { departmentId, cycleId, status, search, managerId } = req.query;
    const empCol = getDbCollection('employees');
    let allEmployees: Employee[] = await (await empCol.find({})).toArray();

    // Strict Role-based scope enforcement
    const userRole = req.user?.role;
    const userEmpId = req.user?.employeeId;
    const userDeptId = req.employeeProfile?.departmentId;

    if (userRole === 'EMPLOYEE') {
      allEmployees = allEmployees.filter((e) => e.id === userEmpId || e.id === req.user?.id);
    } else if (userRole === 'REPORTING_MANAGER' || userRole === 'MANAGER') {
      allEmployees = allEmployees.filter(
        (e) => e.managerId === userEmpId || e.id === userEmpId || e.managerId === req.user?.id
      );
    } else if (userRole === 'HOD') {
      allEmployees = allEmployees.filter(
        (e) => (userDeptId && e.departmentId === userDeptId) || e.hodId === userEmpId || e.id === userEmpId
      );
    }
    // SUPER_ADMIN, HR, MANAGEMENT have organization-wide access (MANAGEMENT read-only)

    // Filters
    if (departmentId) {
      allEmployees = allEmployees.filter((e) => e.departmentId === departmentId);
    }
    if (cycleId) {
      allEmployees = allEmployees.filter((e) => e.cycleId === cycleId);
    }
    if (status) {
      allEmployees = allEmployees.filter((e) => e.status === status);
    }
    if (managerId) {
      allEmployees = allEmployees.filter((e) => e.managerId === managerId);
    }
    const usersCol = getDbCollection('users');
    const allUsers: any[] = await (await usersCol.find({})).toArray();
    const userByEmpId = new Map<string, any>();
    const userByEmail = new Map<string, any>();
    allUsers.forEach((u: any) => {
      if (u.employeeId) userByEmpId.set(String(u.employeeId), u);
      if (u.email) userByEmail.set(String(u.email).toLowerCase().trim(), u);
    });

    allEmployees.forEach((e: any) => {
      if (!e.currentCtc || e.currentCtc === 0) {
        e.currentCtc = Number(e.currentCtc) || 0;
      }
      if (!e.currency) {
        e.currency = '₹';
      }
      const u = userByEmpId.get(String(e.id)) || userByEmail.get(String(e.email).toLowerCase().trim());
      e.hasLoginAccount = !!(u && u.active !== false);
      e.userActive = u ? u.active !== false : false;
      if (u && u.role) {
        e.systemRole = u.role;
      }
      if (u) {
        e.userId = u.id;
      }
    });

    if (search) {
      const q = String(search).toLowerCase();
      allEmployees = allEmployees.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.employeeCode.toLowerCase().includes(q) ||
          e.email.toLowerCase().includes(q) ||
          (e.departmentName && e.departmentName.toLowerCase().includes(q)) ||
          (e.designationName && e.designationName.toLowerCase().includes(q))
      );
    }

    res.json(allEmployees);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch employee records.' });
  }
});

/**
 * GET /api/employees/:id
 * Protected by authorizeEmployeeAccess('id') (Strict IDOR protection)
 */
mastersRouter.get('/employees/:id', authorizeEmployeeAccess('id'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const empCol = getDbCollection('employees');
    const usersCol = getDbCollection('users');
    const employee = await empCol.findOne({ id });
    if (!employee) {
      return res.status(404).json({ error: 'Employee not found.' });
    }
    const user = (await usersCol.findOne({ employeeId: id })) || (await usersCol.findOne({ email: employee.email.toLowerCase().trim() }));
    employee.hasLoginAccount = !!(user && user.active !== false);
    employee.userActive = user ? user.active !== false : false;
    if (user && user.role) {
      employee.systemRole = user.role;
    }
    if (user) {
      employee.userId = user.id;
    }
    res.json(employee);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch employee details.' });
  }
});

/**
 * POST /api/employees
 * Admin/HR creates employee and assigns Manager, HOD, appraisal cycle cohort, KRA Template, CTC, and User Account
 */
mastersRouter.post('/employees', requireRoles('SUPER_ADMIN', 'HR'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      employeeCode,
      name,
      email,
      phone,
      location,
      departmentId,
      designationId,
      joiningDate,
      relievingDate,
      pastEmployeeDate,
      managerId,
      hodId,
      cycleId,
      startingReviewPeriodId,
      currentKraTemplateId,
      status,
      currentCtc,
      currency,
      provisionLogin = true,
      systemRole,
      initialPassword,
      confirmationDate,
      gender,
      employmentType,
      probationPeriodDays,
      companyName,
      customKras,
    } = req.body;

    const empCol = getDbCollection('employees');
    const deptCol = getDbCollection('departments');
    const desCol = getDbCollection('designations');
    const cyclesCol = getDbCollection('cycles');

    const des = await desCol.findOne({ id: designationId });
    const isTargetHod =
      systemRole === 'HOD' ||
      Boolean(des && (des.level >= 4 || des.name?.toLowerCase().includes('vp') || des.name?.toLowerCase().includes('head')));
    const isTargetManager =
      systemRole === 'MANAGER' ||
      Boolean(des && (des.level >= 3 || des.name?.toLowerCase().includes('manager') || des.name?.toLowerCase().includes('lead')));

    if (!employeeCode || !name || !email || !departmentId || !designationId || !joiningDate || !cycleId || (!hodId && !isTargetHod) || !startingReviewPeriodId) {
      return res.status(400).json({
        error: 'Required fields missing: employeeCode, name, email, departmentId, designationId, joiningDate, cycleId, startingReviewPeriodId',
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({ error: 'Please enter a valid corporate email address.' });
    }

    const numericCtc = currentCtc !== undefined && currentCtc !== '' ? Number(currentCtc) : 0;
    if (isNaN(numericCtc) || numericCtc < 0) {
      return res.status(400).json({ error: 'Starting Annual CTC must be a positive number.' });
    }

    // Validate Reporting Manager & HOD
    let managerName: string | undefined;
    if (managerId) {
      const mgr = await empCol.findOne({ id: managerId });
      if (!mgr) {
        return res.status(400).json({ error: 'Selected Reporting Manager was not found in the employee directory.' });
      }
      managerName = mgr.name;
    } else if (!isTargetHod && status !== 'INACTIVE') {
      return res.status(400).json({
        error: 'Reporting Manager is required. Self-managed employees are not permitted.',
      });
    }

    let hodName: string | undefined;
    if (hodId) {
      const hod = await empCol.findOne({ id: hodId });
      if (!hod) {
        return res.status(400).json({ error: 'Selected Head of Department (HOD) was not found in the employee directory.' });
      }
      hodName = hod.name;
    }

    // Auto-generate sequential MSXXXX if employeeCode not provided
    let finalCode = employeeCode ? employeeCode.trim().toUpperCase() : '';
    if (!finalCode) {
      const allExisting = await empCol.find({}).toArray();
      const maxNum = allExisting.reduce((max: number, emp: any) => {
        const match = emp.employeeCode?.match(/(?:MS|EMP-?)(\d+)/i);
        if (match) {
          const num = parseInt(match[1], 10);
          return num > max ? num : max;
        }
        return max;
      }, 0);
      finalCode = `MS${String(maxNum + 1).padStart(4, '0')}`;
    }

    // Check code/email uniqueness
    const existingCode = await empCol.findOne({ employeeCode: finalCode });
    if (existingCode) {
      return res.status(400).json({ error: `Employee code ${finalCode} is already registered.` });
    }
    const existingEmail = await empCol.findOne({ email: email.trim().toLowerCase() });
    if (existingEmail) {
      if (existingEmail.status === 'INACTIVE' || existingEmail.isPastEmployee) {
        return res.status(400).json({
          error: `Email ${email} belongs to past employee ${existingEmail.name} (${existingEmail.employeeCode}). Please use the Rehire workflow to reactivate their profile instead of creating a duplicate account.`,
          isPastEmployee: true,
          existingEmployeeId: existingEmail.id,
          existingEmployeeCode: existingEmail.employeeCode,
          existingEmployeeName: existingEmail.name,
        });
      }
      return res.status(400).json({ error: `Email ${email} is already in use by active employee ${existingEmail.name} (${existingEmail.employeeCode}).` });
    }

    // Fetch related names
    const dept = await deptCol.findOne({ id: departmentId });
    const cycle = await cyclesCol.findOne({ id: cycleId });
    const startingPeriod = await getDbCollection('reviewPeriods').findOne({ id: startingReviewPeriodId });

    const exitDate = relievingDate || pastEmployeeDate || (status === 'INACTIVE' ? new Date().toISOString() : undefined);

    const newEmpId = `emp_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    let assignedKraTemplateId: string | undefined;
    let assignedKraTemplateName: string | undefined;

    // If a shared/library template was chosen ("Template Library" mode), clone it
    // into an employee-owned copy so no two employees ever reference the same
    // kraTemplates document.
    if (currentKraTemplateId && (!Array.isArray(customKras) || customKras.length === 0)) {
      const cloned = await assignKraTemplateToEmployee(currentKraTemplateId, {
        id: newEmpId,
        employeeCode: finalCode,
        name: name.trim(),
      });
      if (cloned) {
        assignedKraTemplateId = cloned.id;
        assignedKraTemplateName = cloned.name;
      }
    }

    // If custom employee KRAs provided, create employee scorecard template
    if (Array.isArray(customKras) && customKras.length > 0) {
      try {
        const kraTemplatesCol = getDbCollection('kraTemplates');
        const krasCol = getDbCollection('kras');
        const tId = `kratpl_${Math.random().toString(36).substr(2, 9)}`;
        const items = [];
        for (const k of customKras) {
          if (!k.title || !String(k.title).trim()) continue;
          const kId = `kra_${Math.random().toString(36).substr(2, 9)}`;
          const kraDoc = {
            id: kId,
            title: String(k.title).trim(),
            description: k.description || k.target || `Target for ${k.title}`,
            departmentId,
            designationId,
            cycleId,
            metricType: 'PERCENTAGE',
            targetUnit: '%',
            active: true,
            createdAt: new Date().toISOString(),
          };
          await krasCol.insertOne(kraDoc);
          items.push({
            id: `item_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            kraId: kId,
            title: String(k.title).trim(),
            description: k.description || k.target || '',
            target: String(k.target || '100% Target SLA'),
            weight: Number(k.weight || k.weightage) || 0,
            measurementCriteria: k.measurementCriteria || '% SLA: 1=Below, 3=Meets, 5=Exceeds',
          });
        }
        if (items.length > 0) {
          const totalWeight = items.reduce((s, it) => s + (Number(it.weight) || 0), 0);
          const tTitle = `${name.trim()} - Performance Scorecard`;
          await kraTemplatesCol.insertOne({
            id: tId,
            title: tTitle,
            employeeId: newEmpId,
            employeeCode: finalCode,
            employeeName: name.trim(),
            departmentId,
            departmentName: dept?.name || 'Department',
            designationId,
            designationName: des?.name || 'Designation',
            cycleId,
            totalWeight,
            items,
            active: true,
            createdAt: new Date().toISOString(),
          });
          assignedKraTemplateId = tId;
          assignedKraTemplateName = tTitle;
        }
      } catch (kraErr) {
        console.warn('[MastersRoutes] Error creating custom employee KRA template:', kraErr);
      }
    }

    const newEmp: Employee = {
      id: newEmpId,
      employeeCode: finalCode,
      name: name.trim(),
      email: email.trim().toLowerCase(),
      phone: phone ? phone.trim() : undefined,
      location: location ? location.trim() : undefined,
      departmentId,
      departmentName: dept?.name || 'Department',
      designationId,
      designationName: des?.name || 'Designation',
      joiningDate: new Date(joiningDate).toISOString(),
      managerId: managerId || undefined,
      managerName,
      hodId: hodId || undefined,
      hodName,
      cycleId,
      cycleCode: cycle?.code || 'N/A',
      cycleName: cycle?.name || 'Unassigned',
      cycleColor: cycle?.colorHex || '#64748b',
      startingReviewPeriodId,
      startingReviewPeriodName: startingPeriod?.name || undefined,
      currentKraTemplateId: assignedKraTemplateId,
      currentKraTemplateName: assignedKraTemplateName,
      currentCtc: numericCtc,
      currency: currency || '₹',
      status: status || 'ACTIVE',
      isPastEmployee: status === 'INACTIVE' || Boolean(exitDate),
      pastEmployeeDate: exitDate ? new Date(exitDate).toISOString() : undefined,
      relievingDate: exitDate ? new Date(exitDate).toISOString() : undefined,
      confirmationDate: confirmationDate ? new Date(confirmationDate).toISOString() : undefined,
      gender: gender ? gender.trim() : undefined,
      employmentType: employmentType ? employmentType.trim() : undefined,
      probationPeriodDays: probationPeriodDays !== undefined && probationPeriodDays !== '' ? Number(probationPeriodDays) : undefined,
      companyName: companyName ? companyName.trim() : undefined,
      createdAt: new Date().toISOString(),
    };

    await empCol.insertOne(newEmp);

    // Auto-provision user account for login with explicit or inferred role and custom password
    let provisionedUserMeta: any = undefined;
    if (provisionLogin !== false) {
      try {
        const usersCol = getDbCollection('users');
        const existingUser = await usersCol.findOne({ email: newEmp.email });
        if (!existingUser) {
          let assignedRole: UserRole = 'EMPLOYEE';
          const validRoles: UserRole[] = ['SUPER_ADMIN', 'HR', 'MANAGER', 'HOD', 'EMPLOYEE', 'MANAGEMENT'];
          if (systemRole && validRoles.includes(systemRole)) {
            assignedRole = systemRole;
          } else {
            // Intelligent fallback based on designation keywords
            const desigLower = (des?.name || '').toLowerCase();
            if (desigLower.includes('hr manager') || desigLower.includes('hr lead')) assignedRole = 'HR';
            else if (desigLower.includes('manager') || desigLower.includes('lead')) assignedRole = 'MANAGER';
            else if (desigLower.includes('vp') || desigLower.includes('director') || desigLower.includes('hod')) assignedRole = 'HOD';
          }

          // Initial password generation or usage
          const tempPassword =
            initialPassword && initialPassword.trim().length >= 6
              ? initialPassword.trim()
              : generateTempPassword();
          const defaultHash = bcrypt.hashSync(tempPassword, 10);

          await usersCol.insertOne({
            id: `usr_${newEmp.id}`,
            employeeId: newEmp.id,
            email: newEmp.email,
            name: newEmp.name,
            role: assignedRole,
            roleId: `role_${assignedRole.toLowerCase()}`,
            active: newEmp.status !== 'INACTIVE',
            passwordHash: defaultHash,
            mustChangePassword: true,
            createdAt: new Date().toISOString(),
          });

          provisionedUserMeta = {
            email: newEmp.email,
            role: assignedRole,
            temporaryPassword: tempPassword,
            mustChangePassword: true,
          };
        }
      } catch (userErr) {
        console.warn('Could not auto-provision user login entry for employee:', userErr);
      }
    }

    if (req.user) {
      await recordAuditLog(
        req.user.id,
        req.user.name,
        req.user.role,
        'EMPLOYEE_MASTER',
        'CREATE_EMPLOYEE',
        newEmp.id,
        '',
        newEmp.name,
        `Created employee record ${newEmp.employeeCode} - ${newEmp.name} (Assigned Cycle ${newEmp.cycleCode}, CTC: ${newEmp.currency}${newEmp.currentCtc?.toLocaleString()})`
      );
    }

    // Automatically sync and initialize review periods and annual appraisal records
    await syncEmployeeAppraisalsAndReviews(newEmp);

    // Dispatch Welcome Email with Login ID and One-Time Password (Asynchronously)
    if (provisionedUserMeta?.temporaryPassword) {
      (async () => {
        try {
          const baseUrl = process.env.APP_URL || 'http://localhost:5173';
          const { subject, html } = renderEmployeeWelcomeEmail({
            employeeName: newEmp.name,
            employeeCode: newEmp.employeeCode,
            email: newEmp.email,
            temporaryPassword: provisionedUserMeta.temporaryPassword,
            departmentName: newEmp.departmentName,
            designationName: newEmp.designationName,
            loginUrl: `${baseUrl}/#login`,
          });

          await sendNotificationEmail({
            recipientId: newEmp.id,
            recipientEmail: newEmp.email,
            recipientName: newEmp.name,
            subject,
            html,
            templateType: 'EMPLOYEE_WELCOME',
            metadata: {
              employeeId: newEmp.id,
              employeeCode: newEmp.employeeCode,
              mustChangePassword: true,
            },
          });
        } catch (emailErr: any) {
          console.warn('[MastersRoutes] Failed to dispatch welcome email to new employee:', emailErr.message);
        }
      })();
    }

    res.status(201).json({
      ...newEmp,
      provisionedUser: provisionedUserMeta,
    });
  } catch (error: any) {
    console.error('Error creating employee:', error);
    if (error.code === 11000 || error.message?.includes('E11000 duplicate key error')) {
      const keyPattern = error.keyPattern || {};
      if (keyPattern.email || error.message?.includes('email')) {
        return res.status(400).json({ error: 'This email address is already registered in the system.' });
      }
      if (keyPattern.employeeCode || error.message?.includes('employeeCode')) {
        return res.status(400).json({ error: 'This employee code is already registered.' });
      }
      return res.status(400).json({ error: 'Duplicate record error: a unique constraint was violated.' });
    }
    res.status(500).json({ error: error.message || 'Failed to create employee record.' });
  }
});

/**
 * PUT /api/employees/:id
 * Update employee details, department transfer, compensation, or manager reassignment
 */
mastersRouter.put('/employees/:id', requireRoles('SUPER_ADMIN', 'HR'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const {
      name,
      email,
      employeeCode,
      phone,
      location,
      departmentId,
      designationId,
      joiningDate,
      relievingDate,
      pastEmployeeDate,
      managerId,
      hodId,
      cycleId,
      startingReviewPeriodId,
      currentKraTemplateId,
      status,
      currentCtc,
      currency,
      systemRole,
      provisionLogin,
      initialPassword,
      confirmationDate,
      gender,
      employmentType,
      probationPeriodDays,
      companyName,
      customKras,
    } = req.body;

    const empCol = getDbCollection('employees');
    const deptCol = getDbCollection('departments');
    const desCol = getDbCollection('designations');
    const cyclesCol = getDbCollection('cycles');
    const usersCol = getDbCollection('users');
    const reviewsCol = getDbCollection('employeeReviews');
    const appraisalsCol = getDbCollection('appraisals');

    const emp = await empCol.findOne({ id });
    if (!emp) {
      return res.status(404).json({ error: 'Employee not found.' });
    }

    const updateData: any = {};
    if (name !== undefined) updateData.name = name.trim();
    // Handle email update with format and uniqueness check
    if (email !== undefined && email.trim() !== '') {
      const normalizedEmail = email.trim().toLowerCase();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(normalizedEmail)) {
        return res.status(400).json({ error: 'Please enter a valid corporate email address.' });
      }

      if (normalizedEmail !== (emp.email || '').toLowerCase()) {
        const emailConflict = await empCol.findOne({ email: normalizedEmail, id: { $ne: id } });
        if (emailConflict) {
          return res.status(400).json({
            error: `Email address '${normalizedEmail}' is already in use by employee ${emailConflict.employeeCode} (${emailConflict.name}).`,
          });
        }

        const userConflict = await usersCol.findOne({ email: normalizedEmail, employeeId: { $ne: id } });
        if (userConflict) {
          return res.status(400).json({
            error: `Email address '${normalizedEmail}' is already registered to user account (${userConflict.name || userConflict.email}).`,
          });
        }
      }
      updateData.email = normalizedEmail;
    }

    if (phone !== undefined) updateData.phone = phone ? phone.trim() : undefined;
    if (location !== undefined) updateData.location = location ? location.trim() : undefined;
    if (joiningDate !== undefined) updateData.joiningDate = new Date(joiningDate).toISOString();
    if (status !== undefined) updateData.status = status;
    // If a shared/library template was picked ("Template Library" mode), clone it into
    // an employee-owned copy so this employee's scorecard never aliases another
    // employee's (or the library blueprint's) document. Custom-scorecard mode is
    // handled separately below and takes precedence when both are sent.
    if (currentKraTemplateId !== undefined && (!Array.isArray(customKras) || customKras.length === 0)) {
      if (currentKraTemplateId) {
        const cloned = await assignKraTemplateToEmployee(currentKraTemplateId, {
          id: emp.id,
          employeeCode: (updateData.employeeCode || emp.employeeCode),
          name: (updateData.name || emp.name),
        });
        updateData.currentKraTemplateId = cloned?.id;
        updateData.currentKraTemplateName = cloned?.name;
      } else {
        updateData.currentKraTemplateId = undefined;
        updateData.currentKraTemplateName = undefined;
      }
    }
    if (currentCtc !== undefined && currentCtc !== '') updateData.currentCtc = Number(currentCtc);
    if (currency !== undefined) updateData.currency = currency;
    if (confirmationDate !== undefined) updateData.confirmationDate = confirmationDate ? new Date(confirmationDate).toISOString() : undefined;
    if (gender !== undefined) updateData.gender = gender ? gender.trim() : undefined;
    if (employmentType !== undefined) updateData.employmentType = employmentType ? employmentType.trim() : undefined;
    if (probationPeriodDays !== undefined) updateData.probationPeriodDays = (probationPeriodDays !== '' && probationPeriodDays !== null) ? Number(probationPeriodDays) : undefined;
    if (companyName !== undefined) updateData.companyName = companyName ? companyName.trim() : undefined;

    // Handle employee code update with uniqueness check and cascade
    if (employeeCode !== undefined && employeeCode.trim() !== '') {
      const normalizedCode = employeeCode.trim().toUpperCase();
      if (normalizedCode !== emp.employeeCode) {
        const conflict = await empCol.findOne({ employeeCode: normalizedCode, id: { $ne: id } });
        if (conflict) {
          return res.status(400).json({ error: `Employee code ${normalizedCode} is already assigned to ${conflict.name}.` });
        }
        updateData.employeeCode = normalizedCode;
        // Cascade update to reviews and appraisals
        await reviewsCol.updateMany({ employeeId: id }, { $set: { employeeCode: normalizedCode } });
        await appraisalsCol.updateMany({ employeeId: id }, { $set: { employeeCode: normalizedCode } });
      }
    }

    if (departmentId !== undefined) {
      updateData.departmentId = departmentId;
      const dept = await deptCol.findOne({ id: departmentId });
      if (dept) updateData.departmentName = dept.name;
    }

    if (designationId !== undefined) {
      updateData.designationId = designationId;
      const des = await desCol.findOne({ id: designationId });
      if (des) updateData.designationName = des.name;
    }

    if (cycleId !== undefined) {
      updateData.cycleId = cycleId;
      const cycle = await cyclesCol.findOne({ id: cycleId });
      if (cycle) {
        updateData.cycleCode = cycle.code;
        updateData.cycleName = cycle.name;
        updateData.cycleColor = cycle.colorHex;
      }
    }

    if (startingReviewPeriodId !== undefined) {
      updateData.startingReviewPeriodId = startingReviewPeriodId;
      const startingPeriod = await getDbCollection('reviewPeriods').findOne({ id: startingReviewPeriodId });
      updateData.startingReviewPeriodName = startingPeriod?.name || undefined;
    }

    // Process custom employee KRAs if provided
    if (Array.isArray(customKras) && customKras.length > 0) {
      try {
        const kraTemplatesCol = getDbCollection('kraTemplates');
        const krasCol = getDbCollection('kras');
        const items = [];
        const targetDeptId = updateData.departmentId || emp.departmentId;
        const targetDesigId = updateData.designationId || emp.designationId;
        const targetCycleId = updateData.cycleId || emp.cycleId;

        // The custom scorecard form always submits its full, current row set, so
        // every save fully replaces this employee's KRA items. Look up the
        // existing employee-owned template up front so its old `kras` docs can
        // be cleaned up afterwards instead of being left as orphans.
        const existingTpl = await kraTemplatesCol.findOne({
          $or: [{ employeeId: emp.id }, { employeeCode: emp.employeeCode }],
        });
        const staleKraIds: string[] = (existingTpl?.items || [])
          .map((it: any) => it.kraId)
          .filter(Boolean);

        for (const k of customKras) {
          if (!k.title || !String(k.title).trim()) continue;
          const kId = `kra_${Math.random().toString(36).substr(2, 9)}`;
          const kraDoc = {
            id: kId,
            title: String(k.title).trim(),
            description: k.description || k.target || `Target for ${k.title}`,
            departmentId: targetDeptId,
            designationId: targetDesigId,
            cycleId: targetCycleId,
            metricType: 'PERCENTAGE',
            targetUnit: '%',
            active: true,
            createdAt: new Date().toISOString(),
          };
          await krasCol.insertOne(kraDoc);
          items.push({
            id: `item_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
            kraId: kId,
            title: String(k.title).trim(),
            description: k.description || k.target || '',
            target: String(k.target || '100% Target SLA'),
            weight: Number(k.weight || k.weightage) || 0,
            measurementCriteria: k.measurementCriteria || '% SLA: 1=Below, 3=Meets, 5=Exceeds',
          });
        }

        if (items.length > 0) {
          const totalWeight = items.reduce((s, it) => s + (Number(it.weight) || 0), 0);
          const tTitle = `${(updateData.name || emp.name).trim()} - Performance Scorecard`;

          if (existingTpl) {
            await kraTemplatesCol.updateOne(
              { id: existingTpl.id },
              {
                $set: {
                  title: tTitle,
                  items,
                  totalWeight,
                  departmentId: targetDeptId,
                  designationId: targetDesigId,
                  cycleId: targetCycleId,
                  updatedAt: new Date().toISOString(),
                },
              }
            );
            updateData.currentKraTemplateId = existingTpl.id;
            updateData.currentKraTemplateName = tTitle;
          } else {
            const newTplId = `kratpl_${Math.random().toString(36).substr(2, 9)}`;
            await kraTemplatesCol.insertOne({
              id: newTplId,
              title: tTitle,
              employeeId: emp.id,
              employeeCode: emp.employeeCode,
              employeeName: (updateData.name || emp.name).trim(),
              departmentId: targetDeptId,
              designationId: targetDesigId,
              cycleId: targetCycleId,
              totalWeight,
              items,
              active: true,
              createdAt: new Date().toISOString(),
            });
            updateData.currentKraTemplateId = newTplId;
            updateData.currentKraTemplateName = tTitle;
          }

          // The scorecard's items were just fully replaced above — remove the
          // previous items' standalone `kras` docs so they don't accumulate as
          // orphans with every edit.
          const newKraIds = new Set(items.map((it) => it.kraId));
          const kraIdsToDelete = staleKraIds.filter((kId) => !newKraIds.has(kId));
          if (kraIdsToDelete.length > 0) {
            await krasCol.deleteMany({ id: { $in: kraIdsToDelete } });
          }
        }
      } catch (kraErr) {
        console.warn('[MastersRoutes] Error updating custom employee KRA template:', kraErr);
      }
    }

    const targetDesId = designationId || emp.designationId;
    const currentDes = targetDesId ? await desCol.findOne({ id: targetDesId }) : null;
    const effectiveRole = systemRole || emp.systemRole;
    const isTargetHod =
      effectiveRole === 'HOD' ||
      Boolean(currentDes && (currentDes.level >= 4 || currentDes.name?.toLowerCase().includes('vp') || currentDes.name?.toLowerCase().includes('head')));
    const isTargetManager =
      effectiveRole === 'MANAGER' ||
      Boolean(currentDes && (currentDes.level >= 3 || currentDes.name?.toLowerCase().includes('manager') || currentDes.name?.toLowerCase().includes('lead')));

    if (managerId !== undefined) {
      if (!managerId && !isTargetHod && status !== 'INACTIVE' && emp.status !== 'INACTIVE') {
        return res.status(400).json({ error: 'Reporting Manager is required. Self-managed employees are not permitted.' });
      }
      if (managerId) {
        const mgr = await empCol.findOne({ id: managerId });
        if (!mgr) {
          return res.status(400).json({ error: 'Selected Reporting Manager was not found in the employee directory.' });
        }
        updateData.managerId = managerId;
        updateData.managerName = mgr.name;

        // Cascade manager update to open quarterly reviews
        await reviewsCol.updateMany(
          { employeeId: id, isClosed: { $ne: true }, status: { $ne: 'CLOSED' } },
          { $set: { managerId, managerName: mgr.name } }
        );
      } else {
        updateData.managerId = undefined;
        updateData.managerName = undefined;
      }
    }

    if (hodId !== undefined) {
      if (!hodId && !isTargetHod && status !== 'INACTIVE' && emp.status !== 'INACTIVE') {
        return res.status(400).json({ error: 'Head of Department (HOD) is required.' });
      }
      if (hodId) {
        const hod = await empCol.findOne({ id: hodId });
        if (!hod) {
          return res.status(400).json({ error: 'Selected Head of Department (HOD) was not found in the employee directory.' });
        }
        updateData.hodId = hodId;
        updateData.hodName = hod.name;
      } else {
        updateData.hodId = undefined;
        updateData.hodName = undefined;
      }
    }

    // Portal Login Access & Account Sync
    const existingUser =
      (await usersCol.findOne({ employeeId: id })) ||
      (await usersCol.findOne({ email: emp.email.toLowerCase().trim() }));

    if (provisionLogin !== undefined) {
      const isLoginEnabled = Boolean(provisionLogin);
      updateData.hasLoginAccount = isLoginEnabled;
      updateData.userActive = isLoginEnabled && status !== 'INACTIVE';

      if (isLoginEnabled) {
        const assignedRole: UserRole = systemRole || existingUser?.role || 'EMPLOYEE';
        updateData.systemRole = assignedRole;

        if (existingUser) {
          const userPatch: any = {
            active: status !== 'INACTIVE',
            employeeId: id,
            role: assignedRole,
            roleId: `role_${assignedRole.toLowerCase()}`,
          };
          if (updateData.email) userPatch.email = updateData.email;
          if (updateData.name) userPatch.name = updateData.name;
          if (initialPassword && initialPassword.trim().length >= 6) {
            userPatch.passwordHash = bcrypt.hashSync(initialPassword.trim(), 10);
            userPatch.mustChangePassword = true;
          }
          await usersCol.updateOne({ id: existingUser.id }, { $set: userPatch });
        } else {
          // Provision a new user
          const targetEmail = (updateData.email || emp.email).trim().toLowerCase();
          const targetName = (updateData.name || emp.name).trim();
          const tempPassword =
            initialPassword && initialPassword.trim().length >= 6
              ? initialPassword.trim()
              : generateTempPassword();
          const defaultHash = bcrypt.hashSync(tempPassword, 10);

          await usersCol.insertOne({
            id: `usr_${emp.id}`,
            employeeId: emp.id,
            email: targetEmail,
            name: targetName,
            role: assignedRole,
            roleId: `role_${assignedRole.toLowerCase()}`,
            active: status !== 'INACTIVE',
            passwordHash: defaultHash,
            mustChangePassword: true,
            createdAt: new Date().toISOString(),
          });
        }
      } else {
        // Deactivate login
        if (existingUser) {
          await usersCol.updateOne({ id: existingUser.id }, { $set: { active: false } });
        }
      }
    } else {
      if (systemRole) {
        updateData.systemRole = systemRole;
        if (existingUser) {
          await usersCol.updateOne(
            { id: existingUser.id },
            { $set: { role: systemRole, roleId: `role_${systemRole.toLowerCase()}` } }
          );
        }
      }
    }

    if (relievingDate !== undefined || pastEmployeeDate !== undefined) {
      const exitDate = relievingDate || pastEmployeeDate;
      updateData.relievingDate = exitDate ? new Date(exitDate).toISOString() : undefined;
      updateData.pastEmployeeDate = exitDate ? new Date(exitDate).toISOString() : undefined;
    }

    const unsetFields: any = {};
    if (status !== undefined) {
      if (status === 'INACTIVE') {
        updateData.isPastEmployee = true;
        if (!updateData.relievingDate && !emp.relievingDate && !emp.pastEmployeeDate) {
          const now = new Date().toISOString();
          updateData.relievingDate = now;
          updateData.pastEmployeeDate = now;
        }
        if (existingUser) {
          await usersCol.updateOne({ id: existingUser.id }, { $set: { active: false } });
          updateData.hasLoginAccount = false;
          updateData.userActive = false;
        }
      } else if (status === 'ACTIVE' || status === 'PROBATION') {
        updateData.isPastEmployee = false;
        unsetFields.relievingDate = '';
        unsetFields.pastEmployeeDate = '';
        delete updateData.relievingDate;
        delete updateData.pastEmployeeDate;
        if (existingUser && provisionLogin !== false) {
          await usersCol.updateOne({ id: existingUser.id }, { $set: { active: true } });
          updateData.hasLoginAccount = true;
          updateData.userActive = true;
        }
      }
    }

    if (email !== undefined || name !== undefined) {
      const userUpdate: any = {};
      if (email) userUpdate.email = email.trim().toLowerCase();
      if (name) userUpdate.name = name.trim();
      if (existingUser) {
        await usersCol.updateOne({ id: existingUser.id }, { $set: userUpdate });
      }
    }

    const updateOps: any = { $set: updateData };
    if (Object.keys(unsetFields).length > 0) {
      updateOps.$unset = unsetFields;
    }
    await empCol.updateOne({ id }, updateOps);
    invalidateAuthCache(id);
    if (existingUser?.id) {
      invalidateAuthCache(existingUser.id);
      if (status === 'INACTIVE') {
        await revokeUserSessions(existingUser.id);
      }
    }
    const updated = await empCol.findOne({ id });

    // Sync updated manager / HOD / department / CTC across existing reviews and appraisals
    if (updated) {
      await syncEmployeeAppraisalsAndReviews(updated);
    }

    // If this request (re)assigned a KRA scorecard, push it into any not-yet-scored
    // review that was created before this assignment and is still showing stale/fallback KRAs.
    if (updateData.currentKraTemplateId !== undefined) {
      await resyncUnscoredReviewKraSnapshots(id);
    }

    if (req.user) {
      await recordAuditLog(
        req.user.id,
        req.user.name,
        req.user.role,
        'EMPLOYEE_MASTER',
        'UPDATE_EMPLOYEE',
        id,
        JSON.stringify(emp),
        JSON.stringify(updated),
        `Updated employee ${emp.employeeCode} (${emp.name})`
      );
    }

    const finalUser =
      (await usersCol.findOne({ employeeId: id })) ||
      (await usersCol.findOne({ email: (updated.email || '').toLowerCase().trim() }));

    const enriched = {
      ...updated,
      hasLoginAccount: !!(finalUser && finalUser.active !== false),
      userActive: finalUser ? finalUser.active !== false : false,
      systemRole: finalUser?.role || updated.systemRole,
      userId: finalUser?.id,
    };

    res.json(enriched);
  } catch (error: any) {
    console.error('Error updating employee:', error);
    if (error.code === 11000 || error.message?.includes('E11000 duplicate key error')) {
      const keyPattern = error.keyPattern || {};
      if (keyPattern.email || error.message?.includes('email')) {
        return res.status(400).json({ error: 'This email address is already in use by another user or employee.' });
      }
      if (keyPattern.employeeCode || error.message?.includes('employeeCode')) {
        return res.status(400).json({ error: 'This employee code is already assigned to another employee.' });
      }
      return res.status(400).json({ error: 'Duplicate record error: a unique constraint was violated.' });
    }
    res.status(500).json({ error: error.message || 'Failed to update employee record.' });
  }
});

/**
 * DELETE /api/employees/:id
 * Super Admin only - Deletes all associated data for an employee (reviews, appraisals, feedback,
 * login credentials, manager linkages), while preserving their core profile details archived as a "Past Employee"
 * in the employee directory.
 */
mastersRouter.delete('/employees/:id', requireRoles('SUPER_ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const empCol = getDbCollection('employees');
    const deptCol = getDbCollection('departments');
    const usersCol = getDbCollection('users');
    const reviewsCol = getDbCollection('employeeReviews');
    const appraisalsCol = getDbCollection('appraisals');
    const feedbackCol = getDbCollection('feedback' as any);
    const notifCol = getDbCollection('notifications');

    const emp = await empCol.findOne({ id });
    if (!emp) {
      return res.status(404).json({ error: 'Employee not found.' });
    }

    // 1. Delete all employee reviews
    await reviewsCol.deleteMany({ employeeId: id });

    // 2. Delete all annual appraisals
    await appraisalsCol.deleteMany({ employeeId: id });

    // 3. Delete all 360 feedback
    await feedbackCol.deleteMany({
      $or: [{ employeeId: id }, { requestedBy: id }, { reviewerId: id }],
    });

    // 4. Delete notifications for this employee / user
    const orNotif: any[] = [{ employeeId: id }];
    if (emp.userId) orNotif.push({ userId: emp.userId });
    await notifCol.deleteMany({ $or: orNotif });

    // 5. Delete login account from users collection so portal access is revoked
    const userOrConditions: any[] = [{ employeeId: id }];
    if (emp.userId) userOrConditions.push({ id: emp.userId });
    if (emp.email) userOrConditions.push({ email: emp.email.toLowerCase().trim() });
    await usersCol.deleteMany({ $or: userOrConditions });

    // 5b. Delete this employee's own KRA scorecard (it is never shared with
    // another employee, so it's always safe to remove alongside them) and the
    // standalone `kras` docs its items reference.
    const kraTemplatesCol = getDbCollection('kraTemplates');
    const krasCol = getDbCollection('kras');
    const ownedTemplates = await (await kraTemplatesCol.find({
      $or: [{ employeeId: id }, { employeeCode: emp.employeeCode }],
    })).toArray();
    if (ownedTemplates.length > 0) {
      const ownedKraIds = ownedTemplates.flatMap((t: any) => (t.items || []).map((it: any) => it.kraId).filter(Boolean));
      if (ownedKraIds.length > 0) {
        await krasCol.deleteMany({ id: { $in: ownedKraIds } });
      }
      await kraTemplatesCol.deleteMany({ id: { $in: ownedTemplates.map((t: any) => t.id) } });
    }

    // 6. Unassign this employee as reporting manager or HOD for any other employees
    await empCol.updateMany(
      { managerId: id },
      { $set: { managerId: undefined, managerName: 'Unassigned' } }
    );
    await empCol.updateMany(
      { hodId: id },
      { $set: { hodId: undefined, hodName: 'Unassigned' } }
    );
    // Unassign this employee as designated HOD on departments
    await deptCol.updateMany(
      { hodId: id },
      { $set: { hodId: undefined, hodName: 'Unassigned' } }
    );

    // 7. Update employee record: archive as Past Employee with status INACTIVE
    const archivedDate = new Date().toISOString();
    await empCol.updateOne(
      { id },
      {
        $set: {
          status: 'INACTIVE',
          isPastEmployee: true,
          pastEmployeeDate: archivedDate,
          relievingDate: archivedDate,
          hasLoginAccount: false,
          userActive: false,
          userId: undefined,
          managerId: undefined,
          managerName: 'Unassigned',
          hodId: undefined,
          hodName: 'Unassigned',
          currentKraTemplateId: undefined,
          currentKraTemplateName: undefined,
          updatedAt: archivedDate,
        },
      }
    );

    // Invalidate auth cache and revoke sessions
    invalidateAuthCache(id);
    if (emp.userId) {
      invalidateAuthCache(emp.userId);
      await revokeUserSessions(emp.userId);
    }

    // 8. Record audit log entry
    if (req.user) {
      await recordAuditLog(
        req.user.id,
        req.user.name,
        req.user.role,
        'EMPLOYEE_MASTER',
        'DELETE_EMPLOYEE_DATA',
        id,
        emp.status,
        'INACTIVE',
        `Deleted reviews, appraisals, feedback, and login account for ${emp.name} (${emp.employeeCode}). Archived profile as Past Employee.`
      );
    }

    res.json({
      success: true,
      message: `Employee "${emp.name}" (${emp.employeeCode}) was successfully archived as a Past Employee. All reviews, appraisals, and login credentials have been deleted.`,
    });
  } catch (error: any) {
    console.error('Error deleting employee data:', error);
    res.status(500).json({ error: error.message || 'Failed to delete employee data.' });
  }
});

/**
 * POST /api/masters/normalize-employee-codes
 * Scans all employees, fixes any inconsistent / jumped employee codes (e.g. EMP-113 -> EMP-012, EMP-114 -> EMP-013),
 * and cascades updates to employeeReviews, appraisals, and audit logs.
 */
mastersRouter.post('/masters/normalize-employee-codes', requireRoles('SUPER_ADMIN', 'HR'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const empCol = getDbCollection('employees');
    const reviewsCol = getDbCollection('employeeReviews');
    const appraisalsCol = getDbCollection('appraisals');

    const allEmps = await empCol.find({}).sort({ joiningDate: 1, createdAt: 1 }).toArray();

    // Specific mapping for known outliers caused by the previous +100 formula jump:
    const codeMap: Record<string, string> = {
      'EMP-113': 'EMP-012',
      'EMP-114': 'EMP-013',
    };

    const changes: Array<{ id: string; name: string; oldCode: string; newCode: string }> = [];

    for (const emp of allEmps) {
      const targetCode = codeMap[emp.employeeCode];
      if (targetCode && emp.employeeCode !== targetCode) {
        const conflict = await empCol.findOne({ employeeCode: targetCode, id: { $ne: emp.id } });
        if (!conflict) {
          const oldCode = emp.employeeCode;
          // 1. Update employee collection
          await empCol.updateOne({ id: emp.id }, { $set: { employeeCode: targetCode } });
          // 2. Cascade update to reviews
          await reviewsCol.updateMany({ employeeId: emp.id }, { $set: { employeeCode: targetCode } });
          // 3. Cascade update to appraisals
          await appraisalsCol.updateMany({ employeeId: emp.id }, { $set: { employeeCode: targetCode } });

          changes.push({
            id: emp.id,
            name: emp.name,
            oldCode,
            newCode: targetCode,
          });

          if (req.user) {
            await recordAuditLog(
              req.user.id,
              req.user.name,
              req.user.role,
              'EMPLOYEE_MASTER',
              'NORMALIZE_EMPLOYEE_CODE',
              emp.id,
              oldCode,
              targetCode,
              `Normalized employee code from ${oldCode} to ${targetCode} for ${emp.name}`
            );
          }
        }
      }
    }

    res.json({
      success: true,
      message: `Successfully normalized ${changes.length} employee code(s).`,
      changes,
    });
  } catch (error: any) {
    console.error('Error normalizing employee codes:', error);
    res.status(500).json({ error: 'Failed to normalize employee codes.' });
  }
});

// ==========================================
// 6. AUTOMATED NOTIFICATIONS & WORKFLOW HUB
// ==========================================

/**
 * Helper to check if a notification's underlying workflow task is completed.
 * If completed, the notification is automatically resolved and removed from the active view.
 */
/**
 * Helper to check if a specific notification target is completed (optional hint)
 */
async function isNotificationTargetCompleted(notif: any): Promise<boolean> {
  try {
    const appraisalsCol = getDbCollection('appraisals');
    const reviewsCol = getDbCollection('employeeReviews');

    if (notif.metadata?.appraisalId) {
      const appr = await appraisalsCol.findOne({ id: notif.metadata.appraisalId });
      if (appr && (appr.status === 'LOCKED' && appr.employeeAcknowledgement?.acknowledged)) {
        return true;
      }
    }

    if (notif.metadata?.reviewId) {
      const rev = await reviewsCol.findOne({ id: notif.metadata.reviewId });
      if (rev && rev.status === 'HR_COMPLETED') {
        return true;
      }
    }

    return false;
  } catch (err) {
    return false;
  }
}

/**
 * Auto-syncs and auto-resolves workflow notifications for a user before they're read —
 * creates/resolves self-assessment reminders and clears stale review-action notifications
 * once their underlying review has moved on. Shared by both the full list and the
 * lightweight unread-count endpoint below, so their side effects and results never drift
 * out of sync with each other.
 */
async function runNotificationAutoSync(currentUser: User): Promise<void> {
  const notifsCol = getDbCollection('notifications');

  // Auto-sync self-assessment notifications for current user/employee with pending reviews
  const targetEmpId = currentUser.employeeId || (currentUser.role === 'EMPLOYEE' ? currentUser.id : null);
  if (targetEmpId) {
    try {
      const reviewsCol = getDbCollection('employeeReviews');
      const pendingReviews: any[] = await (
        await reviewsCol.find({
          $or: [{ employeeId: targetEmpId }, { employeeId: currentUser.id }],
          isClosed: { $ne: true },
          status: { $in: ['ASSIGNED', 'DRAFT', 'MANAGER_PENDING', 'SELF_ASSESSMENT_DUE', 'OPEN'] },
          isSelfSubmitted: { $ne: true },
        })
      ).toArray();

      for (const rev of pendingReviews) {
        const notifId = `notif_self_assess_${rev.id}`;
        const existingNotif = await notifsCol.findOne({
          $or: [
            { id: notifId },
            {
              'metadata.reviewId': rev.id,
              userId: { $in: [targetEmpId, currentUser.id] },
              type: 'REVIEW_ASSIGNED',
            },
          ],
        });

        if (!existingNotif) {
          await notifsCol.insertOne({
            id: notifId,
            userId: targetEmpId,
            userRole: 'EMPLOYEE',
            type: 'REVIEW_ASSIGNED',
            title: `Self-Assessment Due: ${rev.reviewPeriodName || 'Quarterly Review'}`,
            message: `Your quarterly performance self-assessment for ${rev.reviewPeriodName || 'this cycle'} is pending. Complete your ratings and submit your self-evaluation.`,
            isRead: false,
            priority: 'HIGH',
            metadata: {
              reviewId: rev.id,
              periodId: rev.reviewPeriodId,
              subTab: 'reviews',
              openSelfAssess: true,
            },
            createdAt: new Date().toISOString(),
          });
        }
      }

      // If employee has already submitted, ensure the self-assessment notification is marked as read
      const completedReviews: any[] = await (
        await reviewsCol.find({
          $and: [
            { $or: [{ employeeId: targetEmpId }, { employeeId: currentUser.id }] },
            { $or: [{ isSelfSubmitted: true }, { isClosed: true }] },
          ],
        })
      ).toArray();

      for (const rev of completedReviews) {
        await notifsCol.updateMany(
          {
            userId: { $in: [targetEmpId, currentUser.id] },
            'metadata.reviewId': rev.id,
            type: 'REVIEW_ASSIGNED',
            isRead: false,
          },
          {
            $set: { isRead: true },
          }
        );
      }
    } catch (syncErr) {
      console.warn('[Notifications] Error auto-syncing employee self-assessment notifs:', syncErr);
    }
  }

  // Auto-resolve stale workflow review notifications across all roles (HR, HOD, Managers, Employees)
  try {
    const reviewsCol = getDbCollection('employeeReviews');

    // 1. If reviews are completed / closed, resolve all pending review action notifications
    const closedOrCompletedReviews: any[] = await (
      await reviewsCol.find({
        $or: [{ isClosed: true }, { status: 'CLOSED' }],
      })
    ).toArray();

    if (closedOrCompletedReviews.length > 0) {
      const closedReviewIds = closedOrCompletedReviews.map((r) => r.id);
      await notifsCol.updateMany(
        {
          'metadata.reviewId': { $in: closedReviewIds },
          type: { $in: ['MANAGER_SUBMITTED', 'HOD_ACTION_REQUIRED', 'HOD_APPROVED', 'RETURNED', 'REVIEW_ASSIGNED'] },
          isRead: false,
        },
        {
          $set: { isRead: true },
        }
      );
    }

    // 2. If review is no longer pending HR approval (status is not HR_PENDING or SUBMITTED), resolve MANAGER_SUBMITTED and HOD_APPROVED
    const nonHrPendingReviews: any[] = await (
      await reviewsCol.find({
        status: { $nin: ['HR_PENDING', 'SUBMITTED'] },
      })
    ).toArray();

    if (nonHrPendingReviews.length > 0) {
      const nonHrPendingIds = nonHrPendingReviews.map((r) => r.id);
      await notifsCol.updateMany(
        {
          'metadata.reviewId': { $in: nonHrPendingIds },
          type: { $in: ['MANAGER_SUBMITTED', 'HOD_APPROVED'] },
          isRead: false,
        },
        {
          $set: { isRead: true },
        }
      );
    }
  } catch (syncErr) {
    console.warn('[Notifications] Error auto-syncing completed review workflow notifications:', syncErr);
  }
}

/**
 * Resolves the exact, role-scoped, deduplicated notification list a user is allowed to see —
 * the single source of truth for both GET /notifications (full list) and
 * GET /notifications/unread-count (badge count), so the count can never drift from what the
 * list endpoint actually shows.
 */
async function computeVisibleNotifications(currentUser: User): Promise<any[]> {
  const notifsCol = getDbCollection('notifications');

  await runNotificationAutoSync(currentUser);

  const isSuperAdmin = currentUser.role === 'SUPER_ADMIN';

  let filter: any = {};
  if (!isSuperAdmin) {
    const orClauses: any[] = [
      { userId: currentUser.id },
      { userId: 'ALL' },
      { userId: null },
      { userRole: 'ALL' },
      { userRole: currentUser.role },
    ];
    if (currentUser.employeeId) {
      orClauses.push({ userId: currentUser.employeeId });
    }
    filter = { $or: orClauses };
  }

  // Direct database query with sort and limit 100
  const rawNotifications: any = await notifsCol.find(filter);
  const notifications: any[] = Array.isArray(rawNotifications)
    ? rawNotifications
    : typeof rawNotifications?.toArray === 'function'
      ? await rawNotifications.toArray()
      : [];

  let filtered: any[] = notifications;

  if (isSuperAdmin) {
    filtered = notifications.filter((n) => {
      // Exclude individual employee private notifications unless specifically for admin
      if (n.userRole === 'EMPLOYEE' && n.userId !== currentUser.id) return false;
      if (n.type === 'HR_COMPLETED') return false;
      if (n.title && n.title.toLowerCase().includes('self-assessment due')) return false;
      if (n.message && n.message.toLowerCase().includes('your quarterly performance')) return false;
      if (n.type === 'LETTER_RELEASED' && n.userId !== currentUser.id) return false;

      // Admin has oversight over administrative, management, HR, HOD, and global alerts
      if (['SUPER_ADMIN', 'ADMIN', 'HR', 'MANAGEMENT', 'HOD', 'ALL'].includes(n.userRole) || !n.userRole) {
        return true;
      }
      return false;
    });
  } else {
    filtered = notifications.filter((n) => {
      // Direct target match by user ID or employee ID (private notification)
      const isDirectUserMatch = n.userId === currentUser.id;
      const isDirectEmpMatch = Boolean(currentUser.employeeId && n.userId === currentUser.employeeId);
      if (isDirectUserMatch || isDirectEmpMatch) {
        return true;
      }

      // Direct target match by userRole (e.g. HR, MANAGEMENT)
      if (n.userRole === currentUser.role) {
        // If a specific userId is designated and it does not match this user, don't show it
        if (n.userId && n.userId !== 'ALL' && n.userId !== currentUser.id && (!currentUser.employeeId || n.userId !== currentUser.employeeId)) {
          return false;
        }
        return true;
      }

      // Broadcast notifications targeted to ALL or broad role queues
      if (n.userId === 'ALL' || !n.userId) {
        if (!n.userRole || n.userRole === 'ALL' || n.userRole === currentUser.role) {
          return true;
        }
        return false;
      }

      // Shared administrative queues (HR and Executive Management shared pools)
      if (currentUser.role === 'HR' && n.userRole === 'HR' && (n.userId === 'ALL' || (typeof n.userId === 'string' && n.userId.includes('hr')))) {
        return true;
      }
      if (currentUser.role === 'MANAGEMENT' && n.userRole === 'MANAGEMENT' && (n.userId === 'ALL' || (typeof n.userId === 'string' && n.userId.includes('mgmt')))) {
        return true;
      }

      return false;
    });
  }

  // Deduplicate by notification id or (userId + type + metadata.reviewId/periodId)
  const seenNotifs = new Set<string>();
  const deduplicated: any[] = [];
  for (const notif of filtered) {
    const dedupeKey = notif.id || `${notif.userId}_${notif.type}_${notif.metadata?.reviewId || notif.metadata?.periodId || notif.title}`;
    if (!seenNotifs.has(dedupeKey)) {
      seenNotifs.add(dedupeKey);
      deduplicated.push(notif);
    }
  }

  // Sort newest first & limit to top 100
  deduplicated.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  return deduplicated.length > 100 ? deduplicated.slice(0, 100) : deduplicated;
}

/**
 * GET /api/notifications
 * List actionable in-app workflow notifications for current user/role
 */
mastersRouter.get('/notifications', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const currentUser = req.user;
    if (!currentUser) {
      return res.json([]);
    }
    const filtered = await computeVisibleNotifications(currentUser);
    res.json(filtered);
  } catch (error: any) {
    console.error('Failed to fetch notifications:', error);
    res.status(500).json({ error: 'Failed to fetch workflow notifications.' });
  }
});

/**
 * GET /api/notifications/unread-count
 * Lightweight badge-count endpoint — same visibility rules as GET /notifications, but
 * returns only a number instead of the full (up to 100-item) payload. Built for frequent
 * polling (e.g. the header bell) without the network/parsing cost of the full list.
 */
mastersRouter.get('/notifications/unread-count', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const currentUser = req.user;
    if (!currentUser) {
      return res.json({ unreadCount: 0 });
    }
    const filtered = await computeVisibleNotifications(currentUser);
    const unreadCount = filtered.filter((n) => !n.isRead).length;
    res.json({ unreadCount });
  } catch (error: any) {
    console.error('Failed to fetch unread notification count:', error);
    res.status(500).json({ error: 'Failed to fetch unread notification count.' });
  }
});

/**
 * POST /api/notifications
 * Push a new in-app workflow notification
 */
mastersRouter.post('/notifications', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const notifsCol = getDbCollection('notifications');
    const { userId, userRole, type, title, message, priority, metadata, linkUrl } = req.body;

    if (!title || !message) {
      return res.status(400).json({ error: 'Title and message are required.' });
    }

    const newNotif = {
      id: `notif_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      userId: userId || 'ALL',
      userRole: userRole || undefined,
      type: type || 'APPRAISAL_DUE',
      title,
      message,
      isRead: false,
      priority: priority || 'MEDIUM',
      linkUrl: linkUrl || undefined,
      metadata: metadata || {},
      createdAt: new Date().toISOString(),
    };

    await notifsCol.insertOne(newNotif);
    res.status(201).json(newNotif);
  } catch (error: any) {
    console.error('Failed to create notification:', error);
    res.status(500).json({ error: 'Failed to create notification.' });
  }
});

/**
 * DELETE /api/notifications/:id
 * Remove or dismiss a notification once target action or user dismisses it
 */
mastersRouter.delete('/notifications/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const notifsCol = getDbCollection('notifications');
    await notifsCol.deleteMany({ $or: [{ id }, { _id: id }] });
    res.json({ success: true, id, message: 'Notification removed.' });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to delete notification.' });
  }
});

/**
 * POST /api/notifications/:id/complete
 * Explicitly mark target workflow as completed and remove notification
 */
mastersRouter.post('/notifications/:id/complete', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const notifsCol = getDbCollection('notifications');
    await notifsCol.deleteMany({ $or: [{ id }, { _id: id }] });
    res.json({ success: true, id, message: 'Target task completed. Notification automatically removed.' });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to complete notification.' });
  }
});

/**
 * PUT /api/notifications/:id/read
 * Mark notification as read
 */
mastersRouter.put('/notifications/:id/read', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const notifsCol = getDbCollection('notifications');
    await notifsCol.updateMany({ $or: [{ id }, { _id: id }] }, { $set: { isRead: true } });
    res.json({ success: true, id });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to mark notification as read.' });
  }
});

/**
 * PUT /api/notifications/read-all
 * Mark all notifications as read for current user
 */
mastersRouter.put('/notifications/read-all', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const notifsCol = getDbCollection('notifications');
    const currentUser = req.user;

    if (currentUser) {
      const matchCriteria: any[] = [
        { userId: currentUser.id },
        { userId: 'ALL' },
      ];
      if (currentUser.employeeId) {
        matchCriteria.push({ userId: currentUser.employeeId });
      }
      if (currentUser.role) {
        matchCriteria.push({ userRole: currentUser.role });
      }
      await notifsCol.updateMany({ $or: matchCriteria }, { $set: { isRead: true } });
    } else {
      await notifsCol.updateMany({}, { $set: { isRead: true } });
    }

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to mark all notifications as read.' });
  }
});

