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

  console.log("Checking sheet for due tasks...");

  let dueCount = 0;

  for (const patient of patients) {
    const currentTaskActive = toBool(patient[activeKey]);
    const nextFollowupAt = patient[followupKey];
    const telegramLastAlertId = patient[alertKey];
    const nextAction = String(patient[actionKey] || "").trim();

    console.log("Due check:", {
      rowNumber: patient.rowNumber,
      patient_id: patient.patient_id || "",
      currentTaskActive,
      nextFollowupAt,
      telegramLastAlertId,
      nextAction,
      due: isDue(nextFollowupAt)
    });

    if (!currentTaskActive) continue;
    if (!hasValue(nextFollowupAt)) continue;
    if (!isDue(nextFollowupAt)) continue;
    if (hasValue(telegramLastAlertId)) continue;
    if (nextAction !== "wait_patient_reply") continue;

    dueCount++;

    console.log(`Due follow-up found for row ${patient.rowNumber} (${patient.patient_id || ""})`);

    const aiResult = await generatePatientMessage(patient);

    await updateRow(patient.rowNumber, {
      [generatedKey]: aiResult.generatedMessage,
      [finalKey]: aiResult.finalMessage,
      [updatedAtKey]: formatDate(new Date())
    });

    const telegramMessage = await sendPatientTaskCard(
      patient.rowNumber,
      { ...patient, [finalKey]: aiResult.finalMessage },
      aiResult.finalMessage
    );

    await updateRow(patient.rowNumber, {
      [alertKey]: String(telegramMessage.message_id || ""),
      [updatedAtKey]: formatDate(new Date())
    });

    console.log(`Follow-up Telegram task sent for row ${patient.rowNumber}`);
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
  }, 20000);
}

module.exports = {
  startPollSheetJob,
  runPollingCycle,
  checkDueTasks
};