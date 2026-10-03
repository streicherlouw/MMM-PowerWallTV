"use strict";
const { localClock } = require("./export-prediction");

function feedback(status, now = Date.now(), prediction) {
  const message = (heading, detail = "") => ({ heading, detail });
  if (!status || !Number.isFinite(status.updatedAt) || now < status.updatedAt ||
      now - status.updatedAt > 180000) return message("EXPORT STATUS UNKNOWN");
  if (!status.enabled) return message("EXPORT CONTROL OFF");
  if (!status.confirmed) return message("EXPORT STATUS UNKNOWN");
  if (!status.timezone) return message("EXPORT STATUS UNKNOWN");
  let clock;
  try { clock = localClock(now, status.timezone); } catch { return message("EXPORT STATUS UNKNOWN"); }
  if (clock.minute >= 1260) return message("BATTERY EXPORT BLOCKED", "Today's export window has ended");
  if (!Number.isFinite(status.forecastKwh) || !Number.isFinite(status.thresholdKwh) ||
      status.forecastDate !== clock.tomorrow) return message("CHARGE LIMITS APPLY", "Tomorrow's solar forecast unavailable");
  if (status.forecastKwh <= status.thresholdKwh) return message("BATTERY EXPORT BLOCKED", "Low solar forecast for tomorrow");
  if (!Number.isFinite(status.startPercent) || !Number.isFinite(status.stopPercent)) return message("EXPORT STATUS UNKNOWN");
  if (clock.minute >= 1020) {
    if (!Number.isFinite(status.soc) || status.soc < 0 || status.soc > 100) return message("EXPORT STATUS UNKNOWN");
    const eligible = status.soc > status.startPercent ||
      (status.active === true && status.policy === "battery_ok" && status.soc > status.stopPercent);
    return message(eligible ? "BATTERY EXPORT PLANNED" : "BATTERY EXPORT BLOCKED",
      eligible ? "High forecast; charge condition met during the export window" : `Waiting for charge above ${status.startPercent}%`);
  }
  if (!prediction?.available) return message("EXPORT STATUS UNKNOWN", prediction?.reason || "5PM charge prediction unavailable");
  const eligible = prediction.projectedPercent > status.startPercent;
  return message(eligible ? "BATTERY EXPORT PLANNED" : "BATTERY EXPORT BLOCKED",
    `Estimated ${prediction.projectedPercent.toFixed(1)}% at 5PM; requires above ${status.startPercent}%. ` +
    `${prediction.solarKwh.toFixed(1)}kWh solar and ${prediction.loadKwh.toFixed(1)}kWh home use remaining to 5PM; ` +
    `assuming current ${prediction.homeLoadKw.toFixed(2)}kW home load continues.`);
}
module.exports = { feedback };
