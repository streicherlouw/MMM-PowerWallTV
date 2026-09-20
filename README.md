# MMM-PowerWallTV

A MagicMirror module inspired by [sighmon/Powerwall-TV](https://github.com/sighmon/Powerwall-TV). It renders a TV-style Tesla Powerwall scene with live solar, home, Powerwall, grid, optional Wall Connector, battery state, animated power flows, demo mode, and optional electricityMaps grid carbon data.

The module is local-first: the Node helper fetches data from your MagicMirror host and sends a display snapshot to the browser module. For Powerwall 3, the recommended setup is **option 5: RSA-authenticated v1r LAN access through pyPowerwall**. Existing Wi-Fi TEDAPI, local Gateway and Fleet API configurations remain supported.

## Energy readings and export control

In v1r/TEDAPI mode, the upper-left summary displays these readings in matching fonts:

| Reading | What it measures |
| --- | --- |
| `GENERATED TODAY` | Solar energy produced since local midnight |
| `EXPORTED TODAY` | Total energy sent to the grid since local midnight, from solar and batteries |
| `EXPORTED 5-9PM` | Energy sent to the grid during the configured daily window; the label follows its start/end times |
| `FROM BATTERY` | Estimated battery share of window exports; shown from the window start until local midnight |

Energy readings use kWh; the battery contribution uses %. Imports are not subtracted from the export totals. The module uses `tedapi.timezone` (or the host timezone), retains daily state across restarts, and marks estimated solar generation (`≈`), incomplete (`PARTIAL`), or unavailable (`— kWh`) readings explicitly. `showSummary: false` hides the whole summary; `GridExportWindow.show: false` hides the window reading and its battery-share heading/value, while daily totals remain visible.

The display is separate from optional [BatteryExportToGridLimit](#batteryexporttogridlimit) control, which schedules export permission and operational mode during the premium window, with charge thresholds protecting battery export. The [terminal script](#switch-automatic-export-control-on-or-off-from-the-terminal) switches that automation on or off by updating and reloading the MagicMirror config. Details and configuration are below; see [CHANGELOG.md](CHANGELOG.md) for release history.

## Install

Start with a working MagicMirror installation and its supported Node.js version. This module's test runner requires Node.js 18+ and Python 3. Run `npm ci` to install the locked npm dependencies, including the Acorn parser used by the terminal configuration script. On Raspberry Pi OS, install `python3-venv` if `python3 -m venv` is unavailable:

```bash
sudo apt install python3-venv
```

Clone or copy this folder into your MagicMirror `modules` directory:

```bash
cd ~/MagicMirror/modules
git clone https://github.com/streicherlouw/MMM-PowerWallTV.git
cd MMM-PowerWallTV
npm ci
npm test
```

`npm test` runs the JavaScript syntax checks and 77 automated tests (48 JavaScript and 29 Python) without contacting a Powerwall. Continue with the option 5 setup below for Powerwall 3, or use the demo configuration to preview the display without hardware.

## Powerwall 3 LAN Config — Option 5 (Recommended)

Option 5 reads Powerwall data at its reachable LAN address using a registered RSA-4096 key. It does not require the MagicMirror host to join the Powerwall's Wi-Fi. Your gateway must expose `/tedapi/v1r` at that address; this has been verified at `10.0.0.98` on the installation used for this migration.

### 1. Install pyPowerwall on the MagicMirror host

```bash
cd ~/MagicMirror/modules/MMM-PowerWallTV
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

Option 5 requires pyPowerwall 0.17.3 or newer within the supported 0.17 series. The `tedapi.python` setting must point to the Python environment where it is installed.

When upgrading an existing installation, you can preserve its old Python environment by creating a separate one:

```bash
python3 -m venv "$HOME/.local/share/MMM-PowerWallTV/v1r-venv"
"$HOME/.local/share/MMM-PowerWallTV/v1r-venv/bin/python" -m pip install -r requirements.txt
```

For the `pi` account, set `tedapi.python` to `/home/pi/.local/share/MMM-PowerWallTV/v1r-venv/bin/python` when using this alternative. This is the environment used by the deployed Raspberry Pi setup. Use that same executable in the smoke-test commands below instead of `.venv/bin/python`.

### 2. Install the registered key and gateway password

If a key is already registered, reuse it. For a new installation, follow [pyPowerwall's option 5 registration instructions](https://github.com/jasonacox/pypowerwall#v1r-lan-tedapi-setup---option-5-powerwall-3-wired-lan). Registration may require Tesla sign-in and physical verification; normal reads afterward use the local gateway.

On the MagicMirror host, copy the private key into the module's `.auth` directory, keeping it readable only by the service account:

```bash
cd ~/MagicMirror/modules/MMM-PowerWallTV
install -d -m 700 .auth
install -m 600 /path/to/registered/tedapi_rsa_private.pem .auth/tedapi_rsa_private.pem
```

Create the password file with a hidden prompt. Enter the **full gateway password from the QR sticker**, not your Tesla account password:

```bash
python3 - <<'PY'
import getpass
import os
password = getpass.getpass("Gateway sticker password: ")
fd = os.open(".auth/gateway-password", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.fchmod(fd, 0o600)
with os.fdopen(fd, "w") as output:
    output.write(password + "\n")
PY
```

These files are Git-ignored. Alternatively, set `PWTV_TEDAPI_GATEWAY_PASSWORD` in the MagicMirror service environment. A configured password file takes precedence. Existing `tedapi.gatewayPassword` / `tedapi.gwPwd` configurations still work, but a host-side file avoids placing the password in browser configuration.

### 3. Configure MagicMirror

```js
{
  module: "MMM-PowerWallTV",
  position: "fullscreen_above",
  config: {
    mode: "v1r",
    showSummary: true,
    GridExportWindow: {
      show: true,
      start: "17:00",
      end: "21:00"
    },
    BatteryExportToGridLimit: {
      active: false,
      lowerThreshold: 70,
      upperThreshold: 90,
      gridExport: { enabled: true, inside: "battery_ok", outside: "pv_only" },
      operationalMode: { enabled: true, inside: "autonomous", outside: "self_consumption" }
    },
    width: "100%",
    maxWidth: "1050px",
    tedapi: {
      gatewayIP: "10.0.0.98",
      rsaKeyPath: ".auth/tedapi_rsa_private.pem",
      gatewayPasswordFile: ".auth/gateway-password",
      python: "/home/pi/MagicMirror/modules/MMM-PowerWallTV/.venv/bin/python",
      siteName: "Home",
      timezone: "Australia/Melbourne",
      timeoutSeconds: 10,
      retryAttempts: 3,
      retryDelayMs: 1500,
      solarStringGroups: [["A", "B"], ["C", "D"], ["E", "F"]],
      aggregateHistoryPath: "~/.cache/MMM-PowerWallTV/tedapi-aggregates.json"
    }
  }
}
```

Both transports share the `tedapi` configuration block so existing string labels, panel settings and energy-history settings continue to apply. An RSA key also opts an existing `mode: "tedapi"` configuration into v1r, but `mode: "v1r"` is recommended because it requires a key explicitly. Relative key/password paths resolve from the module directory; `~/` and absolute paths are accepted.

### 4. Test before restarting MagicMirror

From the module directory:

```bash
.venv/bin/python scripts/fetch-tedapi.py \
  --transport v1r --host 10.0.0.98 \
  --rsa-key-path .auth/tedapi_rsa_private.pem \
  --password-file .auth/gateway-password \
  --timezone Australia/Melbourne --timeout 10
```

Successful output is one JSON snapshot with `source: "v1r"` and `raw.tedapiMode: "v1r"`. It includes power flows, battery percentage/count, backup-time estimate, solar strings, aggregate meters and the current `gridExportMode`. The v1r battery percentage uses Tesla's app scale. The module is read-only by default; the optional `BatteryExportToGridLimit` feature below can change battery export permission and operational mode. It never changes backup reserve or opens/closes the grid contactor.

After updating `config.js`, restart MagicMirror using your existing service manager. No Tesla cloud credentials are needed for normal v1r reads. The bridge rejects a fallback connection when v1r was requested.

For a PM2 installation with the process named `MagicMirror`:

```bash
node --check ~/MagicMirror/config/config.js
pm2 restart MagicMirror
pm2 status MagicMirror
```

Use your actual process name from `pm2 list`, or your existing systemd/manual startup method if you do not use PM2. Keep the configured Python executable and `.auth` files readable by the account running MagicMirror. Ordinary refreshes do not require root access.

### Updating an installed module

Back up your MagicMirror configuration and note the current module commit first:

```bash
cd ~/MagicMirror/modules/MMM-PowerWallTV
pwtv_backup="$HOME/.cache/MMM-PowerWallTV-backups/$(date +%Y%m%d-%H%M%S)"
install -d -m 700 "$pwtv_backup"
install -m 600 ~/MagicMirror/config/config.js "$pwtv_backup/config.js"
git rev-parse HEAD > "$pwtv_backup/module-commit.txt"
git status --short
if [ -f "$HOME/.cache/MMM-PowerWallTV/tedapi-aggregates.json" ]; then
  install -m 600 "$HOME/.cache/MMM-PowerWallTV/tedapi-aggregates.json" "$pwtv_backup/tedapi-aggregates.json"
fi
```

The history backup above uses the default path; substitute `tedapi.aggregateHistoryPath` if you configured another location. It contains the persisted solar, daily grid-export and tariff-window totals.

If Git reports local source changes, preserve or commit them before pulling; do not discard a deployed customization with a hard reset. For a clean checkout on `main`:

```bash
git pull --ff-only origin main
npm ci
.venv/bin/python -m pip install -r requirements.txt
npm test
```

Substitute the executable from `tedapi.python` when using a separate environment. Run the read-only smoke test above, review `BatteryExportToGridLimit.active`, then restart MagicMirror. Updates preserve the Git-ignored `.auth` directory and the energy-history file outside the repository. Keep your own secure backup of the registered RSA key; a replacement key must be registered separately.

**Upgrading an existing active controller:** omitted lever settings default to both enabled, with savings/threshold-controlled export inside the window and self-powered/solar-only export outside it. Review `GridExportWindow.start/end`, timezone and both lever blocks before restarting. To retain permission-only control, set `operationalMode.enabled: false`; the export lever still follows the configured window. To retain all-day charge-threshold export control, also set `gridExport.outside: "battery_ok"`.

To roll back, restore the saved configuration and your saved code revision, then restart with the previous Python environment. Disabling or rolling back the automation does **not** undo its last gateway export permission or operational mode.

### Migrating the existing Wi-Fi deployment

Keep the current display and `tedapi` settings, change `mode` to `"v1r"` and `tedapi.gatewayIP` to the reachable LAN address, then add `rsaKeyPath` and `gatewayPasswordFile`. Remove `gatewayPassword` / `gwPwd` from `config.js` after creating the password file. Keep the existing aggregate-history file; history is partitioned by gateway address, site name and timezone, so the new LAN address starts a new series. The module can recover the same-day total from a unique legacy Wi-Fi series with the same non-empty site name and timezone; the handover day is marked partial.

The v1r `solar.energy_exported` value is cumulative Wh. The module subtracts a persisted daily baseline to show today's production; it never displays the lifetime counter as today's total. Keep `showSummary: true` to display this counter in the upper-left summary.

Missing keys, unverified keys, authentication errors or unavailable readings produce a refresh error. With `staleDataOnError: true`, the last good display remains visible. A missing Python package requires installation in `tedapi.python`'s environment. A connection timeout requires checking LAN reachability; changing the address alone cannot enable v1r on an unsupported interface.

## Daily grid export display

`EXPORTED TODAY` appears between `GENERATED TODAY` and the configured export-window reading in v1r/TEDAPI modes. It shows all energy exported to the grid since local midnight in kWh, including both solar and battery exports. It uses `site.energy_exported`; imports are not subtracted and solar production is not substituted.

The daily total is independent of the tariff window and remains visible when `GridExportWindow.show` is false. It uses `tedapi.timezone` (or the host timezone), resets at local midnight, and persists in the existing aggregate-history file across restarts. Existing hourly meter history seeds the first total after upgrading. A saved reading within five minutes before midnight can serve as an approximate baseline (tracked internally); a short polling interval across midnight is interpolated. Missing baselines or meter resets are marked `(PARTIAL)`. Missing grid counters show `— kWh`. No new configuration or credentials are required.

## Grid export window display

The upper-left summary shows `GENERATED TODAY`, `EXPORTED TODAY`, `EXPORTED 5-9PM`, and `FROM BATTERY` in that order, using the same label and value fonts with extra spacing between readings. The window reading is **energy exported to the grid**, including solar and battery exports, not solar generation or net exports after imports. It uses cumulative `site.energy_exported` Wh from the v1r/TEDAPI aggregate meters and displays kWh.

Configure the window at the top level of the module config:

```js
GridExportWindow: {
  show: true,
  start: "17:00",
  end: "21:00"
},
```

These are the defaults. Use 24-hour `HH:mm` values; the label follows the configured times (for example, `16:30` to `20:15` displays `EXPORTED 4:30-8:15PM`). The end must be later than the start on the same day; `24:00` is allowed as the end. Overnight windows are not supported. Set `show: false` to hide this reading; counting continues so it can be shown again later. `showSummary` must also be true. This reading is available in v1r and Wi-Fi TEDAPI modes with valid grid export counters.

The window follows `tedapi.timezone`, including daylight saving time, or the host timezone if unset. The value starts at zero each local calendar day, accumulates during the window, and remains visible after the window closes until midnight. Its state is saved with the existing aggregate history, so restarting MagicMirror retains the count. Changing the window recalculates what can be recovered from saved meter history.

Polling rarely lands exactly on a boundary. A boundary crossed within five minutes is interpolated and recorded as estimated internally if energy is apportioned. Longer gaps across a boundary, counter resets, or starting without the necessary history show `(PARTIAL)`; unassignable energy is excluded. Gaps wholly inside the window are recovered from cumulative meter differences. Missing or invalid grid counters display `— kWh` and do not count imports or substitute solar power. Historical hourly readings can recover some of the first day's total, but cannot reconstruct missing boundary readings exactly.

Update the module files and restart MagicMirror to enable the default display. No additional Powerwall credentials or RSA registration are required. This is a read-only display feature and does not change `BatteryExportToGridLimit` or any Powerwall setting.

### Battery contribution to window exports

`FROM BATTERY` below the export-window total shows an **estimated percentage of exported energy** supplied by the battery during that same configured window. It is not battery state of charge. It counts the same `GridExportWindow.start`/`end` interval. Its heading and number are shown only from the configured start (inclusive) until local midnight (exclusive), including after the window ends; both are hidden before the start. Visibility follows the gateway site timezone supplied by the server, including daylight saving time, and updates on display refresh. It is also hidden when `GridExportWindow.show` is false. The percentage remains an estimate, displayed without an approximation prefix.

With the default 17:00–21:00 window, the display behaves as follows (all times are local):

| Time | `EXPORTED 5-9PM` | `FROM BATTERY` heading and percentage |
| --- | --- | --- |
| Midnight to before 5 PM | Today's window total starts at zero | Hidden |
| 5 PM to 9 PM | Accumulates exported kWh | Visible; updates as attributable exports accumulate |
| 9 PM to before midnight | Retains the completed window total | Visible; retains the completed window share |
| At midnight | Resets for the new day | Hidden until the next configured start |

Changing `GridExportWindow.start` moves the battery row's appearance time. Changing `end` changes the counting interval, but the completed percentage remains visible until midnight. These changes take effect on the next display refresh after reloading the config.

The grid meter cannot identify the origin of exported energy. The estimate allocates exports proportionally to concurrent solar generation and positive battery discharge: `battery discharge / (solar generation + battery discharge)`. This assumes solar and batteries supply the home and grid in the same proportions. For example, 3 kW solar plus 1 kW battery discharge attributes 25% of concurrent exports to the battery. Charging contributes zero. This is an allocation estimate, not a separately metered battery-to-grid measurement.

The module averages sampled source fractions over each short polling interval, clips intervals at the configured window boundaries, and weights the fractions by grid-exported Wh. It persists estimated battery-export Wh alongside total exported Wh across restarts; the displayed percentage is their ratio, never an unweighted average of instantaneous percentages. Values are bounded to 0–100%; no approximation prefix is displayed.

Before any export, the reading is `— %` because there is no energy to divide by. Missing power data, gaps longer than five minutes, or older saved exports without attribution leave the percentage unavailable and mark it `(PARTIAL)` rather than treating unknown exports as solar-only. The kWh total remains available. Historical hourly readings cannot reconstruct battery contribution reliably; normal attribution starts with fresh polling samples. At local midnight, the next day's counters start over. This display does not change the battery export-control policy.

#### Why might the battery percentage be blank?

During its display hours, `— %` means that no percentage is available, not that the battery contributed zero. Before any window exports it is undefined. If tracking is installed or upgraded partway through a window, earlier exported kWh may have no saved battery attribution: the module shows `(PARTIAL)` and withholds a whole-window percentage. Later samples cannot recover the missing source information from the lifetime grid counter. A subsequent window can provide a percentage once exports occur, provided polling covers the window without missing attribution data. The same limitation applies after long polling gaps or unavailable source-power readings.

Before the configured start, the entire row is deliberately hidden, including any unavailable-value indicator.

## BatteryExportToGridLimit

Option 5 can control both **battery export permission** and **operational mode**. With the default targets, during `GridExportWindow.start`–`end` (default 17:00–21:00), it selects savings / time-based control (`autonomous`) and applies the charge thresholds below. Outside that window it selects self-powered (`self_consumption`) and `pv_only`. The schedule uses `tedapi.timezone` (host timezone by default), including daylight saving, and runs even if `GridExportWindow.show` is false. The feature is inactive by default. Add this top-level block inside the module's `config` to activate it:

```js
BatteryExportToGridLimit: {
  active: true,
  lowerThreshold: 70,
  upperThreshold: 90,
  gridExport: { enabled: true, inside: "battery_ok", outside: "pv_only" },
  operationalMode: { enabled: true, inside: "autonomous", outside: "self_consumption" }
},
```

The following rules apply whenever an enabled export lever targets `battery_ok` (inside the window by default). A `pv_only` target disables battery export regardless of charge.

| Charge (Tesla-app percentage) | Action when export control targets `battery_ok` |
| --- | --- |
| Below `lowerThreshold` (e.g. less than 70%) | Set `pv_only`: stop battery export while permitting solar export |
| From `lowerThreshold` up to, but below, `upperThreshold` (70% to less than 90%) | Retain the gateway's existing export setting |
| At or above `upperThreshold` (90% or more) | Set `battery_ok`: allow battery and solar export |

For example, export enabled at 95% remains enabled through 80% and exactly 70%, then switches off below 70%. It stays off as the battery charges through 80%, and switches on again at 90%. The gateway setting stores the on/off state, so restarting MagicMirror in the middle band does not accidentally re-enable export. On first activation at 80%, an existing `pv_only` setting stays off until 90%; an existing `battery_ok` setting stays on until below 70%. Manual changes in that middle band are retained.

Every successful v1r battery refresh reads the current export setting, even while this feature is inactive. When active, the module sends a write only if the schedule or a threshold requires a different setting, then reads the setting back to confirm it. Overlapping identical requests share one read/control cycle. No write is sent if charge or the current export setting is unavailable. Failed or unconfirmed control writes leave telemetry visible with a status message and are reconsidered on the next refresh.

The site-wide `never` rule prohibits solar export too, so this feature preserves it and reports that automation is blocked. Use `pv_only` as the starting rule when you want this feature to manage battery export. Allowing battery export grants permission; Tesla's operating mode, backup reserve and site limits still determine actual power flow.

Set `active: false` to stop automatic changes. This leaves both current gateway settings unchanged. Both thresholds must be numbers with `0 <= lowerThreshold < upperThreshold <= 100`. Active control requires option 5 and a registered RSA key; it is not supported in demo, local JSON, Wi-Fi TEDAPI or Fleet mode.

### Premium-window mode control

On each successful refresh, the controller reads both export permission and operational mode, writes only required changes, and verifies each write. Export permission is updated before operational mode. An unconfirmed write is reported and retried on the next poll; the two writes are not atomic. When operational-mode control is enabled, unknown/unavailable modes and `backup` mode prevent automatic changes. When that lever is disabled, its mode reading does not block export-permission control. The site-wide `never` export rule is preserved.

With the default targets, outside the window `pv_only` resets the export hysteresis: the next window needs 90% (or the configured upper threshold) to enable battery export. When both levers are enabled, a confirmed `pv_only` export rule also selects `operationalMode.outside`, including inside the premium window. Both settings remain in this stopped state until the upper threshold re-arms export. An independently enabled mode lever still follows the time window when export control is disabled. Backup reserve and grid-charging permission are not changed. Savings mode uses the tariff already configured in Tesla; export permission does not guarantee a particular export rate.

Window transitions occur on the next successful polling refresh, not an independent clock timer. If MagicMirror stops, the last settings remain until polling resumes. Disabling automation stops both controls without restoring a mode. The existing terminal on/off script controls both levers.

The helper accepts `--premium-controls '{"gridExport":{"enabled":true,"inside":"battery_ok","outside":"pv_only"},"operationalMode":{"enabled":true,"inside":"autonomous","outside":"self_consumption"}}'` for the same lever settings. It also accepts `--export-window-start 17:00 --export-window-end 21:00` with `--timezone Australia/Melbourne`. Snapshot control status includes `inPremiumWindow`, `operationalModeBefore`, `operationalMode`, `operationalModeTarget`, and `modeAction` when a mode decision completes. Mode writes use a partial `/api/operation` payload to avoid older pyPowerwall versions also rewriting backup reserve.

Each lever has its own `enabled` flag and `inside`/`outside` target in `BatteryExportToGridLimit`. Setting `gridExport.enabled: false` leaves export permission untouched; setting `operationalMode.enabled: false` leaves operational mode untouched. `active: false` disables both. Export targets accept `battery_ok` or `pv_only`; whenever the target is `battery_ok`, the 70%/90% hysteresis still applies. Operational targets accept `autonomous` (savings) or `self_consumption` (self-powered). Defaults are shown above; reverse or equal targets are supported. The shared schedule is `GridExportWindow.start`/`end`.

`EXPORTED TODAY`, the premium-window export total, and `FROM BATTERY` display numbers without an approximation prefix. Estimates are still tracked internally; battery attribution remains an estimate, and unavailable readings still show a dash. The solar generation estimate indicator is unchanged.

### Switch automatic export control on or off from the terminal

Run on the Raspberry Pi as the same user who runs MagicMirror. Install the script's parser dependency once after updating the module:

```bash
cd ~/MagicMirror/modules/MMM-PowerWallTV
npm install
node scripts/battery-export-limit.js on
node scripts/battery-export-limit.js off
```

Run **one** of the last two commands for the desired setting. The script modifies only this module's `BatteryExportToGridLimit.active` boolean in `MagicMirror/config/config.js`, preserves the thresholds and other settings, validates JavaScript syntax, saves a private timestamped backup alongside the config, and atomically replaces the file. It then runs `pm2 restart MagicMirror`. The existing `BatteryExportToGridLimit` block must be present with a literal `active: true` or `active: false`. Comments and quoted property names are supported; missing or multiple module entries, dynamic values, spread properties and computed keys are rejected without modifying the file. The config is parsed, never executed by this script.

For a custom config path, PM2 service name, or another service manager:

```bash
node scripts/battery-export-limit.js on --config /path/to/config.js --pm2-name my-mirror
node scripts/battery-export-limit.js off --no-restart
```

With `--no-restart`, restart MagicMirror yourself to apply the saved setting. If a PM2 restart fails after saving, the script reports this explicitly; the saved setting remains in the config. Run `node scripts/battery-export-limit.js --help` for usage.

From another computer, after installing the script and dependency on the Pi:

```bash
ssh pi@homescreen.local 'node ~/MagicMirror/modules/MMM-PowerWallTV/scripts/battery-export-limit.js on'
ssh pi@homescreen.local 'node ~/MagicMirror/modules/MMM-PowerWallTV/scripts/battery-export-limit.js off'
```

Turning the feature **off** stops automatic control after reload; it does **not** change the Powerwall's current export permission or operational mode. Turning it **on** resumes the configured schedule, enabled levers and charge thresholds on the next successful refresh.

The snapshot contains `gridExportMode` plus `batteryExportToGridLimit` with the charge percentage, thresholds, setting before/after, action (`inactive`, `unchanged`, `enabled`, `disabled`, `blocked` or `error`) and any error. The decision uses the latest successful polling sample, so a stopped module or unavailable gateway cannot enforce thresholds until polling resumes.

The standalone helper is read-only unless `--battery-export-limit` is explicitly passed. The corresponding threshold flags are `--export-lower-threshold 70 --export-upper-threshold 90`.

## Demo Config

```js
{
  module: "MMM-PowerWallTV",
  position: "fullscreen_above",
  config: {
    mode: "demo",
    width: "100%",
    maxWidth: "1050px",
    showHistory: false
  }
}
```

## Local Gateway Config

```js
{
  module: "MMM-PowerWallTV",
  position: "fullscreen_above",
  config: {
    mode: "local",
    width: "100%",
    maxWidth: "1050px",
    local: {
      gatewayIP: "192.168.1.50",
      email: "you@example.com",
      password: "your-gateway-password",
      rejectUnauthorized: false,
      siteName: "Home sweet home",
      wallConnectorIP: "192.168.1.60"
    },
    electricityMaps: {
      apiKey: "",
      zone: "AU-VIC"
    }
  }
}
```

The local Gateway calls are:

- `POST /api/login/Basic`
- `GET /api/meters/aggregates`
- `GET /api/system_status/soe`
- `GET /api/system_status/grid_status`

Wall Connector support is optional and uses `GET http://<wallConnectorIP>/api/1/vitals`.

## Wi-Fi TEDAPI Config — Option 4 (Legacy Setup)

This mode uses the full gateway Wi-Fi password from the Tesla QR label and connects to `192.168.91.1`. Recent gateway firmware requires a direct connection to the Powerwall Wi-Fi; do not assume a static route will work. For a reachable Powerwall 3 LAN endpoint, prefer option 5 above.

TEDAPI support uses the Python `pypowerwall` package:

```bash
cd ~/MagicMirror/modules/MMM-PowerWallTV
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
```

```js
{
  module: "MMM-PowerWallTV",
  position: "fullscreen_above",
  config: {
    mode: "tedapi",
    width: "100%",
    maxWidth: "1050px",
    tedapi: {
      gatewayIP: "192.168.91.1",
      gatewayPassword: "your-full-gateway-wifi-password",
      python: "/home/pi/MagicMirror/modules/MMM-PowerWallTV/.venv/bin/python",
      siteName: "Home sweet home",
      timezone: "Australia/Melbourne",
      timeoutSeconds: 10,
      retryAttempts: 3,
      retryDelayMs: 1500,
      solarStringGroups: [["A", "B"], ["C", "D"], ["E", "F"]],
      showSolarStringLabels: false,
      solarStringPanelCount: 12,
      solarStringPanelWatts: 480,
      solarStringExpectedOutputFactor: 0.72,
      aggregateHistoryPath: "~/.cache/MMM-PowerWallTV/tedapi-aggregates.json",
      aggregateHistoryDays: 30,
      solarIntegrationMaxGapSeconds: 300
    }
  }
}
```

For Australian Powerwall 3 TEDAPI data, the display groups paired inverter string readings as `A+B`, `C+D`, and `E+F` by default. The displayed rows are values-only unless `showSolarStringLabels` is set to `true`. String percentages are calculated against the configured panel nameplate power multiplied by `solarStringExpectedOutputFactor`, which defaults to `0.72`.

The upper-left `GENERATED TODAY` counter uses v1r `/api/meters/aggregates` → `solar.energy_exported` (cumulative Wh). Each refresh subtracts a fixed daily anchor, then converts Wh to kWh. A separate daily state and the latest meter sample are persisted alongside hourly history in `~/.cache/MMM-PowerWallTV/tedapi-aggregates.json`. This prevents hourly updates or MagicMirror restarts from moving the baseline.

The day follows `tedapi.timezone`. At rollover, the last sample from the previous day is used only if it was recorded within five minutes before midnight; otherwise the first available reading today becomes the anchor. A first reading within five minutes after midnight is treated as the day boundary. Starting later without a midnight baseline shows `GENERATED TODAY (PARTIAL)` and counts production from the earliest saved reading today. Missing readings show `— kWh` instead of hiding the counter. Meter resets preserve production already observed and mark the day partial.

When moving from the Wi-Fi address `192.168.91.1`, a unique saved series with the same non-empty site name and timezone can supply its earlier same-day integrated total. The module adds subsequent observed v1r meter growth, displays `≈`, and marks this transition day partial because production during the connection gap cannot be recovered from a lifetime counter. No credentials or manual baseline edits are needed. Normal daily tracking resumes at the next observed midnight boundary.

Legacy gateways whose energy counters remain zero still estimate production by integrating live solar watts while MagicMirror runs. Back up the aggregate-history file before upgrades and keep it across restarts. Upgrading an existing installation requires updating the module and restarting MagicMirror; no RSA re-registration is needed for this display fix.

## Fleet API Token Config

This module does not implement the Tesla OAuth browser login flow, but it can use an existing Fleet API access token or refresh token. Tesla refresh tokens are single-use, so the module saves the rotated token to `.pwtv-fleet-tokens.json` by default.

```js
{
  module: "MMM-PowerWallTV",
  position: "fullscreen_above",
  config: {
    mode: "fleet",
    fleet: {
      baseURL: "https://fleet-api.prd.na.vn.cloud.tesla.com",
      accessToken: "paste-current-access-token-here",
      refreshToken: "paste-refresh-token-here",
      clientId: "your-tesla-application-client-id",
      tokenStorePath: ".pwtv-fleet-tokens.json",
      persistTokens: true,
      energySiteId: "123456789",
      siteName: "Home sweet home"
    }
  }
}
```

If `accessToken` is present, the module can usually infer `clientId` from the token's `azp` claim. If you configure only `refreshToken`, set `clientId` explicitly.

Fleet mode also fetches `calendar_history?kind=energy&period=day` to show the "ENERGY GENERATED TODAY" summary.

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `mode` | `"demo"` | `"demo"`, `"local"`, `"tedapi"` (Wi-Fi), `"v1r"` (option 5 LAN), or `"fleet"` |
| `updateInterval` | `10000` | Refresh interval in milliseconds |
| `width` | `"100%"` | CSS width for the 16:9 scene |
| `maxWidth` | `"1050px"` | Maximum scene width; use this to size lower-third tiles |
| `cornerRadius` | `"18px"` | Rounded corner radius for the whole module |
| `domUpdateAnimationSpeed` | `0` | MagicMirror redraw fade speed; keep at `0` to avoid flashing every refresh |
| `animation` | `true` | Enables animated power-flow traces |
| `gridHysteresisWatts` | `30` | Import/export deadband in watts; readings inside the band keep the previous grid direction to avoid flicker |
| `gridAnimationThresholdWatts` | `30` | Minimum raw grid import/export watts required before grid flow animations are shown |
| `staleDataOnError` | `true` | Keeps the last good snapshot visible when a refresh fails |
| `GridExportWindow.show` | `true` | Display the export-window energy and its battery share during the applicable display hours |
| `GridExportWindow.start` | `"17:00"` | Start time in the module's local timezone, 24-hour `HH:mm` |
| `GridExportWindow.end` | `"21:00"` | Same-day end time, exclusive; `24:00` is allowed |
| `BatteryExportToGridLimit.active` | `false` | Master switch for both configured controls in option 5 |
| `BatteryExportToGridLimit.lowerThreshold` | `70` | Disable battery export below this Tesla-app state-of-charge percentage |
| `BatteryExportToGridLimit.upperThreshold` | `90` | Re-enable battery export at or above this percentage |
| `BatteryExportToGridLimit.gridExport.enabled` | `true` | Control export permission when the master switch is active |
| `BatteryExportToGridLimit.gridExport.inside` | `"battery_ok"` | Inside-window export target: `battery_ok` (subject to thresholds) or `pv_only` |
| `BatteryExportToGridLimit.gridExport.outside` | `"pv_only"` | Outside-window export target; same accepted values |
| `BatteryExportToGridLimit.operationalMode.enabled` | `true` | Control operational mode when the master switch is active |
| `BatteryExportToGridLimit.operationalMode.inside` | `"autonomous"` | Inside-window mode: `autonomous` (savings) or `self_consumption` (self-powered) |
| `BatteryExportToGridLimit.operationalMode.outside` | `"self_consumption"` | Outside-window mode; same accepted values |
| `imageScale` | `1.2` | Zooms the home scene artwork and aligned overlays |
| `imageHorizontalOffset` | `"-2%"` | Moves the zoomed home scene left/right |
| `imageVerticalOffset` | `"3%"` | Moves the zoomed home scene up/down |
| `showSummary` | `true` | Shows site name, daily generation, daily grid exports, the configured export window, and status messages |
| `showGridCarbon` | `true` | Shows renewables percentage and carbon intensity when electricityMaps is configured |
| `showVehicle` | `true` | Shows Wall Connector vehicle label |
| `showHistory` | `false` | Adds a compact live sparkline overlay |
| `showLessPrecision` | `false` | Deprecated; numeric display is fixed to one decimal place |
| `scale` | `1` | Scales the scene without changing layout |
| `horizontalOffset` | `0` | Pixel offset for placement tuning |
| `verticalOffset` | `0` | Pixel offset for placement tuning |

Fleet-specific options:

| Option | Default | Notes |
| --- | --- | --- |
| `fleet.baseURL` | `"https://fleet-api.prd.na.vn.cloud.tesla.com"` | Fleet API region URL; this is the current Australia URL |
| `fleet.accessToken` | `""` | Optional current access token |
| `fleet.refreshToken` | `""` | Optional refresh token used to obtain new access tokens |
| `fleet.clientId` | `""` | Required for refresh when it cannot be inferred from `accessToken` |
| `fleet.tokenURL` | `"https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token"` | Tesla token endpoint |
| `fleet.tokenStorePath` | `".pwtv-fleet-tokens.json"` | Local file for rotated access/refresh tokens |
| `fleet.persistTokens` | `true` | Save refreshed tokens to `tokenStorePath` |
| `fleet.energySiteId` | `""` | Tesla energy site ID |
| `fleet.siteName` | `""` | Label shown in the module |

TEDAPI / v1r options (shared `tedapi` block):

| Option | Default | Notes |
| --- | --- | --- |
| `tedapi.gatewayIP` | `"192.168.91.1"` | Set the reachable LAN IP explicitly for option 5; `10.0.0.98` for the tested installation |
| `tedapi.rsaKeyPath` | `""` | Registered RSA-4096 private key; required in `v1r` mode, also enables v1r in `tedapi` mode |
| `tedapi.gatewayPasswordFile` | `""` | Host-side file containing the full gateway password; takes precedence over other password sources |
| `tedapi.gatewayPassword` / `tedapi.gwPwd` | `""` | Legacy inline full gateway password; prefer a file or `PWTV_TEDAPI_GATEWAY_PASSWORD` |
| `tedapi.python` | `"python3"` | Python executable with requirements installed |
| `tedapi.siteName` | `""` | Display label; uses gateway name when empty |
| `tedapi.timezone` | `""` | Timezone for daily history; defaults to host timezone |
| `tedapi.timeoutSeconds` | `10` | Per-request timeout; minimum 5 seconds. The helper allows time for multiple requests per snapshot |
| `tedapi.retryAttempts` | `3` | Python fetch attempts before reporting a refresh failure |
| `tedapi.retryDelayMs` | `1500` | Delay between attempts |
| `tedapi.aggregateHistoryPath` | `"~/.cache/MMM-PowerWallTV/tedapi-aggregates.json"` | Local cache of hourly aggregate meter readings; set to `""` for memory-only history |
| `tedapi.aggregateHistoryDays` | `30` | Number of days of hourly aggregate meter readings to retain |
| `tedapi.solarIntegrationMaxGapSeconds` | `300` | Maximum gap to integrate when TEDAPI has live solar watts but no cumulative solar Wh counter |

For a lower-third tile, prefer:

```js
config: {
  width: "100%",
  maxWidth: "970px"
}
```

## Screen orientation and motion-sensor integration

MMM-PowerWallTV does not control screen rotation. Configure orientation in Raspberry Pi OS display settings so the desktop and MagicMirror use the same orientation.

If the display rotates when MagicMirror starts or wakes, check other modules that control monitor power. The HomeScreen deployment previously had a `waylandTransform: "270"` override in MMM-PIR-Sensor. The [updated MMM-PIR-Sensor fork](https://github.com/streicherlouw/MMM-PIR-Sensor) removes that override and uses `wlr-randr` only to turn the output on or off. Remove obsolete `waylandTransform` configuration entries when upgrading that module.

On the tested Raspberry Pi OS labwc setup, keep the desktop profile (`~/.config/kanshi/config`) and login-screen profile (`/etc/xdg/labwc-greeter/config.kanshi`) consistent. HomeScreen uses the absolute transform `90`, a 180-degree turn from its former `270` orientation; other mountings may need a different value. See the PIR fork's installation instructions for its Wayland and GPIO requirements. After changing orientation, restart MagicMirror and check a motion-triggered wake to verify the OS setting is retained.

## Notes

Powerwall Gateway certificates are usually self-signed, so `rejectUnauthorized: false` is the practical default for local mode. Keep your MagicMirror `config.js` and `.pwtv-fleet-tokens.json` private because they contain Gateway credentials or Fleet API tokens.

Visual assets are from the MIT-licensed Powerwall-TV project; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

### Export-counter recovery

Daily and premium-window export totals reject decreases and implausible jumps in the cumulative grid-export counter. A temporary zero cannot become a new baseline followed by a lifetime-sized export increment. Two successive readings consistent with a new counter range confirm a reset; only the increment between them is counted, and the total remains partial. The plausibility guard permits up to 100 kW averaged over the elapsed interval, plus 1 kWh tolerance, for this residential dashboard.

On the first refresh after this fix, older export accumulators are rebuilt from retained hourly meter readings. A sample within five minutes before midnight can recover the daily baseline as an estimate. Missing boundary data remains partial; if no useful history remains, tracking starts from the next valid sample. Historical battery attribution may be unavailable after reconstruction. Solar generation history and battery-control settings are unchanged.

### Coupled charge-threshold behavior

The HomeScreen deployment uses `lowerThreshold: 65` and `upperThreshold: 90`. With the configured targets, below 65% the controller sets `pv_only` and `self_consumption` in the same polling cycle. At exactly 65% the previous state is retained. From 65% to below 90%, the gateway export rule retains the on/off state; at 90% or above during the premium window, the pair becomes `battery_ok` and `autonomous`. Outside the window, the configured outside targets apply.

The two API writes are sequential, not atomic: export permission is written and confirmed before operational mode. If the mode write fails, the next poll repairs the mismatch using the confirmed export state. Both lever enable flags and custom mode targets remain supported. Changing the lower threshold alone does not re-arm a battery already stopped by the previous threshold; it still waits for 90%.
