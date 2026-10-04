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
    | 'portal'
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
  daysRemaining: number;
  completionRate: number;
}

export interface DashboardMyReview {
  employee: {
    id: string;
    name: string;
    designationName?: string;
    departmentName?: string;
    managerName?: string;
    hodName?: string;
    cycleName?: string;
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

export interface DashboardAppraisalHealth {
  totalEmployees: number;
  draft: number;
  selfReview: number;
  managerReview: number;
  hrReview: number;
  calibration: number;
  locked: number;
}

export interface DashboardRatingDistribution {
  rating: number;
  count: number;
  benchmark: number;
}

export interface DashboardActivityItem {
  id: string;
  actorName: string;
  initials: string;
  action: string;
  description: string;
  timestamp: string;
  relativeTime: string;
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

export interface DashboardComplianceStatus {
  lastAuditEvent: {
    description: string;
    actorName: string;
    relativeTime: string;
  } | null;
  workflowStatus: {
    isActive: boolean;
    statusText: string;
    pendingIssuesCount: number;
  };
  lastDataSync: {
    statusText: string;
    formattedTime: string;
  };
}

export interface DashboardHrOverview {
  totalEmployees: number;
  totalDepartments: number;
  employeeTrendPercent: number;
  reviewsTotal: number;
  reviewsCompleted: number;
  reviewsPendingHr: number;
  reviewsPendingHod: number;
  reviewsPendingManager: number;
  completionRate: number;
  pendingAppraisals: number;
  appraisalsTrendPercent: number;
  employeesWithoutKras: number;
  kraCoverageRate: number;
  kraCoverageLabel: 'Low' | 'Medium' | 'High';
  reviewOnTimeRate: number;
  reviewOnTimeTrendPercent: number;
  departmentProgress: DashboardDepartmentProgress[];
  appraisalHealth: DashboardAppraisalHealth;
  performanceDistribution: DashboardRatingDistribution[];
  recentActivity: DashboardActivityItem[];
  upcomingEvents: DashboardUpcomingEvent[];
  compliance: DashboardComplianceStatus;
  alerts: {
    id: string;
    type: 'crit' | 'warn' | 'info';
    title: string;
    detail?: string;
    actionLabel?: string;
    link?: DashboardTaskLink;
  }[];
  cycleBreakdowns?: Record<
    string,
    {
      key: string;
      label: string;
      appraisalHealth: DashboardAppraisalHealth;
      performanceDistribution: DashboardRatingDistribution[];
      totalStaff: number;
      averageScore?: number | null;
      highPerformersCount?: number;
    }
  >;
}

export interface DashboardHodOverview {
  departmentName: string;
  departmentId: string;
  totalEmployees: number;
  reviewsTotal: number;
  reviewsCompleted: number;
  reviewsPendingHod: number;
  completionRate: number;
  pendingAppraisals: number;
  kraCoverageRate: number;
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
  performanceDistribution: DashboardRatingDistribution[];
  recentActivity: DashboardActivityItem[];
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
  totalDesignations: number;
  totalCycles: number;
  activeCycleName?: string;
  activeCycleId?: string;
  activePeriodId?: string;
  activePeriodName?: string;
  activePeriodStatus?: string;
  activePeriodStart?: string;
  activePeriodEnd?: string;
  totalTemplates: number;
  totalAuditLogs: number;
  systemStatus: 'HEALTHY' | 'DEGRADED' | 'MAINTENANCE';
  /** Count of employees who joined in the current calendar month */
  newJoinersThisMonth: number;
  /** Count of employees who joined last calendar month (for trend) */
  newJoinersLastMonth: number;
  /** Count of employees who left (isPastEmployee) this month */
  exitsThisMonth: number;
  /** Count of employees who left last month */
  exitsLastMonth: number;
  /** Employee count last month (for % change badge) */
  totalEmployeesLastMonth: number;
  /** Pending appraisals needing calibration/approval */
  pendingApprovalsCount: number;
  /** Count of actionable system alerts */
  systemAlertsCount: number;
  /** Monthly headcount trend: last 7 months with total employees & new joiners */
  headcountTrend: {
    month: string;       // e.g. "Apr", "May"
    total: number;
    newJoiners: number;
  }[];
  /** Distribution of active employees across departments */
  departmentDistribution: {
    departmentId: string;
    departmentName: string;
    count: number;
    percentage: number;
  }[];
  /** Per-department review completion progress for the active period */
  reviewCycleProgress: {
    departmentId: string;
    departmentName: string;
    totalEmployees: number;
    reviewed: number;
    completionRate: number;
  }[];
  /** Items needing admin attention */
  attentionItems: {
    id: string;
    icon: 'warning' | 'info' | 'calendar' | 'user';
    color: 'red' | 'blue' | 'purple' | 'amber';
    title: string;
    detail: string;
    count: number;
    link: DashboardTaskLink;
  }[];
  recentSecurityEvents: DashboardActivityItem[];
  masterBreakdown: {
    name: string;
    count: number;
    description: string;
    route: DashboardTaskLink['view'];
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
