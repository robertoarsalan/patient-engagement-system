const {
  getSheetData,
  getSettings,
  updateRow,
  isDue,
  hasValue,
  findHeader,
  formatDate
} = require("../services/sheetService");

const { sendTelegramMessage } = require("../services/telegramService");

function getLast4(phone) {
  const clean = String(phone || "").replace(/\D/g, "");
  return clean.slice(-4) || "----";
}

async function handleCallReminders(headers, patients) {
  const callTimeKey = findHeader(headers, "call_reminder_at");
  const callActiveKey = findHeader(headers, "call_reminder_active");

  for (const p of patients) {
    try {
      if (!toBool(p[callActiveKey])) continue;
      if (!hasValue(p[callTimeKey])) continue;

      if (!isDue(p[callTimeKey])) continue;

      const name = p.full_name || "Patient";
      const last4 = getLast4(p.phone);

      const message = `
📞 Call reminder
👤 ${name}
📱 ${last4}
⏰ ${p[callTimeKey]} (TR time)
`;

      await sendTelegramMessage(message);

      // deactivate after sending
      await updateRow(p.rowNumber, {
        [callActiveKey]: "FALSE"
      });

    } catch (err) {
      console.error("Call reminder error:", err.message);
    }
  }
}

function toBool(value) {
  const v = String(value || "").toLowerCase();
  return v === "true" || v === "1";
}

async function runPollingCycle() {
  try {
    const { headers, patients } = await getSheetData();
    const settings = await getSettings();

    // 🔹 CALL REMINDER CHECK
    await handleCallReminders(headers, patients);

    // 🔹 NORMAL FOLLOW-UP SYSTEM CONTINUES HERE
    for (const p of patients) {
      try {
        const followKey = findHeader(headers, "next_followup_at");
        const activeKey = findHeader(headers, "current_task_active");

        if (!toBool(p[activeKey])) continue;
        if (!hasValue(p[followKey])) continue;

        if (!isDue(p[followKey])) continue;

        // ⚠️ IMPORTANT: prevent double-fire
        const lastAlertKey = findHeader(headers, "telegram_last_alert_id");

        if (hasValue(p[lastAlertKey])) continue;

        const message = `
📌 Patient Follow-up
👤 ${p.full_name}
⏰ ${p[followKey]} (TR time)
`;

        const msgId = await sendTelegramMessage(message);

        await updateRow(p.rowNumber, {
          [lastAlertKey]: String(msgId)
        });

      } catch (err) {
        console.error("Follow-up error:", err.message);
      }
    }

  } catch (err) {
    console.error("Polling cycle error:", err.message);
  }
}

function startPolling() {
  console.log("🚀 Polling started...");
  setInterval(runPollingCycle, 5000); // every 5 seconds
}

module.exports = {
  startPolling
};