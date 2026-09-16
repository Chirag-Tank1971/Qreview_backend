export type UserRole =
  | 'SUPER_ADMIN'
  | 'HR'
  | 'REPORTING_MANAGER'
  | 'MANAGER'
  | 'HOD'
  | 'EMPLOYEE'
  | 'MANAGEMENT';

export type Permission =
  | 'USER_VIEW'
  | 'USER_CREATE'
  | 'USER_UPDATE'
  | 'ROLE_MANAGE'
  | 'EMPLOYEE_VIEW_ALL'
  | 'EMPLOYEE_CREATE'
  | 'EMPLOYEE_UPDATE'
  | 'EMPLOYEE_DEACTIVATE'
  | 'DEPARTMENT_MANAGE'
  | 'DESIGNATION_MANAGE'
  | 'CYCLE_MANAGE'
  | 'KRA_MANAGE'
  | 'REVIEW_VIEW_ALL'
  | 'REVIEW_ADMIN'
  | 'HR_REVIEW'
  | 'REVIEW_RETURN'
  | 'REVIEW_COMPLETE'
  | 'APPRAISAL_MANAGE'
  | 'REPORT_VIEW_ALL'
  | 'REPORT_VIEW'
  | 'AUDIT_VIEW'
  | 'TEAM_VIEW'
  | 'REVIEW_VIEW_ASSIGNED'
  | 'REVIEW_EDIT_ASSIGNED'
  | 'REVIEW_SUBMIT'
  | 'REVIEW_RESUBMIT'
  | 'REVIEW_HISTORY_TEAM'
  | 'DEPARTMENT_VIEW'
  | 'DEPARTMENT_REVIEW_VIEW'
  | 'DEPARTMENT_ANALYTICS'
  | 'DEPARTMENT_HISTORY_VIEW'
  | 'HOD_APPROVAL'
  | 'OWN_PROFILE_VIEW'
  | 'OWN_KRA_VIEW'
  | 'OWN_REVIEW_VIEW'
  | 'OWN_HISTORY_VIEW'
  | 'OWN_SELF_ASSESSMENT'
  | 'ORG_DASHBOARD_VIEW'
  | 'ORG_ANALYTICS_VIEW'
  | 'ORG_REPORT_VIEW'
  | 'APPRAISAL_SUMMARY_VIEW'
  | 'APPRAISAL_DECISION';

export interface SystemConfig {
  id: string;
  hodApprovalEnabled: boolean;
  selfAssessmentEnabled: boolean;
  minTenureDaysForReview?: number;
  includeProbationInReviews?: boolean;
  updatedAt: string;
  updatedBy?: string;
}

export interface User {
  id: string;
  employeeId?: string;
  email: string;
  name: string;
  role: UserRole;
  roleId: string;
  active: boolean;
  avatarUrl?: string;
  lastLoginAt?: string;
  mustChangePassword?: boolean;
  tokenVersion?: number;
  createdAt: string;
}

export interface Role {
  id: string;
  roleName: UserRole;
  displayName: string;
  description: string;
  permissions: string[];
}
