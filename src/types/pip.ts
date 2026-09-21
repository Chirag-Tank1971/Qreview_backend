import { UserRole } from './auth.js';

export type PipStatus = 'DRAFT' | 'ACTIVE' | 'EXTENDED' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

export type PipGoalStatus = 'PENDING' | 'MET' | 'MISSED';

/** 1 = Not Started, 2 = Behind, 3 = On Track, 4 = Ahead, 5 = Met */
export type PipGoalRatingValue = 1 | 2 | 3 | 4 | 5;

export const PIP_GOAL_RATING_LABELS: Record<PipGoalRatingValue, string> = {
  1: 'Not Started',
  2: 'Behind',
  3: 'On Track',
  4: 'Ahead',
  5: 'Met',
};

export interface PipGoal {
  id: string;
  description: string;
  targetMetric?: string;
  dueDate?: string;
  status: PipGoalStatus;
}

export interface PipGoalRatingEntry {
  goalId: string;
  rating: PipGoalRatingValue;
}

export interface PipCheckIn {
  id: string;
  date: string;
  byId: string;
  byName: string;
  byRole: UserRole;
  notes: string;
  /** Optional per-goal progress rating given by the manager/HOD alongside this check-in. */
  goalRatings?: PipGoalRatingEntry[];
}

export interface PipOutcome {
  decision: 'SUCCEEDED' | 'FAILED' | 'EXTENDED';
  decidedById: string;
  decidedByName: string;
  decidedAt: string;
  notes?: string;
  /** Only set when decision === 'EXTENDED' — the plan's new end date. */
  newEndDate?: string;
}

/** What HR ultimately did about a FAILED plan — clears the employee-dashboard alert once set. */
export type PipFailureResolutionAction =
  | 'NEW_PIP_STARTED'
  | 'TERMINATION_PROCESSED'
  | 'ESCALATED_TO_MANAGEMENT'
  | 'NO_FURTHER_ACTION';

export const PIP_FAILURE_RESOLUTION_LABELS: Record<PipFailureResolutionAction, string> = {
  NEW_PIP_STARTED: 'New PIP Started',
  TERMINATION_PROCESSED: 'Termination Processed',
  ESCALATED_TO_MANAGEMENT: 'Escalated to Management',
  NO_FURTHER_ACTION: 'No Further Action',
};

export interface PipFailureResolution {
  action: PipFailureResolutionAction;
  notes?: string;
  resolvedById: string;
  resolvedByName: string;
  resolvedAt: string;
}

export interface PerformanceImprovementPlan {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  departmentId?: string;
  departmentName?: string;
  designationName?: string;
  managerId?: string;
  managerName?: string;
  hodId?: string;
  hodName?: string;

  /** Optional link back to the quarterly review that prompted this plan. */
  triggeredByReviewId?: string;

  reason: string;
  category?: string;

  /** Duration in days is always HR/Admin-chosen at creation (or at each extension) — never a fixed preset. */
  startDate: string;
  durationDays: number;
  endDate: string;

  goals: PipGoal[];
  checkIns: PipCheckIn[];

  status: PipStatus;

  initiatedById: string;
  initiatedByName: string;
  initiatedAt: string;
  publishedAt?: string;

  employeeAcknowledgement?: {
    acknowledged: boolean;
    acknowledgedAt?: string;
    comments?: string;
  };

  outcome?: PipOutcome;
  /** History of every outcome decision — mainly relevant when a plan is extended more than once. */
  outcomeHistory?: PipOutcome[];
  /** Only set on a FAILED plan — HR's record of what happened next. Clears the "Not Successful" alert. */
  failureResolution?: PipFailureResolution;

  cancelledReason?: string;
  cancelledById?: string;
  cancelledByName?: string;
  cancelledAt?: string;

  createdAt: string;
  updatedAt: string;
}
