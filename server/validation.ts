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
  departmentId: z.string().min(1, 'Department is required'),
  departmentName: z.string().optional(),
  designationId: z.string().optional(),
  designationName: z.string().optional(),
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
  selfRating: z.number().min(1).max(5).optional(),
  selfAchievement: z.string().optional(),
  selfComments: z.string().optional(),
  rating: z.number().min(1).max(5).optional(),
  achievement: z.string().optional(),
  comments: z.string().optional(),
  issueReason: z.string().optional(),
});

export const SubmitSelfAssessmentSchema = z.object({
  kraSnapshot: z.array(ReviewKraSnapshotItemSchema).optional(),
  selfStrengths: z.string().max(3000).optional(),
  selfImprovements: z.string().max(3000).optional(),
  selfObstacles: z.string().max(3000).optional(),
});

export const SubmitManagerReviewSchema = z.object({
  kraSnapshot: z.array(ReviewKraSnapshotItemSchema).optional(),
  strengths: z.string().max(3000).optional(),
  improvements: z.string().max(3000).optional(),
  managerOverallComments: z.string().max(3000).optional(),
  employeeComments: z.string().max(3000).optional(),
  hrComments: z.string().max(3000).optional(),
  isDraft: z.boolean().optional(),
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

export const AcknowledgementSchema = z.object({
  comments: z.string().trim().max(2000).optional(),
});
