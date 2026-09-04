import express, { Response } from 'express';
import bcrypt from 'bcryptjs';
import { getDbCollection } from '../db.js';
import { authenticateToken, requireRoles, recordAuditLog, AuthenticatedRequest } from '../auth.js';
import { Employee, Department, Designation, Cycle, User, UserRole } from '../../src/types.js';

export const mastersRouter = express.Router();

// Apply auth middleware to all master routes
mastersRouter.use(authenticateToken);

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
    const { name, code, hodId, hodName } = req.body;
    if (!name || !code) {
      return res.status(400).json({ error: 'Department name and code are required.' });
    }

    const deptCol = getDbCollection('departments');
    const existing = await deptCol.findOne({ code: code.toUpperCase().trim() });
    if (existing) {
      return res.status(400).json({ error: `Department code ${code} already exists.` });
    }

    const newDept: Department = {
      id: `dept_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      name: name.trim(),
      code: code.toUpperCase().trim(),
      hodId: hodId || undefined,
      hodName: hodName || undefined,
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
        `Created department ${newDept.name} (${newDept.code})`
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
    const { name, code, hodId, hodName, active } = req.body;

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

// ==========================================
// 3. CYCLES (8-Cycle Framework)
// ==========================================

/**
 * GET /api/cycles
 */
mastersRouter.get('/cycles', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const cyclesCol = getDbCollection('cycles');
    const cycles = await (await cyclesCol.find({})).toArray();
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

    // If logged in as Manager and not Super Admin/HR/Management, manager sees team + own
    if (req.user?.role === 'MANAGER' && req.employeeProfile) {
      allEmployees = allEmployees.filter(
        (e) => e.managerId === req.employeeProfile?.id || e.id === req.employeeProfile?.id
      );
    }

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
    const defaultCtcMap: Record<string, number> = {
      emp_exec_mgmt: 4500000,
      emp_hod_eng: 3600000,
      emp_hod_sales: 3200000,
      emp_mgr_eng: 2400000,
      emp_dev_1: 1800000,
      emp_hr_lead: 1750000,
      emp_admin: 1600000,
      emp_sales_1: 1350000,
      emp_dev_2: 1100000,
    };

    allEmployees.forEach((e) => {
      if (!e.currentCtc || e.currentCtc === 0) {
        e.currentCtc = defaultCtcMap[e.id] || 1600000;
      }
      if (!e.currency) {
        e.currency = '₹';
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
 */
mastersRouter.get('/employees/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const empCol = getDbCollection('employees');
    const employee = await empCol.findOne({ id });
    if (!employee) {
      return res.status(404).json({ error: 'Employee not found.' });
    }
    res.json(employee);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch employee details.' });
  }
});

/**
 * POST /api/employees
 * Admin/HR creates employee and assigns Manager, HOD, and 8-Cycle appraisal group
 */
mastersRouter.post('/employees', requireRoles('SUPER_ADMIN', 'HR'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      employeeCode,
      name,
      email,
      departmentId,
      designationId,
      joiningDate,
      managerId,
      hodId,
      cycleId,
      currentKraTemplateId,
      status,
    } = req.body;

    if (!employeeCode || !name || !email || !departmentId || !designationId || !joiningDate || !cycleId) {
      return res.status(400).json({
        error: 'Required fields missing: employeeCode, name, email, departmentId, designationId, joiningDate, cycleId',
      });
    }

    const empCol = getDbCollection('employees');
    const deptCol = getDbCollection('departments');
    const desCol = getDbCollection('designations');
    const cyclesCol = getDbCollection('cycles');

    // Check code/email uniqueness
    const existingCode = await empCol.findOne({ employeeCode: employeeCode.trim().toUpperCase() });
    if (existingCode) {
      return res.status(400).json({ error: `Employee code ${employeeCode} is already registered.` });
    }
    const existingEmail = await empCol.findOne({ email: email.trim().toLowerCase() });
    if (existingEmail) {
      return res.status(400).json({ error: `Email ${email} is already in use.` });
    }

    // Fetch related names
    const dept = await deptCol.findOne({ id: departmentId });
    const des = await desCol.findOne({ id: designationId });
    const cycle = await cyclesCol.findOne({ id: cycleId });

    let managerName: string | undefined;
    if (managerId) {
      const mgr = await empCol.findOne({ id: managerId });
      if (mgr) managerName = mgr.name;
    }

    let hodName: string | undefined;
    if (hodId) {
      const hod = await empCol.findOne({ id: hodId });
      if (hod) hodName = hod.name;
    }

    const newEmp: Employee = {
      id: `emp_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      employeeCode: employeeCode.trim().toUpperCase(),
      name: name.trim(),
      email: email.trim().toLowerCase(),
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
      cycleCode: cycle?.code || 'A',
      cycleName: cycle?.name || 'Cycle A',
      cycleColor: cycle?.colorHex || '#1e3a8a',
      currentKraTemplateId: currentKraTemplateId || undefined,
      currentCtc: req.body.currentCtc ? Number(req.body.currentCtc) : 1600000,
      currency: req.body.currency || '₹',
      status: status || 'ACTIVE',
      createdAt: new Date().toISOString(),
    };

    await empCol.insertOne(newEmp);

    // Auto-provision user account for login
    try {
      const usersCol = getDbCollection('users');
      const existingUser = await usersCol.findOne({ email: newEmp.email });
      if (!existingUser) {
        let inferredRole: UserRole = 'EMPLOYEE';
        const desigLower = (des?.name || '').toLowerCase();
        if (desigLower.includes('hr manager') || desigLower.includes('hr lead')) inferredRole = 'HR';
        else if (desigLower.includes('manager') || desigLower.includes('lead')) inferredRole = 'MANAGER';
        else if (desigLower.includes('vp') || desigLower.includes('director') || desigLower.includes('hod')) inferredRole = 'HOD';

        const defaultHash = bcrypt.hashSync('password123', 10);
        await usersCol.insertOne({
          id: `usr_${newEmp.id}`,
          employeeId: newEmp.id,
          email: newEmp.email,
          name: newEmp.name,
          role: inferredRole,
          roleId: `role_${inferredRole.toLowerCase()}`,
          active: true,
          passwordHash: defaultHash,
          createdAt: new Date().toISOString(),
        });
      }
    } catch (userErr) {
      console.warn('Could not auto-provision user login entry for employee:', userErr);
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
        `Created employee record ${newEmp.employeeCode} - ${newEmp.name} (Assigned Cycle ${newEmp.cycleCode})`
      );
    }

    res.status(201).json(newEmp);
  } catch (error: any) {
    console.error('Error creating employee:', error);
    res.status(500).json({ error: 'Failed to create employee record.' });
  }
});

/**
 * PUT /api/employees/:id
 * Update employee details, department transfer, or manager reassignment
 */
mastersRouter.put('/employees/:id', requireRoles('SUPER_ADMIN', 'HR'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const {
      name,
      email,
      departmentId,
      designationId,
      joiningDate,
      managerId,
      hodId,
      cycleId,
      currentKraTemplateId,
      status,
    } = req.body;

    const empCol = getDbCollection('employees');
    const deptCol = getDbCollection('departments');
    const desCol = getDbCollection('designations');
    const cyclesCol = getDbCollection('cycles');

    const emp = await empCol.findOne({ id });
    if (!emp) {
      return res.status(404).json({ error: 'Employee not found.' });
    }

    const updateData: Partial<Employee> = {};
    if (name !== undefined) updateData.name = name.trim();
    if (email !== undefined) updateData.email = email.trim().toLowerCase();
    if (joiningDate !== undefined) updateData.joiningDate = new Date(joiningDate).toISOString();
    if (status !== undefined) updateData.status = status;
    if (currentKraTemplateId !== undefined) updateData.currentKraTemplateId = currentKraTemplateId;
    if (req.body.currentCtc !== undefined) updateData.currentCtc = Number(req.body.currentCtc);
    if (req.body.currency !== undefined) updateData.currency = req.body.currency;

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

    if (managerId !== undefined) {
      updateData.managerId = managerId || undefined;
      if (managerId) {
        const mgr = await empCol.findOne({ id: managerId });
        updateData.managerName = mgr?.name;
      } else {
        updateData.managerName = undefined;
      }
    }

    if (hodId !== undefined) {
      updateData.hodId = hodId || undefined;
      if (hodId) {
        const hod = await empCol.findOne({ id: hodId });
        updateData.hodName = hod?.name;
      } else {
        updateData.hodName = undefined;
      }
    }

    await empCol.updateOne({ id }, { $set: updateData });
    const updated = await empCol.findOne({ id });

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

    res.json(updated);
  } catch (error: any) {
    console.error('Error updating employee:', error);
    res.status(500).json({ error: 'Failed to update employee record.' });
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
 * GET /api/notifications
 * List actionable in-app workflow notifications for current user/role
 */
mastersRouter.get('/notifications', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const notifsCol = getDbCollection('notifications');
    const notifications: any[] = await (await notifsCol.find({})).toArray();

    const currentUser = req.user;
    let filtered: any[] = notifications;

    if (currentUser) {
      filtered = notifications.filter((n) => {
        // 1. If notification specifically targets a userId
        if (n.userId && n.userId !== 'ALL') {
          const isUserMatch = n.userId === currentUser.id;
          const isEmpMatch = currentUser.employeeId && n.userId === currentUser.employeeId;
          return isUserMatch || isEmpMatch;
        }

        // 2. If notification targets ALL users
        if (n.userId === 'ALL') {
          if (!n.userRole || n.userRole === currentUser.role) return true;
        }

        // 3. Broadcast to a specific role with no specific userId
        if (!n.userId && n.userRole && n.userRole === currentUser.role) {
          return true;
        }

        // 4. Super Admin can see system-level broadcast alerts
        if (currentUser.role === 'SUPER_ADMIN' && (!n.userId || n.userId === 'ALL')) {
          return true;
        }

        return false;
      });
    }

    // Sort newest first
    filtered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    res.json(filtered);
  } catch (error: any) {
    console.error('Failed to fetch notifications:', error);
    res.status(500).json({ error: 'Failed to fetch workflow notifications.' });
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
    await notifsCol.deleteOne({ id });
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
    await notifsCol.deleteOne({ id });
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
    await notifsCol.updateOne({ id }, { $set: { isRead: true } });
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

