/**
 * Healthcare Module — Clinical Decision Support (CDS)
 *
 * Tools: 6
 * Rule-based deterministic CDS: 9 ICD-10 condition rules, 15 drug interaction pairs,
 * medication conflict checking, lab interpretation, risk scoring, and guideline lookup.
 */

import type { HandlerContext } from "../handlers/context.js";
import { z } from "zod";
import { withAudit } from "../handlers/shared/audit.js";

// ──────────────────────────────────────────────────────────────
// Schemas
// ──────────────────────────────────────────────────────────────

const ClinicalAssessArgs = z.object({
  patientId: z.string(),
  conditions: z.array(z.string()).optional().default([]),
  medications: z.array(
    z.object({
      name: z.string(),
      dose: z.string(),
      frequency: z.string(),
    })
  ).optional().default([]),
  labs: z.array(
    z.object({
      code: z.string(),
      value: z.number(),
      unit: z.string(),
    })
  ).optional().default([]),
});

const CarePlanCreateArgs = z.object({
  patientId: z.string(),
  goals: z.array(z.string()),
  interventions: z.array(
    z.object({
      type: z.enum(["medication", "procedure", "lifestyle", "monitoring"]),
      description: z.string(),
      durationDays: z.number().optional(),
    })
  ),
});

const MedicationCheckArgs = z.object({
  current: z.array(
    z.object({
      name: z.string(),
      dose: z.string(),
      frequency: z.string(),
    })
  ),
  proposed: z.array(
    z.object({
      name: z.string(),
      dose: z.string(),
      frequency: z.string(),
    })
  ),
});

const LabInterpArgs = z.object({
  tests: z.array(
    z.object({
      code: z.string(),
      value: z.number(),
      unit: z.string(),
      referenceRange: z.object({
        low: z.number(),
        high: z.number(),
      }).optional(),
    })
  ),
});

const RiskCalculateArgs = z.object({
  age: z.number(),
  conditions: z.array(z.string()),
  labs: z.array(
    z.object({
      code: z.string(),
      value: z.number(),
    })
  ).optional().default([]),
});

const GuidelineLookupArgs = z.object({
  condition: z.string(),
  patientAge: z.number().optional(),
});

// ──────────────────────────────────────────────────────────────
// Handlers
// ──────────────────────────────────────────────────────────────

// ARCH-02: Expanded clinical rules — condition assessments, medication safety, risk factors
const CONDITION_RULES: Array<{
  condition: string;
  labCheck?: string;
  risk: string;
  recommendation: string;
}> = [
  { condition: "E11.9", labCheck: "A1C",  risk: "Uncontrolled diabetes (missing HbA1c)", recommendation: "Order HbA1c test within 3 months" },
  { condition: "E11.9", labCheck: "UACR", risk: "Diabetic nephropathy screening overdue", recommendation: "Urine albumin-creatinine ratio annually" },
  { condition: "I10",   labCheck: "CREA", risk: "Hypertension with CKD risk unmonitored", recommendation: "Check creatinine and eGFR annually" },
  { condition: "I10",   labCheck: "POTASS", risk: "Potassium monitoring needed with ACE/ARB", recommendation: "Check potassium within 1 week of ACE/ARB start" },
  { condition: "N18.3", labCheck: "CREA", risk: "CKD stage 3 — renal function monitoring", recommendation: "Check creatinine and eGFR every 3-6 months" },
  { condition: "J45.909", labCheck: "SPIROMETRY", risk: "Asthma — pulmonary function unassessed", recommendation: "Annual spirometry for asthma control" },
  { condition: "F32.9", labCheck: "TSH",  risk: "Depression — hypothyroidism exclusion", recommendation: "Check TSH to exclude thyroid cause" },
  { condition: "E78.5", labCheck: "LDL",  risk: "Hyperlipidemia monitoring", recommendation: "Fasting lipid panel every 6-12 months on statin" },
  { condition: "Z87.891", labCheck: "INR", risk: "Smoker — anticoagulation monitoring", recommendation: "INR monitoring if on warfarin + smoking cessation counseling" },
];

const DRUG_INTERACTIONS: Array<{ drugA: string; drugB: string; severity: "moderate" | "major"; interaction: string; recommendation: string }> = [
  { drugA: "warfarin",      drugB: "ibuprofen",        severity: "major",    interaction: "Warfarin + NSAID: high bleeding risk",               recommendation: "Avoid NSAIDs; use acetaminophen" },
  { drugA: "warfarin",      drugB: "aspirin",           severity: "major",    interaction: "Warfarin + aspirin: additive bleeding risk",          recommendation: "Avoid unless cardiovascular indication confirmed" },
  { drugA: "lisinopril",    drugB: "spironolactone",    severity: "major",    interaction: "ACE inhibitor + potassium-sparing diuretic: hyperkalemia", recommendation: "Monitor potassium weekly for 4 weeks" },
  { drugA: "metformin",     drugB: "contrast",          severity: "major",    interaction: "Metformin + iodinated contrast: lactic acidosis risk", recommendation: "Hold metformin 48h before and after contrast" },
  { drugA: "digoxin",       drugB: "amiodarone",        severity: "major",    interaction: "Digoxin + amiodarone: digoxin toxicity",              recommendation: "Reduce digoxin dose by 50%, monitor levels" },
  { drugA: "simvastatin",   drugB: "amiodarone",        severity: "major",    interaction: "Simvastatin + amiodarone: myopathy/rhabdomyolysis",    recommendation: "Max simvastatin 20mg with amiodarone" },
  { drugA: "ssri",          drugB: "tramadol",          severity: "major",    interaction: "SSRI + tramadol: serotonin syndrome risk",            recommendation: "Avoid combination; use non-serotonergic analgesic" },
  { drugA: "methotrexate",  drugB: "nsaid",             severity: "major",    interaction: "Methotrexate + NSAID: methotrexate toxicity",         recommendation: "Avoid combination; monitor renal function" },
  { drugA: "clopidogrel",   drugB: "omeprazole",        severity: "moderate", interaction: "Clopidogrel + omeprazole: reduced antiplatelet effect", recommendation: "Use pantoprazole instead of omeprazole" },
  { drugA: "ciprofloxacin", drugB: "antacid",           severity: "moderate", interaction: "Fluoroquinolone + antacid: reduced absorption",       recommendation: "Separate administration by 2+ hours" },
  { drugA: "atorvastatin",  drugB: "clarithromycin",    severity: "major",    interaction: "Statin + CYP3A4 inhibitor: myopathy risk",            recommendation: "Temporarily hold statin during antibiotic course" },
  { drugA: "lithium",       drugB: "ibuprofen",         severity: "major",    interaction: "Lithium + NSAID: lithium toxicity",                   recommendation: "Monitor lithium levels; avoid NSAIDs" },
  { drugA: "tacrolimus",    drugB: "fluconazole",       severity: "major",    interaction: "Tacrolimus + azole antifungal: nephrotoxicity",       recommendation: "Reduce tacrolimus dose; monitor levels daily" },
  { drugA: "sildenafil",    drugB: "nitrate",           severity: "major",    interaction: "PDE5 inhibitor + nitrate: severe hypotension",        recommendation: "Contraindicated; do not co-administer" },
  { drugA: "warfarin",      drugB: "fluconazole",       severity: "major",    interaction: "Warfarin + azole: markedly elevated INR",             recommendation: "Reduce warfarin 25-50%; monitor INR closely" },
];

export async function clinicalAssess(
  ctx: HandlerContext,
  args: z.infer<typeof ClinicalAssessArgs>
) {
  return withAudit(ctx, "clinical_assess" as const, `patient:${args.patientId}`, async () => {
    const risks: string[] = [];
    const recommendations: string[] = [];
    const labCodes = new Set(args.labs.map(l => l.code.toUpperCase()));

    // Condition-based assessments
    for (const rule of CONDITION_RULES) {
      if (args.conditions.includes(rule.condition)) {
        if (!rule.labCheck || !labCodes.has(rule.labCheck)) {
          risks.push(rule.risk);
          recommendations.push(rule.recommendation);
        }
      }
    }

    // Medication interaction checks
    const medNames = args.medications.map(m => m.name.toLowerCase());
    for (const ix of DRUG_INTERACTIONS) {
      const hasA = medNames.some(n => n.includes(ix.drugA));
      const hasB = medNames.some(n => n.includes(ix.drugB));
      if (hasA && hasB) {
        risks.push(`[${ix.severity.toUpperCase()}] ${ix.interaction}`);
        recommendations.push(ix.recommendation);
      }
    }

    // Age-based assessments
    const ageMatch = args.labs.find(l => l.code === "AGE");
    if (ageMatch && ageMatch.value >= 65) {
      if (args.conditions.length >= 3) risks.push("Polypharmacy risk — multiple comorbidities in elderly");
    }

    return {
      risks,
      recommendations,
      conditionsAssessed: args.conditions.length,
      medicationsChecked: args.medications.length,
      timestamp: new Date().toISOString(),
    };
  });
}

export async function carePlanCreate(
  ctx: HandlerContext,
  args: z.infer<typeof CarePlanCreateArgs>
) {
  return withAudit(ctx, "care_plan_create" as const, `patient:${args.patientId}`, async () => {
    const planId = `cp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timeline = args.interventions.map((inv, idx) => ({
      order: idx + 1,
      ...inv,
      estimatedDurationDays: inv.durationDays ?? 7,
    }));
    return {
      planId,
      patientId: args.patientId,
      goals: args.goals,
      timeline,
      createdAt: new Date().toISOString(),
    };
  });
}

export async function medicationCheck(
  ctx: HandlerContext,
  args: z.infer<typeof MedicationCheckArgs>
) {
  return withAudit(ctx, "medication_check" as const, "medications", async () => {
    const conflicts: string[] = [];
    const interactions: string[] = [];

    const currentNames = new Set(args.current.map(m => m.name.toLowerCase()));

    for (const p of args.proposed) {
      if (currentNames.has(p.name.toLowerCase())) {
        conflicts.push(`Duplicate medication: ${p.name} already in current list`);
      }
    }

    // Check proposed against current using full DRUG_INTERACTIONS table
    const proposedNames = args.proposed.map(m => m.name.toLowerCase());
    for (const ix of DRUG_INTERACTIONS) {
      const proposedHasA = proposedNames.some(n => n.includes(ix.drugA));
      const proposedHasB = proposedNames.some(n => n.includes(ix.drugB));
      const currentHasA  = args.current.some(m => m.name.toLowerCase().includes(ix.drugA));
      const currentHasB  = args.current.some(m => m.name.toLowerCase().includes(ix.drugB));
      // Flag if one drug is proposed and the other is current (or both proposed)
      const crossInteraction =
        (proposedHasA && (currentHasB || proposedHasB)) ||
        (proposedHasB && (currentHasA || proposedHasA));
      if (crossInteraction) {
        // Format: "DrugA + DrugB: risk description" for readability
        const label = `${ix.drugA.charAt(0).toUpperCase() + ix.drugA.slice(1)} + ${ix.drugB}: ${ix.interaction.split(': ').slice(1).join(': ') || ix.interaction}`;
        if (!interactions.includes(label)) {
          interactions.push(label);
        }
      }
    }
    return { conflicts, interactions, recommendations: interactions.map(i => {
      const ix = DRUG_INTERACTIONS.find(x =>
        i.toLowerCase().includes(x.drugA) && i.toLowerCase().includes(x.drugB)
      );
      return ix?.recommendation ?? "";
    }).filter(Boolean) };
  });
}

export async function labInterp(
  ctx: HandlerContext,
  args: z.infer<typeof LabInterpArgs>
) {
  return withAudit(ctx, "lab_interp" as const, "labs", async () => {
    const interpretations = args.tests.map(test => {
      if (test.referenceRange) {
        const { low, high } = test.referenceRange;
        if (test.value < low) {
          return {
            code: test.code,
            status: "LOW",
            message: `Value ${test.value} ${test.unit} is below normal range (${low}-${high})`,
          };
        } else if (test.value > high) {
          return {
            code: test.code,
            status: "HIGH",
            message: `Value ${test.value} ${test.unit} is above normal range (${low}-${high})`,
          };
        } else {
          return {
            code: test.code,
            status: "NORMAL",
            message: `Within normal range (${low}-${high})`,
          };
        }
      }
      return { code: test.code, status: "UNKNOWN", message: "No reference range provided" };
    });
    return { interpretations };
  });
}

export async function riskCalculate(
  ctx: HandlerContext,
  args: z.infer<typeof RiskCalculateArgs>
) {
  return withAudit(ctx, "risk_calculate" as const, `age:${args.age}`, async () => {
    const score = args.conditions.length + (args.age > 65 ? 1 : 0);
    let category: "low" | "medium" | "high";
    if (score <= 2) category = "low";
    else if (score <= 5) category = "medium";
    else category = "high";
    return { score, category, explanation: `Points: ${args.conditions.length} conditions + age ${args.age > 65 ? 1 : 0}` };
  });
}

export async function guidelineLookup(
  ctx: HandlerContext,
  args: z.infer<typeof GuidelineLookupArgs>
) {
  return withAudit(ctx, "guideline_lookup" as const, args.condition, async () => {
    const guidelines: Record<string, string[]> = {
      "E11.9":   ["Annual dilated eye exam", "HbA1c every 3 months until controlled, then every 6 months", "ACE inhibitor or ARB for nephropathy prevention", "Urine albumin-creatinine ratio annually", "Annual foot exam"],
      "I10":     ["Lifestyle modification: DASH diet, weight reduction, exercise", "Thiazide diuretic as first-line if no comorbidity", "Annual lipid panel", "Creatinine and eGFR annually", "Home blood pressure monitoring"],
      "J45.909": ["Inhaled corticosteroid if persistent symptoms", "Allergy testing and allergen avoidance", "Annual spirometry for asthma control assessment", "Written asthma action plan", "Review inhaler technique at every visit"],
      "N18.3":   ["Creatinine and eGFR every 3–6 months", "Blood pressure target < 130/80 mmHg", "Dietary protein restriction (0.8 g/kg/day)", "Avoid nephrotoxic agents (NSAIDs, contrast)", "Nephrology referral"],
      "F32.9":   ["Screen for hypothyroidism (TSH)", "Psychotherapy + pharmacotherapy combination", "PHQ-9 monitoring every 4–6 weeks", "Safety assessment for suicidality", "Sleep hygiene counseling"],
      "E78.5":   ["Fasting lipid panel every 6–12 months on statin", "LDL target < 100 mg/dL (< 70 if high CV risk)", "Lifestyle: Mediterranean diet, aerobic exercise", "Liver function tests on initiation and if symptomatic", "Annual cardiovascular risk assessment"],
      "Z87.891": ["Smoking cessation counseling at every visit", "Nicotine replacement therapy or varenicline", "INR monitoring if on warfarin", "Lung cancer screening CT if criteria met", "Annual spirometry"],
      "E11.65":  ["HbA1c every 3 months", "Ketone monitoring during illness", "Carbohydrate counting education", "CGM consideration for glycemic variability", "Annual diabetes educator referral"],
      "K21.0":   ["Lifestyle modification: elevate head of bed, avoid late meals", "PPI therapy for erosive disease", "H. pylori testing if indicated", "Avoid NSAIDs and aspirin if possible", "Upper endoscopy if alarm symptoms present"],
    };
    const ageNote = args.patientAge && args.patientAge >= 65
      ? ` (age ${args.patientAge}: consider polypharmacy review and geriatric assessment)`
      : "";
    const baseRecommendations = guidelines[args.condition] || ["No specific guideline found for this condition"];
    const recommendations = ageNote
      ? [...baseRecommendations, `Geriatric note: polypharmacy review and fall risk assessment recommended`]
      : baseRecommendations;
    return {
      condition: args.condition,
      recommendations,
      patientAge: args.patientAge,
      source: "Local clinical knowledge base",
    };
  });
}

// Export schemas for registry
export const clinicalSchemas = {
  clinicalAssess: ClinicalAssessArgs,
  carePlanCreate: CarePlanCreateArgs,
  medicationCheck: MedicationCheckArgs,
  labInterp: LabInterpArgs,
  riskCalculate: RiskCalculateArgs,
  guidelineLookup: GuidelineLookupArgs,
};