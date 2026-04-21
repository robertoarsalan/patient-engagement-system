const axios = require("axios");
const env = require("../config/env");
const { markTelegramSuccess } = require("./supervisorService");

function getBaseUrl() {
  return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
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

  markTelegramSuccess();
  return response.data.result;
}

async function answerCallbackQuery(callbackQueryId, text = "") {
  const response = await axios.post(
    `${getBaseUrl()}/answerCallbackQuery`,
    {
      callback_query_id: callbackQueryId,
      text
    },
    { timeout: 30000 }
  );

  markTelegramSuccess();
  return response.data.result;
}

async function getTelegramWebhookInfo() {
  const response = await axios.get(`${getBaseUrl()}/getWebhookInfo`, {
    timeout: 30000
  });
  markTelegramSuccess();
  return response.data.result;
}

function buildTaskCardText(rowNumber, patient, finalMessage) {
  return `📌 Patient task

👤 ${patient.full_name || ""}
📱 ${patient.phone || "-"}
🆔 Row ${rowNumber}

💬 Suggested message:
${finalMessage || "-"}`;
}

function buildTaskButtons(rowNumber) {
  return {
    inline_keyboard: [
      [
        { text: "✅ Send Message", callback_data: `message:${rowNumber}` },
        { text: "📞 Call Patient", callback_data: `call:${rowNumber}` }
      ],
      [
        { text: "♻️ Regenerate", callback_data: `regen:${rowNumber}` },
        { text: "🔥 Hot Lead", callback_data: `hot:${rowNumber}` }
      ],
      [
        { text: "⏳ Snooze 15m", callback_data: `snooze15:${rowNumber}` },
        { text: "✅ Done", callback_data: `done:${rowNumber}` }
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