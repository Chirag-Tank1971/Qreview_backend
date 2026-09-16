import { UserRole } from './auth.js';

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
