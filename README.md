# MMM-PowerWallTV

A MagicMirror module inspired by [sighmon/Powerwall-TV](https://github.com/sighmon/Powerwall-TV). It renders a TV-style Tesla Powerwall scene with live solar, home, Powerwall, grid, optional Wall Connector, battery state, animated power flows, demo mode, and optional electricityMaps grid carbon data.

The module is local-first: the Node helper fetches data from your MagicMirror host and sends a display snapshot to the browser module. For Powerwall 3, the recommended setup is **option 5: RSA-authenticated v1r LAN access through pyPowerwall**. Existing Wi-Fi TEDAPI, local Gateway and Fleet API configurations remain supported.

## Install

Start with a working MagicMirror installation and its supported Node.js version. This module's test runner requires Node.js 18+ and Python 3. No additional npm packages are needed. On Raspberry Pi OS, install `python3-venv` if `python3 -m venv` is unavailable:

```bash
sudo apt install python3-venv
```

Clone or copy this folder into your MagicMirror `modules` directory:

```bash
cd ~/MagicMirror/modules
git clone https://github.com/streicherlouw/MMM-PowerWallTV.git
cd MMM-PowerWallTV
npm test
```

`npm test` runs the JavaScript syntax checks and 28 automated tests without contacting a Powerwall. Continue with the option 5 setup below for Powerwall 3, or use the demo configuration to preview the display without hardware.

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
    BatteryExportToGridLimit: {
      active: false,
      lowerThreshold: 70,
      upperThreshold: 90
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

Successful output is one JSON snapshot with `source: "v1r"` and `raw.tedapiMode: "v1r"`. It includes power flows, battery percentage/count, backup-time estimate, solar strings, aggregate meters and the current `gridExportMode`. The v1r battery percentage uses Tesla's app scale. The module is read-only by default; the optional `BatteryExportToGridLimit` feature below can change battery export permission. It never changes backup reserve or opens/closes the grid contactor.

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
```

If Git reports local source changes, preserve or commit them before pulling; do not discard a deployed customization with a hard reset. For a clean checkout on `main`:

```bash
git pull --ff-only origin main
.venv/bin/python -m pip install -r requirements.txt
npm test
```

Substitute the executable from `tedapi.python` when using a separate environment. Run the read-only smoke test above, review `BatteryExportToGridLimit.active`, then restart MagicMirror. Updates preserve the Git-ignored `.auth` directory and the energy-history file outside the repository. Keep your own secure backup of the registered RSA key; a replacement key must be registered separately.

To roll back, restore the saved configuration and your saved code revision, then restart with the previous Python environment. Disabling or rolling back the automation does **not** undo its last gateway export setting.

### Migrating the existing Wi-Fi deployment

Keep the current display and `tedapi` settings, change `mode` to `"v1r"` and `tedapi.gatewayIP` to the reachable LAN address, then add `rsaKeyPath` and `gatewayPasswordFile`. Remove `gatewayPassword` / `gwPwd` from `config.js` after creating the password file. Keep the existing aggregate-history file; history is partitioned by gateway address, site name and timezone, so the new LAN address starts a new series and may initially have no midnight baseline.

The hourly-meter and live-power-integration logic is unchanged. A cumulative solar meter is a lifetime counter, not automatically today's generation. Until the relevant history baseline exists, the module does not present the whole counter as generation today.

Missing keys, unverified keys, authentication errors or unavailable readings produce a refresh error. With `staleDataOnError: true`, the last good display remains visible. A missing Python package requires installation in `tedapi.python`'s environment. A connection timeout requires checking LAN reachability; changing the address alone cannot enable v1r on an unsupported interface.

## BatteryExportToGridLimit

Option 5 can automatically allow or disable **battery** export according to state of charge. The feature is inactive by default. Add this top-level block inside the module's `config` to activate it:

```js
BatteryExportToGridLimit: {
  active: true,
  lowerThreshold: 70,
  upperThreshold: 90
},
```

| Charge (Tesla-app percentage) | Action when active |
| --- | --- |
| Below `lowerThreshold` (e.g. less than 70%) | Set `pv_only`: stop battery export while permitting solar export |
| From `lowerThreshold` up to, but below, `upperThreshold` (70% to less than 90%) | Retain the gateway's existing export setting |
| At or above `upperThreshold` (90% or more) | Set `battery_ok`: allow battery and solar export |

For example, export enabled at 95% remains enabled through 80% and exactly 70%, then switches off below 70%. It stays off as the battery charges through 80%, and switches on again at 90%. The gateway setting stores the on/off state, so restarting MagicMirror in the middle band does not accidentally re-enable export. On first activation at 80%, an existing `pv_only` setting stays off until 90%; an existing `battery_ok` setting stays on until below 70%. Manual changes in that middle band are retained.

Every successful v1r battery refresh reads the current export setting, even while this feature is inactive. When active, the module sends a write only if a threshold requires a different setting, then reads the setting back to confirm it. Overlapping identical requests share one read/control cycle. No write is sent if charge or the current export setting is unavailable. Failed or unconfirmed control writes leave telemetry visible with a status message and are reconsidered on the next refresh.

The site-wide `never` rule prohibits solar export too, so this feature preserves it and reports that automation is blocked. Use `pv_only` as the starting rule when you want this feature to manage battery export. Allowing battery export grants permission; Tesla's operating mode, backup reserve and site limits still determine actual power flow.

Set `active: false` to stop automatic changes. This leaves the current gateway export permission unchanged. Both thresholds must be numbers with `0 <= lowerThreshold < upperThreshold <= 100`. Active control requires option 5 and a registered RSA key; it is not supported in demo, local JSON, Wi-Fi TEDAPI or Fleet mode.

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

TEDAPI mode asks the local gateway for `/api/meters/aggregates` and stores one aggregate meter reading per local hour. If the gateway exposes a non-zero cumulative solar meter counter, the default `~/.cache/MMM-PowerWallTV/tedapi-aggregates.json` history is used to show `GENERATED TODAY` by subtracting the latest cached solar meter reading before local midnight from the current cumulative solar reading. Some Powerwall 3 TEDAPI/v1r systems report live solar power but leave aggregate energy counters at `0`; on those systems the module estimates `GENERATED TODAY` locally by integrating live solar watts over time while MagicMirror is running.

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
| `BatteryExportToGridLimit.active` | `false` | Enable automatic battery export permission control in option 5 |
| `BatteryExportToGridLimit.lowerThreshold` | `70` | Disable battery export below this Tesla-app state-of-charge percentage |
| `BatteryExportToGridLimit.upperThreshold` | `90` | Re-enable battery export at or above this percentage |
| `imageScale` | `1.2` | Zooms the home scene artwork and aligned overlays |
| `imageHorizontalOffset` | `"-2%"` | Moves the zoomed home scene left/right |
| `imageVerticalOffset` | `"3%"` | Moves the zoomed home scene up/down |
| `showSummary` | `true` | Shows site name, generated energy, and status message |
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

## Notes

Powerwall Gateway certificates are usually self-signed, so `rejectUnauthorized: false` is the practical default for local mode. Keep your MagicMirror `config.js` and `.pwtv-fleet-tokens.json` private because they contain Gateway credentials or Fleet API tokens.

Visual assets are from the MIT-licensed Powerwall-TV project; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
