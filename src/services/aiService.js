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
    value.includes("18") ||
    value.includes("19") ||
    value.includes("20") ||
    value.includes("21") ||
    value.includes("22") ||
    value.includes("23") ||
    value.includes("24") ||
    value.includes("25") ||
    value.includes("26") ||
    value.includes("27") ||
    value.includes("28") ||
    value.includes("29") ||
    value.includes("30") ||
    value.includes("young")
  ) {
    return "young_adult";
  }

  if (
    value.includes("31") ||
    value.includes("32") ||
    value.includes("33") ||
    value.includes("34") ||
    value.includes("35") ||
    value.includes("36") ||
    value.includes("37") ||
    value.includes("38") ||
    value.includes("39") ||
    value.includes("40") ||
    value.includes("41") ||
    value.includes("42") ||
    value.includes("43") ||
    value.includes("44") ||
    value.includes("45") ||
    value.includes("adult")
  ) {
    return "adult";
  }

  if (
    value.includes("46") ||
    value.includes("47") ||
    value.includes("48") ||
    value.includes("49") ||
    value.includes("50") ||
    value.includes("51") ||
    value.includes("52") ||
    value.includes("53") ||
    value.includes("54") ||
    value.includes("55") ||
    value.includes("56") ||
    value.includes("57") ||
    value.includes("58") ||
    value.includes("59") ||
    value.includes("60") ||
    value.includes("mature")
  ) {
    return "mature";
  }

  if (
    value.includes("61") ||
    value.includes("62") ||
    value.includes("63") ||
    value.includes("64") ||
    value.includes("65") ||
    value.includes("66") ||
    value.includes("67") ||
    value.includes("68") ||
    value.includes("69") ||
    value.includes("70") ||
    value.includes("senior")
  ) {
    return "senior";
  }

  return value;
}

function getAgeGroup(patient) {
  const rawGroup = normalizeAgeGroup(patient.age_group);
  if (rawGroup) return rawGroup;

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

function getToneInstructionByAge(patient) {
  const group = getAgeGroup(patient);

  if (group === "young_adult") {
    return `
Age tone profile: YOUNG ADULT (18-30)

Message style:
- warm, modern, human
- more natural and slightly lighter
- direct and easy to read
- less formal
- still professional

Do:
- sound like a real consultant on WhatsApp
- keep energy slightly fresher
- make the message feel quick and natural

Do not:
- sound stiff
- sound corporate
- use overly formal constructions
- sound like an old-fashioned clinic script
`;
  }

  if (group === "adult") {
    return `
Age tone profile: ADULT (31-45)

Message style:
- balanced
- confident
- clear
- natural
- professional without being cold

Do:
- sound competent and efficient
- keep a strong but relaxed tone
- create trust and forward movement

Do not:
- sound too playful
- sound too rigid
- sound too salesy
`;
  }

  if (group === "mature") {
    return `
Age tone profile: MATURE (46-60)

Message style:
- reassuring
- polished
- respectful
- confidence-building
- slightly more composed

Do:
- sound calm and reliable
- communicate care and clarity
- make the patient feel guided well

Do not:
- sound too casual
- sound rushed
- sound like trendy marketing language
`;
  }

  if (group === "senior") {
    return `
Age tone profile: SENIOR (61+)

Message style:
- calm
- respectful
- very clear
- supportive
- trust-first
- slightly more formal

Do:
- sound stable, kind, and reassuring
- make the message very easy to understand
- create comfort and confidence

Do not:
- use slang
- use trendy/modern phrasing
- sound overly casual
- sound robotic or too long
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

Intent base:
"hello name, I just wanted to let you know your case is still in the evaluation phase, I wanted to give you an update"

Write a better and more natural Italian version.
`;
  }

  if (stage === 1) {
    return `
This is the SECOND message.

Goal:
- say the evaluation is almost done
- give a quick update
- include ONE small calibrated question in Chris Voss style
- the question must be short, natural, and low-pressure
- do not ask for a videocall yet
- create gentle engagement and get a reply

Intent base:
"hello again, the evaluation is almost done, I just wanted to give you a quick update"

Important:
- only one short question
- question must feel human
- question should help keep the patient engaged
`;
  }

  return `
This is the THIRD message.

Goal:
- say the plan is ready
- ask when the patient is available for a videocall
- sound confident, calm, human
- stronger next step
- do not sound aggressive

Intent base:
"hello, the plan is ready, may I know when you are available to have a videocall?"

Write a more natural and persuasive Italian version.
`;
}

function buildPsychologyLayerInstructions(stage) {
  if (stage === 0) {
    return `
Psychology layer:
- Chris Voss: empathy, emotional control, calm reassurance
- Alex Hormozi: clarity and momentum, but very soft at this stage
- focus on reducing uncertainty
- no pressure
`;
  }

  if (stage === 1) {
    return `
Psychology layer:
- Chris Voss: use one calibrated low-pressure question
- Alex Hormozi: create forward motion and light engagement
- make the patient feel included, not chased
`;
  }

  return `
Psychology layer:
- Chris Voss: calm confidence and emotional safety
- Alex Hormozi: clear next action, simple commitment, momentum
- invite the videocall in a natural way
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

${buildPsychologyLayerInstructions(stage)}

Additional writing goals:
- blend Chris Voss style: calm, empathetic, controlled, non-pushy
- blend Alex Hormozi style: clarity, value, momentum, concise forward movement
- sound like a real human consultant
- each message must clearly differ from the other stages
- age must clearly influence the tone
- younger patients should sound lighter and more natural
- older patients should sound more respectful and reassuring
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
- keep the tone adapted to age / age group
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
- The age group must materially affect the tone
`;
}

function buildRefineUserPrompt(patient, draft) {
  const stage = getFollowUpStage(patient);
  const name = getPatientName(patient);
  const age = getPatientAge(patient);
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
Age: ${age || "unknown"}
Age group: ${ageGroup}
${stageContext}

Refinement goals by age:
${getToneInstructionByAge(patient)}

Draft:
${draft}

Refine this draft so it sounds:
- more human
- less robotic
- more natural on WhatsApp
- psychologically smart
- clearly appropriate for the age group

Important:
- if age group is young_adult, the text should feel lighter and less formal
- if age group is adult, it should feel balanced and confident
- if age group is mature, it should feel more polished and reassuring
- if age group is senior, it should feel more respectful, calm, and trust-building

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
  const stage = getFollowUpStage(patient);
  const ageGroup = getAgeGroup(patient);

  if (stage === 0) {
    if (ageGroup === "young_adult") {
      return `Ciao ${name} 👋

Volevo solo aggiornarti che il tuo caso è ancora in fase di valutazione.

Ci tenevo a darti un rapido aggiornamento mentre stiamo completando tutto con attenzione.`;
    }

    if (ageGroup === "senior") {
      return `Buongiorno ${name},

volevo aggiornarla che il suo caso è ancora in fase di valutazione.

Ci tenevo a darle un breve aggiornamento mentre completiamo tutto con attenzione.`;
    }

    return `Ciao ${name} 👋

Volevo solo aggiornarti che il tuo caso è ancora in fase di valutazione.

Ci tenevo a darti un rapido aggiornamento mentre stiamo completando tutto con attenzione.`;
  }

  if (stage === 1) {
    if (ageGroup === "young_adult") {
      return `Ciao ${name} 👋

Ti aggiorno velocemente: la valutazione è quasi pronta.

Così mi regolo meglio, preferisci che ti scriva appena è tutto definito?`;
    }

    if (ageGroup === "senior") {
      return `Buongiorno ${name},

volevo informarla che la valutazione è quasi pronta.

Così posso organizzarmi al meglio, preferisce che le scriva non appena sarà tutto definito?`;
    }

    return `Ciao ${name} 👋

Ti aggiorno rapidamente: la valutazione è quasi pronta.

Così posso regolarmi meglio, preferisci che ti aggiorni appena è tutto definito?`;
  }

  if (ageGroup === "young_adult") {
    return `Ciao ${name} 👋

Il piano è pronto.

Quando ti è più comodo fare una videocall così te lo spiego bene?`;
  }

  if (ageGroup === "senior") {
    return `Buongiorno ${name},

il piano è pronto.

Posso chiederle quando le sarebbe più comodo fare una videocall così posso spiegarle tutto con chiarezza?`;
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