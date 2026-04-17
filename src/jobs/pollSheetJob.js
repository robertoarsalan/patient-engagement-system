const { checkNewPatients } = require("../services/triggerService");
const {
  getSheetData,
  isDue,
  hasValue,
  toBool,
  findHeader,
  updateRow,
  formatDate,
  resetPatientsSheetIfThresholdReached
} = require("../services/sheetService");
const { generatePatientMessage } = require("../services/aiService");
const { sendPatientTaskCard, sendTelegramMessage } = require("../services/telegramService");

let isRunning = false;

function getLast4(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.slice(-4) || "----";
}

async function checkCallReminders() {
  const { headers, patients } = await getSheetData();

  const callReminderAtKey = findHeader(headers, "call_reminder_at");
  const callReminderActiveKey = findHeader(headers, "call_reminder_active");
  const callPendingInputKey = findHeader(headers, "call_pending_input");
  const updatedAtKey = findHeader(headers, "updated_at");

  if (!callReminderAtKey || !callReminderActiveKey) {
    return;
  }

  for (const patient of patients) {
    const active = toBool(patient[callReminderActiveKey]);
    const reminderAt = patient[callReminderAtKey];

    if (!active) continue;
    if (!hasValue(reminderAt)) continue;
    if (!isDue(reminderAt)) continue;

    try {
      await sendTelegramMessage(
        `📞 Call reminder

👤 Patient: ${patient.full_name || ""}
📱 Last 4 digits: ${getLast4(patient.phone)}
⏰ Reminder time: ${reminderAt} (TR time)`
      );

      await updateRow(patient.rowNumber, {
        [callReminderActiveKey]: "FALSE",
        [callPendingInputKey]: "FALSE",
        [updatedAtKey]: formatDate(new Date())
      });

      console.log(`Call reminder sent for row ${patient.rowNumber}`);
    } catch (error) {
      console.error(
        `Call reminder failed for row ${patient.rowNumber}:`,
        error.response?.data || error.message || error
      );
    }
  }
}

async function checkDueTasks() {
  const { headers, patients } = await getSheetData();

  const activeKey = findHeader(headers, "current_task_active");
  const followupKey = findHeader(headers, "next_followup_at");
  const alertKey = findHeader(headers, "telegram_last");
  const generatedKey = findHeader(headers, "last_generated_message");
  const finalKey = findHeader(headers, "last_final_message");
  const updatedAtKey = findHeader(headers, "updated_at");
  const actionKey = findHeader(headers, "next_action");
  const statusKey = findHeader(headers, "status");
  const subStatusKey = findHeader(headers, "sub_status");
  const taskTypeKey = findHeader(headers, "current_task_type");

  console.log("Checking sheet for due tasks...");

  let dueCount = 0;

  for (const patient of patients) {
    const currentTaskActive = toBool(patient[activeKey]);
    const nextFollowupAt = patient[followupKey];
    const telegramLastAlertId = patient[alertKey];
    const nextAction = String(patient[actionKey] || "").trim();
    const status = String(patient[statusKey] || "").trim();
    const subStatus = String(patient[subStatusKey] || "").trim();
    const taskType = String(patient[taskTypeKey] || "").trim();

    const due = isDue(nextFollowupAt);

    console.log("Due check:", {
      rowNumber: patient.rowNumber,
      patient_id: patient.patient_id || "",
      full_name: patient.full_name || "",
      currentTaskActive,
      nextFollowupAt,
      telegramLastAlertId,
      nextAction,
      status,
      subStatus,
      taskType,
      due
    });

    if (!currentTaskActive) continue;
    if (!hasValue(nextFollowupAt)) continue;
    if (!due) continue;
    if (hasValue(telegramLastAlertId)) continue;
    if (nextAction !== "wait_patient_reply") continue;

    dueCount++;

    console.log(`Due follow-up found for row ${patient.rowNumber} (${patient.patient_id || ""})`);

    try {
      const aiResult = await generatePatientMessage({
        ...patient,
        [taskTypeKey]: "follow_up"
      });

      await updateRow(patient.rowNumber, {
        [generatedKey]: aiResult.generatedMessage,
        [finalKey]: aiResult.finalMessage,
        [updatedAtKey]: formatDate(new Date())
      });

      const telegramMessage = await sendPatientTaskCard(
        patient.rowNumber,
        {
          ...patient,
          [generatedKey]: aiResult.generatedMessage,
          [finalKey]: aiResult.finalMessage,
          [taskTypeKey]: "follow_up"
        },
        aiResult.finalMessage
      );

      await updateRow(patient.rowNumber, {
        [alertKey]: String(telegramMessage.message_id || ""),
        [updatedAtKey]: formatDate(new Date())
      });

      console.log(`Follow-up Telegram task sent for row ${patient.rowNumber}`);
    } catch (error) {
      console.error(
        `Failed due follow-up for row ${patient.rowNumber}:`,
        error.response?.data || error.message || error
      );
    }
  }

  if (dueCount === 0) {
    console.log("No due tasks right now.");
  }
}

async function runPollingCycle() {
  if (isRunning) return;
  isRunning = true;

  try {
    const resetResult = await resetPatientsSheetIfThresholdReached();

    if (resetResult.triggered) {
      try {
        await sendTelegramMessage(
          `⚠️ Patients sheet reached ${resetResult.filledCount} names.

🧹 Resetting patient rows now.
✅ Headers, formulas, settings, and logs are preserved.`
        );
      } catch (error) {
        console.error(
          "Failed to send pre-reset notification:",
          error.response?.data || error.message || error
        );
      }

      console.log(`Patients sheet auto-reset completed at threshold ${resetResult.filledCount}.`);
      return;
    }

    await checkNewPatients();
    await checkCallReminders();
    await checkDueTasks();
  } catch (error) {
    console.error("Polling cycle error:", error.message || error);
  } finally {
    isRunning = false;
  }
}

function startPollSheetJob() {
  runPollingCycle();

  setInterval(async () => {
    await runPollingCycle();
  }, 10000);
}

module.exports = {
  startPollSheetJob,
  runPollingCycle,
  checkDueTasks,
  checkCallReminders
};