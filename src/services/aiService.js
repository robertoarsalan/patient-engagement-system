const OpenAI = require("openai");
const Anthropic = require("@anthropic-ai/sdk");
const env = require("../config/env");

const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY
});

const anthropic = new Anthropic({
  apiKey: env.ANTHROPIC_API_KEY
});

function inferStage(patient) {
  const stalled = Number(patient.stalled_task_counter || 0);

  if (stalled <= 0) return "initial";
  if (stalled === 1) return "followup_1";
  if (stalled === 2) return "followup_2";
  return "followup_3plus";
}

function inferTone(age, ageGroup) {
  const ageNum = Number(age || 0);
  const group = String(ageGroup || "").trim().toLowerCase();

  if (group.includes("young") || (ageNum > 0 && ageNum < 30)) {
    return "warmer, modern, natural, human";
  }

  if (group.includes("30") || (ageNum >= 30 && ageNum <= 45)) {
    return "clear, confident, reassuring";
  }

  if (group.includes("45") || group.includes("60") || (ageNum > 45 && ageNum <= 60)) {
    return "calm, respectful, structured";
  }

  if (ageNum > 60 || group.includes("60+")) {
    return "elegant, reassuring, respectful";
  }

  return "clear, empathetic, professional";
}

function fallbackMessage(patient) {
  const name = patient.full_name || "Ciao";
  const stalled = Number(patient.stalled_task_counter || 0);

  if (stalled <= 0) {
    return `Ciao ${name} 👋

Abbiamo ricevuto le tue foto e stiamo valutando il tuo caso con attenzione.

Ti aggiorno appena la valutazione è pronta, così posso spiegarti il piano più adatto a te.`;
  }

  if (stalled === 1) {
    return `Ciao ${name} 👋

Sto seguendo la tua richiesta. Le foto sono in valutazione e stiamo preparando un piano personalizzato per te.

Ti aggiorno appena è pronto.`;
  }

  if (stalled === 2) {
    return `Ciao ${name} 👋

Ti confermo che stiamo ancora controllando tutto con attenzione per preparare una valutazione personalizzata.

Appena è pronta ti aggiorno subito.`;
  }

  return `Ciao ${name} 👋

La tua valutazione è ancora in lavorazione e stiamo verificando tutto con attenzione per darti il piano più adatto.

Ti aggiorno appena è pronta.`;
}

function buildDraftPrompt(patient) {
  const name = patient.full_name || "";
  const age = patient.age || "";
  const ageGroup = patient.age_group || "";
  const market = patient.market || "";
  const treatmentType = patient.treatment_type || "";
  const preferredFormality = patient.preferred_formality || "";
  const stage = inferStage(patient);
  const tone = inferTone(age, ageGroup);

  return `
You are writing a WhatsApp message in Italian for a medical tourism lead.

Patient data:
- Name: ${name}
- Age: ${age}
- Age group: ${ageGroup}
- Market: ${market}
- Treatment type: ${treatmentType}
- Preferred formality: ${preferredFormality}
- Stage: ${stage}
- Tone direction: ${tone}

Business context:
- patient has already sent photos
- evaluation is ongoing
- we are carefully reviewing the case
- a personalized plan is being prepared
- message should keep patient engaged
- no fake urgency
- no hard sales push
- no medical overclaim
- no long paragraph walls
- natural, human, trust-based WhatsApp style
- short and clear

Output rules:
- Italian only
- 3 to 6 short lines
- use patient's first name if available
- do not mention AI
- do not sound robotic
- do not add price
- do not add clinic name unless naturally needed
- no markdown
- no subject line

Stage intent:
- initial: confirm photos received and evaluation started
- followup_1: reassure patient the case is being reviewed
- followup_2: keep patient warm, say personalized plan is being prepared
- followup_3plus: still polite and engaged, slightly more proactive but not pushy

Write only the final message text.
  `.trim();
}

function buildRefinePrompt(draft, patient) {
  const tone = inferTone(patient.age, patient.age_group);

  return `
Refine the following Italian WhatsApp message for a medical tourism lead.

Goals:
- make it more natural
- make it more human
- keep it brief
- keep trust high
- adapt tone to age / age_group
- no hard push
- no fake urgency
- Italian only
- WhatsApp tone

Tone direction:
${tone}

Draft:
${draft}

Return only the improved message text.
  `.trim();
}

async function generatePatientMessage(patient) {
  try {
    const draftPrompt = buildDraftPrompt(patient);

    const draftResponse = await openai.responses.create({
      model: env.OPENAI_MODEL,
      input: draftPrompt
    });

    const generatedMessage =
      (draftResponse.output_text || "").trim() || fallbackMessage(patient);

    const refinePrompt = buildRefinePrompt(generatedMessage, patient);

    const claudeResponse = await anthropic.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: refinePrompt
        }
      ]
    });

    const finalMessage =
      (claudeResponse.content || [])
        .map((item) => item.text || "")
        .join("")
        .trim() || generatedMessage;

    return {
      generatedMessage,
      finalMessage
    };
  } catch (error) {
    console.error("AI pipeline failed:", error.response?.data || error.message || error);

    const message = fallbackMessage(patient);

    return {
      generatedMessage: message,
      finalMessage: message
    };
  }
}

module.exports = {
  generatePatientMessage
};