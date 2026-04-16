const dotenv = require("dotenv");

dotenv.config();

function requireEnv(name, fallback = "") {
  const value = process.env[name] ?? fallback;
  return value;
}

module.exports = {
  PORT: Number(requireEnv("PORT", "3000")),

  GOOGLE_SHEET_ID: requireEnv("GOOGLE_SHEET_ID"),
  GOOGLE_SERVICE_ACCOUNT_EMAIL: requireEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL"),
  GOOGLE_PRIVATE_KEY: requireEnv("GOOGLE_PRIVATE_KEY").replace(/\\n/g, "\n"),

  TELEGRAM_BOT_TOKEN: requireEnv("TELEGRAM_BOT_TOKEN"),
  TELEGRAM_CHAT_ID: requireEnv("TELEGRAM_CHAT_ID"),

  OPENAI_API_KEY: requireEnv("OPENAI_API_KEY"),
  ANTHROPIC_API_KEY: requireEnv("ANTHROPIC_API_KEY"),

  OPENAI_MODEL: requireEnv("OPENAI_MODEL", "gpt-5.4-mini"),
  ANTHROPIC_MODEL: requireEnv("ANTHROPIC_MODEL", "claude-sonnet-4-6"),

  TIMEZONE: requireEnv("TIMEZONE", "Europe/Istanbul")
};