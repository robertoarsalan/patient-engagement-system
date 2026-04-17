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

function buildSystemPrompt() {
  return `
You are a highly effective medical tourism follow-up assistant for Italian-speaking leads.

Your job:
- Write short WhatsApp-style follow-up messages in Italian
- Keep them human, warm, professional, and persuasive
- Never sound robotic
- Never write long paragraphs
- Never use heavy formatting
- Keep messages concise and natural
- Use the patient's first name naturally
- Focus on re-engagement and next step
- Do not invent medical facts
- Do not mention internal systems, AI, automation, CRM, reminders, or scheduling logic
- Do not use more than 2 emojis total
- Output only the final message text

Tone rules:
- Stage 0 = initial response after photos received
- Stage 1 = soft follow-up after no reply
- Stage 2 = more direct follow-up with gentle momentum
- Stage 3 = stronger follow-up with light urgency and clear action

Language:
- Always in Italian
`;
}

function buildUserPrompt(patient) {
  const name = getPatientName(patient);
  const stage = getReminderStage(patient);
  const treatmentType = patient.treatment_type || "";
  const status = patient.status || "";
  const subStatus = patient.sub_status || "";
  const market = patient.market || "";
  const ageGroup = patient.age_group || "";
  const notes = patient.notes || "";

  let stageInstruction = "";

  if (stage === 0) {
    stageInstruction = `
Write the FIRST message after receiving the patient's photos.
Goal:
- acknowledge receipt
- say the case is being evaluated carefully
- say you will update them with the best plan
- keep it reassuring and professional
- no pressure
`;
  } else if (stage === 1) {
    stageInstruction = `
Write FOLLOW-UP #1.
Goal:
- soft check-in
- remind them their case is being followed
- encourage a reply
- keep it warm and very light
- no hard urgency
`;
  } else if (stage === 2) {
    stageInstruction = `
Write FOLLOW-UP #2.
Goal:
- create gentle momentum
- suggest that if they want, you can help them move to the next step
- make it slightly more proactive than follow-up #1
- still polite and natural
`;
  } else {
    stageInstruction = `
Write FOLLOW-UP #3 or later.
Goal:
- create stronger re-engagement
- mention availability / planning / next step
- use light urgency, not pressure
- encourage a concrete reply today
`;
  }

  return `
Patient name: ${name}
Treatment type: ${treatmentType}
Status: ${status}
Sub-status: ${subStatus}
Market: ${market}
Age group: ${ageGroup}
Notes: ${notes}

${stageInstruction}

Requirements:
- maximum 3 short paragraphs
- WhatsApp style
- natural Italian
- mention the patient's name
- avoid repetition
- no bullet points
- no markdown
- no signature
- no placeholders
`;
}

async function generateWithOpenAI(patient) {
  if (!openai) {
    throw new Error("OPENAI_API_KEY missing");
  }

  const response = await openai.chat.completions.create({
    model: env.OPENAI_MODEL || "gpt-5.4-mini",
    temperature: 0.8,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserPrompt(patient) }
    ]
  });

  const text = response.choices?.[0]?.message?.content || "";
  return cleanText(text);
}

async function generateWithAnthropic(patient) {
  if (!anthropic) {
    throw new Error("ANTHROPIC_API_KEY missing");
  }

  const response = await anthropic.messages.create({
    model: env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
    max_tokens: 300,
    temperature: 0.8,
    system: buildSystemPrompt(),
    messages: [
      {
        role: "user",
        content: buildUserPrompt(patient)
      }
    ]
  });

  const text = response.content?.[0]?.text || "";
  return cleanText(text);
}

async function generatePatientMessage(patient) {
  let generatedMessage = "";

  try {
    if (anthropic) {
      generatedMessage = await generateWithAnthropic(patient);
    } else if (openai) {
      generatedMessage = await generateWithOpenAI(patient);
    } else {
      throw new Error("No AI provider configured");
    }
  } catch (primaryError) {
    console.error("Primary AI provider failed:", primaryError.message || primaryError);

    if (!generatedMessage) {
      try {
        if (openai) {
          generatedMessage = await generateWithOpenAI(patient);
        } else if (anthropic) {
          generatedMessage = await generateWithAnthropic(patient);
        }
      } catch (fallbackError) {
        console.error("Fallback AI provider failed:", fallbackError.message || fallbackError);
      }
    }
  }

  if (!generatedMessage) {
    const name = getPatientName(patient);
    const stage = getReminderStage(patient);

    if (stage === 0) {
      generatedMessage = `Ciao ${name} 👋

Abbiamo ricevuto le tue foto e stiamo valutando il tuo caso con attenzione.

Ti aggiorno appena la valutazione è pronta, così posso spiegarti il piano più adatto a te.`;
    } else if (stage === 1) {
      generatedMessage = `Ciao ${name} 👋

Volevo solo ricontattarti perché stiamo seguendo il tuo caso con attenzione.

Se vuoi, ti aggiorno io sul prossimo passo.`;
    } else if (stage === 2) {
      generatedMessage = `Ciao ${name} 👋

Ti scrivo perché possiamo aiutarti a organizzare il prossimo passo in modo semplice e chiaro.

Se vuoi, ti spiego tutto io direttamente qui.`;
    } else {
      generatedMessage = `Ciao ${name} 👋

Se vuoi procedere, questo è un buon momento per organizzare tutto con calma e senza complicazioni.

Scrivimi pure e ti aiuto io passo dopo passo.`;
    }
  }

  return {
    generatedMessage,
    finalMessage: generatedMessage
  };
}

module.exports = {
  generatePatientMessage
};