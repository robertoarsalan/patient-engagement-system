const {
  getSheetData,
  getSettings,
  toBool,
  hasValue,
  findHeader,
  updateRow,
  formatDate,
  addMinutes
} = require("./sheetService");
const { generatePatientMessage } = require("./aiService");
const { sendPatientTaskCard } = require("./telegramService");

async function checkNewPatients() {
  const { headers, patients } = await getSheetData();
  const settings = await getSettings();

  const fullNameKey = findHeader(headers, "full_name");
  const patientIdKey = findHeader(headers, "patient_id");
  const triggerKey = findHeader(headers, "trigger_ready");
  const workflowKey = findHeader(headers, "workflow_started");
  const workflowAtKey = findHeader(headers, "workflow_started_at");
  const photosKey = findHeader(headers, "photos_received");
  const statusKey = findHeader(headers, "status");
  const subStatusKey = findHeader(headers, "sub_status");
  const taskTypeKey = findHeader(headers, "current_task_type");
  const activeKey = findHeader(headers, "current_task_active");
  const nextActionKey = findHeader(headers, "next_action");
  const followupKey = findHeader(headers, "next_followup_at");
  const generatedKey = findHeader(headers, "last_generated_message");
  const finalKey = findHeader(headers, "last_final_message");
  const lastAlertKey = findHeader(headers, "telegram_last");
  const createdAtKey = findHeader(headers, "created_at");
  const updatedAtKey = findHeader(headers, "updated_at");
  const messageCountKey = findHeader(headers, "message_count");
  const stalledKey = findHeader(headers, "stalled_task_counter");

  const initialDelayMinutes = Number(settings.initial_followup_delay_minutes || 5);

  console.log("Checking sheet for new patients...");

  let startedCount = 0;

  for (const patient of patients) {
    try {
      const fullName = patient[fullNameKey];
      const patientId = patient[patientIdKey];
      const workflowStarted = toBool(patient[workflowKey]);

      console.log("Trigger check:", {
        rowNumber: patient.rowNumber,
        patient_id: patientId || "",
        full_name: fullName || "",
        workflow_started: patient[workflowKey],
        parsed: {
          hasFullName: hasValue(fullName),
          workflowStarted
        }
      });

      if (!hasValue(fullName)) continue;
      if (workflowStarted) continue;

      const currentTime = new Date();
      const nowStamp = formatDate(currentTime);
      const nextFollowupAt = formatDate(addMinutes(currentTime, initialDelayMinutes));

      const patientForAi = {
        ...patient,
        [statusKey]: "new_lead",
        [taskTypeKey]: "initial_contact",
        [activeKey]: "TRUE",
        [nextActionKey]: "send_first_message",
        [followupKey]: nextFollowupAt,
        [photosKey]: nowStamp,
        [triggerKey]: "TRUE",
        [workflowKey]: "TRUE",
        [workflowAtKey]: nowStamp,
        [createdAtKey]: patient[createdAtKey] || nowStamp,
        [updatedAtKey]: nowStamp,
        [messageCountKey]: patient[messageCountKey] || "0",
        [stalledKey]: patient[stalledKey] || "0"
      };

      const aiResult = await generatePatientMessage(patientForAi);

      await updateRow(patient.rowNumber, {
        [triggerKey]: "TRUE",
        [photosKey]: nowStamp,
        [statusKey]: "new_lead",
        [subStatusKey]: patient[subStatusKey] || "",
        [taskTypeKey]: "initial_contact",
        [activeKey]: "TRUE",
        [nextActionKey]: "send_first_message",
        [followupKey]: nextFollowupAt,
        [generatedKey]: aiResult.generatedMessage,
        [finalKey]: aiResult.finalMessage,
        [messageCountKey]: patient[messageCountKey] || "0",
        [stalledKey]: patient[stalledKey] || "0",
        [createdAtKey]: patient[createdAtKey] || nowStamp,
        [updatedAtKey]: nowStamp,
        [workflowKey]: "TRUE",
        [workflowAtKey]: nowStamp,
        [lastAlertKey]: ""
      });

      const telegramMessage = await sendPatientTaskCard(
        patient.rowNumber,
        {
          ...patientForAi,
          [generatedKey]: aiResult.generatedMessage,
          [finalKey]: aiResult.finalMessage
        },
        aiResult.finalMessage
      );

      await updateRow(patient.rowNumber, {
        [lastAlertKey]: String(telegramMessage.message_id || ""),
        [updatedAtKey]: formatDate(new Date())
      });

      startedCount++;

      console.log(
        `Instant Telegram task sent for row ${patient.rowNumber} (${patientId || ""})`
      );
    } catch (error) {
      console.error(
        `Error starting workflow for row ${patient.rowNumber}:`,
        error.response?.data || error.message || error
      );
    }
  }

  if (startedCount === 0) {
    console.log("No new patients to process.");
  } else {
    console.log(`Started workflow instantly for ${startedCount} patient(s).`);
  }
}

module.exports = {
  checkNewPatients
};