# Changelog

## 2026-09-20 — Premium-window battery mode control

- Make both levers independently configurable, with inside/outside targets.
- Remove approximation prefixes from export totals and battery-share text, retaining estimate metadata.
- Select savings mode during the configured export window, with existing charge hysteresis; select self-powered and solar-only export outside it.
- Read and verify both settings, preserve reserve with mode-only writes, and report failures for retry on the next refresh.
- Document timezone, restart, inactive-control and partial-write behavior; add schedule and mode-control regression tests.

## 2026-09-19 — OS-managed screen orientation

- Document Raspberry Pi OS ownership of screen orientation and consistent desktop/login-screen profiles.
- Link the companion MMM-PIR-Sensor fix that removes rotation on monitor wake and MagicMirror startup.
- Document the matching space between the site name and daily generation, already applied to the display.

## 2026-09-19 — Battery-share label and display hours

- Renamed the heading to `FROM BATTERY`, retaining the estimated-percentage indicator.
- Show the heading and percentage from the configured premium-window start until local midnight, using the server-provided site timezone.
- Keep the completed share visible after the export window ends; hide it before the next window starts.
- Documented the daily visibility schedule, blank/partial percentage behavior, and the shared visibility switch for the window and battery rows.
- Verified 65 tests, including custom start times, midnight boundaries, and daylight saving time.

## 2026-09-18 — Battery share of export-window energy

- Added spacing between energy readings and `FROM BATTERY (EST.)` below the configured export window.
- Estimate the battery contribution by weighting sampled supply fractions with grid-exported energy, retaining state across restarts.
- Mark unavailable/incomplete attribution explicitly; documented the allocation assumption and preserved existing export control.
- Added regression coverage for mixed generation, charging, energy weighting, boundaries, gaps and upgrades; all 63 tests pass.

## 2026-09-18 — Documentation and installation refresh

- Consolidated the three energy readings, visibility settings, timezone behavior and export automation in the README.
- Updated the complete v1r configuration example with the export-window settings.
- Added `npm ci` to install and upgrade instructions, documented history backups, and updated validation instructions to reflect all 58 tests.

## 2026-09-18 — Daily grid export total

- Added `EXPORTED TODAY` between solar generation today and the tariff-window export reading.
- Count all daily grid exports independently of the tariff window, with persistent state, local-midnight reset, history recovery, and partial/estimated indicators.
- Added daily-meter tests including midnight rollover, restart recovery, and daylight-saving time.

## 2026-09-18 — Configurable grid export window

- Added `EXPORTED 5-9PM` below daily solar production, using the same fonts.
- Added `GridExportWindow.show`, `start`, and `end` settings with a 17:00–21:00 default.
- Count grid exports from cumulative site meter readings, retain totals across restarts, and reset at local midnight.
- Recover saved history, distinguish partial and interpolated totals, and handle missing counters and resets.
- Added regression tests for window boundaries, timezones, persistence, custom settings, and rendering.

## 2026-09-18 — Terminal switch for battery export control

- Added `scripts/battery-export-limit.js on|off` to edit the active flag, back up and validate config, and restart MagicMirror.
- Added custom config/service options and `--no-restart`, with JavaScript parsing that preserves unrelated config and comments.
- Documented local and SSH usage and added regression tests for safe edits and restart failures.

## 2026-09-12 — Restore daily solar production

- Restore the upper-left daily generation counter using v1r `solar.energy_exported` counter deltas.
- Persist a fixed daily anchor and latest meter sample across hourly history updates and restarts.
- Recover earlier Wi-Fi production during migration, clearly marking incomplete and estimated totals.
- Handle timezone day rollover, stale history and meter resets; keep unavailable readings visible.
- Added seven regression tests; all 35 module tests pass.

## 2026-09-12 — Option 5 LAN access and battery export limits

- Added Powerwall 3 v1r LAN access using a registered RSA-4096 key and pyPowerwall 0.17.3.
- Added host-side gateway password files and documented installation, migration, upgrades and rollback.
- Preserved Wi-Fi TEDAPI, local JSON and Fleet modes, solar strings, energy history and display customization from the deployed baseline.
- Added optional `BatteryExportToGridLimit` control: disable battery export below a lower charge threshold and re-enable at an upper threshold.
- Read export permissions on every successful v1r battery refresh and verify changes by reading the setting back.
- Use Tesla-app state of charge for the v1r display and control thresholds.
- Keep the current export setting in the threshold band and preserve site-wide `never` export rules.
- Preserve telemetry on control failures and share identical simultaneous refreshes to avoid duplicate control cycles.
- Added 28 hardware-independent tests covering transport selection, hysteresis, failure handling and backward compatibility.
- Verified live option 5 reads and an export enable transition on Powerwall 3; deployed active 70% / 90% thresholds on the Raspberry Pi. Repository defaults remain inactive.
