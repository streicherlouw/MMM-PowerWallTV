# Changelog

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
