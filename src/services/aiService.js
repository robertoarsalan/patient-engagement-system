const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk");
const env = require("../config/env");

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

function getAgeGroup(patient) {
  const raw = String(patient.age_group || "").trim().toLowerCase();
  if (raw) return raw;

  const age = getPatientAge(patient);

  if (age > 0 && age <= 24) return "young";
  if (age >= 25 && age <= 39) return "adult";
  if (age >= 40 && age <= 55) return "mature";
  if (age >= 56) return "senior";

  return "adult";
}

function getFollowUpStage(patient) {
  const counter = Number(patient.stalled_task_counter || 0);

  if (counter <= 0) return 0;
  if (counter === 1) return 1;
  if (counter === 2) return 2;
  return 3;
}

function getToneInstructionByAge(patient) {
  const group = getAgeGroup(patient);

  if (group === "young") {
    return `
Use a warm, light, modern tone.
Still professional, but slightly more relaxed and approachable.
Avoid sounding too formal or stiff.
`;
  }

  if (group === "adult") {
    return `
Use a balanced professional tone:
warm, confident, human, clear.
This should feel natural and trustworthy.
`;
  }

  if (group === "mature") {
    return `
Use a calm, respectful, reassuring tone.
Slightly more polished and confidence-building.
Focus on clarity, comfort, and professionalism.
`;
  }

  if (group === "senior") {
    return `
Use a very respectful, calm, reassuring tone.
Avoid slang or casual wording.
Make the message feel safe, clear, and supportive.
`;
  }

  return `
Use a balanced professional tone:
warm, confident, human, clear.
`;
}

function buildDraftSystemPrompt() {
  return `
You write short Italian WhatsApp follow-up messages for medical tourism patients.

Workflow context:
- The patient already sent photos
- The clinic is still evaluating the case
- The goal is to keep the patient engaged while they wait for the offer
- Messages must feel human, reassuring, and intentional
- Every stage must feel different from the others
- Output only the message text

Rules:
- Always in Italian
- WhatsApp style only
- Short and natural
- Maximum 3 short paragraphs
- No markdown
- No bullet points
- No signatures
- No fake promises
- No robotic language
- No internal process talk like CRM, automation, reminder, pipeline
- At most 2 emojis total
- Use the patient's name naturally
- Do not write like a receptionist bot
- Do not sound needy or salesy
`;
}

function buildStageInstruction(stage) {
  if (stage === 0) {
    return `
This is the FIRST message after the patient sent photos.

Goal:
- acknowledge the case is under evaluation
- reassure the patient
- let them know you wanted to give a quick update
- do not pressure
- do not ask for a videocall yet
- this should sound personal and human

Intent example:
"Hello name, I just wanted to let you know your case is still in the evaluation phase. I wanted to give you a quick update."
But write a better, more natural version in Italian.
`;
  }

  if (stage === 1) {
    return `
This is the SECOND message.

Timing context:
- It comes later while the patient is still waiting
- The evaluation is almost done

Goal:
- say the evaluation is almost finished
- give a quick update
- include ONE small calibrated question in Chris Voss style
- the question must be light, natural, and low-pressure
- do not ask for a videocall yet
- create gentle engagement and get a reply

Examples of calibrated question style:
- "Così posso regolarmi meglio, preferisci che ti aggiorni appena è tutto pronto?"
- "Per capire come aiutarti meglio, preferisci ricevere tutto appena la valutazione è chiusa?"
- "Così mi organizzo al meglio, ti è più comodo che ti aggiorni appena è tutto pronto?"

Important:
- only one short question
- no pressure
- must feel human
`;
  }

  return `
This is the THIRD message.

Timing context:
- The plan is ready

Goal:
- say the plan is ready
- ask when the patient is available for a videocall
- sound confident, human, calm
- use a stronger next step
- this is the clearest action-oriented message
- do not sound aggressive

Intent example:
"Hello, the plan is ready. May I know when you are available to have a videocall?"
But write a more natural, persuasive Italian version.
`;
}

function buildDraftUserPrompt(patient) {
  const name = getPatientName(patient);
  const age = getPatientAge(patient);
  const ageGroup = getAgeGroup(patient);
  const stage = getFollowUpStage(patient);

  return `
Patient name: ${name}
Age: ${age || "unknown"}
Age group: ${ageGroup}
Language: ${patient.language || "ITA"}
Market: ${patient.market || "Italy"}
Treatment type: ${patient.treatment_type || ""}
Status: ${patient.status || ""}
Sub-status: ${patient.sub_status || ""}
Notes: ${patient.notes || ""}

${getToneInstructionByAge(patient)}

${buildStageInstruction(stage)}

Additional writing goals:
- blend Chris Voss style: calm, empathetic, controlled, non-pushy
- blend Alex Hormozi style: clarity, momentum, value, forward motion
- sound like a real human consultant
- each message must clearly differ from the other stages
- keep it concise and elegant

Write one final Italian WhatsApp message only.
`;
}

function buildRefineSystemPrompt() {
  return `
You refine Italian WhatsApp messages for high-conversion patient follow-up.

Your task:
- refine a draft written by GPT
- make it sound more human, smoother, warmer, and more natural
- keep the original stage goal intact
- keep it concise

Style blend required:
- Chris Voss:
  - empathy
  - calm control
  - emotional intelligence
  - soft calibrated phrasing
- Alex Hormozi:
  - clarity
  - value communication
  - momentum
  - strong but simple next step

Rules:
- Always in Italian
- Output only the final refined message
- Keep it short
- Maximum 3 short paragraphs
- No markdown
- No bullet points
- No formal email tone
- No cheesy sales talk
- No robotic wording
- At most 2 emojis total
- It must feel like a real human consultant wrote it
- Different stages must feel genuinely different
`;
}

function buildRefineUserPrompt(patient, draft) {
  const stage = getFollowUpStage(patient);
  const name = getPatientName(patient);
  const ageGroup = getAgeGroup(patient);

  let stageContext = "";
  if (stage === 0) {
    stageContext = "Stage 1: patient sent photos, case still under evaluation, reassurance/update only.";
  } else if (stage === 1) {
    stageContext = "Stage 2: evaluation almost done, quick update, must include one light calibrated question.";
  } else {
    stageContext = "Stage 3: plan is ready, ask for videocall availability.";
  }

  return `
Patient name: ${name}
Age group: ${ageGroup}
${stageContext}

Draft:
${draft}

Refine this draft so it sounds:
- more human
- less robotic
- more natural on WhatsApp
- psychologically smart
- appropriate for the age group

Do not overcomplicate it.
Do not make it longer than needed.
Return only the final refined Italian message.
`;
}

async function generateDraftWithOpenAI(patient) {
  if (!openai) {
    throw new Error("OPENAI_API_KEY missing");
  }

  const response = await openai.chat.completions.create({
    model: env.OPENAI_MODEL || "gpt-5.4-mini",
    temperature: 0.8,
    messages: [
      { role: "system", content: buildDraftSystemPrompt() },
      { role: "user", content: buildDraftUserPrompt(patient) }
    ]
  });

  return cleanText(response.choices?.[0]?.message?.content || "");
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

  const text = response.content?.[0]?.text || "";
  return cleanText(text);
}

function buildFallbackMessage(patient) {
  const name = getPatientName(patient);
  const stage = getFollowUpStage(patient);

  if (stage === 0) {
    return `Ciao ${name} 👋

Volevo solo aggiornarti che il tuo caso è ancora in fase di valutazione.

Ci tenevo a darti un rapido aggiornamento mentre stiamo completando tutto con attenzione.`;
  }

  if (stage === 1) {
    return `Ciao ${name} 👋

Ti aggiorno rapidamente: la valutazione è quasi pronta.

Così posso regolarmi meglio, preferisci che ti aggiorni appena è tutto definito?`;
  }

  return `Ciao ${name} 👋

Il piano è pronto.

Posso chiederti quando sei disponibile per una videocall così te lo spiego bene?`;
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