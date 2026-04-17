const { sendTelegramMessage } = require("./telegramService");

const state = {
  lastPollingSuccessAt: null,
  lastPollingErrorAt: null,
  lastPollingErrorMessage: "",
  alertsSent: new Map()
};

function nowIso() {
  return new Date().toISOString();
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

async function notifySupervisor(title, details) {
  const text = `🚨 Supervisor Alert

📌 ${title}
🕒 ${new Date().toLocaleString("en-GB", {
    timeZone: process.env.TIMEZONE || "Europe/Istanbul",
    hour12: false
  })} (TR time)

${details}`;

  try {
    await sendTelegramMessage(text);
  } catch (error) {
    console.error("Supervisor Telegram notify failed:", error.response?.data || error.message || error);
  }
}

async function notifyError(source, error) {
  const message = error?.stack || error?.message || String(error || "Unknown error");

  if (shouldThrottle("error", `${source}:${message.slice(0, 120)}`)) {
    return;
  }

  await notifySupervisor(
    `Error in ${source}`,
    `🧩 Source: ${source}
❌ Error:
${message.slice(0, 3000)}`
  );
}

function markPollingSuccess() {
  state.lastPollingSuccessAt = Date.now();
}

function markPollingError(error) {
  state.lastPollingErrorAt = Date.now();
  state.lastPollingErrorMessage = error?.message || String(error || "Unknown polling error");
}

async function runSelfCheck() {
  try {
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
- ${checks.join("\n- ")}`
        );
      }
    }

    if (state.lastPollingSuccessAt) {
      const diffMs = Date.now() - state.lastPollingSuccessAt;
      const diffMin = Math.floor(diffMs / 60000);

      if (diffMin >= 5) {
        const detail = `Polling has not completed successfully for ${diffMin} minute(s). Last error: ${state.lastPollingErrorMessage || "unknown"}`;
        if (!shouldThrottle("polling-stale", detail, 30 * 60 * 1000)) {
          await notifySupervisor(
            "Polling appears stalled",
            `⏳ No successful polling cycle for ${diffMin} minute(s)
🧩 Last polling error: ${state.lastPollingErrorMessage || "unknown"}`
          );
        }
      }
    }
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
  markPollingSuccess,
  markPollingError,
  startSupervisor,
  installGlobalErrorHandlers
};