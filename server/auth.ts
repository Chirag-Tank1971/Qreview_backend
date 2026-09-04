import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { Request, Response, NextFunction } from 'express';
import { getDbCollection } from './db.js';
import { User, UserRole, Employee, Role } from '../src/types.js';

const JWT_SECRET = process.env.JWT_SECRET || 'quarterly_review_appraisal_jwt_secret_key_2026';

export interface AuthenticatedRequest extends Request {
  user?: User;
  employeeProfile?: Employee;
  userRole?: UserRole;
  permissions?: string[];
}

export function generateToken(user: User): string {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      employeeId: user.employeeId,
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

export async function verifyTokenString(token: string): Promise<User | null> {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    const usersCol = getDbCollection('users');
    let user = await usersCol.findOne({ id: decoded.id });
    if (!user && decoded.email) {
      user = await usersCol.findOne({ email: String(decoded.email).toLowerCase().trim() });
    }
    if (!user) {
      const { SEED_USERS } = await import('./seedData.js');
      user = SEED_USERS.find(
        (u) =>
          u.id === decoded.id ||
          (decoded.email && u.email.toLowerCase() === String(decoded.email).toLowerCase().trim())
      ) || null;
    }
    if (!user && (decoded.employeeId || decoded.id)) {
      const employeesCol = getDbCollection('employees');
      const emp = await employeesCol.findOne({
        $or: [{ id: decoded.employeeId }, { id: decoded.id }, { email: decoded.email }],
      });
      if (emp) {
        user = {
          id: `usr_${emp.id}`,
          employeeId: emp.id,
          email: emp.email,
          name: emp.name,
          role: decoded.role || 'EMPLOYEE',
          roleId: `role_${(decoded.role || 'employee').toLowerCase()}`,
          active: emp.status !== 'INACTIVE',
          createdAt: emp.createdAt || new Date().toISOString(),
        };
      }
    }
    if (!user || user.active === false) return null;
    return user;
  } catch (err) {
    return null;
  }
}

export async function authenticateToken(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Authentication required. Missing bearer token.' });
  }

  const user = await verifyTokenString(token);
  if (!user) {
    return res.status(403).json({ error: 'Invalid or expired session token.' });
  }

  req.user = user;
  req.userRole = user.role;

  // Populate associated employee profile
  if (user.employeeId) {
    const employeesCol = getDbCollection('employees');
    const employee = await employeesCol.findOne({ id: user.employeeId });
    if (employee) {
      req.employeeProfile = employee;
    }
  }

  // Populate permissions
  const rolesCol = getDbCollection('roles');
  const roleRecord: Role | null = await rolesCol.findOne({ roleName: user.role });
  req.permissions = roleRecord ? roleRecord.permissions : [];

  next();
}

export function requireRoles(...allowedRoles: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user || !req.userRole) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    // Super Admin has full bypass
    if (req.userRole === 'SUPER_ADMIN') {
      return next();
    }

    if (!allowedRoles.includes(req.userRole)) {
      return res.status(403).json({
        error: `Access forbidden for role ${req.userRole}. Required roles: [${allowedRoles.join(', ')}]`,
      });
    }

    next();
  };
}

export async function recordAuditLog(
  userId: string,
  userName: string,
  userRole: UserRole,
  module: string,
  action: string,
  recordId: string,
  oldValue?: string,
  newValue?: string,
  details?: string
): Promise<void> {
  const auditLogsCol = getDbCollection('auditLogs');
  await auditLogsCol.insertOne({
    id: `audit_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    userId,
    userName,
    userRole,
    module,
    action,
    recordId,
    oldValue: oldValue || '',
    newValue: newValue || '',
    details: details || '',
    createdAt: new Date().toISOString(),
  });
}
