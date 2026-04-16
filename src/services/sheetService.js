const { google } = require("googleapis");
const env = require("../config/env");

const SHEET_NAME = "patients";
const MESSAGE_LOG_SHEET = "message_log";
const STATUS_HISTORY_SHEET = "status_history";
const SETTINGS_SHEET = "settings";

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

function now() {
  return new Date();
}

function formatDate(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function addMinutes(date, m) {
  return new Date(date.getTime() + m * 60000);
}

function isDue(datetime) {
  if (!datetime) return false;
  const d = new Date(String(datetime).replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() <= Date.now();
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

async function getSheetData() {
  const sheets = getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: `${SHEET_NAME}!A:AL`
  });

  const rows = res.data.values || [];
  if (!rows.length) return { headers: [], patients: [] };

  const headers = rows[0].map(normalizeHeader);
  const patients = mapRows(headers, rows.slice(1));

  return { headers, patients };
}

async function getSettings() {
  const sheets = getSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: `${SETTINGS_SHEET}!A:B`
  });

  const rows = res.data.values || [];
  const map = {};

  for (let i = 1; i < rows.length; i++) {
    const key = normalizeHeader(rows[i][0]);
    const val = normalizeValue(rows[i][1]);
    if (key) map[key] = val;
  }

  return map;
}

/**
 * CRITICAL FIX:
 * This preserves existing formulas and values in the row.
 * It reads the current row using FORMULA mode, merges updates,
 * then writes the merged row back.
 */
async function updateRow(rowNumber, updates) {
  const sheets = getSheetsClient();
  const { headers } = await getSheetData();

  const currentRowRes = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: `${SHEET_NAME}!A${rowNumber}:AL${rowNumber}`,
    valueRenderOption: "FORMULA"
  });

  const currentRow = currentRowRes.data.values?.[0] || [];
  const mergedRow = new Array(headers.length).fill("");

  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    if (updates[header] !== undefined) {
      mergedRow[i] = updates[header];
    } else {
      mergedRow[i] = currentRow[i] !== undefined ? currentRow[i] : "";
    }
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: env.GOOGLE_SHEET_ID,
    range: `${SHEET_NAME}!A${rowNumber}:AL${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [mergedRow]
    }
  });
}

async function appendMessageLog(data) {
  const sheets = getSheetsClient();

  await sheets.spreadsheets.values.append({
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
  });
}

async function appendStatusHistory(data) {
  const sheets = getSheetsClient();

  try {
    await sheets.spreadsheets.values.append({
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
    });
  } catch (error) {
    console.error("Status history append failed:", error.message || error);
  }
}

function getReminderMinutes(counter, settings) {
  const reminder1 = Number(settings.reminder_1_minutes || 60);
  const reminder2 = Number(settings.reminder_2_minutes || 120);
  const reminder3 = Number(settings.reminder_3_minutes || 150);

  if (counter <= 1) return reminder1;
  if (counter === 2) return reminder2;
  return reminder3;
}

/**
 * Used when operator clicks "Send Message"
 * Fixes:
 * - updates status automatically
 * - schedules next reminder
 * - clears telegram lock so next reminder can fire
 */
async function markSent(patient, headers, settings, finalMessage) {
  const statusKey = findHeader(headers, "status");
  const subKey = findHeader(headers, "sub_status");
  const typeKey = findHeader(headers, "current_task_type");
  const activeKey = findHeader(headers, "current_task_active");
  const actionKey = findHeader(headers, "next_action");
  const followKey = findHeader(headers, "next_followup_at");
  const lastAgentKey = findHeader(headers, "last_agent_message_at");
  const finalKey = findHeader(headers, "last_final_message");
  const stalledKey = findHeader(headers, "stalled_task_counter");
  const countKey = findHeader(headers, "message_count");
  const alertKey = findHeader(headers, "telegram_last");
  const updatedAtKey = findHeader(headers, "updated_at");

  const oldStatus = patient[statusKey] || "";
  const oldSubStatus = patient[subKey] || "";

  const count = Number(patient[countKey] || 0);
  const stalled = Number(patient[stalledKey] || 0) + 1;

  const minutes = getReminderMinutes(stalled, settings);
  const currentTime = now();
  const nextDate = addMinutes(currentTime, minutes);

  await updateRow(patient.rowNumber, {
    [statusKey]: settings.status_after_send || "contacted",
    [subKey]: settings.sub_status_after_send || "waiting_reply",
    [typeKey]: "follow_up",
    [activeKey]: "TRUE",
    [actionKey]: "wait_patient_reply",
    [followKey]: formatDate(nextDate),
    [lastAgentKey]: formatDate(currentTime),
    [finalKey]: finalMessage,
    [stalledKey]: String(stalled),
    [countKey]: String(count + 1),
    [alertKey]: "",
    [updatedAtKey]: formatDate(currentTime)
  });

  await appendMessageLog({
    timestamp: formatDate(currentTime),
    patient_id: patient.patient_id || "",
    rowNumber: patient.rowNumber,
    channel: "telegram_action",
    direction: "outgoing",
    message_type: "ai_final_message",
    content: finalMessage,
    status: "sent_from_button"
  });

  await appendStatusHistory({
    timestamp: formatDate(currentTime),
    patient_id: patient.patient_id || "",
    rowNumber: patient.rowNumber,
    old_status: oldStatus,
    new_status: settings.status_after_send || "contacted",
    old_sub_status: oldSubStatus,
    new_sub_status: settings.sub_status_after_send || "waiting_reply",
    reason: "message_marked_sent"
  });

  console.log(`Message marked sent for row ${patient.rowNumber}. Next follow-up in ${minutes} minutes.`);
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
  addMinutes
};