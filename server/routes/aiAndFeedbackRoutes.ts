import { Router } from 'express';
import { GoogleGenAI, Type } from '@google/genai';
import { getDbCollection } from '../db.js';
import { authenticateToken, requireRoles, AuthenticatedRequest } from '../auth.js';
import {
  TalentRecord,
  AiReviewSynthesisRequest,
  AiReviewSynthesisResult,
  AiTalentInsightsRequest,
  AiTalentInsightsResult,
} from '../../src/types/index.js';

export const aiAndFeedbackRouter = Router();
aiAndFeedbackRouter.use(authenticateToken);
aiAndFeedbackRouter.use(
  '/gemini',
  requireRoles('SUPER_ADMIN', 'HR', 'HOD', 'MANAGER', 'REPORTING_MANAGER', 'EMPLOYEE')
);

// Initialize Gemini Client (lazy helper to ensure process.env is read)
function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// Resilient helper with retry and model fallback for 503 / high demand spikes
async function safeGenerateContent(ai: GoogleGenAI, config: {
  contents: string;
  responseSchema?: any;
}): Promise<{ text: string; modelUsed: string } | null> {
  const modelsToTry = ['gemini-3.8-flash', 'gemini-flash-latest'];
  
  for (const modelName of modelsToTry) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model: modelName,
          contents: config.contents,
          config: {
            responseMimeType: 'application/json',
            responseSchema: config.responseSchema,
          },
        });
        if (response && response.text) {
          console.log(`[Gemini AI] Content generated using model: "${modelName}"`);
          return { text: response.text, modelUsed: modelName };
        }
      } catch (err: any) {
        // If 503 UNAVAILABLE or 429 high demand, wait briefly before retrying
        const isTransient = err?.message?.includes('503') || err?.message?.includes('429') || err?.message?.includes('demand');
        if (isTransient && attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 800));
          continue;
        }
        // Break to try next fallback model
        break;
      }
    }
  }
  console.warn('[Gemini AI] Gemini models unavailable or rate-limited; falling back to rule-based engine');
  return null;
}

// -------------------------------------------------------------
// AI ENDPOINT 1: Performance Review Narrative & Appraisal Synthesizer
// -------------------------------------------------------------
aiAndFeedbackRouter.post('/gemini/generate-review-narrative', async (req, res) => {
  try {
    const payload: AiReviewSynthesisRequest = req.body;
    console.log(`[Gemini AI] Generating review narrative for: "${payload.employeeName}" (${payload.department})`);
    const ai = getGeminiClient();

    const prompt = `You are an elite Chief People Officer and HR appraisal consultant. Synthesize a comprehensive, executive-level performance review assessment for:
Employee: ${payload.employeeName}
Designation: ${payload.designation}
Department: ${payload.department}
Annual Performance Rollup Score: ${payload.annualScore} / 5.00
Quarterly Scores Breakdown:
${payload.quarterlyScores.map((q) => `- ${q.quarter}: Score ${q.score}/5.00 | Notes: "${q.reviewNotes || 'Solid milestone execution'}"`).join('\n')}

Core KRAs & Weights:
${payload.kraSummary.map((k) => `- ${k.title} (${k.weightage}% weight): Target "${k.target}"`).join('\n')}

Perspective: ${payload.perspective.toUpperCase()}

Generate a structured JSON response matching the required schema with balanced, metric-driven, and empowering language.`;

    if (ai) {
      const responseSchema = {
        type: Type.OBJECT,
        properties: {
          executiveSummary: { type: Type.STRING },
          topStrengths: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          growthAreas: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          suggestedManagerNarrative: { type: Type.STRING },
          suggestedSelfAppraisalDraft: { type: Type.STRING },
          keyAchievements: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          recommendedDevelopmentGoals: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: [
          'executiveSummary',
          'topStrengths',
          'growthAreas',
          'suggestedManagerNarrative',
          'suggestedSelfAppraisalDraft',
          'keyAchievements',
          'recommendedDevelopmentGoals',
        ],
      };

      const result = await safeGenerateContent(ai, { contents: prompt, responseSchema });
      if (result && result.text) {
        try {
          const parsed: AiReviewSynthesisResult = JSON.parse(result.text);
          return res.json({ success: true, data: parsed, engine: result.modelUsed });
        } catch {
          // fallback
        }
      }
    }

    // Fallback structured generation
    const fallbackResult: AiReviewSynthesisResult = {
      executiveSummary: `${payload.employeeName} demonstrated high operational excellence and consistent milestone delivery across Q1–Q4, maintaining an overall score of ${payload.annualScore}/5.00 with strong alignment to departmental strategic KRAs.`,
      topStrengths: [
        `Consistently exceeded quality standards on ${payload.kraSummary[0]?.title || 'core deliverable goals'}.`,
        'Proactive cross-functional collaboration and clear milestone communication.',
        'High ownership in troubleshooting complex edge cases during release cycles.',
      ],
      growthAreas: [
        'Scale mentorship by leading bi-weekly technical or functional knowledge-sharing workshops.',
        'Enhance long-range predictive resource forecasting for Q3/Q4 initiatives.',
      ],
      suggestedManagerNarrative: `Over the past 4 quarters, ${payload.employeeName} has proven to be an invaluable asset to ${payload.department}. Their dedication to quality on weighted KRAs resulted in an exceptional ${payload.annualScore} rating. I recommend continued leadership exposure and expanded project scope for the upcoming cycle.`,
      suggestedSelfAppraisalDraft: `Throughout this cycle, I focused heavily on executing high-impact deliverables aligned with our core KRAs. In addition to meeting targets, I collaborated closely with peers to maintain release stability and address bottlenecks early. I look forward to taking on broader strategic responsibilities in the next cycle.`,
      keyAchievements: [
        `Achieved ${payload.annualScore >= 4.0 ? 'Top Tier' : 'Core'} performance ranking across all 4 quarters.`,
        `Successfully met all ${payload.kraSummary.length} designated KRAs with zero critical compliance slips.`,
        'Received peer recognitions for velocity and proactive problem solving.',
      ],
      recommendedDevelopmentGoals: [
        'Complete Advanced Architecture & Systems Design certification.',
        'Lead one cross-departmental innovation or automation sprint.',
      ],
    };

    return res.json({ success: true, data: fallbackResult, engine: 'rule-synthesizer' });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to synthesize review' });
  }
});

// -------------------------------------------------------------
// AI ENDPOINT 2: Executive Talent Matrix & Retention Intelligence
// -------------------------------------------------------------
aiAndFeedbackRouter.post('/gemini/talent-insights-summary', async (req, res) => {
  try {
    const payload: AiTalentInsightsRequest = req.body;
    console.log(`[Gemini AI] Synthesizing talent matrix insights for: "${payload.department || 'Enterprise-Wide'}"`);
    const ai = getGeminiClient();

    const prompt = `You are an Executive Board Talent Advisor. Generate strategic talent intelligence and risk mitigation recommendations:
Department: ${payload.department || 'Enterprise-Wide'}
Total Cohort: ${payload.talentPoolSummary.totalEmployees} Employees
High Performers: ${payload.talentPoolSummary.highPerformersCount}
Core Performers: ${payload.talentPoolSummary.coreCount}
Underperforming / High Needs: ${payload.talentPoolSummary.underperformersCount}
Flight Risk / Retention Concerns: ${payload.talentPoolSummary.highRiskAttritionCount}

Provide:
1. Department Health Score (0 - 100)
2. Strategic Observations (3-4 bullets)
3. Retention Recommendations (2-3 items)
4. Leadership Succession Pipeline insights (2 items)
5. Immediate Risk Mitigations (2 items)`;

    if (ai) {
      const responseSchema = {
        type: Type.OBJECT,
        properties: {
          departmentHealthScore: { type: Type.NUMBER },
          strategicObservations: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          retentionRecommendations: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          leadershipSuccessionPipelines: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          immediateRiskMitigations: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: [
          'departmentHealthScore',
          'strategicObservations',
          'retentionRecommendations',
          'leadershipSuccessionPipelines',
          'immediateRiskMitigations',
        ],
      };

      const result = await safeGenerateContent(ai, { contents: prompt, responseSchema });
      if (result && result.text) {
        try {
          const parsed: AiTalentInsightsResult = JSON.parse(result.text);
          return res.json({ success: true, data: parsed, engine: result.modelUsed });
        } catch {
          // fallback
        }
      }
    }

    const fallbackResult: AiTalentInsightsResult = {
      departmentHealthScore: 88,
      strategicObservations: [
        `Strong top-tier concentration with ${payload.talentPoolSummary.highPerformersCount} high performers driving core business velocity.`,
        `Solid core benchmark of ${payload.talentPoolSummary.coreCount} contributors providing operational stability across quarterly cycles.`,
        `${payload.talentPoolSummary.underperformersCount} employees currently identified for targeted skill coaching.`,
      ],
      retentionRecommendations: [
        'Accelerate merit increment distribution for high-impact architects to match market 85th percentile.',
        'Grant high-potential leaders autonomy over greenfield research initiatives and executive visibility.',
      ],
      leadershipSuccessionPipelines: [
        'Rohan Deshmukh & Kavita Menon identified as primary succession candidates for upcoming Director-level openings.',
        'Establish structured executive shadowing sessions ahead of next fiscal cycle.',
      ],
      immediateRiskMitigations: [
        'Conduct 1-on-1 retention stay interviews with key flight-risk contributors.',
        'Conduct regular developmental check-ins to ensure structured progression and coachability.',
      ],
    };

    return res.json({ success: true, data: fallbackResult, engine: 'rule-synthesizer' });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to generate talent insights' });
  }
});

// -------------------------------------------------------------
// 9-BOX TALENT MATRIX ENDPOINTS
// -------------------------------------------------------------

// GET all talent records
aiAndFeedbackRouter.get('/talent-records', async (req: AuthenticatedRequest, res) => {
  try {
    const talentCol = getDbCollection('talentRecords');
    let records: TalentRecord[] = await (await talentCol.find({})).toArray();
    // If EMPLOYEE role, restrict to their own talent record
    if (req.userRole === 'EMPLOYEE' && req.user?.employeeId) {
      records = records.filter((r) => r.employeeId === req.user?.employeeId);
    }
    res.json(records);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update talent record (e.g. potential, risk, actions)
aiAndFeedbackRouter.put('/talent-records/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const talentCol = getDbCollection('talentRecords');
    const target = await talentCol.findOne({ id });
    if (!target) {
      return res.status(404).json({ error: 'Talent record not found' });
    }

    const updated = {
      ...target,
      ...req.body,
      lastAssessedDate: new Date().toISOString().split('T')[0],
    };

    await talentCol.updateOne({ id }, { $set: updated });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
