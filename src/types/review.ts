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

/** Standardised reasons for sending a review back — stored as codes so returns can be analysed. */
export type ReturnReasonCode =
  | 'RATING_NOT_SUPPORTED'
  | 'JUSTIFICATION_MISSING'
  | 'ACHIEVEMENT_UNCLEAR'
  | 'RATING_VARIANCE'
  | 'TARGET_MISREAD'
  | 'CALIBRATION'
  | 'OTHER';

export const RETURN_REASON_TEMPLATES: Array<{ code: ReturnReasonCode; label: string; text: string }> = [
  { code: 'RATING_NOT_SUPPORTED', label: 'Rating not supported by achievement', text: 'The rating is not supported by the recorded achievement against target.' },
  { code: 'JUSTIFICATION_MISSING', label: 'Justification missing / too thin', text: 'The rating justification is missing or does not explain the score.' },
  { code: 'ACHIEVEMENT_UNCLEAR', label: 'Achievement not quantified', text: 'Please quantify the achievement (numbers, dates, outcomes) for this KRA.' },
  { code: 'RATING_VARIANCE', label: 'Large Manager / HOD variance', text: 'There is a large gap between the Manager and HOD ratings — please re-check.' },
  { code: 'TARGET_MISREAD', label: 'Scored against wrong target', text: 'The score appears to be measured against a different target than the one set.' },
  { code: 'CALIBRATION', label: 'Calibration with peers', text: 'The rating is out of line with peer calibration for this role/department.' },
  { code: 'OTHER', label: 'Other', text: '' },
];

export type ReturnTarget = 'MANAGER' | 'HOD';

/** Who HR sends a review back to. 'BOTH' = Manager first, then HOD, then back to HR. */
export type ReturnSendTarget = ReturnTarget | 'BOTH';

/** Set on a KRA while it is part of an open return — only flagged KRAs are editable by the recipient. */
export interface KraReturnFlag {
  requestId: string;
  round: number;
  target: ReturnTarget;
  returnedByRole: 'HOD' | 'HR';
  returnedByName: string;
  returnedAt: string;
  comment?: string;
  /** Recipient's own rating/justification at the time of return — the baseline for the diff. */
  previousRating?: number;
  previousJustification?: string;
  previousAchievement?: string;
  /** Recipient's response to the returner's comment. */
  reply?: string;
  /** Recipient explicitly keeps the rating unchanged (requires keepReason). */
  keepRating?: boolean;
  keepReason?: string;
}

/** One KRA's before/after once a return is resolved. */
export interface KraRevisionChange {
  kraId: string;
  kraName: string;
  field: 'rating' | 'hodRating';
  before: number;
  after: number;
  justificationChanged: boolean;
  achievementChanged: boolean;
  kept: boolean;
  keepReason?: string;
  reply?: string;
}

export interface ReviewReturnRequest {
  id: string;
  round: number;
  target: ReturnTarget;
  returnedBy: string;
  returnedByName: string;
  returnedByRole: 'HOD' | 'HR';
  kraIds: string[];
  kraTitles: string[];
  kraComments: Record<string, string>;
  isFullReturn: boolean;
  reasonCodes: ReturnReasonCode[];
  reason: string;
  createdAt: string;
  dueAt: string;
  /** QUEUED = second leg of a return to both, waiting for the Manager to finish first. */
  status: 'OPEN' | 'QUEUED' | 'RESOLVED' | 'SUPERSEDED';
  resolvedAt?: string;
  resolvedBy?: string;
  resolvedByName?: string;
  changes?: KraRevisionChange[];
  remindersSent?: number;
  lastReminderAt?: string;
  escalatedAt?: string;
  /** Set when the return exceeded the configured per-review limit (ESCALATE policy). */
  overLimit?: boolean;
  /** Shared by the Manager and HOD legs of a single 'return to both'. */
  groupId?: string;
  /** When a QUEUED leg became OPEN (its SLA starts then). */
  activatedAt?: string;
}

/** In-progress return selection, saved per reviewer so it survives closing the dialog. */
export interface ReviewReturnDraft {
  id: string;
  reviewId: string;
  userId: string;
  target: ReturnSendTarget;
  kraIds: string[];
  /** HOD's KRAs when target is 'BOTH'. */
  hodKraIds?: string[];
  kraComments: Record<string, string>;
  reasonCodes: ReturnReasonCode[];
  reason: string;
  savedAt: string;
}

export interface ReturnPolicy {
  maxReturnsPerReview: number;
  /** BLOCK: HOD cannot return past the limit (HR/Super Admin can). ESCALATE: allowed, HR is alerted. */
  returnLimitAction: 'BLOCK' | 'ESCALATE';
  returnSlaDays: number;
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
  rating: number; // 1 to 5 — Manager's own independent rating
  comments?: string;
  issueReason?: string;
  ratingJustification?: string; // Mandatory justification when rating is 1, 2, or 5
  selfRating?: number;
  selfAchievement?: string;
  selfComments?: string;
  selfJustification?: string; // Mandatory justification when selfRating is 1, 2, or 5
  hodRating?: number; // 1 to 5 — HOD's own independent rating (never derived from/overwrites Manager's `rating`)
  hodAchievement?: string;
  hodComments?: string;
  hodJustification?: string; // Mandatory justification when hodRating is 1, 2, or 5
  returnFlag?: KraReturnFlag;
  /** Left by the last resolved Manager return so the next reviewer can see what changed. */
  revisedAfterReturn?: {
    requestId: string;
    before: number;
    after: number;
    kept: boolean;
    reply?: string;
    previousHodRating?: number;
    revisedAt: string;
  };
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
  /** Set only on HR-initiated 'RETURNED' actions — who HR sent the review back to. Drives the "Returned by HR" badge and the resubmission skip-routing. */
  returnTarget?: 'MANAGER' | 'HOD';
  returnRequestId?: string;
  returnedKraIds?: string[];
  returnedKraTitles?: string[];
  reasonCodes?: ReturnReasonCode[];
  /** Per-KRA diff recorded when a returned review is resubmitted. */
  kraChanges?: KraRevisionChange[];
  /** On a 'return to both': the KRAs queued for the HOD after the Manager. */
  hodKraIds?: string[];
  hodKraTitles?: string[];
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
  finalScore?: number; // Official score: Manager's own score until HOD also scores, then the average of the two
  managerScore?: number; // Manager's own weighted score (independent of HOD's)
  hodScore?: number; // HOD's own weighted score (independent of Manager's)
  selfScore?: number;
  isSelfSubmitted?: boolean;
  selfSubmittedAt?: string;
  selfStrengths?: string;
  selfImprovements?: string;
  selfObstacles?: string;
  strengths?: string;
  improvements?: string;
  managerOverallComments?: string;
  hodOverallComments?: string;
  employeeComments?: string;
  hrComments?: string;
  kraSnapshot: ReviewKraSnapshot[];
  actionHistory?: ReviewAction[];
  returnRequests?: ReviewReturnRequest[];
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
