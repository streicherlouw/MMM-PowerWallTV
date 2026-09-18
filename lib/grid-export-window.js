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
const validCounter = value => typeof value === "number" && Number.isFinite(value) && value >= 0;

// A site (grid) export accumulator includes solar AND battery export. Import
// energy and solar production must never be substituted for this counter.
function sample(state, counter, at, options, timeZone) {
  const local = clock(at, timeZone), start = seconds(options.start), end = seconds(options.end);
  const signature = `${options.start}|${options.end}|${timeZone}`;
  const previous = state && state.signature === signature ? state.sample : null;
  if (!state || state.signature !== signature || state.date !== local.date) {
    state = { signature, date: local.date, totalWh: 0, partial: local.seconds > start && !previous,
      estimated: false, sample: previous, available: false };
  }
  if (!validCounter(counter)) return { state, reading: null };
  const current = { at, counter, date: local.date, seconds: local.seconds };
  const prior = state.sample;
  if (prior && at > prior.at) {
    const dayOffset = (Date.parse(prior.date) - Date.parse(local.date)) / 86400000;
    const from = prior.seconds + dayOffset * 86400, to = local.seconds;
    const overlap = Math.max(0, Math.min(to, end) - Math.max(from, start));
    const delta = counter - prior.counter;
    if (overlap > 0) {
      if (delta < 0 || to <= from) state.partial = true;
      else if (from >= start && to <= end) state.totalWh += delta;
      else if (at - prior.at <= 300000 && Math.abs((to - from) * 1000 - (at - prior.at)) < 2000) {
        // Sampling rarely hits a tariff boundary exactly. Interpolate only
        // across short intervals; long boundary outages cannot be attributed.
        state.totalWh += delta * overlap / (to - from);
        if (delta > 0) state.estimated = true;
      } else state.partial = true;
    } else if (to < from && to >= start && to < end) state.partial = true; // clock moved back / DST
  } else if (!prior && local.seconds > start) state.partial = true;
  // Ignore duplicate or out-of-order samples instead of moving the anchor back.
  if (!prior || at > prior.at) state.sample = current;
  state.available = true;
  return { state, reading: { energyWh: state.totalWh, partial: state.partial,
    estimated: state.estimated, date: state.date, start: options.start, end: options.end } };
}

function update(site, aggregates, options, now, timeZone) {
  const signature = `${options.start}|${options.end}|${timeZone}`;
  let state = site.gridExportWindow;
  if (!state || state.signature !== signature) {
    state = null;
    // Existing hourly history can recover known interior deltas on upgrade.
    // It cannot recover a missing boundary precisely: sample() marks that partial.
    const history = (site.readings || []).filter(r => r && Date.parse(r.observedAt) < now.getTime())
      .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
    for (const row of history) {
      const counter = row.aggregates && row.aggregates.site && row.aggregates.site.energy_exported;
      state = sample(state, counter, Date.parse(row.observedAt), options, timeZone).state;
    }
  }
  const counter = aggregates && aggregates.site && aggregates.site.energy_exported;
  const result = sample(state, counter, now.getTime(), options, timeZone);
  site.gridExportWindow = result.state;
  return result.reading;
}

module.exports = { normalize, sample, update };
