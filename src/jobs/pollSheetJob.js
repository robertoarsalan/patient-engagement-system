const { checkNewPatients } = require("../services/triggerService");
const {
  getSheetData,
  isDue,
  hasValue,
  toBool,
  findHeader,
  updateRow,
  formatDate
} = require("../services/sheetService");
const { generatePatientMessage } = require("../services/aiService");
const { sendPatientTaskCard } = require("../services/telegramService");

let isRunning = false;

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
    await checkNewPatients();
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
  checkDueTasks
};