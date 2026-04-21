const { google } = require("googleapis");
const env = require("../config/env");
const { formatDate, addMinutes } = require("../utils/time");

const SHEET_NAME = "patients";
const MESSAGE_LOG_SHEET = "message_log";
const STATUS_HISTORY_SHEET = "status_history";
const SETTINGS_SHEET = "settings";
const PATIENTS_RANGE_END = "AO";
const AUTO_RESET_THRESHOLD = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableGoogleError(error) {
  const msg = String(error?.message || "").toLowerCase();
  const code = error?.code;
  const status = error?.response?.status;

  return (
    msg.includes("operation was aborted") ||
    msg.includes("request aborted") ||
    msg.includes("timeout") ||
    msg.includes("deadline") ||
    msg.includes("socket hang up") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === 429 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

async function withGoogleRetry(fn, label = "google_request", maxAttempts = 4) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (!isRetryableGoogleError(error) || attempt === maxAttempts) {
        throw error;
      }

      const delay = attempt * 1500;
      console.warn(
        `[${label}] Google request failed on attempt ${attempt}/${maxAttempts}. Retrying in ${delay}ms...`,
        error.message || error
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: env.GOOGLE_PRIVATE_KEY
    },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  return google.sheets({ version: "v4", auth });
}

function normalizeHeader(header = "") {
  return String(header).trim().toLowerCase().replace(/\s+/g, "_");
}

function normalizeValue(value) {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value.trim() : value;
}

function toBool(value) {
  const v = String(value || "").trim().toLowerCase();
  return v === "true" || v === "yes" || v === "1";
}

function hasValue(v) {
  return String(v || "").trim() !== "";
}

function parseSheetDateTime(datetime) {
  if (!datetime) return null;

  const raw = String(datetime).replace(/^'/, "").trim();
  if (!raw) return null;

  let match = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/
  );

  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6] || 0);

    return new Date(Date.UTC(year, month - 1, day, hour - 3, minute, second));
  }

  match = raw.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/
  );

  if (match) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    const year = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6] || 0);

    return new Date(Date.UTC(year, month - 1, day, hour - 3, minute, second));
  }

  const fallback = new Date(raw);
  if (!Number.isNaN(fallback.getTime())) {
    return fallback;
  }

  return null;
}

function isDue(datetime) {
  const parsed = parseSheetDateTime(datetime);
  if (!parsed) return false;
  return parsed.getTime() <= Date.now();
}

function mapRows(headers, rows) {
  return rows.map((row, i) => {
    const obj = { rowNumber: i + 2 };
    headers.forEach((h, idx) => {
      obj[h] = normalizeValue(row[idx]);
    });
    return obj;
  });
}

function findHeader(headers, key) {
  return headers.find((h) => h === key || h.startsWith(key));
}

function isDateHeader(header) {
  return [
    "next_followup_at",
    "last_patient_reply_at",
    "last_agent_message_at",
    "photos_requested_at",
    "photos_received_at",
    "evaluation_sent_at",
    "created_at",
    "updated_at",
    "call_reminder_at",
    "workflow_started_at",
    "workflow_started_at"
  ].includes(header);
}

function prepareCellValue(header, value) {
  if (value === undefined) return undefined;
  if (value === null) return "";

  if (isDateHeader(header) && String(value).trim() !== "") {
    return `'${String(value).trim()}`;
  }

  return value;
}

async function getSheetData() {
  const sheets = getSheetsClient();

  const res = await withGoogleRetry(
    () =>
      sheets.spreadsheets.values.get({
        spreadsheetId: env.GOOGLE_SHEET_ID,
        range: `${SHEET_NAME}!A:${PATIENTS_RANGE_END}`
      }),
    "getSheetData"
  );

  const rows = res.data.values || [];
  if (!rows.length) return { headers: [], patients: [] };

  const headers = rows[0].map(normalizeHeader);
  const patients = mapRows(headers, rows.slice(1));

  return { headers, patients };
}

async function getSettings() {
  const sheets = getSheetsClient();

  const res = await withGoogleRetry(
    () =>
      sheets.spreadsheets.values.get({
        spreadsheetId: env.GOOGLE_SHEET_ID,
        range: `${SETTINGS_SHEET}!A:B`
      }),
    "getSettings"
  );

  const rows = res.data.values || [];
  const map = {};

  for (let i = 1; i < rows.length; i++) {
    const key = normalizeHeader(rows[i][0]);
    const val = normalizeValue(rows[i][1]);
    if (key) map[key] = val;
  }

  return map;
}

async function updateRow(rowNumber, updates) {
  const sheets = getSheetsClient();
  const { headers } = await getSheetData();

  const currentRowRes = await withGoogleRetry(
    () =>
      sheets.spreadsheets.values.get({
        spreadsheetId: env.GOOGLE_SHEET_ID,
        range: `${SHEET_NAME}!A${rowNumber}:${PATIENTS_RANGE_END}${rowNumber}`,
        valueRenderOption: "FORMULA"
      }),
    "updateRow.getCurrentRow"
  );

  const currentRow = currentRowRes.data.values?.[0] || [];
  const mergedRow = new Array(headers.length).fill("");

  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];

    if (updates[header] !== undefined) {
      mergedRow[i] = prepareCellValue(header, updates[header]);
    } else {
      mergedRow[i] = currentRow[i] !== undefined ? currentRow[i] : "";
    }
  }

  await withGoogleRetry(
    () =>
      sheets.spreadsheets.values.update({
        spreadsheetId: env.GOOGLE_SHEET_ID,
        range: `${SHEET_NAME}!A${rowNumber}:${PATIENTS_RANGE_END}${rowNumber}`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [mergedRow]
        }
      }),
    "updateRow.writeRow"
  );
}

async function appendMessageLog(data) {
  const sheets = getSheetsClient();

  await withGoogleRetry(
    () =>
      sheets.spreadsheets.values.append({
        spreadsheetId: env.GOOGLE_SHEET_ID,
        range: `${MESSAGE_LOG_SHEET}!A:H`,
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: {
          values: [[
            data.timestamp,
            data.patient_id,
            data.rowNumber,
            data.channel,
            data.direction,
            data.message_type,
            data.content,
            data.status
          ]]
        }
      }),
    "appendMessageLog"
  );
}

async function appendStatusHistory(data) {
  const sheets = getSheetsClient();

  try {
    await withGoogleRetry(
      () =>
        sheets.spreadsheets.values.append({
          spreadsheetId: env.GOOGLE_SHEET_ID,
          range: `${STATUS_HISTORY_SHEET}!A:H`,
          valueInputOption: "USER_ENTERED",
          insertDataOption: "INSERT_ROWS",
          requestBody: {
            values: [[
              data.timestamp,
              data.patient_id,
              data.rowNumber,
              data.old_status,
              data.new_status,
              data.old_sub_status,
              data.new_sub_status,
              data.reason
            ]]
          }
        }),
      "appendStatusHistory"
    );
  } catch (error) {
    console.error("Status history append failed:", error.message || error);
  }
}

function getMixedReminderPlan(counter, settings, firstSentTime, currentSendTime) {
  const r1 = Number(settings.reminder_1_minutes || 60);
  const r2 = Number(settings.reminder_2_minutes || 210); // 1h + 2.5h after second notification flow target
  const r3 = Number(settings.reminder_3_minutes || 150);

  if (counter === 1) {
    return {
      minutes: r1,
      nextDate: addMinutes(firstSentTime, r1)
    };
  }

  if (counter === 2) {
    return {
      minutes: r3,
      nextDate: addMinutes(currentSendTime, r3)
    };
  }

  return {
    minutes: r3,
    nextDate: addMinutes(currentSendTime, r3)
  };
}

async function markSent(patient, headers, settings, finalMessage) {
  const statusKey = findHeader(headers, "status");
  const subKey = findHeader(headers, "sub_status");
  const typeKey = findHeader(headers, "current_task_type");
  const activeKey = findHeader(headers, "current_task_active");
  const actionKey = findHeader(headers, "next_action");
  const followKey = findHeader(headers, "next_followup_at");
  const lastAgentKey = findHeader(headers, "last_agent_message_at");
  const finalKey = findHeader(headers, "last_final_message");
  const generatedKey = findHeader(headers, "last_generated_message");
  const stalledKey = findHeader(headers, "stalled_task_counter");
  const countKey = findHeader(headers, "message_count");
  const alertKey = findHeader(headers, "telegram_last_alert_id");
  const updatedAtKey = findHeader(headers, "updated_at");
  const workflowStartedAtKey = findHeader(headers, "workflow_started_at");

  const oldStatus = patient[statusKey] || "";
  const oldSubStatus = patient[subKey] || "";

  const count = Number(patient[countKey] || 0);
  const stalled = Number(patient[stalledKey] || 0) + 1;

  const currentSendTime = new Date();

  const firstSentTime = patient[workflowStartedAtKey]
    ? parseSheetDateTime(patient[workflowStartedAtKey]) || currentSendTime
    : currentSendTime;

  const plan = getMixedReminderPlan(
    stalled,
    settings,
    firstSentTime,
    currentSendTime
  );

  await updateRow(patient.rowNumber, {
    [statusKey]: settings.status_after_send || "contacted",
    [subKey]: settings.sub_status_after_send || "waiting_reply",
    [typeKey]: "follow_up",
    [activeKey]: "TRUE",
    [actionKey]: "wait_patient_reply",
    [followKey]: formatDate(plan.nextDate),
    [lastAgentKey]: formatDate(currentSendTime),
    [workflowStartedAtKey]: patient[workflowStartedAtKey] || formatDate(currentSendTime),
    [generatedKey]: patient[generatedKey] || "",
    [finalKey]: finalMessage,
    [stalledKey]: String(stalled),
    [countKey]: String(count + 1),
    [alertKey]: "",
    [updatedAtKey]: formatDate(currentSendTime)
  });

  await appendMessageLog({
    timestamp: formatDate(currentSendTime),
    patient_id: patient.patient_id || "",
    rowNumber: patient.rowNumber,
    channel: "telegram_action",
    direction: "outgoing",
    message_type: "ai_final_message",
    content: finalMessage,
    status: "sent_from_button"
  });

  await appendStatusHistory({
    timestamp: formatDate(currentSendTime),
    patient_id: patient.patient_id || "",
    rowNumber: patient.rowNumber,
    old_status: oldStatus,
    new_status: settings.status_after_send || "contacted",
    old_sub_status: oldSubStatus,
    new_sub_status: settings.sub_status_after_send || "waiting_reply",
    reason: "message_marked_sent"
  });

  return {
    nextFollowupAt: formatDate(plan.nextDate),
    minutes: plan.minutes
  };
}

async function resetPatientsSheetIfThresholdReached() {
  const sheets = getSheetsClient();

  const valuesRes = await withGoogleRetry(
    () =>
      sheets.spreadsheets.values.get({
        spreadsheetId: env.GOOGLE_SHEET_ID,
        range: `${SHEET_NAME}!A:${PATIENTS_RANGE_END}`
      }),
    "resetPatientsSheetIfThresholdReached.readSheet"
  );

  const rows = valuesRes.data.values || [];
  if (rows.length <= 1) {
    return { triggered: false, filledCount: 0 };
  }

  const headers = rows[0].map(normalizeHeader);
  const fullNameIndex = headers.findIndex((h) => h === "full_name");

  if (fullNameIndex === -1) {
    return { triggered: false, filledCount: 0 };
  }

  let filledCount = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const fullName = row[fullNameIndex];
    if (hasValue(fullName)) {
      filledCount++;
    }
  }

  if (filledCount < AUTO_RESET_THRESHOLD) {
    return { triggered: false, filledCount };
  }

  console.log(`Patients threshold reached (${filledCount}). Resetting patient rows while preserving formulas...`);

  const formulaRes = await withGoogleRetry(
    () =>
      sheets.spreadsheets.values.get({
        spreadsheetId: env.GOOGLE_SHEET_ID,
        range: `${SHEET_NAME}!A2:${PATIENTS_RANGE_END}`,
        valueRenderOption: "FORMULA"
      }),
    "resetPatientsSheetIfThresholdReached.readFormulas"
  );

  const formulaRows = formulaRes.data.values || [];
  const cleanedRows = formulaRows.map((row) =>
    row.map((cell) => {
      const value = String(cell ?? "");
      if (value.startsWith("=")) {
        return value;
      }
      return "";
    })
  );

  if (cleanedRows.length > 0) {
    await withGoogleRetry(
      () =>
        sheets.spreadsheets.values.update({
          spreadsheetId: env.GOOGLE_SHEET_ID,
          range: `${SHEET_NAME}!A2:${PATIENTS_RANGE_END}${cleanedRows.length + 1}`,
          valueInputOption: "USER_ENTERED",
          requestBody: {
            values: cleanedRows
          }
        }),
      "resetPatientsSheetIfThresholdReached.writeReset"
    );
  }

  console.log("Patients sheet reset complete.");
  return { triggered: true, filledCount };
}

module.exports = {
  getSheetData,
  getSettings,
  updateRow,
  appendMessageLog,
  appendStatusHistory,
  markSent,
  isDue,
  hasValue,
  toBool,
  findHeader,
  formatDate,
  addMinutes,
  parseSheetDateTime,
  getMixedReminderPlan,
  resetPatientsSheetIfThresholdReached
};