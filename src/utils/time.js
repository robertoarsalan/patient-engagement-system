const TIMEZONE = 'Europe/Istanbul';

// Format date to YYYY-MM-DD HH:mm:ss (24h)
function formatDate(date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
    .format(date)
    .replace(',', '')
    .replace(/\//g, '-');
}

// Add minutes to current time
function addMinutes(minutes) {
  const now = new Date();
  return new Date(now.getTime() + minutes * 60000);
}

// Add hours to current time
function addHours(hours) {
  return addMinutes(hours * 60);
}

module.exports = {
  formatDate,
  addMinutes,
  addHours
};