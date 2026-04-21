function pad(value) {
  return String(value).padStart(2, "0");
}

function formatDate(date) {
  const d = new Date(date);

  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function addMinutes(date, minutes) {
  return new Date(new Date(date).getTime() + Number(minutes || 0) * 60000);
}

module.exports = {
  formatDate,
  addMinutes
};