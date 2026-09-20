"use strict";

function normalize(options = {}) {
  const config = Object.assign({ show: true, start: "17:00", end: "21:00" }, options);
  const minutes = value => typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
    ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : NaN;
  const start = minutes(config.start), end = config.end === "24:00" ? 1440 : minutes(config.end);
  if (typeof config.show !== "boolean" || !Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error("GridExportWindow requires show: true/false and same-day HH:mm start < end (end may be 24:00).");
  }
  return { show: config.show, start: config.start, end: config.end };
}

function clock(at, timeZone) {
  const parts = {};
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(at)).forEach(p => { parts[p.type] = p.value; });
  return { date: `${parts.year}-${parts.month}-${parts.day}`,
    seconds: Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second) };
}
const seconds = value => Number(value.slice(0, 2)) * 3600 + Number(value.slice(3)) * 60;
// Reject meter discontinuities beyond a generous residential 100 kW envelope.
// The 1 kWh tolerance accommodates quantization and non-simultaneous samples.
const plausibleDelta = (a, b) => b.at > a.at && b.counter >= a.counter &&
  b.counter - a.counter <= 1000 + 100000 * (b.at - a.at) / 3600000;
const validCounter = value => typeof value === "number" && Number.isFinite(value) && value >= 0;

// A site (grid) export accumulator includes solar AND battery export. Import
// energy and solar production must never be substituted for this counter.
function batteryFraction(aggregates) {
  const solar = aggregates && aggregates.solar && aggregates.solar.instant_power;
  const battery = aggregates && aggregates.battery && aggregates.battery.instant_power;
  const grid = aggregates && aggregates.site && aggregates.site.instant_power;
  if (![solar, battery, grid].every(v => typeof v === "number" && Number.isFinite(v))) return null;
  if (grid >= 0) return 0;
  const discharge = Math.max(0, battery), generation = Math.max(0, solar);
  if (discharge + generation === 0) return null;
  // An allocation estimate: solar and discharging batteries supply the home
  // and grid in the same proportions. The meter cannot identify energy origin.
  return discharge / (discharge + generation);
}

function sample(state, counter, at, options, timeZone, aggregates) {
  const local = clock(at, timeZone), start = seconds(options.start), end = seconds(options.end);
  const signature = `${options.start}|${options.end}|${timeZone}`;
  const previous = state && state.signature === signature ? state.sample : null;
  if (!state || state.signature !== signature || state.date !== local.date) {
    state = { signature, date: local.date, totalWh: 0, partial: local.seconds > start && !previous,
      estimated: false, batteryExportWh: 0, attributedExportWh: 0, sample: previous, available: false };
  }
  if (!validCounter(counter)) return { state, reading: null };
  // Existing saved totals have no attribution. Keep their denominator so an
  // upgrade never reports a later sample's share as the whole window's share.
  state.batteryExportWh = state.batteryExportWh || 0;
  state.attributedExportWh = state.attributedExportWh || 0;
  const initialTotalWh = state.totalWh;
  const current = { at, counter, date: local.date, seconds: local.seconds,
    batteryFraction: batteryFraction(aggregates) };
  let prior = state.sample;
  let rejected = false;
  if (prior && at > prior.at) {
    if (plausibleDelta(prior, current)) {
      delete state.pendingCounter;
    } else {
      state.partial = true;
      // A transient zero/drop must never replace the good lifetime anchor.
      // If two successive samples support a new counter epoch, rebase there
      // and count only their plausible delta, never the discontinuity itself.
      const pending = state.pendingCounter;
      if (pending && plausibleDelta(pending, current)) {
        prior = pending;
        delete state.pendingCounter;
      } else {
        state.pendingCounter = current;
        rejected = true;
      }
    }
  }
  if (!rejected && prior && at > prior.at) {
    const dayOffset = (Date.parse(prior.date) - Date.parse(local.date)) / 86400000;
    const from = prior.seconds + dayOffset * 86400, to = local.seconds;
    const overlap = Math.max(0, Math.min(to, end) - Math.max(from, start));
    const delta = counter - prior.counter;
    if (start === 0 && end === 86400 && prior.date === local.date) {
      // All same-day export belongs to the daily total, including across a
      // repeated DST hour or a long outage inside the day.
      if (delta < 0) state.partial = true;
      else state.totalWh += delta;
    } else if (start === 0 && end === 86400 && from >= -300 && from < 0 && delta >= 0 && at - prior.at > 300000) {
      // Hourly history keeps the final sample of each hour. A reading within
      // five minutes before midnight is a useful approximate daily baseline.
      state.totalWh += delta;
      if (delta > 0) state.estimated = true;
    } else if (overlap > 0) {
      if (delta < 0 || to <= from) state.partial = true;
      else if (from >= start && to <= end) state.totalWh += delta;
      else if (at - prior.at <= 300000 && Math.abs((to - from) * 1000 - (at - prior.at)) < 2000) {
        // Sampling rarely hits a tariff boundary exactly. Interpolate only
        // across short intervals; long boundary outages cannot be attributed.
        state.totalWh += delta * overlap / (to - from);
        if (delta > 0) state.estimated = true;
      } else state.partial = true;
    } else if (to < from && to >= start && to < end) state.partial = true; // clock moved back / DST
    const addedWh = state.totalWh - initialTotalWh;
    if (addedWh > 0 && at - prior.at <= 300000 && to > from &&
        Number.isFinite(prior.batteryFraction) && Number.isFinite(current.batteryFraction)) {
      // Weight energy, not percentages: short clipped boundary intervals use
      // the average of linearly interpolated endpoint supply fractions.
      const left = Math.max(0, Math.min(1, (Math.max(from, start) - from) / (to - from)));
      const right = Math.max(0, Math.min(1, (Math.min(to, end) - from) / (to - from)));
      const slope = current.batteryFraction - prior.batteryFraction;
      const fraction = prior.batteryFraction + slope * (left + right) / 2;
      state.batteryExportWh += addedWh * Math.max(0, Math.min(1, fraction));
      state.attributedExportWh += addedWh;
    }
  } else if (!prior && local.seconds > start) state.partial = true;
  // Ignore duplicate or out-of-order samples instead of moving the anchor back.
  if (!rejected && (!prior || at > prior.at)) state.sample = current;
  state.available = true;
  const attributionComplete = state.totalWh > 0 && Math.abs(state.totalWh - state.attributedExportWh) < 0.001;
  return { state, reading: { energyWh: state.totalWh, partial: state.partial,
    batteryPercent: attributionComplete ? Math.max(0, Math.min(100, state.batteryExportWh / state.totalWh * 100)) : null,
    batterySharePartial: state.partial || state.totalWh - state.attributedExportWh >= 0.001,
    estimated: state.estimated, date: state.date, start: options.start, end: options.end } };
}

function update(site, aggregates, options, now, timeZone, stateKey = "gridExportWindow") {
  const signature = `${options.start}|${options.end}|${timeZone}`;
  let state = site[stateKey];
  if (!state || state.signature !== signature || state.counterGuardVersion !== 1) {
    state = null;
    // Existing hourly history can recover known interior deltas on upgrade.
    // It cannot recover a missing boundary precisely: sample() marks that partial.
    const history = (site.readings || []).filter(r => r && Date.parse(r.observedAt) < now.getTime())
      .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
    for (const row of history) {
      const counter = row.aggregates && row.aggregates.site && row.aggregates.site.energy_exported;
      state = sample(state, counter, Date.parse(row.observedAt), options, timeZone, row.aggregates).state;
    }
  }
  const counter = aggregates && aggregates.site && aggregates.site.energy_exported;
  const result = sample(state, counter, now.getTime(), options, timeZone, aggregates);
  result.state.counterGuardVersion = 1;
  site[stateKey] = result.state;
  return result.reading;
}

module.exports = { normalize, sample, update };
