const axios = require("axios");
const env = require("../config/env");

const TELEGRAM_API = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendTelegramMessage(text, extra = {}) {
  const payload = {
    chat_id: env.TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
    ...extra
  };

  const response = await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
  return response.data.result;
}

async function answerCallbackQuery(callbackQueryId, text = "Done") {
  try {
    await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId,
      text
    });
  } catch (error) {
    console.error("Error answering callback query:", error.response?.data || error.message || error);
  }
}

async function getTelegramWebhookInfo() {
  const response = await axios.get(`${TELEGRAM_API}/getWebhookInfo`);
  return response.data;
}

function buildPatientTaskText(patient, finalMessage) {
  return `<b>🧾 Patient Task</b>

<b>Name:</b> ${escapeHtml(patient.full_name || "-")}
<b>Patient ID:</b> ${escapeHtml(patient.patient_id || "-")}
<b>Status:</b> ${escapeHtml(patient.status || "-")}
<b>Action:</b> ${escapeHtml(patient.next_action || "-")}
<b>Follow-up time:</b> ${escapeHtml(patient.next_followup_at || "-")}

<b>AI message:</b>
${escapeHtml(finalMessage || patient.last_final_message || "-")}`;
}

function buildInlineKeyboard(rowNumber) {
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
  const text = buildPatientTaskText(patient, finalMessage);

  const message = await sendTelegramMessage(text, {
    reply_markup: buildInlineKeyboard(rowNumber)
  });

  return message;
}

module.exports = {
  sendTelegramMessage,
  answerCallbackQuery,
  getTelegramWebhookInfo,
  sendPatientTaskCard
};