import { UserRole } from './auth.js';
import { EmployeeStatus } from './organization.js';

export type ReviewStatus =
  | 'DRAFT'
  | 'ASSIGNED'
  | 'MANAGER_PENDING'
  | 'MANAGER_COMPLETED'
  | 'HOD_PENDING'
  | 'HOD_APPROVED'
  | 'HOD_COMPLETED'
  | 'HR_PENDING'
  | 'RETURNED'
  | 'HR_COMPLETED'
  | 'CLOSED';

export interface ReviewPeriod {
  id: string;
  name: string;
  quarter: 1 | 2 | 3 | 4;
  year: number;
  startDate: string;
  endDate: string;
  dueDate: string;
  status: 'UPCOMING' | 'ACTIVE' | 'LOCKED' | 'COMPLETED';
}

export interface ReviewKraSnapshot {
  id: string;
  kraId?: string;
  kraName: string;
  title?: string;
  description?: string;
  targetSnapshot: string;
  measurementCriteria?: string;
  weight: number;
  achievement?: string;
  rating: number; // 1 to 5
  comments?: string;
  issueReason?: string;
  selfRating?: number;
  selfAchievement?: string;
  selfComments?: string;
}

export interface ReviewAction {
  id: string;
  reviewId: string;
  action:
    | 'CREATED'
    | 'ASSIGNED'
    | 'DRAFT_SAVED'
    | 'SELF_SUBMITTED'
    | 'SUBMITTED'
    | 'RETURNED'
    | 'RESUBMITTED'
    | 'APPROVED'
    | 'HOD_APPROVED'
    | 'HOD_RETURNED'
    | 'HOD_MISSING_EXCEPTION'
    | 'HR_COMPLETED'
    | 'CLOSED';
  performedBy: string;
  performedByName: string;
  performedByRole: UserRole;
  remarks: string;
  performedAt: string;
}

export interface EmployeeReview {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  employeeStatus?: EmployeeStatus;
  departmentId: string;
  departmentName: string;
  designationName: string;
  reviewPeriodId: string;
  reviewPeriodName: string;
  cycleId: string;
  cycleCode: string;
  cycleColor?: string;
  isAppraisalMonthDue?: boolean;
  managerId: string;
  managerName: string;
  hodId?: string;
  hodName?: string;
  hrId?: string;
  hrName?: string;
  status: ReviewStatus;
  finalScore?: number;
  selfScore?: number;
  isSelfSubmitted?: boolean;
  selfSubmittedAt?: string;
  selfStrengths?: string;
  selfImprovements?: string;
  selfObstacles?: string;
  strengths?: string;
  improvements?: string;
  managerOverallComments?: string;
  employeeComments?: string;
  hrComments?: string;
  kraSnapshot: ReviewKraSnapshot[];
  actionHistory?: ReviewAction[];
  isClosed?: boolean;
  creationSource?: 'AUTOMATIC' | 'MANUAL';
  manualOverrideReason?: string;
  initiatedBy?: string;
  submittedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface ReviewSummaryStats {
  total: number;
  draft: number;
  managerPending: number;
  managerCompleted: number;
  hodPending: number;
  hrPending: number;
  closed: number;
  exceptions: number;
  averageScore: number;
  completionRate: number;
  distribution: {
    outstanding: number;
    exceeds: number;
    meets: number;
    needsImprovement: number;
    unscored: number;
  };
}
