"use strict";

function feedback(status, now = Date.now()) {
  const message = heading => ({ heading, detail: "" });
  if (!status || !Number.isFinite(status.updatedAt) || now < status.updatedAt ||
      now - status.updatedAt > 180000 || !status.confirmed) {
    return message("EXPORT STATUS UNKNOWN");
  }
  // Describe the confirmed setting, independent of forecast or controller scheduling.
  if (status.policy === "battery_ok") return message("BATTERY EXPORT ENABLED");
  if (["pv_only", "never"].includes(status.policy)) return message("NO BATTERY EXPORT");
  return message("EXPORT STATUS UNKNOWN");
}
module.exports = { feedback };
