import express, { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { getDbCollection, getDatabaseStatus } from '../db.js';
import {
  generateToken,
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  revokeUserSessions,
  authenticateToken,
  verifyTokenString,
  recordAuditLog,
  AuthenticatedRequest,
} from '../auth.js';
import { validateBody, LoginSchema, ChangePasswordSchema, RefreshTokenSchema } from '../validation.js';
import { SEED_USERS } from '../seedData.js';
import { User, Employee, Role, UserRole } from '../../src/types.js';

export const authRouter = express.Router();

// ---------------------------------------------------------------------------
// In-memory failed-login tracker (per IP, auto-purges after 15 min window)
// Max attempts matches the rate limiter cap in server.ts (10 per 15 min)
// ---------------------------------------------------------------------------
const MAX_LOGIN_ATTEMPTS = 10;
const WARN_AFTER_FAILURES = 2; // start showing warning after this many failures
interface FailEntry { count: number; firstFailAt: number; }
const loginFailMap = new Map<string, FailEntry>();

function getClientIp(req: Request): string {
  return (
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

function recordFailure(ip: string): number {
  const now = Date.now();
  const entry = loginFailMap.get(ip);
  if (!entry || now - entry.firstFailAt > 15 * 60 * 1000) {
    // Fresh window
    loginFailMap.set(ip, { count: 1, firstFailAt: now });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

function clearFailures(ip: string) {
  loginFailMap.delete(ip);
}

/**
 * POST /api/auth/login
 * Authenticates user by email and password with runtime input validation and token lifecycle support
 */
authRouter.post('/login', validateBody(LoginSchema), async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const ip = getClientIp(req);

    const usersCol = getDbCollection('users');
    let user = await usersCol.findOne({ email: email.toLowerCase().trim() });

    if (!user) {
      user = SEED_USERS.find((u) => u.email.toLowerCase() === email.toLowerCase().trim()) || null;
    }

    // If user record not found in users collection, check employees collection
    if (!user) {
      const employeesCol = getDbCollection('employees');
      const emp = await employeesCol.findOne({
        $or: [
          { email: email.toLowerCase().trim() },
          { employeeCode: email.toUpperCase().trim() },
        ],
      });

      if (emp) {
        let inferredRole: UserRole = 'EMPLOYEE';
        const desigLower = (emp.designationName || '').toLowerCase();
        if (desigLower.includes('hr manager') || desigLower.includes('hr lead')) inferredRole = 'HR';
        else if (desigLower.includes('manager') || desigLower.includes('lead')) inferredRole = 'MANAGER';
        else if (desigLower.includes('vp') || desigLower.includes('director') || desigLower.includes('hod')) inferredRole = 'HOD';

        const defaultHash = bcrypt.hashSync('password123', 10);
        user = {
          id: `usr_${emp.id}`,
          employeeId: emp.id,
          email: emp.email,
          name: emp.name,
          role: inferredRole,
          roleId: `role_${inferredRole.toLowerCase()}`,
          active: emp.status !== 'INACTIVE',
          passwordHash: defaultHash,
          mustChangePassword: true,
          tokenVersion: 1,
          createdAt: emp.createdAt || new Date().toISOString(),
        };

        try {
          await usersCol.insertOne(user);
        } catch {
          // quiet fallback
        }
      }
    }

    if (!user) {
      const failCount = recordFailure(ip);
      const remainingAttempts = Math.max(0, MAX_LOGIN_ATTEMPTS - failCount);
      const payload: Record<string, any> = { error: 'Invalid email or password.' };
      if (failCount >= WARN_AFTER_FAILURES) payload.remainingAttempts = remainingAttempts;
      return res.status(401).json(payload);
    }

    if (!user.active) {
      return res.status(403).json({ error: 'Account is deactivated. Contact system administrator.' });
    }

    // Strict cryptographic verification against user's stored bcrypt hash
    const isPasswordValid = Boolean(user.passwordHash && bcrypt.compareSync(password, user.passwordHash));
    if (!isPasswordValid) {
      const failCount = recordFailure(ip);
      const remainingAttempts = Math.max(0, MAX_LOGIN_ATTEMPTS - failCount);
      const payload: Record<string, any> = { error: 'Invalid email or password.' };
      if (failCount >= WARN_AFTER_FAILURES) payload.remainingAttempts = remainingAttempts;
      return res.status(401).json(payload);
    }

    // ✅ Successful login — clear the fail counter
    clearFailures(ip);

    const tokenVersion = user.tokenVersion ?? 1;
    const token = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user, tokenVersion);

    // Update last login and ensure tokenVersion is stored
    await usersCol.updateOne(
      { id: user.id },
      {
        $set: {
          lastLoginAt: new Date().toISOString(),
          tokenVersion: tokenVersion,
        },
      }
    );

    // Fetch employee profile if exists
    let employeeProfile: Employee | null = null;
    if (user.employeeId) {
      const employeesCol = getDbCollection('employees');
      employeeProfile = await employeesCol.findOne({ id: user.employeeId });
    }

    // Fetch role permissions
    const rolesCol = getDbCollection('roles');
    const roleRecord: Role | null = await rolesCol.findOne({ roleName: user.role });

    // Record login audit log
    await recordAuditLog(
      user.id,
      user.name,
      user.role,
      'AUTHENTICATION',
      'USER_LOGIN',
      user.id,
      '',
      user.role,
      `User ${user.email} logged in successfully`
    );

    const safeUser: User = {
      id: user.id,
      employeeId: user.employeeId,
      email: user.email,
      name: user.name,
      role: user.role,
      roleId: user.roleId,
      active: user.active,
      avatarUrl: user.avatarUrl,
      lastLoginAt: new Date().toISOString(),
      mustChangePassword: (user as any).mustChangePassword,
      tokenVersion: tokenVersion,
      createdAt: user.createdAt,
    };

    res.json({
      token,
      refreshToken,
      user: safeUser,
      employeeProfile,
      permissions: roleRecord ? roleRecord.permissions : [],
    });
  } catch (error: any) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error during authentication.' });
  }
});


/**
 * GET /api/auth/me
 * Retrieves current authenticated user session
 */
authRouter.get('/me', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  const safeUser: User = {
    id: req.user.id,
    employeeId: req.user.employeeId,
    email: req.user.email,
    name: req.user.name,
    role: req.user.role,
    roleId: req.user.roleId,
    active: req.user.active,
    avatarUrl: req.user.avatarUrl,
    lastLoginAt: req.user.lastLoginAt,
    mustChangePassword: (req.user as any).mustChangePassword ?? false,
    tokenVersion: req.user.tokenVersion,
    createdAt: req.user.createdAt,
  };

  res.json({
    user: safeUser,
    employeeProfile: req.employeeProfile || null,
    permissions: req.permissions || [],
  });
});

/**
 * GET /api/auth/demo-users
 * Returns list of seeded demo personas for fast role-testing
 */
authRouter.get('/demo-users', async (_req: Request, res: Response) => {
  try {
    const usersCol = getDbCollection('users');
    const allUsers = await (await usersCol.find({ active: true })).toArray();

    const safeDemoUsers = allUsers.map((u: any) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      employeeId: u.employeeId,
    }));

    res.json(safeDemoUsers);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch demo personas.' });
  }
});

/**
 * POST /api/auth/switch-role
 * Rapid role switcher for seamless evaluation across Super Admin, HR, Manager, HOD, Employee, Management
 */
authRouter.post('/switch-role', async (req: Request, res: Response) => {
  try {
    // Production Security Guard: Persona switching is strictly for development/staging environments
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'Role switching is strictly prohibited in production mode.' });
    }

    const { role, userId } = req.body || {};
    const usersCol = getDbCollection('users');
    let allUsers: any[] = [];
    try {
      allUsers = await (await usersCol.find({})).toArray();
    } catch {
      allUsers = [];
    }

    if (allUsers.length === 0) {
      allUsers = SEED_USERS;
    }

    // Standardize role aliases (e.g. 'ADMIN', 'super_admin', 'EMPLOYEE', 'HR Manager', 'Hiring Manager')
    const roleNormalized = typeof role === 'string' ? role.trim().toUpperCase() : '';
    const cleaned = roleNormalized.replace(/[\s\-_]+/g, '');
    let targetRole: UserRole | string = roleNormalized;
    let targetEmail: string | null = null;

    if (['ADMIN', 'SUPERADMIN', 'SYSTEMADMIN'].includes(cleaned)) {
      targetRole = 'SUPER_ADMIN';
    } else if (['HR', 'HRMANAGER', 'HRLEAD', 'HRBP', 'HRADMIN', 'HUMANRESOURCES'].includes(cleaned)) {
      targetRole = 'HR';
    } else if (['MGR', 'MANAGER', 'REPORTINGMANAGER', 'ENGMANAGER', 'HIRINGMANAGER', 'TAMANAGER'].includes(cleaned)) {
      targetRole = 'MANAGER';
    } else if (['HOD', 'HEADOFORGANIZATION', 'HEADOFORGANISATION', 'HEADOFDEPARTMENT', 'DEPTHEAD', 'DEPARTMENTHEAD'].includes(cleaned)) {
      targetRole = 'HOD';
    } else if (['EMPLOYEE', 'DEV', 'STAFF', 'INDIVIDUALCONTRIBUTOR', 'USER'].includes(cleaned)) {
      targetRole = 'EMPLOYEE';
    } else if (['MANAGEMENT', 'MGMT', 'EXECUTIVE', 'EXEC', 'COO', 'CEO'].includes(cleaned)) {
      targetRole = 'MANAGEMENT';
    }

    let targetUser: any = null;

    // 0. If targetEmail is specified (e.g. Hiring Manager)
    if (targetEmail) {
      targetUser = allUsers.find((u: any) => u.email && u.email.toLowerCase() === targetEmail!.toLowerCase());
    }

    // 1. Try matching by specific userId, _id, employeeId, or email
    if (!targetUser && userId) {
      const uStr = String(userId).trim().toLowerCase();
      targetUser = allUsers.find(
        (u: any) =>
          (u.id && u.id.toLowerCase() === uStr) ||
          (u._id && String(u._id).toLowerCase() === uStr) ||
          (u.employeeId && u.employeeId.toLowerCase() === uStr) ||
          (u.email && u.email.toLowerCase() === uStr)
      );

      // If user wasn't in users table, check if userId corresponds to an employee
      if (!targetUser) {
        const employeesCol = getDbCollection('employees');
        const emp = await employeesCol.findOne({
          $or: [{ id: userId }, { employeeCode: userId }, { email: uStr }],
        });
        if (emp) {
          // Check if existing user has this employeeId or email
          const existingUser = allUsers.find(
            (u: any) => (u.employeeId && u.employeeId === emp.id) || (u.email && u.email.toLowerCase() === emp.email.toLowerCase())
          );
          if (existingUser) {
            targetUser = existingUser;
          } else {
            // Determine default role based on designation
            let inferredRole: UserRole = 'EMPLOYEE';
            if (emp.designationName?.toLowerCase().includes('hr manager')) inferredRole = 'HR';
            else if (emp.designationName?.toLowerCase().includes('manager')) inferredRole = 'MANAGER';
            else if (emp.designationName?.toLowerCase().includes('vp') || emp.designationName?.toLowerCase().includes('director') || emp.designationName?.toLowerCase().includes('hod')) inferredRole = 'HOD';
            
            targetUser = {
              id: `usr_${emp.id}`,
              employeeId: emp.id,
              email: emp.email,
              name: emp.name,
              role: (targetRole as UserRole) || inferredRole,
              roleId: `role_${inferredRole.toLowerCase()}`,
              active: true,
              createdAt: emp.createdAt || new Date().toISOString(),
            };
          }
        }
      }
    }

    // Special match for HR role
    if (!targetUser && targetRole === 'HR') {
      targetUser =
        allUsers.find((u: any) => u.role === 'HR') ||
        allUsers.find((u: any) => u.email === 'frank.mgr@company.com') ||
        SEED_USERS.find((u) => u.role === 'HR');
    }

    // 2. If not matched by userId, match by normalized target role
    if (!targetUser && targetRole) {
      targetUser = allUsers.find((u: any) => u.role === targetRole);
    }

    // 3. If still not matched, case-insensitive match on role
    if (!targetUser && roleNormalized) {
      targetUser = allUsers.find(
        (u: any) => u.role && u.role.toString().toUpperCase() === roleNormalized
      );
    }

    // 4. Fallback in seed users if dynamic collection didn't have it
    if (!targetUser && targetRole) {
      targetUser = SEED_USERS.find((u) => u.role === targetRole);
    }

    // 5. Final fallback to Super Admin or first available user
    if (!targetUser) {
      targetUser =
        allUsers.find((u: any) => u.role === 'SUPER_ADMIN') ||
        SEED_USERS.find((u) => u.role === 'SUPER_ADMIN') ||
        allUsers[0] ||
        SEED_USERS[0];
    }

    if (!targetUser) {
      return res.status(404).json({ error: 'Demo user not found for requested role.' });
    }

    const tokenVersion = targetUser.tokenVersion ?? 1;
    const token = generateAccessToken(targetUser);
    const refreshToken = generateRefreshToken(targetUser, tokenVersion);

    let employeeProfile: Employee | null = null;
    if (targetUser.employeeId) {
      const employeesCol = getDbCollection('employees');
      try {
        employeeProfile = await employeesCol.findOne({ id: targetUser.employeeId });
      } catch {
        employeeProfile = null;
      }
    }

    const rolesCol = getDbCollection('roles');
    let roleRecord: Role | null = null;
    try {
      roleRecord = await rolesCol.findOne({ roleName: targetUser.role });
    } catch {
      roleRecord = null;
    }

    const safeUser: User = {
      id: targetUser.id,
      employeeId: targetUser.employeeId,
      email: targetUser.email,
      name: targetUser.name,
      role: targetUser.role,
      roleId: targetUser.roleId,
      active: targetUser.active ?? true,
      avatarUrl: targetUser.avatarUrl,
      lastLoginAt: new Date().toISOString(),
      tokenVersion: tokenVersion,
      createdAt: targetUser.createdAt,
    };

    res.json({
      token,
      refreshToken,
      user: safeUser,
      employeeProfile,
      permissions: roleRecord ? roleRecord.permissions : [],
    });
  } catch (error: any) {
    console.error('Failed to switch role:', error);
    res.status(500).json({ error: 'Failed to switch role.' });
  }
});

/**
 * POST /api/auth/logout
 * Invalidates session and revokes refresh tokens on logout
 */
authRouter.post('/logout', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token) {
      const user = await verifyTokenString(token);
      if (user) {
        // Invalidate active session tokens on logout
        await revokeUserSessions(user.id);
        await recordAuditLog(
          user.id,
          user.name,
          user.role,
          'AUTHENTICATION',
          'USER_LOGOUT',
          user.id,
          '',
          '',
          `User ${user.email} logged out (sessions invalidated)`
        );
      }
    }
  } catch (err) {
    // quiet fallback
  }
  res.json({ success: true, message: 'Logged out successfully.' });
});

/**
 * GET /api/system/db-status
 * Health & MongoDB Compass connectivity diagnostics
 */
authRouter.get('/system/db-status', async (_req: Request, res: Response) => {
  try {
    const status = await getDatabaseStatus();
    res.json(status);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to fetch database diagnostics.' });
  }
});

/**
 * POST /api/auth/refresh
 * Exchanges a valid, unrevoked Refresh Token for a fresh short-lived Access Token
 * and rotated Refresh Token. Also supports backward-compatibility with unexpired access tokens.
 */
authRouter.post('/refresh', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers['authorization'];
    const headerToken = authHeader && authHeader.split(' ')[1];
    const refreshToken = req.body?.refreshToken || headerToken;

    if (!refreshToken) {
      return res.status(401).json({ error: 'Refresh token is required.' });
    }

    // 1. First attempt verification as a dedicated refresh token (checks tokenVersion revocation)
    const refreshResult = await verifyRefreshToken(refreshToken);
    let user: User | null = refreshResult?.user || null;

    // 2. Backward compatibility fallback: if passed an unexpired access token, verify it
    if (!user) {
      user = await verifyTokenString(refreshToken);
    }

    if (!user || user.active === false) {
      return res.status(401).json({
        error: 'Your session has expired or has been revoked. Please sign in again.',
        code: 'SESSION_REVOKED',
      });
    }

    const currentVersion = user.tokenVersion ?? 1;
    const newAccessToken = generateAccessToken(user);
    const newRefreshToken = generateRefreshToken(user, currentVersion);

    // Fetch employee profile if exists
    let employeeProfile: Employee | null = null;
    if (user.employeeId) {
      const employeesCol = getDbCollection('employees');
      try {
        employeeProfile = await employeesCol.findOne({ id: user.employeeId });
      } catch { /* ignore */ }
    }

    const rolesCol = getDbCollection('roles');
    let roleRecord: Role | null = null;
    try {
      roleRecord = await rolesCol.findOne({ roleName: user.role });
    } catch { /* ignore */ }

    const safeUser: User = {
      id: user.id,
      employeeId: user.employeeId,
      email: user.email,
      name: user.name,
      role: user.role,
      roleId: user.roleId,
      active: user.active,
      avatarUrl: user.avatarUrl,
      lastLoginAt: user.lastLoginAt,
      mustChangePassword: (user as any).mustChangePassword,
      tokenVersion: currentVersion,
      createdAt: user.createdAt,
    };

    res.json({
      token: newAccessToken,
      refreshToken: newRefreshToken,
      user: safeUser,
      employeeProfile,
      permissions: roleRecord ? roleRecord.permissions : [],
    });
  } catch (error: any) {
    console.error('Token refresh error:', error);
    res.status(500).json({ error: 'Failed to refresh token.' });
  }
});

/**
 * POST /api/auth/revoke-sessions
 * Terminates all active sessions across all devices for the calling user,
 * or for a target employee if called by a SUPER_ADMIN / HR.
 */
authRouter.post('/revoke-sessions', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const targetUserId = req.body?.userId;
    let userIdToRevoke = req.user.id;

    if (targetUserId && targetUserId !== req.user.id) {
      if (req.user.role !== 'SUPER_ADMIN' && req.user.role !== 'HR') {
        return res.status(403).json({ error: 'Only administrators can revoke sessions of other users.' });
      }
      userIdToRevoke = targetUserId;
    }

    await revokeUserSessions(userIdToRevoke);

    await recordAuditLog(
      req.user.id,
      req.user.name,
      req.user.role,
      'AUTHENTICATION',
      'SESSIONS_REVOKED',
      userIdToRevoke,
      '',
      '',
      `All active sessions revoked for user ${userIdToRevoke} by ${req.user.email}`
    );

    res.json({
      success: true,
      message: 'All active sessions have been revoked successfully across all devices.',
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to revoke sessions.' });
  }
});

/**
 * POST /api/auth/logout
 * Securely signs out the user and revokes their active sessions and refresh tokens on the server
 */
authRouter.post('/logout', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (req.user?.id) {
      await revokeUserSessions(req.user.id);

      await recordAuditLog(
        req.user.id,
        req.user.name,
        req.user.role,
        'AUTHENTICATION',
        'LOGOUT',
        req.user.id,
        '',
        '',
        `User ${req.user.email} signed out and active session tokens were revoked.`
      );
    }

    res.json({
      success: true,
      message: 'Logged out successfully and server session was invalidated.',
    });
  } catch (err: any) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Failed to complete logout.' });
  }
});

/**
 * PUT /api/auth/change-password
 * Allows an authenticated user to change their password with Zod validation.
 * Clears mustChangePassword flag and revokes all old sessions across all devices.
 */
authRouter.put(
  '/change-password',
  authenticateToken,
  validateBody(ChangePasswordSchema),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Authentication required.' });
      }

      const { newPassword } = req.body;

      // Reject common/weak passwords
      const forbidden = ['password123', 'Welcome@2026', 'password', '12345678', 'admin123'];
      if (forbidden.includes(newPassword.toLowerCase())) {
        return res.status(400).json({ error: 'This password is too common. Please choose a stronger password.' });
      }

      const usersCol = getDbCollection('users');
      const passwordHash = bcrypt.hashSync(newPassword, 12);

      // Increment tokenVersion by 1 to invalidate all old active sessions across all devices
      const updatedTokenVersion = ((req.user as any).tokenVersion ?? 1) + 1;

      await usersCol.updateOne(
        { id: req.user.id },
        {
          $set: {
            passwordHash,
            mustChangePassword: false,
            passwordChangedAt: new Date().toISOString(),
            tokenVersion: updatedTokenVersion,
          },
        }
      );

      // Record audit
      await recordAuditLog(
        req.user.id,
        req.user.name,
        req.user.role,
        'AUTHENTICATION',
        'PASSWORD_CHANGED',
        req.user.id,
        '',
        '',
        `User ${req.user.email} changed their password (previous sessions invalidated)`
      );

      const safeUser: User = {
        id: req.user.id,
        employeeId: req.user.employeeId,
        email: req.user.email,
        name: req.user.name,
        role: req.user.role,
        roleId: req.user.roleId,
        active: req.user.active,
        avatarUrl: req.user.avatarUrl,
        lastLoginAt: req.user.lastLoginAt,
        mustChangePassword: false,
        tokenVersion: updatedTokenVersion,
        createdAt: req.user.createdAt,
      };

      // Issue fresh access & refresh tokens with the new tokenVersion
      const newToken = generateAccessToken(safeUser);
      const newRefreshToken = generateRefreshToken(safeUser, updatedTokenVersion);

      res.json({
        success: true,
        user: safeUser,
        token: newToken,
        refreshToken: newRefreshToken,
      });
    } catch (error: any) {
      console.error('Change password error:', error);
      res.status(500).json({ error: 'Failed to change password.' });
    }
  }
);
