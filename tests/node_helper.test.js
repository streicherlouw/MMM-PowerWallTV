const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const directory = path.resolve(__dirname, "..");
function helper() {
  const sandbox = {
    require: (name) => name === "node_helper" ? { create: (definition) => definition } : require(name),
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
