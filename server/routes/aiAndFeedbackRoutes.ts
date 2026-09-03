import { Router } from 'express';
import { GoogleGenAI, Type } from '@google/genai';
import { memoryDb } from '../db.js';
import {
  FeedbackEntry,
  PipRecord,
  TalentRecord,
  AiReviewSynthesisRequest,
  AiReviewSynthesisResult,
  AiBiasCheckRequest,
  AiBiasCheckResult,
  AiGrowthPlanRequest,
  AiGrowthPlanResult,
  AiTalentInsightsRequest,
  AiTalentInsightsResult,
} from '../../src/types.js';

export const aiAndFeedbackRouter = Router();

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
  return null;
}

// -------------------------------------------------------------
// AI ENDPOINT 1: Performance Review Narrative & Appraisal Synthesizer
// -------------------------------------------------------------
aiAndFeedbackRouter.post('/gemini/generate-review-narrative', async (req, res) => {
  try {
    const payload: AiReviewSynthesisRequest = req.body;
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

Peer Kudos & Recognitions Received:
${(payload.kudosReceived && payload.kudosReceived.length > 0)
  ? payload.kudosReceived.map((k) => `- [${k.category}] "${k.text}"`).join('\n')
  : '- Consistent peer praise for technical velocity and cross-team reliability.'}

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
// AI ENDPOINT 2: Tone, Constructiveness & Bias Harmonizer
// -------------------------------------------------------------
aiAndFeedbackRouter.post('/gemini/analyze-bias-and-tone', async (req, res) => {
  try {
    const payload: AiBiasCheckRequest = req.body;
    const ai = getGeminiClient();

    const prompt = `You are a compliance officer auditing performance review feedback. Analyze the following manager appraisal comments for unconscious bias, subjective language, vague feedback, or unconstructive tone:
Employee: ${payload.employeeName}
Assigned Score: ${payload.ratingScore}/5.00
Review Text:
"${payload.reviewText}"

Assess:
1. Overall tone (objective_balanced, constructive_neutral, subjective_vague, harsh_punitive, overly_generous)
2. Bias score (0 to 100 where 0 is pristine objective evidence, 100 is highly biased/problematic)
3. Specific phrase issues and concrete rewrites
4. A professional, compliant rewrite that preserves the underlying message using objective, measurable language.`;

    if (ai) {
      const responseSchema = {
        type: Type.OBJECT,
        properties: {
          overallTone: {
            type: Type.STRING,
            enum: [
              'objective_balanced',
              'constructive_neutral',
              'subjective_vague',
              'harsh_punitive',
              'overly_generous',
            ],
          },
          biasScore: { type: Type.NUMBER },
          detectedIssues: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                phrase: { type: Type.STRING },
                issueType: {
                  type: Type.STRING,
                  enum: [
                    'subjective_bias',
                    'vague_feedback',
                    'recency_bias',
                    'unsubstantiated_criticism',
                  ],
                },
                suggestion: { type: Type.STRING },
              },
              required: ['phrase', 'issueType', 'suggestion'],
            },
          },
          suggestedRevisedText: { type: Type.STRING },
          complianceRating: {
            type: Type.STRING,
            enum: ['COMPLIANT', 'NEEDS_REVISION', 'FLAGGED'],
          },
        },
        required: [
          'overallTone',
          'biasScore',
          'detectedIssues',
          'suggestedRevisedText',
          'complianceRating',
        ],
      };

      const result = await safeGenerateContent(ai, { contents: prompt, responseSchema });
      if (result && result.text) {
        try {
          const parsed: AiBiasCheckResult = JSON.parse(result.text);
          return res.json({ success: true, data: parsed, engine: result.modelUsed });
        } catch {
          // fallback
        }
      }
    }

    // Fallback heuristic analyzer
    const text = payload.reviewText || '';
    const hasVagueWords = /(always|never|good job|bad attitude|lazy|smart|rockstar|superstar)/i.test(text);
    const biasScore = hasVagueWords ? 42 : 12;

    const fallbackResult: AiBiasCheckResult = {
      overallTone: hasVagueWords ? 'subjective_vague' : 'objective_balanced',
      biasScore,
      detectedIssues: hasVagueWords
        ? [
            {
              phrase: 'General feedback phrasing',
              issueType: 'vague_feedback',
              suggestion: 'Anchor comments with specific quarterly metrics and delivery dates rather than generalized characterizations.',
            },
          ]
        : [],
      suggestedRevisedText: text.length > 20
        ? `${payload.employeeName} met all key deliverable deadlines with consistent attention to quality. Looking ahead, focusing on cross-team documentation and SLA compliance will further strengthen project outcomes.`
        : `${payload.employeeName} demonstrated consistent performance on core KRAs. Continued focus on proactive communication will ensure high project predictability.`,
      complianceRating: hasVagueWords ? 'NEEDS_REVISION' : 'COMPLIANT',
    };

    return res.json({ success: true, data: fallbackResult, engine: 'rule-evaluator' });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to analyze tone and bias' });
  }
});

// -------------------------------------------------------------
// AI ENDPOINT 3: Personalized Career Growth & Upskilling Planner
// -------------------------------------------------------------
aiAndFeedbackRouter.post('/gemini/generate-growth-plan', async (req, res) => {
  try {
    const payload: AiGrowthPlanRequest = req.body;
    const ai = getGeminiClient();

    const prompt = `You are a Chief Talent Officer. Generate a structured 6-month career growth roadmap and upskilling strategy for:
Employee: ${payload.employeeName}
Designation: ${payload.designation}
Department: ${payload.department}
Current Performance Rating: ${payload.currentScore}/5.00
Key Strengths: ${payload.strengths.join(', ') || 'High execution capability'}
Development Gaps: ${payload.weaknesses.join(', ') || 'Cross-team leadership & architecture'}
Target Aspirational Role: ${payload.aspirationalRole || 'Lead / Managerial Specialist'}

Provide 4 concrete chronological milestones (Months 1-2, Months 3-4, Month 5, Month 6), a matched mentor profile, and a high-visibility stretch project idea.`;

    if (ai) {
      const responseSchema = {
        type: Type.OBJECT,
        properties: {
          recommendedTrack: { type: Type.STRING },
          timeframe: { type: Type.STRING },
          milestones: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                month: { type: Type.STRING },
                focusArea: { type: Type.STRING },
                actionableTask: { type: Type.STRING },
                recommendedCertificationOrCourse: { type: Type.STRING },
              },
              required: [
                'month',
                'focusArea',
                'actionableTask',
                'recommendedCertificationOrCourse',
              ],
            },
          },
          mentorProfileMatch: { type: Type.STRING },
          stretchProjectIdea: { type: Type.STRING },
        },
        required: [
          'recommendedTrack',
          'timeframe',
          'milestones',
          'mentorProfileMatch',
          'stretchProjectIdea',
        ],
      };

      const result = await safeGenerateContent(ai, { contents: prompt, responseSchema });
      if (result && result.text) {
        try {
          const parsed: AiGrowthPlanResult = JSON.parse(result.text);
          return res.json({ success: true, data: parsed, engine: result.modelUsed });
        } catch {
          // fallback
        }
      }
    }

    const fallbackResult: AiGrowthPlanResult = {
      recommendedTrack: `${payload.designation} $\\rightarrow$ Senior Technical Leadership Track`,
      timeframe: '6 Months (Q3 - Q4)',
      milestones: [
        {
          month: 'Month 1-2',
          focusArea: 'Domain Mastery & Advanced Standards',
          actionableTask: 'Audit current service performance metrics and write a comprehensive optimization RFC.',
          recommendedCertificationOrCourse: 'Certified Cloud Solutions Architect / Enterprise Domain Professional',
        },
        {
          month: 'Month 3-4',
          focusArea: 'Cross-Functional Systems Architecture',
          actionableTask: 'Lead the architectural refactoring for high-throughput messaging pipelines.',
          recommendedCertificationOrCourse: 'Distributed Systems & Microservices Masterclass',
        },
        {
          month: 'Month 5',
          focusArea: 'Team Mentorship & Review Standards',
          actionableTask: 'Mentor two junior engineers and establish peer-review code quality benchmarks.',
          recommendedCertificationOrCourse: 'Engineering Leadership & Constructive Feedback Training',
        },
        {
          month: 'Month 6',
          focusArea: 'Strategic Business Alignment & Capstone Delivery',
          actionableTask: 'Present capstone project impact and latency savings to Department Head and Leadership.',
          recommendedCertificationOrCourse: 'Executive Technology Strategy & ROI Assessment',
        },
      ],
      mentorProfileMatch: 'Principal Architect / Director of Engineering with 8+ years experience in large-scale distributed architectures',
      stretchProjectIdea: 'Design and deploy an automated multi-region disaster recovery and continuous data sync pipeline.',
    };

    return res.json({ success: true, data: fallbackResult, engine: 'rule-planner' });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to generate growth plan' });
  }
});

// -------------------------------------------------------------
// AI ENDPOINT 4: Executive Talent Matrix & Retention Intelligence
// -------------------------------------------------------------
aiAndFeedbackRouter.post('/gemini/talent-insights-summary', async (req, res) => {
  try {
    const payload: AiTalentInsightsRequest = req.body;
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
        `${payload.talentPoolSummary.underperformersCount} employees currently flagged for active PIP / milestone coaching.`,
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
        'Monitor bi-weekly PIP check-ins to ensure structured progression and coachability.',
      ],
    };

    return res.json({ success: true, data: fallbackResult, engine: 'rule-synthesizer' });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to generate talent insights' });
  }
});

// -------------------------------------------------------------
// FEEDBACK & KUDOS CRUD ENDPOINTS
// -------------------------------------------------------------

// GET all feedback
aiAndFeedbackRouter.get('/feedback', async (req, res) => {
  try {
    const { employeeId, department, type } = req.query;
    let list = memoryDb.feedback.getAll();

    if (employeeId) {
      list = list.filter((f) => f.toEmployeeId === String(employeeId) || f.fromUserId === String(employeeId));
    }
    if (department && department !== 'ALL') {
      list = list.filter((f) => f.toDepartment === String(department));
    }
    if (type && type !== 'ALL') {
      list = list.filter((f) => f.type === String(type));
    }

    // Sort newest first
    list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST new feedback
aiAndFeedbackRouter.post('/feedback', async (req, res) => {
  try {
    const feedbackData: Partial<FeedbackEntry> = req.body;
    const newEntry: FeedbackEntry = {
      id: `fb_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      fromUserId: feedbackData.fromUserId || 'usr_current',
      fromUserName: feedbackData.fromUserName || 'Team Member',
      fromUserRole: feedbackData.fromUserRole || 'EMPLOYEE',
      fromDepartment: feedbackData.fromDepartment,
      toEmployeeId: feedbackData.toEmployeeId!,
      toEmployeeName: feedbackData.toEmployeeName!,
      toDepartment: feedbackData.toDepartment!,
      type: feedbackData.type || 'kudos',
      badgeCategory: feedbackData.badgeCategory || 'team_collaboration',
      message: feedbackData.message || '',
      linkedKraTitle: feedbackData.linkedKraTitle,
      quarter: feedbackData.quarter || 'Q2',
      cycleId: feedbackData.cycleId || 'cycle_f_sep',
      isPublic: feedbackData.isPublic !== undefined ? feedbackData.isPublic : true,
      likesCount: 0,
      likedBy: [],
      createdAt: new Date().toISOString(),
    };

    await memoryDb.feedback.insertOne(newEntry);
    res.status(201).json(newEntry);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST like/reaction on feedback
aiAndFeedbackRouter.post('/feedback/:id/react', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;
    const entry = await memoryDb.feedback.findOne({ id });
    if (!entry) {
      return res.status(404).json({ error: 'Feedback entry not found' });
    }

    const likedBy = entry.likedBy || [];
    const userIndex = likedBy.indexOf(userId || 'current_user');

    if (userIndex >= 0) {
      likedBy.splice(userIndex, 1);
    } else {
      likedBy.push(userId || 'current_user');
    }

    const updated = {
      ...entry,
      likedBy,
      likesCount: likedBy.length,
    };

    await memoryDb.feedback.updateOne({ id }, updated);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// PERFORMANCE IMPROVEMENT PLAN (PIP) ENDPOINTS
// -------------------------------------------------------------

// GET all PIPs
aiAndFeedbackRouter.get('/pips', async (req, res) => {
  try {
    const { employeeId, status } = req.query;
    let list = memoryDb.pips.getAll();

    if (employeeId) {
      list = list.filter((p) => p.employeeId === String(employeeId));
    }
    if (status && status !== 'ALL') {
      list = list.filter((p) => p.status === String(status));
    }

    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST create PIP
aiAndFeedbackRouter.post('/pips', async (req, res) => {
  try {
    const data: Partial<PipRecord> = req.body;
    const newPip: PipRecord = {
      id: `pip_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      employeeId: data.employeeId!,
      employeeName: data.employeeName!,
      employeeCode: data.employeeCode || 'EMP-GEN',
      department: data.department || 'General',
      designation: data.designation || 'Specialist',
      managerId: data.managerId || 'usr_manager',
      managerName: data.managerName || 'Reporting Manager',
      startDate: data.startDate || new Date().toISOString().split('T')[0],
      targetEndDate: data.targetEndDate || new Date(Date.now() + 60 * 86400000).toISOString().split('T')[0],
      durationDays: data.durationDays || 60,
      status: 'active',
      overallProgress: data.overallProgress || 0,
      coreGaps: data.coreGaps || [],
      milestones: data.milestones || [],
      checkins: data.checkins || [],
      finalOutcomeNotes: data.finalOutcomeNotes,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await memoryDb.pips.insertOne(newPip);
    res.status(201).json(newPip);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update PIP
aiAndFeedbackRouter.put('/pips/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const target = await memoryDb.pips.findOne({ id });
    if (!target) {
      return res.status(404).json({ error: 'PIP record not found' });
    }

    const updated = {
      ...target,
      ...req.body,
      updatedAt: new Date().toISOString(),
    };

    await memoryDb.pips.updateOne({ id }, updated);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST add Checkin to PIP
aiAndFeedbackRouter.post('/pips/:id/checkin', async (req, res) => {
  try {
    const { id } = req.params;
    const target = await memoryDb.pips.findOne({ id });
    if (!target) {
      return res.status(404).json({ error: 'PIP record not found' });
    }

    const checkin = {
      id: `chk_${Date.now()}`,
      date: req.body.date || new Date().toISOString().split('T')[0],
      weekNumber: req.body.weekNumber || (target.checkins.length + 1) * 2,
      managerNotes: req.body.managerNotes || '',
      ratingOutOf5: Number(req.body.ratingOutOf5) || 3.0,
      actionItems: req.body.actionItems || '',
      employeeComments: req.body.employeeComments || '',
    };

    const checkins = [...(target.checkins || []), checkin];
    
    // Auto-calculate progress based on completed milestones
    const metMilestones = (target.milestones || []).filter((m) => m.status === 'met').length;
    const totalMilestones = (target.milestones || []).length || 1;
    const overallProgress = Math.round((metMilestones / totalMilestones) * 100);

    const updated: PipRecord = {
      ...target,
      checkins,
      overallProgress,
      updatedAt: new Date().toISOString(),
    };

    await memoryDb.pips.updateOne({ id }, updated);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------
// 9-BOX TALENT MATRIX ENDPOINTS
// -------------------------------------------------------------

// GET all talent records
aiAndFeedbackRouter.get('/talent-records', async (_req, res) => {
  try {
    const records = memoryDb.talentRecords.getAll();
    res.json(records);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update talent record (e.g. potential, risk, actions)
aiAndFeedbackRouter.put('/talent-records/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const target = await memoryDb.talentRecords.findOne({ id });
    if (!target) {
      return res.status(404).json({ error: 'Talent record not found' });
    }

    const updated = {
      ...target,
      ...req.body,
      lastAssessedDate: new Date().toISOString().split('T')[0],
    };

    await memoryDb.talentRecords.updateOne({ id }, updated);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
