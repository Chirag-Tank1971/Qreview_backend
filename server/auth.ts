import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { Request, Response, NextFunction } from 'express';
import { getDbCollection } from './db.js';
import { User, UserRole, Employee, Role, EmployeeReview, ReviewStatus, Permission } from '../src/types/index.js';

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

// Dev: 8 hours for convenient local/Postman testing | Production: 15 minutes for security
export const ACCESS_TOKEN_EXPIRY = process.env.NODE_ENV === 'production' ? '15m' : '8h';
export const REFRESH_TOKEN_EXPIRY = '7d';

export interface AuthenticatedRequest extends Request {
  user?: User;
  employeeProfile?: Employee;
  userRole?: UserRole;
  permissions?: Permission[];
  review?: EmployeeReview;
}

/**
 * Canonical 6-Role Permission Definitions as specified in Section 7
 */
export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  SUPER_ADMIN: [
    'USER_VIEW',
    'USER_CREATE',
    'USER_UPDATE',
    'ROLE_MANAGE',
    'EMPLOYEE_VIEW_ALL',
    'EMPLOYEE_CREATE',
    'EMPLOYEE_UPDATE',
    'EMPLOYEE_DEACTIVATE',
    'DEPARTMENT_MANAGE',
    'DESIGNATION_MANAGE',
    'CYCLE_MANAGE',
    'KRA_MANAGE',
    'REVIEW_VIEW_ALL',
    'REVIEW_ADMIN',
    'HR_REVIEW',
    'REVIEW_RETURN',
    'REVIEW_COMPLETE',
    'APPRAISAL_MANAGE',
    'REPORT_VIEW_ALL',
    'REPORT_VIEW',
    'AUDIT_VIEW',
  ],
  HR: [
    'EMPLOYEE_VIEW_ALL',
    'EMPLOYEE_CREATE',
    'EMPLOYEE_UPDATE',
    'EMPLOYEE_DEACTIVATE',
    'KRA_MANAGE',
    'REVIEW_VIEW_ALL',
    'HR_REVIEW',
    'REVIEW_RETURN',
    'REVIEW_COMPLETE',
    'APPRAISAL_MANAGE',
    'REPORT_VIEW',
    'AUDIT_VIEW',
  ],
  REPORTING_MANAGER: [
    'TEAM_VIEW',
    'REVIEW_VIEW_ASSIGNED',
    'REVIEW_EDIT_ASSIGNED',
    'REVIEW_SUBMIT',
    'REVIEW_RESUBMIT',
    'REVIEW_HISTORY_TEAM',
  ],
  MANAGER: [
    'TEAM_VIEW',
    'REVIEW_VIEW_ASSIGNED',
    'REVIEW_EDIT_ASSIGNED',
    'REVIEW_SUBMIT',
    'REVIEW_RESUBMIT',
    'REVIEW_HISTORY_TEAM',
  ],
  HOD: [
    'DEPARTMENT_VIEW',
    'DEPARTMENT_REVIEW_VIEW',
    'DEPARTMENT_ANALYTICS',
    'DEPARTMENT_HISTORY_VIEW',
    'HOD_APPROVAL',
  ],
  EMPLOYEE: [
    'OWN_PROFILE_VIEW',
    'OWN_KRA_VIEW',
    'OWN_REVIEW_VIEW',
    'OWN_HISTORY_VIEW',
    'OWN_SELF_ASSESSMENT',
  ],
  MANAGEMENT: [
    'ORG_DASHBOARD_VIEW',
    'ORG_ANALYTICS_VIEW',
    'ORG_REPORT_VIEW',
    'APPRAISAL_SUMMARY_VIEW',
  ],
};


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

export function generateToken(user: User): string {
  return generateAccessToken(user);
}

/**
 * Verifies a refresh token and checks that the user's tokenVersion has not been revoked
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

    if (!user || user.active === false) {
      return null;
    }

    const currentVersion = user.tokenVersion ?? 1;
    const tokenVersion = decoded.tokenVersion ?? 1;
    if (currentVersion !== tokenVersion) {
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

interface CachedAuthSession {
  user: any;
  employeeProfile: any;
  permissions: Permission[];
  userRole: UserRole;
  cachedAt: number;
}

const authSessionCache = new Map<string, CachedAuthSession>();
const AUTH_CACHE_TTL_MS = 30 * 1000; // 30 seconds TTL

export function invalidateAuthCache(userId?: string) {
  if (!userId) {
    authSessionCache.clear();
    return;
  }
  for (const [token, session] of authSessionCache.entries()) {
    if (session.user?.id === userId || session.user?.employeeId === userId) {
      authSessionCache.delete(token);
    }
  }
}

/**
 * Step 1: Authentication Middleware
 * Validates JWT bearer token and injects user profile, role, and permissions into request.
 * Uses high-speed in-memory cache to prevent multiple remote MongoDB round-trips per HTTP call.
 * Returns 401 Unauthorized if unauthenticated.
 */
export async function authenticateToken(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Authentication required. Missing bearer token.' });
  }

  // Check in-memory cache first (0.01ms response time)
  const cached = authSessionCache.get(token);
  const now = Date.now();
  if (cached && (now - cached.cachedAt < AUTH_CACHE_TTL_MS)) {
    req.user = cached.user;
    req.userRole = cached.userRole;
    req.employeeProfile = cached.employeeProfile;
    req.permissions = cached.permissions;
    return next();
  }

  const user = await verifyTokenString(token);
  if (!user) {
    authSessionCache.delete(token);
    return res.status(401).json({ error: 'Authentication required. Invalid or expired session token.' });
  }

  req.user = user;
  req.userRole = user.role;

  // Populate associated employee profile
  let employeeProfile = null;
  if (user.employeeId) {
    const employeesCol = getDbCollection('employees');
    employeeProfile = await employeesCol.findOne({ id: user.employeeId });
    if (employeeProfile) {
      req.employeeProfile = employeeProfile;
    }
  }

  // Populate canonical permissions from Role or predefined mapping
  const rolePerms = ROLE_PERMISSIONS[user.role] || [];
  const rolesCol = getDbCollection('roles');
  const roleRecord: Role | null = await rolesCol.findOne({ roleName: user.role });
  const permissions: Permission[] = roleRecord && roleRecord.permissions?.length > 0
    ? (roleRecord.permissions as Permission[])
    : rolePerms;
  req.permissions = permissions;

  // Cache resolved session
  authSessionCache.set(token, {
    user,
    employeeProfile,
    permissions,
    userRole: user.role,
    cachedAt: now,
  });

  // Prune cache if it grows too large
  if (authSessionCache.size > 1000) {
    for (const [t, s] of authSessionCache.entries()) {
      if (now - s.cachedAt >= AUTH_CACHE_TTL_MS) {
        authSessionCache.delete(t);
      }
    }
  }

  next();
}

export const authenticateUser = authenticateToken;

/**
 * Step 2: Role Authorization Middleware
 * Verifies that the authenticated user possesses one of the allowed roles.
 * Returns 401 if not authenticated, 403 if authenticated but not permitted.
 */
export function authorizeRoles(...allowedRoles: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user || !req.userRole) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    // Super Admin has system-wide administrative access
    if (req.userRole === 'SUPER_ADMIN') {
      return next();
    }

    // Support REPORTING_MANAGER and MANAGER as aliases
    const effectiveAllowed = allowedRoles.flatMap((r) =>
      r === 'REPORTING_MANAGER' || r === 'MANAGER' ? ['REPORTING_MANAGER', 'MANAGER'] : [r]
    );

    if (!effectiveAllowed.includes(req.userRole)) {
      return res.status(403).json({
        error: `Forbidden: Access denied for role ${req.userRole}. Required roles: [${allowedRoles.join(', ')}]`,
      });
    }

    next();
  };
}

export const requireRoles = authorizeRoles;

/**
 * Step 3: Permission-Based Authorization Middleware
 * Checks granular permissions against user role/profile.
 */
export function authorizePermission(...requiredPermissions: Permission[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user || !req.userRole) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    if (req.userRole === 'SUPER_ADMIN') {
      return next();
    }

    const userPerms: Permission[] = req.permissions && req.permissions.length > 0
      ? req.permissions
      : (ROLE_PERMISSIONS[req.userRole] || []);

    const hasAll = requiredPermissions.every((p) => userPerms.includes(p));
    if (!hasAll) {
      return res.status(403).json({
        error: `Forbidden: Missing required permission(s): [${requiredPermissions.join(', ')}]`,
      });
    }

    next();
  };
}

/**
 * Step 4: Resource-Level Employee Access Authorization
 * CRITICAL OWNERSHIP RULE:
 * - EMPLOYEE: targetEmployeeId == loggedInUser.employee_id
 * - REPORTING_MANAGER: targetEmployee.managerId == loggedInUser.employee_id
 * - HOD: targetEmployee.departmentId == HOD.departmentId
 * - HR / SUPER_ADMIN: full organization access
 * - MANAGEMENT: permitted read scope
 */
export function authorizeEmployeeAccess(paramName: string = 'id') {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required.' });
      }

      const targetId = req.params[paramName];
      if (!targetId) {
        return next();
      }

      const role = req.user.role;

      // Super Admin and HR have organization-wide access
      if (role === 'SUPER_ADMIN' || role === 'HR') {
        return next();
      }

      // Management has organization-wide read access
      if (role === 'MANAGEMENT') {
        if (req.method === 'GET') return next();
        return res.status(403).json({ error: 'Forbidden: Management has read-only access to employee records.' });
      }

      // Employee can ONLY view their own records
      if (role === 'EMPLOYEE') {
        const isOwn = req.user.employeeId === targetId || req.user.id === targetId;
        if (!isOwn) {
          return res.status(403).json({
            error: 'Forbidden: You are only authorized to access your own employee profile and history.',
          });
        }
        return next();
      }

      // Fetch target employee for Reporting Manager & HOD scope checks
      const employeesCol = getDbCollection('employees');
      const targetEmp = await employeesCol.findOne({
        $or: [{ id: targetId }, { employeeCode: targetId }],
      });

      if (!targetEmp) {
        return res.status(404).json({ error: 'Employee not found.' });
      }

      // Reporting Manager: only self or direct reports assigned to manager
      if (role === 'REPORTING_MANAGER' || role === 'MANAGER') {
        const isSelf = req.user.employeeId === targetEmp.id || req.user.id === targetEmp.id;
        const isDirectReport =
          targetEmp.managerId === req.user.employeeId ||
          targetEmp.managerId === req.user.id ||
          (req.user.name && targetEmp.managerName?.toLowerCase() === req.user.name.toLowerCase());

        if (isSelf || isDirectReport) {
          return next();
        }

        return res.status(403).json({
          error: 'Forbidden: You can only access direct reports assigned to you.',
        });
      }

      // HOD: only employees in the HOD's permitted department(s)
      if (role === 'HOD') {
        const isSelf = req.user.employeeId === targetEmp.id || req.user.id === targetEmp.id;
        const hodDeptId = req.employeeProfile?.departmentId;
        const isDeptMatch =
          (hodDeptId && targetEmp.departmentId === hodDeptId) ||
          (req.employeeProfile?.departmentName &&
            targetEmp.departmentName?.toLowerCase() === req.employeeProfile.departmentName.toLowerCase()) ||
          targetEmp.hodId === req.user.employeeId;

        if (isSelf || isDeptMatch) {
          return next();
        }

        return res.status(403).json({
          error: 'Forbidden: You can only access employees in your designated department.',
        });
      }

      return res.status(403).json({ error: 'Forbidden: Insufficient privileges.' });
    } catch (err: any) {
      return res.status(500).json({ error: 'Employee authorization verification failed.' });
    }
  };
}

/**
 * Step 5: Department Scope Authorization
 * Enforces departmental data boundaries for HODs.
 */
export function authorizeDepartmentScope(departmentIdParam: string = 'departmentId') {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const role = req.user.role;
    if (role === 'SUPER_ADMIN' || role === 'HR' || role === 'MANAGEMENT') {
      return next();
    }

    const targetDeptId = req.params[departmentIdParam] || req.query[departmentIdParam] || req.body[departmentIdParam];
    if (!targetDeptId) {
      return next();
    }

    if (role === 'HOD') {
      const hodDeptId = req.employeeProfile?.departmentId;
      if (hodDeptId && hodDeptId === targetDeptId) {
        return next();
      }
      return res.status(403).json({ error: 'Forbidden: You can only access your designated department.' });
    }

    return res.status(403).json({ error: 'Forbidden: Insufficient departmental privileges.' });
  };
}

/**
 * Step 6: Review Workflow & Resource-Level Authorization
 * Enforces ownership, role permissions, and workflow state transitions.
 */
export function authorizeReviewAccess(
  action: 'read' | 'score' | 'submit' | 'return' | 'complete' | 'hod_approve' | 'hod_return' | 'self_assess'
) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required.' });
      }

      const reviewId = req.params.id;
      if (!reviewId) {
        return next();
      }

      const reviewCol = getDbCollection('employeeReviews');
      const review: EmployeeReview | null = await reviewCol.findOne({ id: reviewId });

      if (!review) {
        return res.status(404).json({ error: 'Quarterly review record not found.' });
      }

      const role = req.user.role;
      const userEmpId = req.user.employeeId;

      // Read action: role + ownership/scope check
      if (action === 'read') {
        if (role === 'SUPER_ADMIN' || role === 'HR' || role === 'MANAGEMENT') {
          req.review = review;
          return next();
        }

        if (role === 'EMPLOYEE') {
          if (review.employeeId === userEmpId || review.employeeId === req.user.id) {
            req.review = review;
            return next();
          }
          return res.status(403).json({
            error: 'Forbidden: Employees can only view their own quarterly reviews.',
          });
        }

        if (role === 'REPORTING_MANAGER' || role === 'MANAGER') {
          const isAssigned =
            review.managerId === userEmpId ||
            review.managerId === req.user.id ||
            review.employeeId === userEmpId;

          if (isAssigned) {
            req.review = review;
            return next();
          }
          return res.status(403).json({
            error: 'Forbidden: You can only view reviews assigned to your direct reports.',
          });
        }

        if (role === 'HOD') {
          const hodDeptId = req.employeeProfile?.departmentId;
          const isDeptMatch =
            (hodDeptId && review.departmentId === hodDeptId) ||
            review.hodId === userEmpId ||
            review.managerId === userEmpId ||
            review.employeeId === userEmpId;

          if (isDeptMatch) {
            req.review = review;
            return next();
          }
          return res.status(403).json({
            error: 'Forbidden: HOD can only view reviews in their designated department.',
          });
        }

        return res.status(403).json({ error: 'Forbidden: Unauthorized review access.' });
      }

      // Self-assessment action (Employee only, own review, must not be closed)
      if (action === 'self_assess') {
        if (review.isClosed) {
          return res.status(400).json({ error: 'Cannot submit self-assessment on a closed review.' });
        }
        if (role === 'SUPER_ADMIN') {
          req.review = review;
          return next();
        }
        if (review.employeeId !== userEmpId && review.employeeId !== req.user.id) {
          return res.status(403).json({
            error: 'Forbidden: You can only submit self-assessment for your own performance review.',
          });
        }
        req.review = review;
        return next();
      }

      // Score (draft) action: ONLY assigned reporting manager, HR, or Super Admin (HOD is view-only)
      if (action === 'score') {
        const isAssignedManager =
          (role === 'REPORTING_MANAGER' || role === 'MANAGER') &&
          (review.managerId === userEmpId || review.managerId === req.user.id);
        const isSuperAdminOrHr = role === 'SUPER_ADMIN' || role === 'HR';

        if (!isAssignedManager && !isSuperAdminOrHr) {
          return res.status(403).json({
            error: 'Forbidden: Only the designated Reporting Manager or HR can score this review. HOD has view-only access.',
          });
        }

        if (review.isClosed) {
          return res.status(400).json({ error: 'Cannot edit or score a closed review.' });
        }

        const editableStatuses: ReviewStatus[] = ['DRAFT', 'ASSIGNED', 'MANAGER_PENDING', 'RETURNED'];
        if (!editableStatuses.includes(review.status) && !isSuperAdminOrHr) {
          return res.status(400).json({
            error: `Cannot edit review in status "${review.status}". Review is not in an editable stage.`,
          });
        }

        req.review = review;
        return next();
      }

      // Submit action: ONLY assigned reporting manager, HR, or Super Admin
      if (action === 'submit') {
        const isAssignedManager =
          (role === 'REPORTING_MANAGER' || role === 'MANAGER') &&
          (review.managerId === userEmpId || review.managerId === req.user.id);
        const isSuperAdminOrHr = role === 'SUPER_ADMIN' || role === 'HR';

        if (!isAssignedManager && !isSuperAdminOrHr) {
          return res.status(403).json({
            error: 'Forbidden: Only the designated Reporting Manager or HR can submit this review.',
          });
        }

        if (review.isClosed) {
          return res.status(400).json({ error: 'Cannot submit a closed review.' });
        }

        const editableStatuses: ReviewStatus[] = ['DRAFT', 'ASSIGNED', 'MANAGER_PENDING', 'RETURNED'];
        if (!editableStatuses.includes(review.status) && !isSuperAdminOrHr) {
          return res.status(400).json({
            error: `Cannot submit review in status "${review.status}". Review must be in MANAGER_PENDING or RETURNED status.`,
          });
        }

        req.review = review;
        return next();
      }

      // HR Return action
      if (action === 'return') {
        if (role !== 'HR' && role !== 'SUPER_ADMIN') {
          return res.status(403).json({
            error: 'Forbidden: Only HR or Super Admin can return a submitted review.',
          });
        }

        if (review.status !== 'HR_PENDING') {
          return res.status(400).json({
            error: `Cannot return review in status "${review.status}". Must be HR_PENDING.`,
          });
        }

        req.review = review;
        return next();
      }

      // HR Complete action
      if (action === 'complete') {
        if (role !== 'HR' && role !== 'SUPER_ADMIN') {
          return res.status(403).json({
            error: 'Forbidden: Only HR or Super Admin can complete and close a review.',
          });
        }

        if (review.status !== 'HR_PENDING') {
          return res.status(400).json({
            error: `Cannot complete review in status "${review.status}". Must be HR_PENDING.`,
          });
        }

        req.review = review;
        return next();
      }

      return res.status(403).json({ error: 'Forbidden: Unauthorized action on review.' });
    } catch (err: any) {
      return res.status(500).json({ error: 'Review authorization verification failed.' });
    }
  };
}

/**
 * Step 7: State Machine Validation Helper
 */
export function validateReviewTransition(
  currentStatus: ReviewStatus,
  action: 'submit' | 'return' | 'complete' | 'score' | 'self_assess'
): { allowed: boolean; nextStatus?: ReviewStatus; error?: string } {
  switch (action) {
    case 'score':
    case 'self_assess':
      if (currentStatus === 'CLOSED') {
        return { allowed: false, error: 'Cannot modify a closed review.' };
      }
      return { allowed: true, nextStatus: currentStatus };

    case 'submit':
      if (!['DRAFT', 'ASSIGNED', 'MANAGER_PENDING', 'RETURNED'].includes(currentStatus)) {
        return { allowed: false, error: `Cannot submit review in status ${currentStatus}. Must be editable.` };
      }
      return { allowed: true, nextStatus: 'HR_PENDING' };

    case 'return':
      if (currentStatus !== 'HR_PENDING') {
        return { allowed: false, error: `Cannot return review in status ${currentStatus}. Must be HR_PENDING.` };
      }
      return { allowed: true, nextStatus: 'RETURNED' };

    case 'complete':
      if (currentStatus !== 'HR_PENDING') {
        return { allowed: false, error: `Cannot complete review in status ${currentStatus}. Must be HR_PENDING.` };
      }
      return { allowed: true, nextStatus: 'CLOSED' };

    default:
      return { allowed: false, error: 'Unknown workflow action.' };
  }
}

/**
 * Step 8: Comprehensive Audit Logger
 */
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
