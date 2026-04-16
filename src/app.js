const express = require("express");
const env = require("./config/env");
const { startPollSheetJob } = require("./jobs/pollSheetJob");
const {
  getSheetData,
  getSettings,
  findHeader,
  updateRow,
  markSent,
  formatDate
} = require("./services/sheetService");
const { generatePatientMessage } = require("./services/aiService");
const {
  sendTelegramMessage,
  sendPatientTaskCard,
  answerCallbackQuery,
  getTelegramWebhookInfo
} = require("./services/telegramService");

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Patient engagement backend is running");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "Patient engagement backend is running"
  });
});

app.get("/telegram-webhook", (req, res) => {
  res.json({
    ok: true,
    message: "Telegram webhook route exists"
  });
});

app.get("/telegram-webhook-info", async (req, res) => {
  try {
    const info = await getTelegramWebhookInfo();
    res.json(info);
  } catch (error) {
    console.error("Webhook info error:", error.response?.data || error.message || error);
    res.status(500).json({
      ok: false,
      error: error.response?.data || error.message || String(error)
    });
  }
});

app.post("/telegram-webhook", async (req, res) => {
  try {
    const body = req.body || {};

    if (!body.callback_query) {
      return res.json({ ok: true });
    }

    const callbackQuery = body.callback_query;
    const callbackData = callbackQuery.data || "";
    const callbackQueryId = callbackQuery.id;

    const [action, rowNumberRaw] = callbackData.split(":");
    const rowNumber = Number(rowNumberRaw);

    console.log("Button clicked:", callbackData);

    const { headers, patients } = await getSheetData();
    const patient = patients.find((p) => Number(p.rowNumber) === rowNumber);

    if (!patient) {
      await answerCallbackQuery(callbackQueryId, "Patient not found");
      return res.json({ ok: true });
    }

    const currentTaskActiveKey = findHeader(headers, "current_task_active");
    const nextActionKey = findHeader(headers, "next_action");
    const nextFollowupAtKey = findHeader(headers, "next_followup_at");
    const telegramLastAlertKey = findHeader(headers, "telegram_last");
    const lastGeneratedMessageKey = findHeader(headers, "last_generated_message");
    const lastFinalMessageKey = findHeader(headers, "last_final_message");
    const statusKey = findHeader(headers, "status");
    const subStatusKey = findHeader(headers, "sub_status");
    const notesKey = findHeader(headers, "notes");
    const updatedAtKey = findHeader(headers, "updated_at");

    if (action === "message") {
      try {
        console.log(`Processing Send Message for row ${rowNumber}...`);

        const settings = await getSettings();
        let finalMessage = patient[lastFinalMessageKey] || "";

        if (!finalMessage) {
          const aiResult = await generatePatientMessage(patient);

          await updateRow(patient.rowNumber, {
            [lastGeneratedMessageKey]: aiResult.generatedMessage,
            [lastFinalMessageKey]: aiResult.finalMessage,
            [updatedAtKey]: formatDate(new Date())
          });

          finalMessage = aiResult.finalMessage;
        }

        const result = await markSent(patient, headers, settings, finalMessage);

        await answerCallbackQuery(callbackQueryId, "Message marked as sent");

        const refreshedData = await getSheetData();
        const refreshedPatient = refreshedData.patients.find(
          (p) => Number(p.rowNumber) === rowNumber
        );

        await sendTelegramMessage(
          `✅ Message marked as sent for row ${rowNumber}
👤 ${patient.full_name || ""}
📌 Status: ${refreshedPatient?.[statusKey] || "contacted"}
📌 Sub-status: ${refreshedPatient?.[subStatusKey] || "waiting_reply"}
⏰ Next reminder: ${result.nextFollowupAt} (TR time)`
        );

        return res.json({ ok: true });
      } catch (error) {
        console.error("Send Message action failed:", error.response?.data || error.message || error);
        await answerCallbackQuery(callbackQueryId, "Send Message failed");
        return res.status(500).json({
          ok: false,
          action: "message",
          error: error.response?.data || error.message || String(error)
        });
      }
    }

    if (action === "regen") {
      try {
        const aiResult = await generatePatientMessage(patient);

        await updateRow(patient.rowNumber, {
          [lastGeneratedMessageKey]: aiResult.generatedMessage,
          [lastFinalMessageKey]: aiResult.finalMessage,
          [telegramLastAlertKey]: "",
          [updatedAtKey]: formatDate(new Date())
        });

        await answerCallbackQuery(callbackQueryId, "Message regenerated");

        await sendPatientTaskCard(
          patient.rowNumber,
          {
            ...patient,
            [lastFinalMessageKey]: aiResult.finalMessage
          },
          aiResult.finalMessage
        );

        return res.json({ ok: true });
      } catch (error) {
        console.error("Regenerate action failed:", error.response?.data || error.message || error);
        await answerCallbackQuery(callbackQueryId, "Regenerate failed");
        return res.status(500).json({
          ok: false,
          action: "regen",
          error: error.response?.data || error.message || String(error)
        });
      }
    }

    if (action === "done") {
      try {
        await updateRow(patient.rowNumber, {
          [currentTaskActiveKey]: "FALSE",
          [nextActionKey]: "done",
          [nextFollowupAtKey]: "",
          [telegramLastAlertKey]: "",
          [statusKey]: patient[statusKey] || "contacted",
          [subStatusKey]: "done",
          [updatedAtKey]: formatDate(new Date())
        });

        await answerCallbackQuery(callbackQueryId, "Task marked as done");

        await sendTelegramMessage(
          `✅ Done marked for row ${rowNumber}
👤 ${patient.full_name || ""}`
        );

        return res.json({ ok: true });
      } catch (error) {
        console.error("Done action failed:", error.response?.data || error.message || error);
        await answerCallbackQuery(callbackQueryId, "Done failed");
        return res.status(500).json({
          ok: false,
          action: "done",
          error: error.response?.data || error.message || String(error)
        });
      }
    }

    if (action === "snooze15") {
      try {
        const nextDate = new Date(Date.now() + 15 * 60 * 1000);
        const formatted = formatDate(nextDate);

        await updateRow(patient.rowNumber, {
          [nextFollowupAtKey]: formatted,
          [telegramLastAlertKey]: "",
          [updatedAtKey]: formatDate(new Date())
        });

        await answerCallbackQuery(callbackQueryId, "Snoozed 15 minutes");

        await sendTelegramMessage(
          `⏳ Snoozed row ${rowNumber} for 15 minutes
👤 ${patient.full_name || ""}
⏰ New reminder: ${formatted} (TR time)`
        );

        return res.json({ ok: true });
      } catch (error) {
        console.error("Snooze action failed:", error.response?.data || error.message || error);
        await answerCallbackQuery(callbackQueryId, "Snooze failed");
        return res.status(500).json({
          ok: false,
          action: "snooze15",
          error: error.response?.data || error.message || String(error)
        });
      }
    }

    if (action === "hot") {
      try {
        const existingNotes = patient[notesKey] || "";
        const newNotes = existingNotes ? `${existingNotes} | HOT LEAD` : "HOT LEAD";

        await updateRow(patient.rowNumber, {
          [notesKey]: newNotes,
          [telegramLastAlertKey]: "",
          [updatedAtKey]: formatDate(new Date())
        });

        await answerCallbackQuery(callbackQueryId, "Hot lead marked");

        await sendTelegramMessage(
          `🔥 Hot lead marked
👤 ${patient.full_name || ""}
🆔 Row ${rowNumber}`
        );

        return res.json({ ok: true });
      } catch (error) {
        console.error("Hot action failed:", error.response?.data || error.message || error);
        await answerCallbackQuery(callbackQueryId, "Hot lead failed");
        return res.status(500).json({
          ok: false,
          action: "hot",
          error: error.response?.data || error.message || String(error)
        });
      }
    }

    if (action === "call") {
      try {
        await answerCallbackQuery(callbackQueryId, "Call patient");

        await sendTelegramMessage(
          `📞 Call patient
👤 ${patient.full_name || ""}
📱 ${patient.phone || "-"}
🆔 Row ${rowNumber}`
        );

        return res.json({ ok: true });
      } catch (error) {
        console.error("Call action failed:", error.response?.data || error.message || error);
        await answerCallbackQuery(callbackQueryId, "Call failed");
        return res.status(500).json({
          ok: false,
          action: "call",
          error: error.response?.data || error.message || String(error)
        });
      }
    }

    await answerCallbackQuery(callbackQueryId, "Unknown action");
    return res.json({ ok: true });
  } catch (error) {
    console.error("Telegram webhook error:", error.response?.data || error.message || error);
    return res.status(500).json({
      ok: false,
      error: error.response?.data || error.message || String(error)
    });
  }
});

app.listen(env.PORT, () => {
  console.log(`Server running on http://localhost:${env.PORT}`);
  console.log("🚀 Polling job started...");
  startPollSheetJob();
});