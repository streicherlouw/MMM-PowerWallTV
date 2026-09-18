const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { updateActive } = require("../scripts/battery-export-limit.js");
const script = path.resolve(__dirname, "../scripts/battery-export-limit.js");
const fixture = `// BatteryExportToGridLimit: { active: false } -- leave this comment alone
const config = { modules: [
 { module: "Other", config: { BatteryExportToGridLimit: { active: false } } },
 { module: "MMM-PowerWallTV", config: { mode: "v1r", BatteryExportToGridLimit: {
   "active": false, lowerThreshold: 70, upperThreshold: 90
 } } }
] };
module.exports = config;
`;

test("edits only the real module flag, preserving comments, other modules and thresholds", () => {
  const expected = fixture.replace('"active": false', '"active": true');
  assert.equal(updateActive(fixture, true), expected);
  assert.equal(updateActive(expected, false), fixture);
  assert.equal(updateActive(expected, true), expected);
});

test("refuses missing, ambiguous, dynamic and overridden settings", () => {
  for (const input of [
    fixture.replace('"MMM-PowerWallTV"', '"Missing"'),
    fixture.replace('"Other"', '"MMM-PowerWallTV"'),
    fixture.replace('"active": false', '"active": check()'),
    fixture.replace('"active": false', '"active": false, active: true'),
    fixture.replace('"active": false', '...settings, "active": false'),
    fixture.replace('"active": false', 'get active() { return false; }'),
    fixture.replace('"active": false', '["active"]: false'),
    fixture.replace('BatteryExportToGridLimit: {\n', 'BatteryExportToGridLimit: policy || {\n')
  ]) assert.throws(() => updateActive(input, true));
});

function setup(t, source = fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pwtv-toggle-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, "custom config.js");
  fs.writeFileSync(config, source, { mode: 0o640 });
  const log = path.join(dir, "pm2.log");
  fs.writeFileSync(path.join(dir, "pm2"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PWTV_TEST_LOG"\ncase "$1" in\ndescribe) exit "${PWTV_TEST_DESCRIBE:-0}";;\nrestart) exit "${PWTV_TEST_RESTART:-0}";;\nesac\n', { mode: 0o755 });
  const run = (args, env = {}) => spawnSync(process.execPath, [script, ...args, "--config", config], {
    encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PWTV_TEST_LOG: log, ...env }
  });
  return { dir, config, log, run };
}

test("backs up privately, preserves permissions and restarts selected PM2 service", t => {
  const { dir, config, log, run } = setup(t);
  const result = run(["on", "--pm2-name", "Mirror custom"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(config, "utf8"), updateActive(fixture, true));
  const backups = fs.readdirSync(dir).filter(n => n.includes(".backup-"));
  assert.equal(backups.length, 1);
  const backup = path.join(dir, backups[0]);
  assert.equal(fs.readFileSync(backup, "utf8"), fixture);
  assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
  assert.equal(fs.statSync(config).mode & 0o777, 0o640);
  assert.equal(fs.readFileSync(log, "utf8"), "describe Mirror custom\nrestart Mirror custom\n");
  assert.ok(!fs.readdirSync(dir).some(n => n.startsWith(".pwtv-config-")));
});

test("no-restart saves config without executing it or invoking PM2", t => {
  const source = fixture + '\nthrow new Error("Config must not execute");\n';
  const { config, log, run } = setup(t, source);
  assert.equal(run(["on", "--no-restart"]).status, 0);
  const result = run(["off", "--no-restart"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(config, "utf8"), source);
  assert.ok(!fs.existsSync(log));
  assert.match(result.stdout, /export permission is unchanged/);
});

test("missing PM2 process leaves config untouched", t => {
  const { config, run } = setup(t);
  const result = run(["on"], { PWTV_TEST_DESCRIBE: "1" });
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(config, "utf8"), fixture);
  assert.match(result.stderr, /nothing changed/);
});

test("restart failure reports that config was saved but must be applied manually", t => {
  const { config, run } = setup(t);
  const result = run(["on"], { PWTV_TEST_RESTART: "1" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Config saved, but PM2 restart failed/);
  assert.equal(fs.readFileSync(config, "utf8"), updateActive(fixture, true));
});

test("invalid CLI arguments and syntax errors cannot change config", t => {
  const { config, run } = setup(t, fixture + "\n invalid !!!");
  for (const args of [["on", "--no-restart"], ["enable"], ["on", "--unknown"]]) {
    assert.equal(run(args).status, 1);
    assert.equal(fs.readFileSync(config, "utf8"), fixture + "\n invalid !!!");
  }
});
