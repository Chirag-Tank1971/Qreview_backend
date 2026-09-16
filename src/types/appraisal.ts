import { EmployeeStatus } from './organization.js';
import { ReviewStatus } from './review.js';

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
