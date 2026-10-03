"use strict";

function feedback(status, now = Date.now()) {
  const unavailable = { heading: "Export controller unavailable", detail: "Export settings unconfirmed—checking connection." };
  if (!status || !Number.isFinite(status.updatedAt) || now < status.updatedAt || now - status.updatedAt > 180000) return unavailable;
  if (!status.enabled) return { heading: "Automatic export paused", detail: "Current export settings are unchanged." };
  if (!status.confirmed) return unavailable;
  const high = Number.isFinite(status.forecastKwh) && status.forecastKwh > status.thresholdKwh;
  const low = Number.isFinite(status.forecastKwh) && !high;
  const heading = high || low ? `Tomorrow: ${high ? "High" : "Low"} solar forecast (${Math.round(status.forecastKwh)}kWh)` : "Tomorrow: Solar forecast unavailable";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: status.timezone,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(now)).map(p => [p.type, p.value]));
  const tomorrow = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day + 1)).toISOString().slice(0, 10);
  if (status.forecastDate !== tomorrow) return unavailable;
  const minute = +parts.hour * 60 + +parts.minute;
  const start = status.startPercent, stop = status.stopPercent;
  let detail;
  if (minute < 1020) detail = low ? `5–9PM: solar export only, above ${start}% charge.` :
    `5–9PM: battery export starts above ${start}%, stops at ${stop}%.`;
  else if (minute >= 1260) detail = "Solar export only—premium window ended.";
  else if (status.policy === "battery_ok") detail = `Battery export enabled until ${stop}% charge or 9PM.`;
  else if (low && status.policy === "pv_only") detail = "Solar export only—battery energy retained.";
  else if (low) detail = `All export paused—low forecast and charge at or below ${start}%.`;
  else if (status.soc <= stop) detail = `Export paused at ${stop}%—restart requires above ${start}%.`;
  else detail = `Export paused—waiting for charge above ${start}%.`;
  return { heading, detail };
}
module.exports = { feedback };
