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
const {
  notifyError,
  startSupervisor,
  installGlobalErrorHandlers
} = require("./services/supervisorService");

const app = express();
app.use(express.json());

function getTurkeyNowDate() {
  const now = new Date();
  const tr = new Intl.DateTimeFormat("en-GB", {
    timeZone: env.TIMEZONE || "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(now);

  const map = {};
  for (const part of tr) {
    if (part.type !== "literal") map[part.type] = part.value;
  }

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second)
  };
}

function buildTurkeyDate(year, month, day, hour, minute, second = 0) {
  // Europe/Istanbul = UTC+3
  return new Date(Date.UTC(year, month - 1, day, hour - 3, minute, second));
}

function parseCallReminderInput(text) {
  const raw = String(text || "").trim();

  // YYYY-MM-DD HH:mm
  let full = raw.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (full) {
    const year = Number(full[1]);
    const month = Number(full[2]);
    const day = Number(full[3]);
    const hour = Number(full[4]);
    const minute = Number(full[5]);
    return buildTurkeyDate(year, month, day, hour, minute, 0);
  }

  // HH:mm
  const short = raw.match(/^(\d{2}):(\d{2})$/);
  if (short) {
    const trNow = getTurkeyNowDate();
    const hour = Number(short[1]);
    const minute = Number(short[2]);

    let reminderDate = buildTurkeyDate(
      trNow.year,
      trNow.month,
      trNow.day,
      hour,
      minute,
      0
    );

    const nowUtc = new Date();
    if (reminderDate.getTime() <= nowUtc.getTime()) {
      reminderDate = new Date(
        Date.UTC(
          trNow.year,
          trNow.month - 1,
          trNow.day + 1,
          hour - 3,
          minute,
          0
        )
      );
    }

    return reminderDate;
  }

  return null;
}

function getLast4(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.slice(-4) || "----";
}

function toBoolSafe(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function isStaleTaskButton(callbackQuery, patient, telegramLastAlertValue) {
  const clickedMessageId = String(callbackQuery?.message?.message_id || "");
  const activeMessageId = String(telegramLastAlertValue || "");

  if (!activeMessageId) {
    return true;
  }

  return clickedMessageId !== activeMessageId;
}

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
    await notifyError("app.telegram-webhook-info", error);
    res.status(500).json({
      ok: false,
      error: error.response?.data || error.message || String(error)
    });
  }
});

app.post("/telegram-webhook", async (req, res) => {
  try {
    const body = req.body || {};

    // =========================
    // CALLBACK BUTTON HANDLER
    // =========================
    if (body.callback_query) {
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
      const telegramLastAlertKey = findHeader(headers, "telegram_last_alert_id");
      const lastGeneratedMessageKey = findHeader(headers, "last_generated_message");
      const lastFinalMessageKey = findHeader(headers, "last_final_message");
      const statusKey = findHeader(headers, "status");
      const subStatusKey = findHeader(headers, "sub_status");
      const notesKey = findHeader(headers, "notes");
      const updatedAtKey = findHeader(headers, "updated_at");

      const callPendingInputKey = findHeader(headers, "call_pending_input");
      const callReminderAtKey = findHeader(headers, "call_reminder_at");
      const callReminderActiveKey = findHeader(headers, "call_reminder_active");

      const actionsNeedingFreshTaskCard = new Set([
        "message",
        "call",
        "regen",
        "done",
        "snooze15",
        "hot"
      ]);

      if (actionsNeedingFreshTaskCard.has(action)) {
        const stale = isStaleTaskButton(
          callbackQuery,
          patient,
          patient[telegramLastAlertKey]
        );

        if (stale) {
          await answerCallbackQuery(
            callbackQueryId,
            "This is an old task card. Use the latest notification."
          );
          return res.json({ ok: true });
        }
      }

      // -------- SEND MESSAGE --------
      if (action === "message") {
        try {
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
          await notifyError("app.action.message", error);
          await answerCallbackQuery(callbackQueryId, "Send Message failed");
          return res.status(500).json({
            ok: false,
            action: "message",
            error: error.response?.data || error.message || String(error)
          });
        }
      }

      // -------- CALL PATIENT --------
      if (action === "call") {
        try {
          // clear any old pending call input first
          for (const p of patients) {
            if (toBoolSafe(p[callPendingInputKey])) {
              await updateRow(p.rowNumber, {
                [callPendingInputKey]: "FALSE",
                [updatedAtKey]: formatDate(new Date())
              });
            }
          }

          // set current row as waiting for call time input
          await updateRow(patient.rowNumber, {
            [callPendingInputKey]: "TRUE",
            [callReminderActiveKey]: "FALSE",
            [callReminderAtKey]: "",
            [updatedAtKey]: formatDate(new Date())
          });

          await answerCallbackQuery(callbackQueryId, "Send call time");

          await sendTelegramMessage(
            `📞 Set call time

👤 ${patient.full_name || ""}
📱 ${getLast4(patient.phone)}

Send:
HH:mm
or
YYYY-MM-DD HH:mm`
          );

          return res.json({ ok: true });
        } catch (error) {
          console.error("Call action failed:", error.response?.data || error.message || error);
          await notifyError("app.action.call", error);
          await answerCallbackQuery(callbackQueryId, "Call reminder failed");
          return res.status(500).json({
            ok: false,
            action: "call",
            error: error.response?.data || error.message || String(error)
          });
        }
      }

      // -------- REGENERATE --------
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
          await notifyError("app.action.regen", error);
          await answerCallbackQuery(callbackQueryId, "Regenerate failed");
          return res.status(500).json({
            ok: false,
            action: "regen",
            error: error.response?.data || error.message || String(error)
          });
        }
      }

      // -------- DONE --------
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
          await notifyError("app.action.done", error);
          await answerCallbackQuery(callbackQueryId, "Done failed");
          return res.status(500).json({
            ok: false,
            action: "done",
            error: error.response?.data || error.message || String(error)
          });
        }
      }

      // -------- SNOOZE --------
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
          await notifyError("app.action.snooze15", error);
          await answerCallbackQuery(callbackQueryId, "Snooze failed");
          return res.status(500).json({
            ok: false,
            action: "snooze15",
            error: error.response?.data || error.message || String(error)
          });
        }
      }

      // -------- HOT --------
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
          await notifyError("app.action.hot", error);
          await answerCallbackQuery(callbackQueryId, "Hot lead failed");
          return res.status(500).json({
            ok: false,
            action: "hot",
            error: error.response?.data || error.message || String(error)
          });
        }
      }

      await answerCallbackQuery(callbackQueryId, "Unknown action");
      return res.json({ ok: true });
    }

    // =========================
    // TEXT INPUT HANDLER
    // =========================
    if (body.message && body.message.text) {
      const messageText = String(body.message.text || "").trim();

      const { headers, patients } = await getSheetData();
      const callPendingInputKey = findHeader(headers, "call_pending_input");
      const callReminderAtKey = findHeader(headers, "call_reminder_at");
      const callReminderActiveKey = findHeader(headers, "call_reminder_active");
      const updatedAtKey = findHeader(headers, "updated_at");

      const pendingPatient = patients.find((p) => toBoolSafe(p[callPendingInputKey]));

      if (pendingPatient) {
        const parsed = parseCallReminderInput(messageText);

        if (!parsed) {
          await sendTelegramMessage("❌ Invalid time. Use HH:mm or YYYY-MM-DD HH:mm");
          return res.json({ ok: true });
        }

        const formatted = formatDate(parsed);

        await updateRow(pendingPatient.rowNumber, {
          [callPendingInputKey]: "FALSE",
          [callReminderAtKey]: formatted,
          [callReminderActiveKey]: "TRUE",
          [updatedAtKey]: formatDate(new Date())
        });

        await sendTelegramMessage(
          `✅ Call reminder saved

👤 ${pendingPatient.full_name || ""}
📱 ${getLast4(pendingPatient.phone)}
⏰ ${formatted} (TR time)`
        );

        return res.json({ ok: true });
      }
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error("Telegram webhook error:", error.response?.data || error.message || error);
    await notifyError("app.telegram-webhook", error);
    return res.status(500).json({
      ok: false,
      error: error.response?.data || error.message || String(error)
    });
  }
});

installGlobalErrorHandlers();

app.listen(env.PORT, () => {
  console.log(`Server running on http://localhost:${env.PORT}`);
  console.log("🚀 Polling job started...");
  startSupervisor();
  startPollSheetJob();
});