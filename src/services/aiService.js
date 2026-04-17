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

function getReminderStage(patient) {
  const count = Number(patient.stalled_task_counter || 0);

  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count === 2) return 2;
  return 3;
}

function buildDraftSystemPrompt() {
  return `
You are a medical tourism WhatsApp message writer for Italian-speaking leads.

Write short, persuasive, natural-sounding patient messages in Italian.

Rules:
- Output only the message text
- Keep it concise and WhatsApp-friendly
- Professional, warm, human
- Do not sound robotic
- Do not invent medical facts
- Do not overpromise
- Use the patient's first name naturally
- Max 3 short paragraphs
- No bullet points
- No markdown
- No formal email language
- At most 2 emojis total
- Always in Italian

Stage behavior:
- Stage 0: first reply after photos received
- Stage 1: soft follow-up
- Stage 2: more proactive follow-up
- Stage 3: stronger follow-up with light urgency
`;
}

function buildDraftUserPrompt(patient) {
  const name = getPatientName(patient);
  const stage = getReminderStage(patient);

  let stageInstruction = "";

  if (stage === 0) {
    stageInstruction = `
Write the first message after receiving the patient's photos.
Goal:
- acknowledge receipt
- say the case is being evaluated carefully
- reassure the patient
- say you will update them with the best plan
- no pressure
`;
  } else if (stage === 1) {
    stageInstruction = `
Write follow-up #1.
Goal:
- soft check-in
- warm, human
- remind them their case is being followed
- encourage a reply gently
`;
  } else if (stage === 2) {
    stageInstruction = `
Write follow-up #2.
Goal:
- slightly more proactive
- create gentle momentum
- suggest you can help with the next step
- still calm and natural
`;
  } else {
    stageInstruction = `
Write follow-up #3 or later.
Goal:
- stronger re-engagement
- light urgency without pressure
- encourage a concrete reply
- make it easy for the patient to continue
`;
  }

  return `
Patient name: ${name}
Treatment type: ${patient.treatment_type || ""}
Status: ${patient.status || ""}
Sub-status: ${patient.sub_status || ""}
Market: ${patient.market || ""}
Age group: ${patient.age_group || ""}
Notes: ${patient.notes || ""}

${stageInstruction}

Write one final Italian WhatsApp message.
`;
}

function buildRefineSystemPrompt() {
  return `
You refine Italian WhatsApp lead messages for medical tourism.

Your job:
- rewrite the draft to sound more human, smoother, and less robotic
- preserve meaning and structure
- make it feel like a top closer wrote it

Style blend:
- Chris Voss style:
  - calm
  - empathetic
  - non-needy
  - controlled
  - subtle emotional intelligence
- Alex Hormozi style:
  - clear
  - high-value
  - practical
  - momentum-oriented
  - easy next step

Rules:
- Always in Italian
- Keep it short and natural
- WhatsApp tone only
- No fake hype
- No exaggerated promises
- No cheesy sales language
- No markdown
- No bullet points
- No quotation marks around the message
- Output only the final refined message
- Max 3 short paragraphs
- At most 2 emojis total
`;
}

function buildRefineUserPrompt(patient, draft) {
  const stage = getReminderStage(patient);

  let stageHint = "";
  if (stage === 0) stageHint = "This is the first message after photos were received.";
  else if (stage === 1) stageHint = "This is the first follow-up after no reply.";
  else if (stage === 2) stageHint = "This is the second follow-up.";
  else stageHint = "This is the third or later follow-up.";

  return `
Patient name: ${getPatientName(patient)}
${stageHint}

Draft message:
${draft}

Refine this so it sounds more human, more natural, and more persuasive, while staying short and professional.
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
    model: env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
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

  return cleanText(response.content?.[0]?.text || "");
}

function buildFallbackMessage(patient) {
  const name = getPatientName(patient);
  const stage = getReminderStage(patient);

  if (stage === 0) {
    return `Ciao ${name} 👋

Abbiamo ricevuto le tue foto e stiamo valutando il tuo caso con attenzione.

Ti aggiorno appena la valutazione è pronta, così posso spiegarti il piano più adatto a te.`;
  }

  if (stage === 1) {
    return `Ciao ${name} 👋

Volevo ricontattarti perché stiamo seguendo il tuo caso con attenzione.

Se vuoi, ti aggiorno io direttamente sul prossimo passo.`;
  }

  if (stage === 2) {
    return `Ciao ${name} 👋

Se vuoi, possiamo già organizzare il prossimo passo in modo semplice e chiaro.

Ti aiuto io direttamente qui, senza complicazioni.`;
  }

  return `Ciao ${name} 👋

Se vuoi procedere, questo è un buon momento per organizzare tutto con calma e in modo chiaro.

Scrivimi pure e ti aiuto io passo dopo passo.`;
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
    finalMessage: finalMessage
  };
}

module.exports = {
  generatePatientMessage
};