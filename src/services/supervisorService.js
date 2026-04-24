const state = {
  lastPollingSuccessAt: null,
  lastPollingErrorAt: null,
  lastPollingErrorMessage: "",

  lastTelegramSuccessAt: null,
  lastSheetsSuccessAt: null,
  lastAiSuccessAt: null,

  alertsSent: new Map(),

  pollingStallAlertSentAt: null,

  counters: {
    newPatientsToday: 0,
    messagesMarkedSentToday: 0,
    followUpsTriggeredToday: 0,
    callRemindersTriggeredToday: 0,
    errorsToday: 0
  },

  lastDailySummaryDate: null,
  lastSummarySentKey: null
};

const POLLING_STALL_THRESHOLD_MINUTES = 20;
const POLLING_STALL_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

function getTurkeyNow() {
  return new Date(
    new Date().toLocaleString("en-US", {
      timeZone: process.env.TIMEZONE || "Europe/Istanbul"
    })
  );
}

function getTurkeyDateKey() {
  const now = getTurkeyNow();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getTurkeyTimestampLabel() {
  return new Date().toLocaleString("en-GB", {
    timeZone: process.env.TIMEZONE || "Europe/Istanbul",
    hour12: false
  });
}

function formatTimestamp(ts) {
  if (!ts) return "never";

  return (
    new Date(ts).toLocaleString("en-GB", {
      timeZone: process.env.TIMEZONE || "Europe/Istanbul",
      hour12: false
    }) + " (TR time)"
  );
}

function resetDailyCountersIfNeeded() {
  const today = getTurkeyDateKey();

  if (state.lastDailySummaryDate === null) {
    state.lastDailySummaryDate = today;
    return;
  }

  if (state.lastDailySummaryDate !== today) {
    state.counters = {
      newPatientsToday: 0,
      messagesMarkedSentToday: 0,
      followUpsTriggeredToday: 0,
      callRemindersTriggeredToday: 0,
      errorsToday: 0
    };
    state.lastDailySummaryDate = today;
    state.lastSummarySentKey = null;
  }
}

function incrementCounter(counterName) {
  resetDailyCountersIfNeeded();

  if (typeof state.counters[counterName] !== "number") {
    state.counters[counterName] = 0;
  }

  state.counters[counterName] += 1;
}

function makeAlertKey(type, detail) {
  return `${type}::${detail}`;
}

function shouldThrottle(type, detail, windowMs = 15 * 60 * 1000) {
  const key = makeAlertKey(type, detail);
  const last = state.alertsSent.get(key);

  if (!last) {
    state.alertsSent.set(key, Date.now());
    return false;
  }

  const diff = Date.now() - last;
  if (diff > windowMs) {
    state.alertsSent.set(key, Date.now());
    return false;
  }

  return true;
}

function isTransientAbort(error) {
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

function classifySource(source = "") {
  const s = String(source).toLowerCase();

  if (s.includes("telegram")) return "telegram";
  if (s.includes("sheet") || s.includes("google")) return "sheets";
  if (s.includes("ai")) return "ai";
  if (s.includes("poll")) return "scheduler";
  if (s.includes("call")) return "call_reminder";
  if (s.includes("follow")) return "follow_up";
  if (s.includes("webhook")) return "webhook";

  return "system";
}

function buildLikelyReason(source, error) {
  const cls = classifySource(source);
  const msg = String(error?.message || "").toLowerCase();

  if (cls === "telegram") return "Telegram bot API issue, token/chat mismatch, or temporary Telegram request failure.";
  if (cls === "sheets") return "Google Sheets API/network issue, credentials problem, or temporary request timeout.";
  if (cls === "ai") return "AI provider issue, API key problem, rate limit, or temporary model request failure.";

  if (cls === "scheduler") {
    if (msg.includes("timeout") || msg.includes("aborted")) {
      return "Scheduler was interrupted by a temporary API/network timeout.";
    }
    return "Polling cycle hit an unhandled workflow or service error.";
  }

  if (cls === "call_reminder") return "Call reminder row state may be incomplete or Telegram send failed.";
  if (cls === "follow_up") return "Follow-up generation/send failed or row state is inconsistent.";
  if (cls === "webhook") return "Telegram webhook request processing failed or callback handling hit an error.";

  return "Unhandled system error.";
}

function buildSuggestedAction(source, error) {
  const cls = classifySource(source);
  const msg = String(error?.message || "").toLowerCase();

  if (isTransientAbort(error)) {
    return "No manual action needed now. System will retry automatically.";
  }

  if (cls === "telegram") return "Check TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, and verify the bot can message your chat.";
  if (cls === "sheets") return "Check GOOGLE_SHEET_ID, service account email, private key, and sheet sharing permissions.";
  if (cls === "ai") return "Check OPENAI_API_KEY / ANTHROPIC_API_KEY, model names, and provider availability.";
  if (cls === "scheduler") return "Open Railway logs and inspect the latest polling cycle error for the specific failing service.";
  if (cls === "call_reminder") return "Check call_pending_input, call_reminder_at, and call_reminder_active in the patient row.";
  if (cls === "follow_up") return "Check next_followup_at, current_task_active, next_action, and telegram_last_alert_id fields.";
  if (cls === "webhook") return "Verify webhook is set correctly and test button click / text input flow again.";
  if (msg.includes("not found")) return "Check IDs, headers, and referenced rows/fields.";

  return "Check Railway logs and the affected module.";
}

async function notifySupervisor(title, details) {
  const text = `🚨 Supervisor Alert

📌 ${title}
🕒 ${getTurkeyTimestampLabel()} (TR time)

${details}`;

  try {
    const { sendTelegramMessage } = require("./telegramService");
    await sendTelegramMessage(text);
    state.lastTelegramSuccessAt = Date.now();
  } catch (error) {
    console.error("Supervisor Telegram notify failed:", error.response?.data || error.message || error);
  }
}

async function notifyError(source, error) {
  if (isTransientAbort(error)) {
    console.warn(`Transient error suppressed from supervisor: ${source} -> ${error.message || error}`);
    return;
  }

  incrementCounter("errorsToday");

  const message = error?.stack || error?.message || String(error || "Unknown error");
  const likelyReason = buildLikelyReason(source, error);
  const suggestedAction = buildSuggestedAction(source, error);
  const category = classifySource(source);

  if (shouldThrottle("error", `${category}:${source}:${message.slice(0, 120)}`)) {
    return;
  }

  await notifySupervisor(
    `Error in ${source}`,
    `🧩 Category: ${category}
🧩 Source: ${source}

❌ Error:
${message.slice(0, 1800)}

🔎 Likely reason:
${likelyReason}

🛠 Suggested action:
${suggestedAction}`
  );
}

function markPollingSuccess() {
  state.lastPollingSuccessAt = Date.now();

  // Reset emergency polling-stall lock only after polling becomes healthy again.
  state.pollingStallAlertSentAt = null;
}

function markPollingError(error) {
  state.lastPollingErrorAt = Date.now();
  state.lastPollingErrorMessage = error?.message || String(error || "Unknown polling error");
}

function markTelegramSuccess() {
  state.lastTelegramSuccessAt = Date.now();
}

function markSheetsSuccess() {
  state.lastSheetsSuccessAt = Date.now();
}

function markAiSuccess() {
  state.lastAiSuccessAt = Date.now();
}

function recordNewPatient() {
  incrementCounter("newPatientsToday");
}

function recordMessageMarkedSent() {
  incrementCounter("messagesMarkedSentToday");
}

function recordFollowUpTriggered() {
  incrementCounter("followUpsTriggeredToday");
}

function recordCallReminderTriggered() {
  incrementCounter("callRemindersTriggeredToday");
}

async function sendScheduledSummaryIfNeeded() {
  resetDailyCountersIfNeeded();

  const now = getTurkeyNow();
  const hour = now.getHours();
  const minute = now.getMinutes();

  let slot = null;
  if (hour === 7 && minute === 0) slot = "07:00";
  if (hour === 15 && minute === 0) slot = "15:00";

  if (!slot) return;

  const todayKey = getTurkeyDateKey();
  const summaryKey = `${todayKey}-${slot}`;

  if (state.lastSummarySentKey === summaryKey) {
    return;
  }

  state.lastSummarySentKey = summaryKey;

  await notifySupervisor(
    `Scheduled supervisor summary (${slot})`,
    `📊 Date: ${todayKey}

🆕 New patients: ${state.counters.newPatientsToday}
💬 Messages marked sent: ${state.counters.messagesMarkedSentToday}
🔁 Follow-ups triggered: ${state.counters.followUpsTriggeredToday}
📞 Call reminders triggered: ${state.counters.callRemindersTriggeredToday}
❌ Errors today: ${state.counters.errorsToday}

✅ Last polling success: ${formatTimestamp(state.lastPollingSuccessAt)}
✅ Last Telegram success: ${formatTimestamp(state.lastTelegramSuccessAt)}
✅ Last Sheets success: ${formatTimestamp(state.lastSheetsSuccessAt)}
✅ Last AI success: ${formatTimestamp(state.lastAiSuccessAt)}`
  );
}

async function checkPollingStallIfNeeded() {
  if (!state.lastPollingSuccessAt) return;

  const diffMs = Date.now() - state.lastPollingSuccessAt;
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < POLLING_STALL_THRESHOLD_MINUTES) {
    return;
  }

  const lastAlertAt = state.pollingStallAlertSentAt;

  if (lastAlertAt && Date.now() - lastAlertAt < POLLING_STALL_ALERT_COOLDOWN_MS) {
    return;
  }

  state.pollingStallAlertSentAt = Date.now();

  await notifySupervisor(
    "Polling appears stalled",
    `⏳ No successful polling cycle for ${diffMin} minute(s)

🧩 Last polling error:
${state.lastPollingErrorMessage || "unknown"}

🛠 Suggested action:
Check Railway logs and the latest scheduler-related errors.`
  );
}

async function runSelfCheck() {
  try {
    resetDailyCountersIfNeeded();

    const checks = [];

    if (!process.env.GOOGLE_SHEET_ID) checks.push("Missing GOOGLE_SHEET_ID");
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) checks.push("Missing GOOGLE_SERVICE_ACCOUNT_EMAIL");
    if (!process.env.GOOGLE_PRIVATE_KEY) checks.push("Missing GOOGLE_PRIVATE_KEY");
    if (!process.env.TELEGRAM_BOT_TOKEN) checks.push("Missing TELEGRAM_BOT_TOKEN");
    if (!process.env.TELEGRAM_CHAT_ID) checks.push("Missing TELEGRAM_CHAT_ID");

    if (checks.length > 0) {
      const detail = checks.join(" | ");
      if (!shouldThrottle("selfcheck-missing-env", detail, 60 * 60 * 1000)) {
        await notifySupervisor(
          "Configuration issue detected",
          `⚠️ Missing configuration:
- ${checks.join("\n- ")}

🛠 Suggested action:
Check Railway environment variables and redeploy if needed.`
        );
      }
    }

    await checkPollingStallIfNeeded();
    await sendScheduledSummaryIfNeeded();
  } catch (error) {
    console.error("Supervisor self-check failed:", error.message || error);
  }
}

function startSupervisor() {
  setInterval(async () => {
    await runSelfCheck();
  }, 60 * 1000);
}

function installGlobalErrorHandlers() {
  process.on("unhandledRejection", async (reason) => {
    console.error("Unhandled Rejection:", reason);
    await notifyError("unhandledRejection", reason);
  });

  process.on("uncaughtException", async (error) => {
    console.error("Uncaught Exception:", error);
    await notifyError("uncaughtException", error);
  });
}

module.exports = {
  notifyError,
  notifySupervisor,
  markPollingSuccess,
  markPollingError,
  markTelegramSuccess,
  markSheetsSuccess,
  markAiSuccess,
  recordNewPatient,
  recordMessageMarkedSent,
  recordFollowUpTriggered,
  recordCallReminderTriggered,
  startSupervisor,
  installGlobalErrorHandlers
};