const {
  getSheetData,
  getSettings,
  toBool,
  hasValue,
  findHeader,
  updateRow,
  formatDate
} = require("./sheetService");
const { generatePatientMessage } = require("./aiService");
const { sendPatientTaskCard } = require("./telegramService");
const { recordNewPatient } = require("./supervisorService");

async function checkNewPatients() {
  const { headers, patients } = await getSheetData();
  const settings = await getSettings();

  const fullNameKey = findHeader(headers, "full_name");
  const patientIdKey = findHeader(headers, "patient_id");
  const workflowKey = findHeader(headers, "workflow_started");
  const workflowAtKey = findHeader(headers, "workflow_started_at");
  const statusKey = findHeader(headers, "status");
  const subStatusKey = findHeader(headers, "sub_status");
  const taskTypeKey = findHeader(headers, "current_task_type");
  const activeKey = findHeader(headers, "current_task_active");
  const nextActionKey = findHeader(headers, "next_action");
  const generatedKey = findHeader(headers, "last_generated_message");
  const finalKey = findHeader(headers, "last_final_message");
  const alertKey = findHeader(headers, "telegram_last_alert_id");
  const createdAtKey = findHeader(headers, "created_at");
  const updatedAtKey = findHeader(headers, "updated_at");
  const countKey = findHeader(headers, "message_count");
  const stalledKey = findHeader(headers, "stalled_task_counter");

  let startedCount = 0;

  for (const patient of patients) {
    try {
      const fullName = patient[fullNameKey];
      const workflowStarted = toBool(patient[workflowKey]);

      if (!hasValue(fullName)) continue;
      if (workflowStarted) continue;

      const currentTime = new Date();
      const nowStamp = formatDate(currentTime);

      const patientForAi = {
        ...patient,
        [statusKey]: "new_lead",
        [taskTypeKey]: "initial_contact",
        [activeKey]: "TRUE",
        [nextActionKey]: "send_first_message",
        [workflowKey]: "TRUE",
        [workflowAtKey]: nowStamp,
        [createdAtKey]: patient[createdAtKey] || nowStamp,
        [updatedAtKey]: nowStamp,
        [countKey]: patient[countKey] || "0",
        [stalledKey]: patient[stalledKey] || "0"
      };

      const aiResult = await generatePatientMessage(patientForAi);

      await updateRow(patient.rowNumber, {
        [statusKey]: "new_lead",
        [subStatusKey]: patient[subStatusKey] || "",
        [taskTypeKey]: "initial_contact",
        [activeKey]: "TRUE",
        [nextActionKey]: "send_first_message",
        [generatedKey]: aiResult.generatedMessage,
        [finalKey]: aiResult.finalMessage,
        [countKey]: patient[countKey] || "0",
        [stalledKey]: patient[stalledKey] || "0",
        [createdAtKey]: patient[createdAtKey] || nowStamp,
        [updatedAtKey]: nowStamp,
        [workflowKey]: "TRUE",
        [workflowAtKey]: nowStamp,
        [alertKey]: ""
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
        [alertKey]: String(telegramMessage.message_id || ""),
        [updatedAtKey]: formatDate(new Date())
      });

      recordNewPatient();
      startedCount++;

      console.log(
        `Instant Telegram task sent for row ${patient.rowNumber} (${patient[patientIdKey] || ""})`
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