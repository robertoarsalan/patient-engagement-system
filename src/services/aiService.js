const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk");
const env = require("../config/env");
const { markAiSuccess } = require("./supervisorService");

const openai = env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: env.OPENAI_API_KEY })
  : null;

const anthropic = env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  : null;

function cleanText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .trim();
}

function getPatientName(patient) {
  return patient.full_name || patient.name || "Paziente";
}

function getPatientAge(patient) {
  const age = Number(patient.age || 0);
  return Number.isFinite(age) ? age : 0;
}

function normalizeAgeGroup(raw) {
  const value = String(raw || "").trim().toLowerCase();

  if (!value) return "";

  if (
    value.includes("young") ||
    value.includes("giovane") ||
    value.includes("18-30") ||
    value.includes("18_30") ||
    value.includes("18 to 30")
  ) {
    return "young_adult";
  }

  if (
    value.includes("adult") ||
    value.includes("31-45") ||
    value.includes("31_45") ||
    value.includes("31 to 45")
  ) {
    return "adult";
  }

  if (
    value.includes("mature") ||
    value.includes("maturo") ||
    value.includes("46-60") ||
    value.includes("46_60") ||
    value.includes("46 to 60")
  ) {
    return "mature";
  }

  if (
    value.includes("senior") ||
    value.includes("61+") ||
    value.includes("61_plus") ||
    value.includes("61 plus") ||
    value.includes("over 60")
  ) {
    return "senior";
  }

  return "";
}

function getAgeGroup(patient) {
  const fromSheet = normalizeAgeGroup(patient.age_group);
  if (fromSheet) return fromSheet;

  const age = getPatientAge(patient);

  if (age >= 18 && age <= 30) return "young_adult";
  if (age >= 31 && age <= 45) return "adult";
  if (age >= 46 && age <= 60) return "mature";
  if (age >= 61) return "senior";

  return "adult";
}

function getFollowUpStage(patient) {
  const counter = Number(patient.stalled_task_counter || 0);

  if (counter <= 0) return 0;
  if (counter === 1) return 1;
  if (counter === 2) return 2;
  return 3;
}

function getToneProfile(patient) {
  const ageGroup = getAgeGroup(patient);

  if (ageGroup === "young_adult") {
    return {
      code: "young_adult",
      label: "Young adult 18-30",
      greetingStyle: "ciao",
      formality: "low",
      energy: "fresh",
      pacing: "quick",
      emotionalTone: "light, warm, natural",
      forbidden: [
        "Buongiorno",
        "volevo informarla",
        "le scriverò",
        "la sua valutazione",
        "gentilmente",
        "qualora"
      ],
      required: [
        "short WhatsApp rhythm",
        "simple wording",
        "modern natural Italian",
        "not stiff"
      ]
    };
  }

  if (ageGroup === "adult") {
    return {
      code: "adult",
      label: "Adult 31-45",
      greetingStyle: "ciao",
      formality: "medium",
      energy: "balanced",
      pacing: "clear",
      emotionalTone: "confident, calm, human",
      forbidden: [
        "overly formal clinic language",
        "too playful slang"
      ],
      required: [
        "clear",
        "trustworthy",
        "professional but human"
      ]
    };
  }

  if (ageGroup === "mature") {
    return {
      code: "mature",
      label: "Mature 46-60",
      greetingStyle: "buongiorno_or_ciao_respectful",
      formality: "medium-high",
      energy: "calm",
      pacing: "composed",
      emotionalTone: "reassuring, polished, respectful",
      forbidden: [
        "slang",
        "too casual modern expressions",
        "overly trendy language"
      ],
      required: [
        "respectful",
        "calm",
        "confidence-building"
      ]
    };
  }

  return {
    code: "senior",
    label: "Senior 61+",
    greetingStyle: "buongiorno",
    formality: "high",
    energy: "calm",
    pacing: "very clear",
    emotionalTone: "respectful, supportive, trust-first",
    forbidden: [
      "ciao unless clearly natural",
      "slang",
      "casual shortcuts",
      "trendy phrasing",
      "youthful modern tone"
    ],
    required: [
      "respectful Italian",
      "clear",
      "stable",
      "gentle",
      "trust-building"
    ]
  };
}

function buildStageGoal(stage) {
  if (stage === 0) {
    return {
      name: "first_update",
      objective: "Case still under evaluation. Give a quick update only.",
      mustInclude: "Acknowledge evaluation is still ongoing and reassure the patient.",
      questionRule: "No question required.",
      callRule: "Do not ask for videocall."
    };
  }

  if (stage === 1) {
    return {
      name: "second_update",
      objective: "Evaluation is almost done. Keep the patient engaged.",
      mustInclude: "Say the evaluation is almost finished and include one short low-pressure calibrated question.",
      questionRule: "Exactly one short question.",
      callRule: "Do not ask for videocall."
    };
  }

  return {
    name: "final_ready",
    objective: "Plan is ready. Move patient to videocall.",
    mustInclude: "Say the plan is ready and ask for videocall availability.",
    questionRule: "Question allowed if needed.",
    callRule: "Must ask for videocall availability."
  };
}

function buildPromptStyleRules(patient) {
  const tone = getToneProfile(patient);

  return `
AGE-DRIVEN STYLE PROFILE (MANDATORY):
- profile: ${tone.label}
- greeting style: ${tone.greetingStyle}
- formality: ${tone.formality}
- energy: ${tone.energy}
- pacing: ${tone.pacing}
- emotional tone: ${tone.emotionalTone}

MANDATORY REQUIRED STYLE:
${tone.required.map((x) => `- ${x}`).join("\n")}

FORBIDDEN STYLE:
${tone.forbidden.map((x) => `- ${x}`).join("\n")}

IMPORTANT:
The final text MUST sound materially different depending on age group.
This is not optional.
If profile is young_adult, the text must sound younger, lighter, less formal.
If profile is mature or senior, the text must sound more respectful, calmer, and more polished.
`;
}

function buildDraftSystemPrompt() {
  return `
You write Italian WhatsApp follow-up messages for medical tourism patients.

Rules:
- Always in Italian
- WhatsApp style only
- Output only message text
- Maximum 3 short paragraphs
- No markdown
- No bullet points
- No signatures
- No robotic wording
- No generic clinic script
- No fake promises
- At most 2 emojis total
- Must sound like a real human consultant

CRITICAL RULE:
Age tone adaptation is mandatory.
The tone must materially change depending on the age profile.
`;
}

function buildDraftUserPrompt(patient) {
  const name = getPatientName(patient);
  const age = getPatientAge(patient);
  const ageGroup = getAgeGroup(patient);
  const stage = getFollowUpStage(patient);
  const goal = buildStageGoal(stage);

  return `
PATIENT DATA:
- name: ${name}
- age: ${age || "unknown"}
- age_group_from_sheet: ${patient.age_group || ""}
- normalized_age_group: ${ageGroup}
- market: ${patient.market || "Italy"}
- language: ${patient.language || "ITA"}
- treatment_type: ${patient.treatment_type || ""}
- notes: ${patient.notes || ""}

${buildPromptStyleRules(patient)}

STAGE:
- stage_name: ${goal.name}
- objective: ${goal.objective}
- must_include: ${goal.mustInclude}
- question_rule: ${goal.questionRule}
- call_rule: ${goal.callRule}

PSYCHOLOGY LAYER:
- Chris Voss: empathy, calm control, low-pressure wording
- Alex Hormozi: clarity, momentum, simple forward movement
- never sound manipulative
- never sound robotic

REFERENCE INTENT:
Stage 1 idea:
"hello name, I just wanted to let you know your case is still in the evaluation phase, I wanted to give you an update"

Stage 2 idea:
"hello again, the evaluation is almost done, I just wanted to give you a quick update"

Stage 3 idea:
"hello, the plan is ready, may I know when you are available to have a videocall?"

Write ONE final Italian WhatsApp message only.
`;
}

function buildRefineSystemPrompt() {
  return `
You refine Italian WhatsApp messages for patient follow-up.

Rules:
- Output only the final message
- Keep it concise
- Keep it natural
- Keep age-based tone clearly visible
- Maximum 3 short paragraphs
- No markdown
- No bullets
- No robotic tone
- No generic wording

CRITICAL:
You must preserve and strengthen the age-based tone profile.
The final text must clearly sound different for a 28-year-old vs a 65-year-old.
`;
}

function buildRefineUserPrompt(patient, draft) {
  const tone = getToneProfile(patient);
  const stage = getFollowUpStage(patient);
  const goal = buildStageGoal(stage);

  return `
PATIENT:
- name: ${getPatientName(patient)}
- age: ${getPatientAge(patient) || "unknown"}
- normalized_age_group: ${getAgeGroup(patient)}

MANDATORY STYLE PROFILE:
- ${tone.label}
- greeting style: ${tone.greetingStyle}
- formality: ${tone.formality}
- emotional tone: ${tone.emotionalTone}

FORBIDDEN:
${tone.forbidden.map((x) => `- ${x}`).join("\n")}

REQUIRED:
${tone.required.map((x) => `- ${x}`).join("\n")}

STAGE:
- ${goal.name}
- ${goal.objective}
- ${goal.mustInclude}

Draft to refine:
${draft}

Refine it so:
- it sounds more human
- it clearly matches the age profile
- it stays concise
- it keeps the stage goal exactly right

Return only the final Italian message.
`;
}

async function generateDraftWithOpenAI(patient) {
  if (!openai) {
    throw new Error("OPENAI_API_KEY missing");
  }

  const response = await openai.chat.completions.create({
    model: env.OPENAI_MODEL || "gpt-5.4-mini",
    temperature: 0.85,
    messages: [
      { role: "system", content: buildDraftSystemPrompt() },
      { role: "user", content: buildDraftUserPrompt(patient) }
    ]
  });

  const text = cleanText(response.choices?.[0]?.message?.content || "");
  markAiSuccess();
  return text;
}

async function refineWithClaude(patient, draft) {
  if (!anthropic) {
    throw new Error("ANTHROPIC_API_KEY missing");
  }

  const response = await anthropic.messages.create({
    model: env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
    max_tokens: 300,
    temperature: 0.8,
    system: buildRefineSystemPrompt(),
    messages: [
      {
        role: "user",
        content: buildRefineUserPrompt(patient, draft)
      }
    ]
  });

  const text = cleanText(response.content?.[0]?.text || "");
  markAiSuccess();
  return text;
}

function buildFallbackMessage(patient) {
  const name = getPatientName(patient);
  const ageGroup = getAgeGroup(patient);
  const stage = getFollowUpStage(patient);

  if (stage === 0) {
    if (ageGroup === "young_adult") {
      return `Ciao ${name} 👋

Ti aggiorno al volo: il tuo caso è ancora in fase di valutazione.

Ci tenevo comunque a darti un aggiornamento mentre completiamo tutto con attenzione.`;
    }

    if (ageGroup === "adult") {
      return `Ciao ${name} 👋

Volevo aggiornarti che il tuo caso è ancora in fase di valutazione.

Ci tenevo a darti un rapido aggiornamento mentre stiamo completando tutto con attenzione.`;
    }

    if (ageGroup === "mature") {
      return `Buongiorno ${name},

volevo aggiornarla che il suo caso è ancora in fase di valutazione.

Ci tenevo a darle un breve aggiornamento mentre completiamo tutto con attenzione.`;
    }

    return `Buongiorno ${name},

volevo informarla che il suo caso è ancora in fase di valutazione.

Ci tenevo a darle un breve aggiornamento mentre completiamo tutto con la massima attenzione.`;
  }

  if (stage === 1) {
    if (ageGroup === "young_adult") {
      return `Ciao ${name} 👋

Ti aggiorno velocemente: la valutazione è quasi pronta.

Così mi regolo meglio, preferisci che ti scriva appena è tutto definito?`;
    }

    if (ageGroup === "adult") {
      return `Ciao ${name} 👋

Ti aggiorno rapidamente: la valutazione è quasi pronta.

Così posso regolarmi meglio, preferisci che ti aggiorni appena è tutto definito?`;
    }

    if (ageGroup === "mature") {
      return `Buongiorno ${name},

volevo aggiornarla che la valutazione è quasi completata.

Così posso organizzarmi al meglio, preferisce che le scriva appena sarà tutto pronto?`;
    }

    return `Buongiorno ${name},

volevo informarla che la valutazione è quasi completata.

Così posso organizzarmi al meglio, preferisce che le scriva non appena sarà tutto pronto?`;
  }

  if (ageGroup === "young_adult") {
    return `Ciao ${name} 👋

Il piano è pronto.

Quando ti è più comodo fare una videocall così te lo spiego bene?`;
  }

  if (ageGroup === "adult") {
    return `Ciao ${name} 👋

Il piano è pronto.

Posso chiederti quando sei disponibile per una videocall così te lo spiego bene?`;
  }

  if (ageGroup === "mature") {
    return `Buongiorno ${name},

il piano è pronto.

Posso chiederle quando le sarebbe più comodo fare una videocall così posso spiegarle tutto con chiarezza?`;
  }

  return `Buongiorno ${name},

il piano è pronto.

Posso chiederle quando sarebbe disponibile per una videocall così da spiegarle tutto con calma e chiarezza?`;
}

async function generatePatientMessage(patient) {
  let draftMessage = "";
  let finalMessage = "";

  try {
    draftMessage = await generateDraftWithOpenAI(patient);
  } catch (error) {
    console.error("OpenAI draft generation failed:", error.message || error);
  }

  if (!draftMessage) {
    draftMessage = buildFallbackMessage(patient);
  }

  try {
    finalMessage = await refineWithClaude(patient, draftMessage);
  } catch (error) {
    console.error("Claude refinement failed:", error.message || error);
  }

  if (!finalMessage) {
    finalMessage = draftMessage;
  }

  return {
    generatedMessage: draftMessage,
    finalMessage
  };
}

module.exports = {
  generatePatientMessage
};