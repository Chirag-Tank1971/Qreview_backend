import { ReviewStatus } from './review.js';

/** Work items the dashboard can raise. Each one exists only while the underlying record is still waiting on the viewer. */
export type DashboardTaskType =
  | 'SELF_ASSESSMENT'
  | 'ACKNOWLEDGE_APPRAISAL'
  | 'ACKNOWLEDGE_PIP'
  | 'SCORE_REVIEW'
  | 'HOD_SCORE_REVIEW'
  | 'HR_FINALIZE_REVIEW'
  | 'REVISE_RETURNED_REVIEW'
  | 'RECOMMEND_INCREMENT'
  | 'CALIBRATE_APPRAISAL'
  | 'ASSIGN_KRAS'
  | 'REVIEW_WORKFLOW'
  | 'PIP_CHECKIN'
  | 'NOTIFICATION';

export type DashboardUrgency = 'OVERDUE' | 'DUE_SOON' | 'UPCOMING' | 'NO_DATE';

/** Where a task's action button takes the user — mirrors App.tsx handleNavigate(view, params). */
export interface DashboardTaskLink {
  view:
    | 'dashboard'
    | 'reviews'
    | 'appraisals'
    | 'pip'
    | 'kras'
    | 'employees'
    | 'reports'
    | 'bulk'
    | 'notifications'
    | 'hierarchy'
    | 'audit'
    | 'calibration'
    | 'management';
  params?: Record<string, string | number | boolean>;
}

export interface DashboardTask {
  id: string;
  type: DashboardTaskType;
  title: string;
  detail: string;
  employeeId?: string;
  employeeName?: string;
  dueDate?: string;
  urgency: DashboardUrgency;
  priority?: 'High' | 'Medium' | 'Low';
  dueText?: string;
  link: DashboardTaskLink;
  notificationId?: string;
}

export type DashboardReviewStage = 'MANAGER' | 'HOD' | 'HR' | 'CLOSED';

export interface DashboardPeriod {
  id: string;
  name: string;
  status: string;
  startDate: string;
  endDate: string;
  dueDate: string;
}

export interface DashboardMyReview {
  employee: {
    id: string;
    name: string;
    employeeCode?: string;
    designationName?: string;
    departmentName?: string;
    managerName?: string;
    hodName?: string;
    cycleName?: string;
    email?: string;
    phone?: string;
    joiningDate?: string;
    status?: string;
  };
  currentReview: {
    id: string;
    periodName: string;
    status: ReviewStatus;
    stage: DashboardReviewStage;
    isSelfSubmitted: boolean;
    finalScore?: number;
    dueDate?: string;
  } | null;
  /** Snapshot of the active/most-recent annual appraisal for this employee */
  activeAppraisal: {
    id: string;
    appraisalYear: number;
    appraisalMonth: number;
    status: string;
    isLocked: boolean;
    averageQuarterlyScore?: number;
    suggestedIncrementMin?: number;
    suggestedIncrementMax?: number;
    recommendedRating?: string;
    managerRecommendedIncrement?: number;
    hrApprovedIncrement?: number;
    ctcBreakdown?: {
      currentCTC?: number;
      newCTC?: number;
      incrementAmount?: number;
    };
    acknowledged: boolean;
  } | null;
  /** Average of the last four manager-evaluated quarters (same rule as the appraisal matrix). */
  rollingScore: number;
  evaluatedQuarters: number;
  /** Appraisal-matrix band implied by the rolling score; null until a quarter has been evaluated. */
  ratingBand: string | null;
  scoreHistory: { periodName: string; score: number }[];
  kras: { title: string; weight: number; lastRating?: number; description?: string; target?: string }[];
  nextAppraisal: { month: number; year: number; cycleName?: string } | null;
}

export interface DashboardTeamMember {
  employeeId: string;
  name: string;
  designationName?: string;
  reviewId?: string;
  reviewStatus?: ReviewStatus;
  stage?: DashboardReviewStage;
  isSelfSubmitted: boolean;
  lastScore?: number;
  previousScore?: number;
  onPip: boolean;
}

export interface DashboardTeam {
  /** The oldest review period that still has open team reviews, else the latest one. */
  periodName?: string;
  size: number;
  reviewsInPeriod: number;
  scoredByManager: number;
  selfSubmitted: number;
  averageScore: number;
  members: DashboardTeamMember[];
  ratingSpread: { outstanding: number; exceeds: number; meets: number; needsImprovement: number; unrated: number };
  alerts?: {
    id: string;
    type: 'crit' | 'warn' | 'info';
    title: string;
    detail?: string;
    actionLabel?: string;
    link?: DashboardTaskLink;
  }[];
}

export interface DashboardDepartmentProgress {
  departmentId: string;
  departmentName: string;
  totalEmployees: number;
  reviewsInitiated: number;
  reviewsCompleted: number;
  completionRate: number;
  kraCoverageRate: number;
  pendingCount: number;
  status: 'Completed' | 'In Progress' | 'Not Started';
}

export interface DashboardUpcomingEvent {
  id: string;
  title: string;
  category: string;
  timeRange: string;
  dateMonth: string;
  dateDay: string;
  daysRemaining: number;
  daysText: string;
}

/** Who in scope has no review for the active period, grouped by the eligibility check that blocks them. */
export interface DashboardCoverage {
  periodName: string;
  inScope: number;
  withReview: number;
  missing: number;
  reasons: {
    key: 'NO_MANAGER' | 'NO_KRA' | 'START_LATER' | 'TENURE' | 'READY' | 'OTHER';
    label: string;
    hint: string;
    count: number;
    people: string[];
    link: DashboardTaskLink;
  }[];
}

/** A Manager or HOD with active-period reviews waiting on them. */
export interface DashboardReviewerBacklog {
  reviewerId: string;
  reviewerName: string;
  role: 'MANAGER' | 'HOD';
  pending: number;
  employees: string[];
  oldestWaitingDays: number;
  overdueDays: number;
  lastRemindedAt?: string;
}

/** Active-period rating spread vs the Bell Curve targets, Manager/HOD disagreement and returns. */
export interface DashboardCalibration {
  scored: number;
  bands: {
    key: 'OUTSTANDING' | 'EXCEEDS_EXPECTATIONS' | 'MEETS_EXPECTATIONS' | 'NEEDS_IMPROVEMENT';
    label: string;
    count: number;
    percent: number;
    targetPercent: number;
  }[];
  krasCompared: number;
  krasDisagreeing: number;
  reviewsWithDisagreement: number;
  returnsThisCycle: number;
  returnsOpen: number;
  returnsOverdue: number;
}

export interface DashboardDataHealthItem {
  key: string;
  label: string;
  count: number;
  people: string[];
  link: DashboardTaskLink;
}

export interface DashboardEmailDelivery {
  days: number;
  providerConfigured: boolean;
  sent: number;
  failed: number;
  skipped: number;
  queued: number;
  recentFailures: { recipientName: string; subject: string; error?: string; at: string }[];
}

export interface DashboardHrOverview {
  totalEmployees: number;
  totalDepartments: number;
  reviewsTotal: number;
  reviewsCompleted: number;
  reviewsPendingHr: number;
  reviewsPendingHod: number;
  reviewsPendingManager: number;
  completionRate: number;
  pendingAppraisals: number;
  employeesWithoutKras: number;
  kraCoverageRate: number;
  departmentProgress: DashboardDepartmentProgress[];
  upcomingEvents: DashboardUpcomingEvent[];
  coverage: DashboardCoverage | null;
  reviewerBacklog: DashboardReviewerBacklog[];
  calibration: DashboardCalibration;
  alerts: {
    id: string;
    type: 'crit' | 'warn' | 'info';
    title: string;
    detail?: string;
    actionLabel?: string;
    link?: DashboardTaskLink;
  }[];
}

export interface DashboardHodOverview {
  departmentName: string;
  totalEmployees: number;
  reviewsTotal: number;
  reviewsCompleted: number;
  reviewsPendingHod: number;
  completionRate: number;
  averageScore: number | null;
  highPerformersCount: number;
  ratingSpread: {
    outstanding: number;
    exceeds: number;
    meets: number;
    needsImprovement: number;
    unrated: number;
  };
  departmentMembers: {
    employeeId: string;
    name: string;
    designationName?: string;
    managerId?: string;
    managerName?: string;
    reviewStatus?: string;
    stage?: string;
    lastScore?: number;
    onPip: boolean;
  }[];
  alerts: {
    id: string;
    type: 'crit' | 'warn' | 'info';
    title: string;
    detail?: string;
    actionLabel?: string;
    link?: DashboardTaskLink;
  }[];
}

export interface DashboardAdminOverview {
  totalUsers: number;
  activeUsers: number;
  totalEmployees: number;
  totalDepartments: number;
  activePeriodName?: string;
  newJoinersThisMonth: number;
  exitsThisMonth: number;
  reviewCycleProgress: {
    departmentId: string;
    departmentName: string;
    totalEmployees: number;
    reviewed: number;
    completionRate: number;
  }[];
  attentionItems: {
    id: string;
    icon: 'warning' | 'info' | 'calendar' | 'user';
    color: 'red' | 'blue' | 'purple' | 'amber';
    title: string;
    detail: string;
    count: number;
    link: DashboardTaskLink;
  }[];
  dataHealth: DashboardDataHealthItem[];
  emailDelivery: DashboardEmailDelivery;
}

export interface DashboardSummary {
  generatedAt: string;
  period: DashboardPeriod | null;
  tasks: DashboardTask[];
  me: DashboardMyReview | null;
  /** Present only when the viewer has direct reports. */
  team: DashboardTeam | null;
  /** Present when the viewer is an HR or Admin user. */
  hr?: DashboardHrOverview | null;
  /** Present when the viewer is a HOD. */
  hod?: DashboardHodOverview | null;
  /** Present when the viewer is a Super Admin. */
  admin?: DashboardAdminOverview | null;
}
