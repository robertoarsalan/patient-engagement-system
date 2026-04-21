const express = require("express");
const env = require("./config/env");

const {
  getSheetData,
  findHeader,
  updateRow,
  formatDate
} = require("./services/sheetService");

const {
  sendTelegramMessage,
  answerCallbackQuery
} = require("./services/telegramService");

const {
  notifyError
} = require("./services/supervisorService");

const app = express();
app.use(express.json());

/* =========================
   HELPERS
========================= */

function toBool(value) {
  return String(value || "").toLowerCase() === "true";
}

function getLast4(phone) {
  const clean = String(phone || "").replace(/\D/g, "");
  return clean.slice(-4) || "----";
}

/* =========================
   TIME PARSER (VERY IMPORTANT)
========================= */

function parseCallTime(input) {
  const text = String(input || "").trim();

  // HH:mm
  let m = text.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const now = new Date();

    const date = new Date();
    date.setHours(Number(m[1]));
    date.setMinutes(Number(m[2]));
    date.setSeconds(0);

    // if time already passed today → schedule tomorrow
    if (date.getTime() <= now.getTime()) {
      date.setDate(date.getDate() + 1);
    }

    return date;
  }

  // YYYY-MM-DD HH:mm
  m = text.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2})$/);
  if (m) {
    return new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      0
    );
  }

  return null;
}

/* =========================
   TELEGRAM WEBHOOK
========================= */

app.post("/telegram-webhook", async (req, res) => {
  try {
    const body = req.body;

    /* =========================
       BUTTON CLICK HANDLER
    ========================= */

    if (body.callback_query) {
      const data = body.callback_query.data || "";
      const callbackId = body.callback_query.id;

      const [action, rowRaw] = data.split(":");
      const rowNumber = Number(rowRaw);

      const { headers, patients } = await getSheetData();
      const patient = patients.find(p => p.rowNumber === rowNumber);

      if (!patient) {
        await answerCallbackQuery(callbackId, "Patient not found");
        return res.json({ ok: true });
      }

      const callPendingKey = findHeader(headers, "call_pending_input");
      const callActiveKey = findHeader(headers, "call_reminder_active");
      const callTimeKey = findHeader(headers, "call_reminder_at");
      const updatedKey = findHeader(headers, "updated_at");

      /* ===== CALL BUTTON ===== */

      if (action === "call") {
        // 🔴 RESET ANY OLD PENDING FIRST
        for (const p of patients) {
          if (toBool(p[callPendingKey])) {
            await updateRow(p.rowNumber, {
              [callPendingKey]: "FALSE"
            });
          }
        }

        // 🟢 SET NEW PENDING
        await updateRow(patient.rowNumber, {
          [callPendingKey]: "TRUE",
          [callActiveKey]: "FALSE",
          [callTimeKey]: "",
          [updatedKey]: formatDate(new Date())
        });

        await answerCallbackQuery(callbackId, "Enter call time");

        await sendTelegramMessage(
          `📞 Call setup\n\n👤 ${patient.full_name}\n📱 ${getLast4(patient.phone)}\n\nSend time:\nHH:mm\nor\nYYYY-MM-DD HH:mm`
        );

        return res.json({ ok: true });
      }

      await answerCallbackQuery(callbackId, "OK");
      return res.json({ ok: true });
    }

    /* =========================
       TEXT INPUT HANDLER (CALL TIME)
    ========================= */

    if (body.message && body.message.text) {
      const text = body.message.text;

      const { headers, patients } = await getSheetData();

      const callPendingKey = findHeader(headers, "call_pending_input");
      const callActiveKey = findHeader(headers, "call_reminder_active");
      const callTimeKey = findHeader(headers, "call_reminder_at");
      const updatedKey = findHeader(headers, "updated_at");

      const pending = patients.find(p => toBool(p[callPendingKey]));

      if (!pending) {
        return res.json({ ok: true });
      }

      const parsed = parseCallTime(text);

      if (!parsed) {
        await sendTelegramMessage("❌ Invalid format. Use HH:mm or YYYY-MM-DD HH:mm");
        return res.json({ ok: true });
      }

      const formatted = formatDate(parsed);

      await updateRow(pending.rowNumber, {
        [callPendingKey]: "FALSE",
        [callActiveKey]: "TRUE",
        [callTimeKey]: formatted,
        [updatedKey]: formatDate(new Date())
      });

      await sendTelegramMessage(
        `✅ Call reminder saved\n\n👤 ${pending.full_name}\n⏰ ${formatted} (TR time)`
      );

      return res.json({ ok: true });
    }

    return res.json({ ok: true });

  } catch (error) {
    console.error("Webhook error:", error.message);
    await notifyError("telegram-webhook", error);

    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/* ========================= */

app.listen(env.PORT, () => {
  console.log("🚀 Server running...");
});