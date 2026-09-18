const assert = require("node:assert/strict");
const test = require("node:test");
const { normalize, sample, update } = require("../lib/grid-export-window");
const zone = "Australia/Melbourne", settings = normalize();
function tracker(options = settings) {
  let state;
  return (counter, date) => {
    const result = sample(state, counter, Date.parse(date), options, zone);
    state = JSON.parse(JSON.stringify(result.state)); // round-trip persisted state on each sample
    return result.reading;
  };
}
// September: Melbourne is UTC+10. Tests use explicit local offsets.
test("only exports within 17:00–21:00 count; total freezes then resets at local midnight", () => {
  const read = tracker();
  assert.equal(read(100000, "2026-09-18T16:00:00+10:00").energyWh, 0);
  assert.equal(read(101000, "2026-09-18T17:00:00+10:00").energyWh, 0);
  assert.equal(read(103000, "2026-09-18T18:00:00+10:00").energyWh, 2000);
  assert.equal(read(109000, "2026-09-18T21:00:00+10:00").energyWh, 8000);
  assert.equal(read(111000, "2026-09-18T22:00:00+10:00").energyWh, 8000);
  const next = read(112000, "2026-09-19T00:00:00+10:00");
  assert.equal(next.energyWh, 0);
  assert.equal(next.partial, false);
});
test("short intervals crossing boundaries are prorated and labelled estimates", () => {
  const read = tracker();
  read(1000, "2026-09-18T16:59:50+10:00");
  let result = read(1020, "2026-09-18T17:00:10+10:00");
  assert.equal(result.energyWh, 10);
  assert.equal(result.estimated, true);
  assert.equal(result.partial, false);
  read(2000, "2026-09-18T20:59:50+10:00");
  result = read(2020, "2026-09-18T21:00:10+10:00");
  assert.equal(result.energyWh, 1000);
});
test("long boundary outages are excluded, while interior meter deltas survive gaps", () => {
  const read = tracker();
  read(1000, "2026-09-18T16:00:00+10:00");
  const start = read(5000, "2026-09-18T18:00:00+10:00");
  assert.equal(start.energyWh, 0);
  assert.equal(start.partial, true);
  assert.equal(read(8000, "2026-09-18T20:00:00+10:00").energyWh, 3000);
  assert.equal(read(10000, "2026-09-18T22:00:00+10:00").energyWh, 3000);
});
test("first observation mid-window or after it is partial, never a lifetime total", () => {
  for (const hour of [18, 22]) {
    const result = tracker()(4600000, `2026-09-18T${hour}:00:00+10:00`);
    assert.equal(result.energyWh, 0);
    assert.equal(result.partial, true);
  }
});
test("invalid counter is unavailable, zero is valid, imports and solar are never counted", () => {
  const site = {}, now = new Date("2026-09-18T17:00:00+10:00");
  assert.equal(update(site, { solar: { energy_exported: 90000 }, site: { energy_imported: 20000 } }, settings, now, zone), null);
  const result = update(site, { site: { energy_exported: 0 } }, settings, now, zone);
  assert.equal(result.energyWh, 0);
  for (const value of [null, undefined, "100", true, NaN, Infinity, -1]) {
    assert.equal(update(site, { site: { energy_exported: value } }, settings, now, zone), null);
  }
});
test("missing samples can recover interior cumulative deltas; resets preserve known totals", () => {
  const read = tracker();
  read(1000, "2026-09-18T17:00:00+10:00");
  read(1500, "2026-09-18T18:00:00+10:00");
  assert.equal(read(null, "2026-09-18T18:15:00+10:00"), null);
  assert.equal(read(2000, "2026-09-18T18:30:00+10:00").energyWh, 1000);
  const reset = read(0, "2026-09-18T19:00:00+10:00");
  assert.equal(reset.energyWh, 1000);
  assert.equal(reset.partial, true);
  assert.equal(read(300, "2026-09-18T20:00:00+10:00").energyWh, 1300);
});
test("custom minute boundaries use local daylight saving time", () => {
  const read = tracker(normalize({ start: "16:30", end: "20:15", show: false }));
  read(100, "2026-10-05T16:30:00+11:00");
  const result = read(1100, "2026-10-05T20:15:00+11:00");
  assert.equal(result.energyWh, 1000);
  assert.equal(result.partial, false);
  assert.equal(result.date, "2026-10-05");
});
test("history seeds meter deltas, and changing windows does not reuse old totals", () => {
  const site = { readings: [17, 18, 19, 20, 21].map((hour, i) => ({
    observedAt: `2026-09-18T${hour}:00:00+10:00`, aggregates: { site: { energy_exported: 1000 + i * 1000 } }
  })) };
  const now = new Date("2026-09-18T22:00:00+10:00");
  assert.equal(update(site, { site: { energy_exported: 5500 } }, settings, now, zone).energyWh, 4000);
  const changed = update(site, { site: { energy_exported: 5500 } }, normalize({ start: "18:00", end: "20:00" }), now, zone);
  assert.equal(changed.energyWh, 2000);
  assert.equal(changed.partial, false);
});
test("duplicate and out-of-order samples cannot double-count exports", () => {
  const read = tracker();
  read(1000, "2026-09-18T17:00:00+10:00");
  read(2000, "2026-09-18T18:00:00+10:00");
  read(1500, "2026-09-18T17:30:00+10:00");
  assert.equal(read(2000, "2026-09-18T18:00:00+10:00").energyWh, 1000);
  assert.equal(read(3000, "2026-09-18T19:00:00+10:00").energyWh, 2000);
});
test("invalid and overnight windows are rejected with a useful config error", () => {
  for (const options of [{ start: "5PM" }, { end: "25:00" }, { start: "21:00", end: "17:00" },
    { start: "17:00", end: "17:00" }, { show: "false" }, { end: "21:60" }]) {
    assert.throws(() => normalize(options), /GridExportWindow/);
  }
  assert.equal(normalize({ end: "24:00" }).end, "24:00");
});

test("daily export includes daytime and evening exports independently of the tariff window", () => {
  const site = {}, daily = { start: "00:00", end: "24:00" };
  function read(counter, at) {
    const aggregates = { site: { energy_exported: counter, energy_imported: 999999 }, solar: { energy_exported: 999999 } };
    const now = new Date(at);
    const today = update(site, aggregates, daily, now, zone, "gridExportToday");
    const window = update(site, aggregates, settings, now, zone);
    return { today, window };
  }
  read(10000, "2026-09-18T00:00:00+10:00");
  let result = read(15000, "2026-09-18T17:00:00+10:00");
  assert.equal(result.today.energyWh, 5000);
  assert.equal(result.window.energyWh, 0);
  result = read(18000, "2026-09-18T21:00:00+10:00");
  assert.equal(result.today.energyWh, 8000);
  assert.equal(result.window.energyWh, 3000);
  result = read(19000, "2026-09-18T23:00:00+10:00");
  assert.equal(result.today.energyWh, 9000);
  assert.equal(result.today.partial, false);
  assert.equal(result.window.energyWh, 3000);
});

test("daily total recovers hourly history near midnight and survives a restart", () => {
  let site = { readings: [
    { observedAt: "2026-09-17T23:59:50+10:00", aggregates: { site: { energy_exported: 1000 } } },
    { observedAt: "2026-09-18T00:59:50+10:00", aggregates: { site: { energy_exported: 1200 } } },
    { observedAt: "2026-09-18T14:59:50+10:00", aggregates: { site: { energy_exported: 11000 } } }
  ] };
  const daily = { start: "00:00", end: "24:00" };
  const first = update(site, { site: { energy_exported: 12000 } }, daily, new Date("2026-09-18T15:00:00+10:00"), zone, "gridExportToday");
  assert.equal(first.energyWh, 11000);
  assert.equal(first.partial, false);
  assert.equal(first.estimated, true);
  site = JSON.parse(JSON.stringify(site));
  const next = update(site, { site: { energy_exported: 13000 } }, daily, new Date("2026-09-18T16:00:00+10:00"), zone, "gridExportToday");
  assert.equal(next.energyWh, 12000);
});

test("daily reset interpolates midnight, and missing baselines remain explicitly partial", () => {
  const read = tracker({ start: "00:00", end: "24:00" });
  assert.equal(read(1000, "2026-09-18T12:00:00+10:00").partial, true);
  assert.equal(read(2000, "2026-09-18T23:59:50+10:00").energyWh, 1000);
  const next = read(2020, "2026-09-19T00:00:10+10:00");
  assert.equal(next.energyWh, 10);
  assert.equal(next.partial, false);
  assert.equal(next.estimated, true);
});

test("daily export includes energy during the repeated daylight-saving hour", () => {
  const read = tracker({ start: "00:00", end: "24:00" });
  read(1000, "2026-04-05T00:00:00+11:00");
  read(2000, "2026-04-05T02:59:00+11:00");
  const result = read(2500, "2026-04-05T02:01:00+10:00");
  assert.equal(result.energyWh, 1500);
  assert.equal(result.partial, false);
});

function attributedTracker() {
  let site = {};
  return (counter, at, solar, battery, grid = -1000) => {
    const result = update(site, { site: { energy_exported: counter, instant_power: grid },
      solar: { instant_power: solar }, battery: { instant_power: battery } }, settings, new Date(at), zone);
    site = JSON.parse(JSON.stringify(site));
    return result;
  };
}

test("battery share estimates solar-only, battery-only, mixed and charging exports", () => {
  for (const [solar, battery, expected] of [[4000, 0, 0], [0, 4000, 100], [3000, 1000, 25], [4000, -1000, 0]]) {
    const read = attributedTracker();
    assert.equal(read(1000, "2026-09-18T17:00:00+10:00", solar, battery).batteryPercent, null);
    const result = read(1100, "2026-09-18T17:01:00+10:00", solar, battery);
    assert.equal(result.batteryPercent, expected);
    assert.equal(result.batterySharePartial, false);
  }
});

test("battery percentage weights exported energy and survives persisted state", () => {
  const read = attributedTracker();
  read(1000, "2026-09-18T17:00:00+10:00", 1000, 0);
  read(1100, "2026-09-18T17:01:00+10:00", 1000, 0); // 100 Wh solar
  read(1100, "2026-09-18T17:02:00+10:00", 0, 1000); // zero-energy transition
  const result = read(1400, "2026-09-18T17:03:00+10:00", 0, 1000); // 300 Wh battery
  assert.equal(result.energyWh, 400);
  assert.equal(result.batteryPercent, 75);
});

test("battery share clips at window boundaries and freezes after the window", () => {
  const read = attributedTracker();
  read(1000, "2026-09-18T16:59:50+10:00", 1000, 0);
  const first = read(1020, "2026-09-18T17:00:10+10:00", 0, 1000);
  assert.equal(first.energyWh, 10);
  assert.equal(first.batteryPercent, 75); // fraction rises 50% -> 100% inside window
  read(1020, "2026-09-18T20:59:50+10:00", 0, 1000);
  const last = read(1040, "2026-09-18T21:00:10+10:00", 0, 1000);
  assert.equal(last.energyWh, 20);
  assert.equal(last.batteryPercent, 87.5);
  assert.equal(read(1200, "2026-09-18T22:00:00+10:00", 1000, 0).batteryPercent, 87.5);
  assert.equal(read(1200, "2026-09-19T00:00:00+10:00", 0, 1000).batteryPercent, null);
});

test("missing flows or long gaps keep exports but do not fabricate battery attribution", () => {
  for (const [minutes, solar] of [[1, undefined], [10, 0]]) {
    const read = attributedTracker();
    read(1000, "2026-09-18T17:00:00+10:00", 0, 1000);
    const result = read(1100, `2026-09-18T17:${String(minutes).padStart(2, "0")}:00+10:00`, solar, 1000);
    assert.equal(result.energyWh, 100);
    assert.equal(result.batteryPercent, null);
    assert.equal(result.batterySharePartial, true);
  }
});

test("upgrading existing totals cannot claim that later battery share covers the whole window", () => {
  const site = { gridExportWindow: {
    signature: "17:00|21:00|Australia/Melbourne", date: "2026-09-18", totalWh: 500,
    partial: false, estimated: false, sample: { at: Date.parse("2026-09-18T18:00:00+10:00"),
      counter: 1500, date: "2026-09-18", seconds: 64800 }
  } };
  const result = update(site, { site: { energy_exported: 1600, instant_power: -1000 },
    solar: { instant_power: 0 }, battery: { instant_power: 1000 } }, settings,
    new Date("2026-09-18T18:01:00+10:00"), zone);
  assert.equal(result.energyWh, 600);
  assert.equal(result.batteryPercent, null);
  assert.equal(result.batterySharePartial, true);
});
