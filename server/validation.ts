import { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';

/**
 * Express middleware to validate req.body against a Zod schema
 */
export function validateBody<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const errorDetails = formatZodErrors(result.error);
      const detailMsg = errorDetails.map((d) => d.message).join('; ');
      return res.status(400).json({
        error: detailMsg ? `Validation failed: ${detailMsg}` : 'Validation failed: Please check your input fields.',
        details: errorDetails,
      });
    }
    // Replace req.body with the sanitized and parsed data
    req.body = result.data;
    next();
  };
}

/**
 * Express middleware to validate req.query against a Zod schema
 */
export function validateQuery<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const errorDetails = formatZodErrors(result.error);
      const detailMsg = errorDetails.map((d) => d.message).join('; ');
      return res.status(400).json({
        error: detailMsg ? `Invalid query parameters: ${detailMsg}` : 'Invalid query parameters.',
        details: errorDetails,
      });
    }
    req.query = result.data as any;
    next();
  };
}

/**
 * Format Zod errors into a clean array of field-level errors
 */
function formatZodErrors(error: ZodError): Array<{ field: string; message: string }> {
  const issues = error.issues || (error as any).errors || [];
  return issues.map((err: any) => ({
    field: err.path ? err.path.join('.') || 'root' : 'root',
    message: err.message,
  }));
}

// ============================================================================
// 1. AUTH SCHEMAS
// ============================================================================

export const LoginSchema = z.object({
  email: z.string().trim().min(1, 'Email is required').email('Invalid email address format'),
  password: z.string().min(1, 'Password is required'),
});

export const ChangePasswordSchema = z
  .object({
    newPassword: z.string().min(8, 'Password must be at least 8 characters long'),
    confirmPassword: z.string().min(1, 'Please confirm your new password'),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'New password and confirmation password do not match',
    path: ['confirmPassword'],
  });

export const RefreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

// ============================================================================
// 2. KRA SCHEMAS
// ============================================================================

export const CreateKraSchema = z.object({
  title: z.string().trim().min(3, 'Title must be at least 3 characters').max(200, 'Title cannot exceed 200 characters'),
  description: z.string().trim().max(1000).optional().default(''),
  category: z.string().trim().min(2, 'Category is required'),
  metricType: z.enum(['PERCENTAGE', 'TARGET_NUMERIC', 'RATING_SCALE', 'MILESTONE', 'BOOLEAN']),
  targetUnit: z.string().optional(),
  departmentId: z.string().optional(),
  departmentName: z.string().optional(),
  active: z.boolean().optional().default(true),
});

export const UpdateKraSchema = CreateKraSchema.partial();

export const KraTemplateItemSchema = z.object({
  id: z.string().optional(),
  kraId: z.string().optional(),
  kraName: z.string().optional(),
  title: z.string().trim().min(2, 'KRA title is required'),
  description: z.string().optional().default(''),
  target: z.string().optional().default(''),
  weight: z.number().min(1, 'Weight must be at least 1%').max(100, 'Weight cannot exceed 100%'),
  measurementCriteria: z.string().optional(),
});

export const KraTemplateSchema = z.object({
  title: z.string().trim().min(3, 'Template title must be at least 3 characters'),
  name: z.string().optional(),
  employeeId: z.string().optional(),
  employeeCode: z.string().optional(),
  employeeName: z.string().optional(),
  departmentId: z.string().optional(),
  departmentName: z.string().optional(),
  designationId: z.string().optional(),
  designationName: z.string().optional(),
  cycleId: z.string().optional(),
  cycleCode: z.string().optional(),
  items: z.array(KraTemplateItemSchema).min(1, 'At least one KRA item is required'),
  active: z.boolean().optional().default(true),
}).refine(
  (data) => {
    const totalWeight = data.items.reduce((sum, item) => sum + (Number(item.weight) || 0), 0);
    return Math.abs(totalWeight - 100) < 0.1;
  },
  {
    message: 'Total weightage of all KRA items must sum up to exactly 100%',
    path: ['items'],
  }
);

// ============================================================================
// 3. QUARTERLY REVIEW SCHEMAS
// ============================================================================

export const ReviewKraSnapshotItemSchema = z.object({
  id: z.string().optional(),
  kraId: z.string().optional(),
  kraName: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  targetSnapshot: z.string().optional(),
  measurementCriteria: z.string().optional(),
  weight: z.number().optional(),
  selfRating: z.number().min(0, 'Rating cannot be negative').max(5, 'Rating cannot exceed 5').optional(),
  selfAchievement: z.string().optional(),
  selfComments: z.string().optional(),
  rating: z.number().min(0, 'Rating cannot be negative').max(5, 'Rating cannot exceed 5').optional(),
  achievement: z.string().optional(),
  comments: z.string().optional(),
  issueReason: z.string().optional(),
  hodRating: z.number().min(0, 'Rating cannot be negative').max(5, 'Rating cannot exceed 5').optional(),
  hodAchievement: z.string().optional(),
  hodComments: z.string().optional(),
});

export const SubmitSelfAssessmentSchema = z.object({
  kraSnapshot: z.array(ReviewKraSnapshotItemSchema).optional(),
  selfStrengths: z.string().max(3000).optional(),
  selfImprovements: z.string().max(3000).optional(),
  selfObstacles: z.string().max(3000).optional(),
});

export const SubmitManagerReviewSchema = z
  .object({
    kraSnapshot: z.array(ReviewKraSnapshotItemSchema).optional(),
    strengths: z.string().max(3000).optional(),
    improvements: z.string().max(3000).optional(),
    managerOverallComments: z.string().max(3000).optional(),
    employeeComments: z.string().max(3000).optional(),
    hrComments: z.string().max(3000).optional(),
    isDraft: z.boolean().optional(),
  })
  .refine(
    (data) => {
      if (data.isDraft) return true;
      if (!data.kraSnapshot || data.kraSnapshot.length === 0) return true;
      return data.kraSnapshot.every((k) => k.rating === undefined || (Number(k.rating) >= 1 && Number(k.rating) <= 5));
    },
    {
      message: 'When submitting evaluation scores, all rated KRAs must have a rating between 1.0 and 5.0.',
      path: ['kraSnapshot'],
    }
  );

export const FinalizeAppraisalSchema = z.object({
  remarks: z.string().trim().max(3000).optional(),
  updateEmployeeCtc: z.boolean().optional().default(true),
});

export const ReturnReviewSchema = z.object({
  remarks: z.string().trim().min(3, 'Return remarks must be at least 3 characters long').max(2000),
});

// ============================================================================
// 4. APPRAISAL & CALIBRATION SCHEMAS
// ============================================================================

export const ManagerRecommendationSchema = z.object({
  suggestedIncrementPercent: z
    .number()
    .min(0, 'Increment percentage cannot be negative')
    .max(100, 'Increment percentage cannot exceed 100%'),
  promotionRecommended: z.boolean(),
  promotionDesignationId: z.string().optional(),
  promotionDesignationName: z.string().optional(),
  justification: z
    .string()
    .trim()
    .min(3, 'Justification must be at least 3 characters')
    .max(3000),
  strengthsSummary: z.string().max(3000).optional(),
});

export const HodCalibrationSchema = z.object({
  calibratedIncrementPercent: z
    .number()
    .min(0, 'Increment percentage cannot be negative')
    .max(100, 'Increment percentage cannot exceed 100%'),
  promotionApproved: z.boolean().optional().default(false),
  calibratedRating: z.string().optional(),
  notes: z.string().max(3000).optional().or(z.literal('')),
});

export const HodReturnSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, 'Reason must be at least 3 characters')
    .max(3000),
});

export const HrApprovalSchema = z.object({
  finalIncrementPercent: z
    .number()
    .min(0, 'Increment percentage cannot be negative')
    .max(100, 'Increment percentage cannot exceed 100%'),
  finalRating: z.string().min(1, 'Final rating is required'),
  revisedCtc: z.number().min(0, 'Revised CTC must be positive').optional(),
  effectiveDate: z.string().min(4, 'Effective date is required'),
  notes: z.string().max(3000).optional().or(z.literal('')),
});

export const LockAppraisalSchema = z.object({
  finalIncrementPercent: z
    .number()
    .min(0, 'Increment percentage cannot be negative')
    .max(100, 'Increment percentage cannot exceed 100%')
    .optional(),
  finalRating: z.string().min(1).optional(),
  revisedCtc: z.number().min(0, 'Revised CTC must be positive').optional(),
  effectiveDate: z.string().min(4).optional(),
  promotionApproved: z.boolean().optional(),
  promotionDesignationId: z.string().optional(),
  promotionDesignationName: z.string().optional(),
  notes: z.string().max(3000).optional().or(z.literal('')),
});

export const AcknowledgementSchema = z.object({
  comments: z.string().trim().max(2000).optional(),
});

// ============================================================================
// 5. PERFORMANCE IMPROVEMENT PLAN (PIP) SCHEMAS
// ============================================================================

export const PipGoalSchema = z.object({
  id: z.string().optional(),
  description: z.string().trim().min(3, 'Goal description is required').max(1000),
  targetMetric: z.string().max(500).optional(),
  dueDate: z.string().optional(),
  status: z.enum(['PENDING', 'MET', 'MISSED']).optional().default('PENDING'),
});

export const CreatePipSchema = z.object({
  employeeId: z.string().min(1, 'Employee is required'),
  reason: z.string().trim().min(10, 'Reason must be at least 10 characters').max(3000),
  category: z.string().max(200).optional(),
  triggeredByReviewId: z.string().optional(),
  startDate: z.string().min(4, 'Start date is required'),
  // HR/Admin explicitly choose the plan length in days — no fixed 30/60/90 preset.
  durationDays: z
    .number()
    .int('Duration must be a whole number of days')
    .min(7, 'Duration must be at least 7 days')
    .max(365, 'Duration cannot exceed 365 days'),
  goals: z.array(PipGoalSchema).min(1, 'At least one improvement goal is required'),
  publish: z.boolean().optional().default(false),
});

export const UpdatePipSchema = CreatePipSchema.partial().extend({
  employeeId: z.string().min(1).optional(),
});

export const PipGoalRatingEntrySchema = z.object({
  goalId: z.string().min(1),
  rating: z.number().int().min(1).max(5),
});

export const PipCheckInSchema = z.object({
  notes: z.string().trim().min(3, 'Check-in notes must be at least 3 characters').max(3000),
  // Optional per-goal progress rating (1-5) the manager/HOD can log alongside the check-in.
  goalRatings: z.array(PipGoalRatingEntrySchema).max(50).optional(),
});

export const PipAcknowledgementSchema = z.object({
  comments: z.string().trim().max(2000).optional(),
});

export const PipOutcomeSchema = z
  .object({
    decision: z.enum(['SUCCEEDED', 'FAILED', 'EXTENDED']),
    notes: z.string().max(3000).optional().or(z.literal('')),
    // Required only when extending — HR/Admin again explicitly chooses the additional days.
    additionalDays: z
      .number()
      .int('Additional days must be a whole number')
      .min(1, 'Additional days must be at least 1')
      .max(365)
      .optional(),
  })
  .refine((data) => data.decision !== 'EXTENDED' || (data.additionalDays && data.additionalDays > 0), {
    message: 'Additional days are required when extending a plan',
    path: ['additionalDays'],
  });

export const PipCancelSchema = z.object({
  reason: z.string().trim().min(3, 'A cancellation reason is required').max(2000),
});

export const PipFailureResolutionSchema = z.object({
  action: z.enum(['NEW_PIP_STARTED', 'TERMINATION_PROCESSED', 'ESCALATED_TO_MANAGEMENT', 'NO_FURTHER_ACTION']),
  notes: z.string().max(2000).optional().or(z.literal('')),
});
