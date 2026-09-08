import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { Request, Response, NextFunction } from 'express';
import { getDbCollection } from './db.js';
import { User, UserRole, Employee, Role } from '../src/types.js';

const DEFAULT_SECRET = 'quarterly_review_appraisal_jwt_secret_key_2026_production_entropy_secure';
if (process.env.NODE_ENV === 'production') {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    console.warn(
      '[Security Notice] No custom JWT_SECRET (>= 32 chars) provided in environment. ' +
      'Using secure default secret. For production hardening, add a custom JWT_SECRET in your Render dashboard.'
    );
  }
}

const JWT_SECRET = process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32
  ? process.env.JWT_SECRET
  : DEFAULT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || `${JWT_SECRET}_refresh_key_2026`;

export const ACCESS_TOKEN_EXPIRY = '15m';
export const REFRESH_TOKEN_EXPIRY = '7d';

export interface AuthenticatedRequest extends Request {
  user?: User;
  employeeProfile?: Employee;
  userRole?: UserRole;
  permissions?: string[];
}

/**
 * Generates a short-lived access token (15 minutes)
 */
export function generateAccessToken(user: User): string {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      employeeId: user.employeeId,
      type: 'access',
    },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );
}

/**
 * Generates a long-lived refresh token (7 days) tied to the user's current tokenVersion
 */
export function generateRefreshToken(user: User, tokenVersion: number = 1): string {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      tokenVersion,
      type: 'refresh',
    },
    JWT_REFRESH_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRY }
  );
}

/**
 * Backward-compatible helper that returns the access token
 */
export function generateToken(user: User): string {
  return generateAccessToken(user);
}

/**
 * Verifies a refresh token and checks that the user's tokenVersion has not been incremented/revoked
 */
export async function verifyRefreshToken(refreshToken: string): Promise<{ user: User; tokenVersion: number } | null> {
  try {
    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET) as any;
    if (!decoded || decoded.type !== 'refresh' || !decoded.id) {
      return null;
    }

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

    if (!user || user.active === false) {
      return null;
    }

    // Strict revocation check: verify tokenVersion matches current user record
    const currentVersion = user.tokenVersion ?? 1;
    const tokenVersion = decoded.tokenVersion ?? 1;
    if (currentVersion !== tokenVersion) {
      // Session has been revoked!
      return null;
    }

    return { user, tokenVersion: currentVersion };
  } catch (err) {
    return null;
  }
}

/**
 * Revokes all active refresh tokens for a user by incrementing tokenVersion
 */
export async function revokeUserSessions(userId: string): Promise<void> {
  try {
    const usersCol = getDbCollection('users');
    await usersCol.updateOne(
      { $or: [{ id: userId }, { employeeId: userId }] },
      { $inc: { tokenVersion: 1 } }
    );
  } catch (err) {
    console.error('Failed to revoke user sessions:', err);
  }
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
