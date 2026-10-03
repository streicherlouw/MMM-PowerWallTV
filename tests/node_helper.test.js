const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const directory = path.resolve(__dirname, "..");
function helper(now) {
  const sandbox = {
    require: (name) => name === "node_helper" ? { create: (definition) => definition } : require(name.startsWith("./") ? path.join(directory, name) : name),
    Date: now === undefined ? Date : class extends Date { static now() { return now; } },
    module: { exports: {} }, __dirname: directory, process, Buffer, setTimeout, clearTimeout, console
  };
  vm.runInNewContext(fs.readFileSync(path.join(directory, "node_helper.js"), "utf8"), sandbox);
  const result = sandbox.module.exports;
  result.start();
  return result;
}

test("option 5 uses Python v1r flags, private paths and the existing display shape", async () => {
  const h = helper();
  let invocation;
  h.execJsonFile = async (python, args, options) => {
    invocation = { python, args: Array.from(args), options };
    return { solarPower: 5000, homePower: 600, gridPower: -4300, batteryPower: -100,
      batteryPercentage: 100, batteryCount: 2, gridStatus: "UP", solarStrings: { A: { Power: 1000 } },
      aggregateMeters: { solar: { energy_exported: 12345 } }, raw: { tedapiMode: "v1r" } };
  };
  h.updateTedapiAggregateHistory = () => ({ hasBaseline: true, solarEnergyTodayWh: 2345,
    solarEnergyCumulativeWh: 12345, solarEnergySource: "meter" });
  const snapshot = await h.fetchSnapshot("test", { mode: "v1r", tedapi: {
    gatewayIP: "10.0.0.98", rsaKeyPath: ".auth/key.pem", gatewayPasswordFile: ".auth/password",
    gatewayPassword: "test-secret", python: "/custom/python", siteName: "Home"
  } });
  assert.equal(invocation.args[invocation.args.indexOf("--transport") + 1], "v1r");
  assert.ok(invocation.args.includes(path.join(directory, ".auth/key.pem")));
  assert.ok(invocation.args.includes(path.join(directory, ".auth/password")));
  assert.ok(!invocation.args.includes("test-secret"));
  assert.equal(invocation.options.env.PWTV_TEDAPI_GATEWAY_PASSWORD, "test-secret");
  assert.equal(snapshot.source, "v1r");
  assert.equal(snapshot.solarEnergyExportedWh, 2345);
  assert.equal(snapshot.solarEnergyToday, true);
  assert.equal(snapshot.gridStatus, "SystemGridConnected");
  assert.equal(snapshot.solarStrings.A.Power, 1000);
  assert.equal(snapshot.batteryCount, 2);
  assert.ok(!JSON.stringify(snapshot).includes("test-secret"));
});

test("explicit v1r requires a key before spawning Python", async () => {
  const h = helper();
  h.execJsonFile = () => assert.fail("must not launch");
  await assert.rejects(h.fetchSnapshot("test", { mode: "v1r", tedapi: {
    gatewayIP: "10.0.0.98", gatewayPassword: "test-secret"
  } }), /rsaKeyPath/);
});

test("legacy TEDAPI and key-based opt-in both dispatch correctly", async () => {
  for (const rsaKeyPath of ["", ".auth/key.pem"]) {
    const h = helper();
    h.execJsonFile = async (_, args) => {
      assert.equal(args[args.indexOf("--transport") + 1], rsaKeyPath ? "v1r" : "wifi");
      return { gridStatus: "DOWN" };
    };
    const snapshot = await h.fetchSnapshot("test", { mode: "tedapi", tedapi: {
      gatewayIP: "192.168.91.1", gatewayPassword: "test-secret", rsaKeyPath
    } });
    assert.equal(snapshot.source, rsaKeyPath ? "v1r" : "tedapi");
  }
});

test("bridge errors use existing PWTV_ERROR route rather than a zero snapshot", async () => {
  const h = helper();
  h.execJsonFile = async () => { throw new Error("v1r unavailable"); };
  const response = new Promise(resolve => { h.sendSocketNotification = (name, data) => resolve({ name, data }); });
  h.socketNotificationReceived("PWTV_FETCH", { instanceId: "test", config: { mode: "v1r", tedapi: {
    gatewayIP: "10.0.0.98", gatewayPassword: "test-secret", rsaKeyPath: ".auth/key.pem"
  } } });
  const { name, data } = await response;
  assert.equal(name, "PWTV_ERROR");
  assert.equal(data.instanceId, "test");
  assert.equal(data.error, "v1r unavailable");
});

test("policy flags and status are forwarded with the snapshot", async () => {
  const h = helper();
  h.execJsonFile = async (_, args) => {
    assert.ok(args.includes("--battery-export-limit"));
    assert.equal(args[args.indexOf("--export-lower-threshold") + 1], "70");
    assert.equal(args[args.indexOf("--export-upper-threshold") + 1], "90");
    return { gridExportMode: "battery_ok", batteryExportToGridLimit: { active: true, action: "enabled", error: "" } };
  };
  const snapshot = await h.fetchSnapshot("test", { mode: "v1r", BatteryExportToGridLimit: { active: true },
    tedapi: { gatewayIP: "10.0.0.98", gatewayPassword: "test-secret", rsaKeyPath: ".auth/key.pem" } });
  assert.equal(snapshot.gridExportMode, "battery_ok");
  assert.equal(snapshot.batteryExportToGridLimit.action, "enabled");
});

test("invalid thresholds and unsupported modes fail before spawning", async () => {
  const h = helper();
  h.execJsonFile = () => assert.fail("must not launch");
  for (const limit of [{ active: true, lowerThreshold: 95 }, { active: "true" },
    { active: true, upperThreshold: Infinity }, { lowerThreshold: -1 }]) {
    await assert.rejects(h.fetchSnapshot("test", { mode: "v1r", BatteryExportToGridLimit: limit }), /BatteryExportToGridLimit/);
  }
  await assert.rejects(h.fetchSnapshot("test", { mode: "tedapi", BatteryExportToGridLimit: { active: true } }), /requires option 5/);
});

test("identical simultaneous fetches share one control cycle with separate instance IDs", async () => {
  const h = helper();
  let count = 0, complete;
  h.execJsonFile = () => { count++; return new Promise(resolve => { complete = resolve; }); };
  const config = { mode: "v1r", BatteryExportToGridLimit: { active: true },
    tedapi: { gatewayIP: "10.0.0.98", gatewayPassword: "test-secret", rsaKeyPath: ".auth/key.pem" } };
  const a = h.fetchSnapshot("one", config), b = h.fetchSnapshot("two", config);
  complete({ gridExportMode: "battery_ok" });
  const snapshots = await Promise.all([a, b]);
  assert.equal(count, 1);
  assert.equal(snapshots[0].instanceId, "one");
  assert.equal(snapshots[1].instanceId, "two");
  assert.equal(h.tedapiRequests.size, 0);
});

test("control failures retain telemetry and show an info message", async () => {
  const h = helper();
  h.execJsonFile = async () => ({ solarPower: 1234, batteryExportToGridLimit: {
    action: "error", error: "BatteryExportToGridLimit: write not confirmed" } });
  const snapshot = await h.fetchSnapshot("test", { mode: "v1r", tedapi: {
    gatewayIP: "10.0.0.98", gatewayPassword: "test-secret", rsaKeyPath: ".auth/key.pem" } });
  assert.equal(snapshot.solarPower, 1234);
  assert.match(snapshot.infoMessage, /write not confirmed/);
});

function energyHarness() {
  const h = helper();
  const config = h.normalizeConfig({ mode: "v1r", tedapi: { gatewayIP: "10.0.0.98", siteName: "Home", timezone: "Australia/Melbourne" } });
  const store = { sites: {} };
  h.loadTedapiAggregateHistoryStore = () => store;
  h.saveTedapiAggregateHistoryStore = () => {};
  const key = h.tedapiAggregateHistoryKey(config, "Australia/Melbourne");
  const site = store.sites[key] = { siteName: "Home", timeZone: "Australia/Melbourne", readings: [] };
  const read = (wh, at) => h.updateSolarMeterDay(site, store, key, wh, new Date(at),
    h.localTimeParts(new Date(at), "Australia/Melbourne"), "Australia/Melbourne");
  return { h, config, store, site, read };
}

test("midday startup stays visible, tracks meter deltas and survives restart", () => {
  const { h, site, store, config } = energyHarness();
  let result = h.updateTedapiAggregateHistory(config, { solar: { energy_exported: 4600000 } });
  assert.equal(result.hasBaseline, true);
  assert.equal(result.solarEnergyTodayWh, 0);
  const restarted = helper();
  restarted.loadTedapiAggregateHistoryStore = () => JSON.parse(JSON.stringify(store));
  restarted.saveTedapiAggregateHistoryStore = () => {};
  result = restarted.updateTedapiAggregateHistory(config, { solar: { energy_exported: 4601234 } });
  assert.equal(result.solarEnergyTodayWh, 1234);
  assert.equal(result.solarEnergySource, "meter");
  assert.equal(site.readings.length, 1);
});

test("midnight anchor is frozen even as readings advance during hour zero", () => {
  const { read } = energyHarness();
  assert.equal(read(100000, "2026-09-11T14:00:10Z").partial, false);
  assert.equal(read(100100, "2026-09-11T14:30:00Z").totalWh, 100);
  assert.equal(read(101000, "2026-09-12T03:00:00Z").totalWh, 1000);
  read(110000, "2026-09-12T13:59:50Z");
  const next = read(110001, "2026-09-12T14:00:10Z");
  assert.equal(next.localDate, "2026-09-13");
  assert.equal(next.totalWh, 1);
  assert.equal(next.partial, false);
});

test("restart after midnight uses yesterday's last near-midnight sample", () => {
  const { read, site } = energyHarness();
  read(100000, "2026-09-11T13:59:50Z");
  const next = read(120000, "2026-09-12T02:00:00Z");
  assert.equal(next.totalWh, 20000);
  assert.equal(next.partial, false);
  assert.equal(site.meterDay.baselineWh, 100000);
});

test("stale previous-day counters and zero Wi-Fi counters cannot become today's baseline", () => {
  const { read, site } = energyHarness();
  site.readings = [
    { localDate: "2026-09-10", observedAt: "2026-09-10T00:00:00Z", solarEnergyExportedWh: 90000, solarEnergySource: "meter" },
    { localDate: "2026-09-12", observedAt: "2026-09-11T14:00:00Z", solarEnergyExportedWh: 0, solarEnergySource: "integrated_power" }
  ];
  const next = read(120000, "2026-09-12T02:00:00Z");
  assert.equal(next.totalWh, 0);
  assert.equal(next.partial, true);
});

test("migration recovers stored legacy production and adds only observed v1r counter growth", () => {
  const { read, site, store } = energyHarness();
  store.sites.legacy = { gatewayIP: "192.168.91.1", siteName: "Home", timeZone: "Australia/Melbourne",
    daily: { localDate: "2026-09-12", solarEnergyTodayWh: 58000 },
    lastSample: { observedAt: "2026-09-12T06:46:00Z" } };
  site.readings = [{ localDate: "2026-09-12", observedAt: "2026-09-12T06:59:00Z",
    solarEnergyExportedWh: 4600000, solarEnergySource: "meter" }];
  const day = read(4601200, "2026-09-12T09:00:00Z");
  assert.equal(day.totalWh, 59200);
  assert.equal(day.partial, true);
  assert.equal(day.estimated, true);
  assert.equal(read(4601300, "2026-09-12T09:05:00Z").totalWh, 59300);
});

test("counter reset preserves observed daily production without a lifetime jump", () => {
  const { read } = energyHarness();
  read(4600000, "2026-09-12T02:00:00Z");
  read(4601000, "2026-09-12T03:00:00Z");
  assert.equal(read(10, "2026-09-12T04:00:00Z").totalWh, 1000);
  assert.equal(read(110, "2026-09-12T05:00:00Z").totalWh, 1100);
});

test("daily summary renders zero, partial estimates and unavailable v1r readings", () => {
  let frontend;
  vm.runInNewContext(fs.readFileSync(path.join(directory, "MMM-PowerWallTV.js"), "utf8"), {
    Module: { register: (_, definition) => { frontend = definition; } }
  });
  frontend.formatNumber = n => n.toFixed(1);
  frontend.config = { local: {}, fleet: {} };
  frontend.el = (_, className, textContent) => ({ className, textContent, children: [], appendChild(child) { this.children.push(child); } });
  assert.equal(frontend.generatedTodayValue({ source: "v1r", solarEnergyToday: true, solarEnergyExportedWh: 0 }), "0.0 kWh");
  assert.equal(frontend.generatedTodayValue({ source: "v1r", solarEnergyToday: false }), "— kWh");
  const dom = frontend.renderSummary({ source: "v1r", solarEnergyToday: true, solarEnergyExportedWh: 59200,
    solarEnergyPartial: true, solarEnergyEstimated: true });
  assert.equal(dom.children[0].children[0].textContent, "GENERATED TODAY");
  assert.equal(dom.children[0].children[1].textContent, "≈ 59.2 kWh");
});

test("export window uses existing summary fonts, follows its label settings and can be hidden", () => {
  let frontend;
  vm.runInNewContext(fs.readFileSync(path.join(directory, "MMM-PowerWallTV.js"), "utf8"), {
    Module: { register: (_, definition) => { frontend = definition; } }
  });
  frontend.config = { local: {}, fleet: {}, GridExportWindow: { show: true } };
  frontend.batteryShareVisible = () => true;
  frontend.formatNumber = n => n.toFixed(1);
  frontend.el = (_, className, textContent) => ({ className, textContent, children: [], appendChild(child) { this.children.push(child); } });
  const snapshot = { source: "v1r", solarEnergyToday: true, solarEnergyExportedWh: 42000,
    gridExportToday: { energyWh: 27000, partial: false, estimated: false },
    gridExportWindow: { energyWh: 12500, partial: false, estimated: false, batteryPercent: 37.5 } };
  let dom = frontend.renderSummary(snapshot);
  assert.equal(dom.children[0].children[0].textContent, "GENERATED TODAY");
  assert.equal(dom.children[1].children[0].textContent, "EXPORTED TODAY");
  assert.equal(dom.children[1].children[1].textContent, "27.0 kWh");
  assert.equal(dom.children[1].children[1].className, dom.children[0].children[1].className);
  assert.equal(dom.children[2].children[0].textContent, "EXPORTED 5-9PM");
  assert.equal(dom.children[2].children[1].textContent, "12.5 kWh");
  assert.equal(dom.children[2].children[1].className, dom.children[0].children[1].className);
  frontend.config.GridExportWindow = { show: true, start: "16:30", end: "20:15" };
  snapshot.gridExportToday.partial = true;
  snapshot.gridExportWindow.partial = true;
  snapshot.gridExportWindow.estimated = true;
  dom = frontend.renderSummary(snapshot);
  assert.equal(dom.children[1].children[0].textContent, "EXPORTED TODAY");
  assert.equal(dom.children[2].children[0].textContent, "EXPORTED 4:30-8:15PM");
  assert.equal(dom.children[2].children[1].textContent, "12.5 kWh");
  snapshot.gridExportWindow.batterySharePartial = true;
  snapshot.gridExportWindow.batteryPercent = null;
  dom = frontend.renderSummary(snapshot);
  snapshot.gridExportWindow = null;
  assert.equal(frontend.renderSummary(snapshot).children[2].children[1].textContent, "— kWh");
  frontend.config.GridExportWindow.show = false;
  assert.equal(frontend.renderSummary(snapshot).children.length, 2);
  assert.equal(frontend.exportWindowLabel("10:00", "14:00"), "10AM-2PM");
});

test("export window is persisted with aggregate history and forwarded to display snapshots", async () => {
  const { h, config, store, site } = energyHarness();
  const result = h.updateTedapiAggregateHistory(config, {
    solar: { energy_exported: 4600000 }, site: { energy_exported: 2300000 }
  });
  assert.equal(result.gridExportWindow.energyWh, 0);
  assert.ok(site.gridExportWindow.sample);
  assert.equal(site.gridExportToday.sample.counter, 2300000);
  assert.equal(Object.values(store.sites)[0].gridExportWindow.sample.counter, 2300000);
  h.execJsonFile = async () => ({ aggregateMeters: { solar: { energy_exported: 4600000 }, site: { energy_exported: 2300000 } } });
  h.updateTedapiAggregateHistory = () => result;
  const snapshot = await h.fetchSnapshot("display", { mode: "v1r", tedapi: {
    gatewayIP: "10.0.0.98", gatewayPassword: "test", rsaKeyPath: "test.pem"
  } });
  assert.equal(snapshot.gridExportWindow, result.gridExportWindow);
  assert.equal(snapshot.gridExportToday, result.gridExportToday);
});

test("battery share visibility starts at local premium time, continues after its end, and stops at midnight", () => {
  let frontend;
  vm.runInNewContext(fs.readFileSync(path.join(directory, "MMM-PowerWallTV.js"), "utf8"), {
    Module: { register: (_, definition) => { frontend = definition; } }
  });
  frontend.config = { tedapi: { timezone: "UTC" } };
  const visible = date => frontend.batteryShareVisible("17:00", "Australia/Melbourne", new Date(date));
  assert.equal(visible("2026-09-19T16:59:59+10:00"), false);
  assert.equal(visible("2026-09-19T17:00:00+10:00"), true);
  assert.equal(visible("2026-09-19T21:01:00+10:00"), true);
  assert.equal(visible("2026-09-19T23:59:59+10:00"), true);
  assert.equal(visible("2026-09-20T00:00:00+10:00"), false);
  assert.equal(visible("2026-10-05T17:00:00+11:00"), true);
  assert.equal(visible("2026-10-05T16:59:59+11:00"), false);
  assert.equal(frontend.batteryShareVisible("16:30", "Australia/Melbourne", new Date("2026-09-19T16:30:00+10:00")), true);
});

test("export source percentages stay hidden while energy totals remain", () => {
  let frontend;
  vm.runInNewContext(fs.readFileSync(path.join(directory, "MMM-PowerWallTV.js"), "utf8"), {
    Module: { register: (_, definition) => { frontend = definition; } }
  });
  frontend.config = { local: {}, fleet: {} };
  frontend.formatNumber = n => n.toFixed(1);
  frontend.el = (_, className, textContent) => ({ className, textContent, children: [], appendChild(child) { this.children.push(child); } });
  const snapshot = { source: "v1r", solarEnergyToday: true, solarEnergyExportedWh: 40000,
    gridExportToday: { energyWh: 20000 }, gridExportWindow: { energyWh: 5000, batteryPercent: 40 } };
  frontend.batteryShareVisible = () => false;
  let dom = frontend.renderSummary(snapshot);
  assert.equal(dom.children.length, 3);
  assert.ok(!JSON.stringify(dom).includes("FROM BATTERY"));
  assert.ok(JSON.stringify(dom).includes("EXPORTED 5-9PM"));
  frontend.batteryShareVisible = () => true;
  dom = frontend.renderSummary(snapshot);
  assert.equal(dom.children.length, 3);
  assert.ok(!JSON.stringify(dom).includes("FROM BATTERY"));
});


test("verified DIN migrates history once and survives another IP change", () => {
  const { h, config, store, site } = energyHarness();
  site.migrationMarker = "retained";
  const old = h.tedapiAggregateHistoryKey(config, "Australia/Melbourne");
  config.tedapi.deviceDIN = "expected-din";
  config.tedapi.resolvedGatewayIP = "10.0.0.75";
  h.updateTedapiAggregateHistory(config, { solar: { energy_exported: 1000 }, site: { energy_exported: 500 } });
  const key = h.tedapiAggregateHistoryKey(config, "Australia/Melbourne");
  assert.equal(key, "din:expected-din|Australia/Melbourne");
  assert.equal(store.sites[key].migrationMarker, "retained");
  assert.equal(store.sites[old], undefined);
  config.tedapi.resolvedGatewayIP = "10.0.0.80";
  h.updateTedapiAggregateHistory(config, { solar: { energy_exported: 1100 }, site: { energy_exported: 550 } });
  assert.equal(store.sites[key].migrationMarker, "retained");
  assert.equal(store.sites[key].gatewayIP, "10.0.0.80");
});

test("discovery flags and verified identity reach history and snapshot", async () => {
  const h = helper();
  h.execJsonFile = async (_, args) => {
    assert.equal(args[args.indexOf("--expected-din") + 1], "expected-din");
    assert.equal(args[args.indexOf("--discovery-cidr") + 1], "10.0.0.0/24");
    return { gatewayDIN: "expected-din", resolvedGatewayIP: "10.0.0.75", aggregateMeters: {} };
  };
  h.updateTedapiAggregateHistory = config => {
    assert.equal(config.tedapi.deviceDIN, "expected-din");
    return {};
  };
  const result = await h.fetchSnapshot("test", { mode: "v1r", tedapi: {
    gatewayIP: "10.0.0.98", rsaKeyPath: "key", gatewayPassword: "secret",
    discovery: { enabled: true, cidr: "10.0.0.0/24", expectedDIN: "expected-din" }
  } });
  assert.equal(result.resolvedGatewayIP, "10.0.0.75");
});

test("battery energy caption preserves fractional capacity and guards missing readings", () => {
  let frontend;
  vm.runInNewContext(fs.readFileSync(path.join(directory, "MMM-PowerWallTV.js"), "utf8"), {
    Module: { register: (_, definition) => { frontend = definition; } }
  });
  frontend.formatNumber = (value, digits) => value.toFixed(digits);
  assert.equal(frontend.batteryEnergyLabel({ batteryCount: 2, batteryPercentage: 50 }), "13.5 OF 27kWh");
  assert.equal(frontend.batteryEnergyLabel({ batteryCount: 1, batteryPercentage: 100 }), "13.5 OF 13.5kWh");
  assert.equal(frontend.batteryEnergyLabel({ batteryCount: 2, batteryPercentage: 0 }), "0.0 OF 27kWh");
  assert.equal(frontend.batteryEnergyLabel({ batteryCount: 2, batteryPercentage: null }), "");
  assert.equal(frontend.batteryEnergyLabel({ batteryPercentage: 50 }), "");
});

test("export dot shows forecast plan and turns grey on delayed readings", () => {
  let frontend;
  vm.runInNewContext(fs.readFileSync(path.join(directory, "MMM-PowerWallTV.js"), "utf8"), {
    Module: { register: (_, definition) => { frontend = definition; } }
  });
  frontend.el = (_, className, textContent) => ({ className, textContent, children: [],
    appendChild(child) { this.children.push(child); }, setAttribute(key, value) { this[key] = value; } });
  for (const [heading, state] of [["BATTERY EXPORT PLANNED", "planned"],
    ["BATTERY EXPORT BLOCKED", "blocked"], ["CHARGE LIMITS APPLY", "unknown"],
    ["EXPORT CONTROL OFF", "unknown"], ["EXPORT STATUS UNKNOWN", "unknown"]]) {
    const dom = frontend.renderExportFeedback({ exportFeedback: { heading } });
    assert.equal(dom.children[0].textContent, "EXPORT");
    assert.equal(dom.children[1].className, `pwtv-export-dot pwtv-export-dot-${state}`);
    assert.equal(dom["aria-label"], heading);
  }
  frontend.infoMessage = "Powerwall data delayed";
  assert.equal(frontend.renderExportFeedback({ exportFeedback: { heading: "BATTERY EXPORT PLANNED" } })
    .children[1].className, "pwtv-export-dot pwtv-export-dot-unknown");
});

test("snapshot integrates cached hourly generation with live load for the export dot", async () => {
  const now = Date.parse("2026-10-03T13:00:00+10:00");
  const folder = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "pwtv-prediction-"));
  try {
    const statusPath = path.join(folder,"status.json"), forecastPath = path.join(folder,"forecast.json");
    fs.writeFileSync(statusPath,JSON.stringify({updatedAt:now,enabled:true,confirmed:true,soc:50,
      timezone:"Australia/Melbourne",forecastDate:"2026-10-04",forecastKwh:75,thresholdKwh:35,
      startPercent:90,stopPercent:65}));
    fs.writeFileSync(forecastPath,JSON.stringify({instances:{solar:{forecast:{updatedAt:new Date(now).toISOString(),
      timezone:"Australia/Melbourne",days:[{date:"2026-10-03",hours:[13,14,15,16].map(hour=>({
        minuteOfDay:hour*60,time:`2026-10-03T${hour}:00`,generationKwh:5}))}]}}}}));
    const h=helper(now);
    h.fetchElectricityMaps=async()=>null;
    h.fetchTedapiSnapshot=async()=>({source:"v1r",batteryCount:2,predictionHomePowerWatts:1000});
    const config={mode:"v1r",exportFeedbackPath:statusPath,ExportPrediction:{forecastCachePath:forecastPath}};
    let result=await h.fetchSnapshot("test",config);
    assert.equal(result.exportFeedback.heading,"BATTERY EXPORT PLANNED");
    assert.ok(result.exportPrediction.projectedPercent>90);
    h.fetchTedapiSnapshot=async()=>({source:"v1r",batteryCount:2,predictionHomePowerWatts:4000});
    result=await h.fetchSnapshot("test",config);
    assert.equal(result.exportFeedback.heading,"BATTERY EXPORT BLOCKED");
    fs.unlinkSync(forecastPath);
    result=await h.fetchSnapshot("test",config);
    assert.equal(result.exportFeedback.heading,"EXPORT STATUS UNKNOWN");
  } finally { fs.rmSync(folder,{recursive:true,force:true}); }
});
