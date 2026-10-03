"use strict";

function feedback(status, now = Date.now()) {
  const message = heading => ({ heading, detail: "" });
  if (!status || !Number.isFinite(status.updatedAt) || now < status.updatedAt ||
      now - status.updatedAt > 180000 || !status.confirmed) return message("EXPORT STATUS UNKNOWN");
  if (!status.enabled) return message("EXPORT CONTROL OFF");
  // Describe the forecast-driven plan, not the current export permission.
  if (!Number.isFinite(status.forecastKwh) || !Number.isFinite(status.thresholdKwh)) {
    return message("CHARGE LIMITS APPLY");
  }
  return message(status.forecastKwh > status.thresholdKwh ? "BATTERY EXPORT PLANNED" : "BATTERY EXPORT BLOCKED");
}
module.exports = { feedback };
