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
  employeeId?: string;
  employeeCode?: string;
  employeeName?: string;
  departmentId?: string;
  departmentName?: string;
  designationId?: string;
  designationName?: string;
  cycleId?: string;
  cycleCode?: string;
  totalWeight: number;
  active: boolean;
  items: KraTemplateItem[];
  createdAt?: string;
  updatedAt?: string;
}
