const axios = require("axios");
const env = require("../config/env");

function getBaseUrl() {
  return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
}

function markTelegramSuccessSafe() {
  try {
    const supervisor = require("./supervisorService");
    if (typeof supervisor.markTelegramSuccess === "function") {
      supervisor.markTelegramSuccess();
    }
  } catch (error) {
    console.error("markTelegramSuccessSafe error:", error.message || error);
  }
}

async function sendTelegramMessage(text, extra = {}) {
  const payload = {
    chat_id: env.TELEGRAM_CHAT_ID,
    text,
    ...extra
  };

  const response = await axios.post(`${getBaseUrl()}/sendMessage`, payload, {
    timeout: 30000
  });

  markTelegramSuccessSafe();
  return response.data.result;
}

async function answerCallbackQuery(callbackQueryId, text = "") {
  try {
    const response = await axios.post(
      `${getBaseUrl()}/answerCallbackQuery`,
      {
        callback_query_id: callbackQueryId,
        text
      },
      {
        timeout: 30000
      }
    );

    markTelegramSuccessSafe();
    return response.data.result;
  } catch (error) {
    // Telegram often returns 400 if callback already answered or expired.
    // Do not break the whole app for that.
    const status = error?.response?.status;
    const data = error?.response?.data;

    console.error("answerCallbackQuery error:", status, data || error.message || error);

    if (status === 400) {
      return null;
    }

    throw error;
  }
}

async function getTelegramWebhookInfo() {
  const response = await axios.get(`${getBaseUrl()}/getWebhookInfo`, {
    timeout: 30000
  });

  markTelegramSuccessSafe();
  return response.data.result;
}

function buildTaskCardText(rowNumber, patient, finalMessage) {
  return `📌 Patient Task

Name: ${patient.full_name || ""}
Patient ID: ${patient.patient_id || ""}
Status: ${patient.status || ""}
Action: ${patient.next_action || ""}
Follow-up time: ${String(patient.next_followup_at || "").replace(/^'/, "")}

AI message:
${finalMessage || "-"}`;
}

function buildTaskButtons(rowNumber) {
  return {
    inline_keyboard: [
      [
        { text: "📞 Call Patient", callback_data: `call:${rowNumber}` },
        { text: "💬 Send Message", callback_data: `message:${rowNumber}` }
      ],
      [
        { text: "🔥 Hot Lead", callback_data: `hot:${rowNumber}` },
        { text: "✅ Done", callback_data: `done:${rowNumber}` }
      ],
      [
        { text: "⏳ Snooze 15m", callback_data: `snooze15:${rowNumber}` },
        { text: "✏️ Regenerate", callback_data: `regen:${rowNumber}` }
      ]
    ]
  };
}

async function sendPatientTaskCard(rowNumber, patient, finalMessage) {
  const result = await sendTelegramMessage(buildTaskCardText(rowNumber, patient, finalMessage), {
    reply_markup: buildTaskButtons(rowNumber)
  });

  return result;
}

module.exports = {
  sendTelegramMessage,
  answerCallbackQuery,
  getTelegramWebhookInfo,
  sendPatientTaskCard
};