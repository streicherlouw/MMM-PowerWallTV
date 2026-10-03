"use strict";

function feedback(status, now = Date.now()) {
  const message = heading => ({ heading, detail: "" });
  const unavailable = message("Powerwall unavailable · Export status unconfirmed");
  if (!status || !Number.isFinite(status.updatedAt) || now < status.updatedAt || now - status.updatedAt > 180000) return unavailable;
  if (!status.enabled) return message("Automatic export control off");
  if (!status.confirmed) return unavailable;
  const high = Number.isFinite(status.forecastKwh) && status.forecastKwh > status.thresholdKwh;
  const low = Number.isFinite(status.forecastKwh) && !high;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: status.timezone,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(now)).map(p => [p.type, p.value]));
  const tomorrow = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day + 1)).toISOString().slice(0, 10);
  if (status.forecastDate !== tomorrow) return unavailable;
  const minute = +parts.hour * 60 + +parts.minute;
  const start = status.startPercent, stop = status.stopPercent;
  // Do not turn a contradictory confirmed policy into a reassuring disabled message.
  if (status.policy === "battery_ok" && (low || minute < 1020 || minute >= 1260)) return unavailable;
  if (minute >= 1260) return message("Export window ended · Battery export disabled");
  if (!high && !low) return message("Solar forecast unavailable · Using charge limits");
  if (low) return message("Low solar forecast · Battery export disabled");
  if (minute < 1020) return message("High solar forecast · Battery export planned");
  if (status.policy === "battery_ok") return message("High solar forecast · Battery export enabled");
  if (status.soc <= stop) return message(`Battery export paused · Waiting for charge above ${start}%`);
  return message(`High solar forecast · Waiting for charge above ${start}%`);
}
module.exports = { feedback };
