/**
 * Canonical Domain Types & Data Contracts for Appraisal Management System (Backend)
 * Self-contained, production-ready TypeScript definitions.
 */

export type UserRole =
  | 'SUPER_ADMIN'
  | 'HR'
  | 'REPORTING_MANAGER'
  | 'MANAGER'
  | 'HOD'
  | 'EMPLOYEE'
  | 'MANAGEMENT';

export type EmployeeStatus = 'ACTIVE' | 'INACTIVE' | 'PROBATION' | 'NOTICE';

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

export type AppraisalStatus =
  | 'PENDING'
  | 'MANAGER_RECOMMENDED'
  | 'HOD_CALIBRATED'
  | 'HR_APPROVED'
  | 'COMPLETED'
  | 'LOCKED'
  | 'SUBMITTED'
  | 'APPROVED'
  | 'REJECTED';

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

export interface Department {
  id: string;
  name: string;
  code: string;
  hodId?: string;
  hodName?: string;
  budgetCapPercent?: number;
  active: boolean;
  createdAt: string;
}

export interface Designation {
  id: string;
  name: string;
  departmentId: string;
  departmentName?: string;
  level: number;
  active: boolean;
}

export interface Cycle {
  id: string;
  code: string; // 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H'
  name: string;
  appraisalMonth: number; // 1 - 12 (Jan - Dec)
  colorHex: string;
  description?: string;
  active: boolean;
}

export interface Employee {
  id: string;
  employeeCode: string;
  name: string;
  email: string;
  phone?: string;
  location?: string;
  departmentId: string;
  departmentName?: string;
  designationId: string;
  designationName?: string;
  joiningDate: string;
  managerId?: string;
  managerName?: string;
  hodId?: string;
  hodName?: string;
  cycleId: string;
  cycleCode: string;
  cycleName?: string;
  cycleColor?: string;
  currentKraTemplateId?: string;
  currentKraTemplateName?: string;
  status: EmployeeStatus;
  isPastEmployee?: boolean;
  pastEmployeeDate?: string;
  relievingDate?: string;
  currentCtc?: number;
  currency?: string;
  hasLoginAccount?: boolean;
  userActive?: boolean;
  systemRole?: UserRole;
  userId?: string;
  lastAppraisalDate?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Kra {
  id: string;
  code?: string;
  title: string;
  description: string;
  category?: string;
  departmentId?: string;
  departmentName?: string;
  defaultWeight?: number;
  measurementCriteria?: string;
  metricType?: string;
  targetUnit?: string;
  target?: string;
  active: boolean;
  createdAt?: string;
}

export interface KraTemplateItem {
  id?: string;
  kraId?: string;
  kraName?: string;
  title: string;
  description: string;
  target: string;
  measurementCriteria?: string;
  weight: number;
}

export type KraItem = KraTemplateItem;

export interface KraTemplate {
  id: string;
  title: string;
  name?: string;
  description?: string;
  departmentId?: string;
  departmentName?: string;
  designationId?: string;
  designationName?: string;
  totalWeight: number;
  active: boolean;
  items: KraTemplateItem[];
  createdAt?: string;
  updatedAt?: string;
}

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

export interface AppraisalQuarterRecord {
  quarter?: number; // 1 to 4
  periodId?: string;
  periodName?: string;
  reviewId?: string;
  reviewPeriodId?: string;
  reviewPeriodName?: string;
  score: number;
  strengths?: string;
  improvements?: string;
  managerComments?: string;
  hrComments?: string;
  status?: ReviewStatus;
}

export interface Appraisal {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  employeeStatus?: EmployeeStatus;
  departmentId: string;
  departmentName: string;
  designationId?: string;
  designationName: string;
  joiningDate?: string;
  cycleId: string;
  cycleCode: string;
  cycleName?: string;
  cycleColor?: string;
  appraisalMonth: number;
  appraisalYear: number;
  appraisalPeriod?: string;
  quarterlyReviews?: AppraisalQuarterRecord[];
  quarterlyHistory?: AppraisalQuarterRecord[];
  averageQuarterlyScore: number;
  managerId: string;
  managerName: string;
  hodId?: string;
  hodName?: string;
  status: AppraisalStatus;
  currentCtc?: number;
  previousCtc?: number;
  proposedCtc?: number;
  finalCtc?: number;
  currency?: string;
  incrementPercentage?: number;
  incrementAmount?: number;
  approvedIncrementPercentage?: number;
  proposedIncrementPercentage?: number;
  revisedCtc?: number;
  suggestedIncrementMin?: number;
  suggestedIncrementMax?: number;
  defaultIncrement?: number;
  recommendedRating?: string;
  finalRating?: string;
  promotionRecommended?: boolean;
  promotedDesignationId?: string;
  promotionDesignationId?: string;
  promotedDesignationName?: string;
  promotionDesignationName?: string;
  managerRemarks?: string;
  managerRecommendation?: any;
  hodRemarks?: string;
  hodCalibration?: any;
  hrRemarks?: string;
  hrApproval?: any;
  remarks?: string;
  effectiveDate?: string;
  isLocked: boolean;
  lockedAt?: string;
  finalizedAt?: string;
  letterIssued?: boolean;
  letterReleased?: boolean;
  letterIssuedAt?: string;
  acknowledgedByEmployee?: boolean;
  acknowledgedAt?: string;
  employeeAcknowledgement?: any;
  createdAt: string;
  updatedAt: string;
}

export type NotificationType =
  | 'REVIEW_ASSIGNED'
  | 'MANAGER_SUBMITTED'
  | 'RETURNED'
  | 'HR_COMPLETED'
  | 'APPRAISAL_DUE'
  | 'LETTER_RELEASED'
  | 'CALIBRATION_WARNING'
  | 'BUDGET_ALERT'
  | 'HOD_ACTION_REQUIRED'
  | 'LETTER_ACKNOWLEDGED'
  | 'DUE_SOON'
  | 'GENERAL'
  | string;

export interface Notification {
  id: string;
  userId: string;
  userRole?: UserRole;
  type: NotificationType;
  title: string;
  message: string;
  isRead: boolean;
  priority?: 'LOW' | 'MEDIUM' | 'HIGH';
  metadata?: Record<string, any>;
  createdAt: string;
}

export interface AuditLog {
  id: string;
  userId?: string;
  userName?: string;
  userRole?: UserRole;
  actorId?: string;
  actorName?: string;
  actorRole?: UserRole;
  actorEmail?: string;
  targetEmployeeId?: string;
  targetEmployeeName?: string;
  module: string;
  action?: string;
  actionType?: string;
  recordId?: string;
  oldValue?: any;
  newValue?: any;
  previousValue?: any;
  details?: string;
  metadata?: any;
  targetDepartment?: string;
  cycleId?: string;
  cycleName?: string;
  description?: string;
  diffSummary?: string;
  ipAddress?: string;
  userAgent?: string;
  isFlaggedCompliance?: boolean;
  severity?: string;
  timestamp?: string;
  createdAt?: string;
}

export type AuditLogEntry = AuditLog;

export interface TalentRecord {
  id: string;
  employeeId: string;
  employeeCode?: string;
  employeeName?: string;
  department?: string;
  designation?: string;
  performanceLevel?: string;
  potentialLevel?: string;
  nineBoxCategory?: string;
  riskFactors?: string[];
  recommendedActions?: string[];
  currentScore?: number;
  nineBoxGrid?: { performance: 1 | 2 | 3; potential: 1 | 2 | 3 };
  flightRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'low' | 'medium' | 'high';
  growthPlan?: string;
  successionReady?: boolean;
  targetNextRole?: string;
  lastAssessedDate?: string;
  updatedAt?: string;
}

export interface ComplianceFlag {
  id: string;
  title?: string;
  type?: 'WEIGHT_MISMATCH' | 'ORPHAN_EMPLOYEE' | 'OVERDUE_REVIEW' | 'UNASSIGNED_KRA' | string;
  flagType?: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'WARNING' | 'NOTICE';
  description: string;
  impactMetric?: string;
  employeeId?: string;
  employeeName?: string;
  department?: string;
  cycleId?: string;
  recordId?: string;
  resolved?: boolean;
  isResolved?: boolean;
  detectedAt?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionNote?: string;
  createdAt?: string;
}

export interface EmailLog {
  id: string;
  recipientId: string;
  recipientEmail: string;
  recipientName: string;
  subject: string;
  templateType: string;
  status: 'SENT' | 'FAILED' | 'QUEUED' | 'SKIPPED';
  errorMessage?: string;
  previewUrl?: string;
  messageId?: string;
  metadata?: Record<string, any>;
  sentAt?: string;
  createdAt?: string;
}

export interface DbStatus {
  connected: boolean;
  mode: 'MONGODB' | 'EMBEDDED_COMPATIBLE';
  uri?: string;
  databaseName: string;
  collections: Record<string, number>;
}

export interface ReviewSummaryStats {
  total: number;
  draft: number;
  managerPending: number;
  managerCompleted: number;
  hrPending: number;
  closed: number;
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

export interface AppraisalSummaryStats {
  total: number;
  pending: number;
  managerRecommended: number;
  hodCalibrated: number;
  hrApproved: number;
  completed?: number;
  locked: number;
  promotionsCount?: number;
  averageScore?: number;
  averageIncrement?: number;
  averageIncrementPercent?: number;
  totalCurrentPayroll?: number;
  totalRevisedPayroll?: number;
  totalIncrementBudgetImpact?: number;
  totalBudgetUtilized?: number;
  ratingDistribution?: {
    outstanding: number;
    exceeds: number;
    meets: number;
    needsImprovement: number;
  };
}

export type BulkDatasetType =
  | 'employees'
  | 'kras'
  | 'quarterly-scores'
  | 'increment-matrix'
  | 'EMPLOYEES'
  | 'REVIEWS'
  | 'SALARIES'
  | 'KRAS'
  | string;

export interface BulkTemplateColumn {
  key: string;
  label: string;
  required: boolean;
  description: string;
  example: string;
  type?: string;
  options?: string[];
}

export interface BulkValidationRowResult {
  rowIndex?: number;
  rowNumber?: number;
  status?: string;
  action?: string;
  data: Record<string, any>;
  errors: string[];
  warnings?: string[];
  isValid: boolean;
}

export interface BulkValidationReport {
  datasetType?: string;
  totalRows: number;
  validRows?: number;
  validCount?: number;
  errorRows?: number;
  errorCount?: number;
  warningCount?: number;
  canProceed?: boolean;
  requiredFields?: string[];
  rows?: BulkValidationRowResult[];
  results?: any;
  isValid?: boolean;
}

export interface BulkImportResult {
  total?: number;
  inserted?: number;
  insertedCount?: number;
  updated?: number;
  updatedCount?: number;
  skippedCount?: number;
  failed?: number;
  failedCount?: number;
  message?: string;
  batchId?: string;
  success?: boolean;
  errors: any[];
  datasetType?: BulkDatasetType;
}

export interface AiReviewSynthesisRequest {
  employeeName?: string;
  reviewPeriodName?: string;
  scores?: any[];
  strengths?: string;
  improvements?: string;
  comments?: string;
  [key: string]: any;
}

export interface AiReviewSynthesisResult {
  summary?: string;
  executiveSummary?: string;
  strengths?: string[];
  topStrengths?: string[];
  growthAreas?: string[];
  recommendedRating?: string;
  talkingPoints?: string[];
  suggestedGoals?: string[];
  [key: string]: any;
}

export interface AiTalentInsightsRequest {
  departmentId?: string;
  department?: string;
  cycleId?: string;
  talentPoolSummary?: any;
  [key: string]: any;
}

export interface AiTalentInsightsResult {
  departmentHealthScore?: number;
  strategicObservations?: string[];
  retentionRecommendations?: any;
  leadershipSuccessionPipelines?: any;
  topPerformersSummary?: string;
  flightRiskInsights?: string;
  skillGaps?: string[];
  successionRecommendations?: Array<{ role: string; candidates: string[] }>;
  [key: string]: any;
}

export interface AuditTimelineEvent {
  id: string;
  timestamp?: string;
  action?: string;
  actorName: string;
  actorRole: string;
  title?: string;
  stageName?: string;
  stageKey?: string;
  status?: string;
  summary?: string;
  [key: string]: any;
}

export interface ComplianceRiskReport {
  overallRiskLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  overallRiskScore?: number;
  riskLevel?: string;
  totalFlags?: number;
  totalActiveFlags?: number;
  criticalFlagsCount?: number;
  unresolvedFlags?: number;
  categories?: Record<string, number>;
  recommendations?: string[];
  [key: string]: any;
}

export interface AuditFilterParams {
  userId?: string;
  module?: string;
  action?: string;
  startDate?: string;
  endDate?: string;
  search?: string;
}

export interface AuditSummaryMetrics {
  totalLogs: number;
  todayLogsCount?: number;
  calibrationsCount?: number;
  letterAcknowledgementsCount?: number;
  flaggedAnomaliesCount?: number;
  complianceScore?: number;
  actionsByModule?: Record<string, number>;
  complianceViolationsCount?: number;
  recentActivityCount?: number;
  [key: string]: any;
}
