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
