export interface DbStatus {
  connected: boolean;
  mode: 'MONGODB' | 'EMBEDDED_COMPATIBLE';
  uri?: string;
  databaseName: string;
  collections: Record<string, number>;
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
