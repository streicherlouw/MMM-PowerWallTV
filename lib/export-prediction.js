"use strict";

const DEFAULTS = {
  forecastCachePath: "~/.cache/MMM-SolarIrradianceForecast/forecast-cache.json",
  forecastInstanceId: "",
  maxAgeMinutes: 120,
  chargeEfficiency: 0.90,
  dischargeEfficiency: 0.95,
  capacityKwh: null,
  maxChargeKw: null
};

function localClock(now, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(now)).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`,
    tomorrow: new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day + 1)).toISOString().slice(0, 10),
    minute: +parts.hour * 60 + +parts.minute + +parts.second / 60 };
}

function predictCharge(status, snapshot, cache, options = {}, now = Date.now()) {
  const unknown = reason => ({ available: false, reason });
  const c = { ...DEFAULTS, ...options };
  if (!status?.timezone) return unknown("Controller timezone unavailable");
  let clock;
  try { clock = localClock(now, status.timezone); } catch { return unknown("Invalid controller timezone"); }
  if (clock.minute >= 1020) return unknown("The 5PM target has passed");
  // Use the controller's SOC so this prediction and its strict start threshold share a scale.
  const soc = status.soc;
  const count = snapshot?.batteryCount;
  const capacity = c.capacityKwh ?? (count * 13.5);
  const maxCharge = c.maxChargeKw ?? (count * 5);
  const load = ["v1r", "tedapi"].includes(snapshot?.source)
    ? snapshot.predictionHomePowerWatts : snapshot?.homePower;
  if (!Number.isFinite(soc) || soc < 0 || soc > 100 || !Number.isFinite(load) || load < 0 ||
      !Number.isFinite(capacity) || capacity <= 0 || !Number.isFinite(maxCharge) || maxCharge <= 0) {
    return unknown("Battery capacity, charge or home load unavailable");
  }
  if (![c.chargeEfficiency, c.dischargeEfficiency].every(x => Number.isFinite(x) && x > 0 && x <= 1) ||
      !Number.isFinite(c.maxAgeMinutes) || c.maxAgeMinutes <= 0) return unknown("Invalid prediction settings");
  const entries = c.forecastInstanceId ? [cache?.instances?.[c.forecastInstanceId]] : Object.values(cache?.instances || {});
  const matches = entries.filter(e => e?.forecast?.timezone === status.timezone &&
    e.forecast.days?.some(d => d.date === clock.date));
  if (matches.length !== 1) return unknown("Today's forecast is missing or ambiguous");
  const forecast = matches[0].forecast;
  const fetched = Date.parse(forecast.updatedAt);
  if (!Number.isFinite(fetched) || now < fetched || now - fetched > c.maxAgeMinutes * 60000) {
    return unknown("Today's solar forecast is stale");
  }
  const day = forecast.days.find(d => d.date === clock.date);
  if (!Array.isArray(day.hours)) return unknown("Hourly solar forecast unavailable");
  const hours = day.hours.filter(h => h && Number.isFinite(h.minuteOfDay) &&
    h.minuteOfDay < 1020 && h.minuteOfDay + 60 > clock.minute).sort((a,b) => a.minuteOfDay - b.minuteOfDay);
  let cursor = clock.minute, stored = capacity * soc / 100, solarKwh = 0, loadKwh = 0;
  for (const h of hours) {
    const start = Math.max(h.minuteOfDay, clock.minute), end = Math.min(h.minuteOfDay + 60, 1020);
    if (Math.abs(start - cursor) > 0.00001 || !Number.isFinite(h.generationKwh) || h.generationKwh < 0 ||
        !String(h.time || "").startsWith(clock.date + "T")) return unknown("Hourly forecast has gaps or invalid values");
    const duration = (end - start) / 60;
    // The shared forecast model labels the START of each one-hour generation interval.
    const solar = h.generationKwh * duration, demand = load / 1000 * duration;
    const net = solar - demand;
    stored += net >= 0 ? Math.min(net, maxCharge * duration) * c.chargeEfficiency : net / c.dischargeEfficiency;
    stored = Math.max(0, Math.min(capacity, stored));
    solarKwh += solar; loadKwh += demand; cursor = end;
  }
  if (Math.abs(cursor - 1020) > 0.00001) return unknown("Hourly forecast does not cover the time to 5PM");
  return { available: true, projectedPercent: stored / capacity * 100, currentPercent: soc,
    solarKwh, loadKwh, homeLoadKw: load / 1000, capacityKwh: capacity, maxChargeKw: maxCharge,
    chargeEfficiency: c.chargeEfficiency, dischargeEfficiency: c.dischargeEfficiency,
    target: "17:00", date: clock.date, forecastUpdatedAt: forecast.updatedAt };
}

module.exports = { DEFAULTS, localClock, predictCharge };
