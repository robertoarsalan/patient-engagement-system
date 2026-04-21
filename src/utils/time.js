function pad(value) {
  return String(value).padStart(2, "0");
}

function getTurkeyParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: process.env.TIMEZONE || "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const map = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  }

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second)
  };
}

function formatDate(date) {
  const tr = getTurkeyParts(new Date(date));
  return `${tr.year}-${pad(tr.month)}-${pad(tr.day)} ${pad(tr.hour)}:${pad(tr.minute)}:${pad(tr.second)}`;
}

function addMinutes(date, minutes) {
  return new Date(new Date(date).getTime() + Number(minutes || 0) * 60000);
}

module.exports = {
  formatDate,
  addMinutes
};