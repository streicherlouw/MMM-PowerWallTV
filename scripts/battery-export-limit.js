#!/usr/bin/env node
"use strict";

// Edit only this module's literal active flag; never execute the user's config.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function updateActive(source, enabled) {
  const { parse } = require("acorn");
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "script" });
  const key = p => p.computed ? null : p.key.name || p.key.value;
  const properties = (object, name) => object.properties.filter(p => p.type === "Property" && key(p) === name);
  const modules = [];
  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "ObjectExpression" && properties(node, "module").some(p => p.value.value === "MMM-PowerWallTV")) modules.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") walk(value);
    }
  }
  walk(ast);
  if (modules.length !== 1) throw new Error("Expected exactly one MMM-PowerWallTV module; nothing changed.");
  function property(object, name) {
    if (object.type !== "ObjectExpression" || object.properties.some(p => p.type === "SpreadElement" || p.computed)) {
      throw new Error("Use plain config objects without spreads or computed keys; nothing changed.");
    }
    const matches = properties(object, name);
    if (matches.length !== 1 || matches[0].kind !== "init" || matches[0].method) {
      throw new Error(`Expected exactly one literal ${name} setting; nothing changed.`);
    }
    return matches[0].value;
  }
  const config = property(modules[0], "config");
  const limit = property(config, "BatteryExportToGridLimit");
  const active = property(limit, "active");
  if (active.type !== "Literal" || typeof active.value !== "boolean") {
    throw new Error("BatteryExportToGridLimit.active must be literal true or false; nothing changed.");
  }
  return source.slice(0, active.start) + String(enabled) + source.slice(active.end);
}

function main(args) {
  const usage = "Usage: node scripts/battery-export-limit.js on|off [--config PATH] [--pm2-name NAME] [--no-restart]";
  if (args.includes("--help") || args.includes("-h")) { console.log(usage); return; }
  const action = args.shift();
  if (!["on", "off"].includes(action)) throw new Error(usage);
  let configPath = path.resolve(__dirname, "../../../config/config.js");
  let pm2Name = "MagicMirror", restart = true;
  while (args.length) {
    const option = args.shift();
    if (option === "--no-restart") restart = false;
    else if (["--config", "--pm2-name"].includes(option) && args[0] && !args[0].startsWith("--")) {
      const value = args.shift();
      if (option === "--config") configPath = path.resolve(value);
      else pm2Name = value;
    } else throw new Error(usage);
  }
  configPath = fs.realpathSync(configPath);
  const original = fs.readFileSync(configPath, "utf8");
  const updated = updateActive(original, action === "on");
  if (restart) {
    const check = spawnSync("pm2", ["describe", pm2Name], { stdio: "ignore" });
    if (check.error || check.status !== 0) throw new Error(`PM2 process ${pm2Name} unavailable; nothing changed. Use --pm2-name or --no-restart.`);
  }
  if (updated !== original) {
    // Private staging also makes the final replacement atomic on this filesystem.
    const stage = fs.mkdtempSync(path.join(path.dirname(configPath), ".pwtv-config-"));
    fs.chmodSync(stage, 0o700);
    const temporary = path.join(stage, "config.js");
    try {
      fs.writeFileSync(temporary, updated, { mode: 0o600 });
      const check = spawnSync(process.execPath, ["--check", temporary], { stdio: "ignore" });
      if (check.error || check.status !== 0) throw new Error("Updated config failed syntax validation; nothing changed.");
      if (fs.readFileSync(configPath, "utf8") !== original) throw new Error("Config changed concurrently; retry.");
      const backup = `${configPath}.backup-${Date.now()}-${process.pid}`;
      fs.writeFileSync(backup, original, { mode: 0o600, flag: "wx" });
      fs.chmodSync(temporary, fs.statSync(configPath).mode & 0o777);
      fs.renameSync(temporary, configPath);
      console.log(`Backup: ${backup}`);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }
  console.log(`BatteryExportToGridLimit.active = ${action === "on"}`);
  if (restart) {
    const result = spawnSync("pm2", ["restart", pm2Name], { stdio: "inherit" });
    if (result.error || result.status !== 0) throw new Error("Config saved, but PM2 restart failed. Restart MagicMirror manually to apply it.");
  } else console.log("Restart MagicMirror to apply the saved setting.");
  if (action === "off") console.log("Automatic control disabled in config; the current Powerwall export permission is unchanged.");
}

module.exports = { updateActive, main };
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.code === "MODULE_NOT_FOUND" ? "Missing dependency. Run npm install in MMM-PowerWallTV first." : error.message); process.exitCode = 1; }
}
