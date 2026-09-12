# MMM-PowerWallTV

A MagicMirror module inspired by [sighmon/Powerwall-TV](https://github.com/sighmon/Powerwall-TV). It renders a TV-style Tesla Powerwall scene with live solar, home, Powerwall, grid, optional Wall Connector, battery state, animated power flows, demo mode, and optional electricityMaps grid carbon data.

The module is local-first: the Node helper logs in to the Tesla Gateway API from your MagicMirror host and sends only the display snapshot to the browser module.

## Install

Clone or copy this folder into your MagicMirror `modules` directory:

```bash
cd ~/MagicMirror/modules
git clone <your-repo-url> MMM-PowerWallTV
cd MMM-PowerWallTV
npm test
```

No npm dependencies are required.

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

## TEDAPI Config

Powerwall 3 systems do not expose the older local JSON portal API. Use TEDAPI instead, with the full gateway Wi-Fi password from the Tesla QR label. The MagicMirror host must be able to reach `192.168.91.1`, either by joining the Powerwall Wi-Fi or through a working static route.

TEDAPI support uses the Python `pypowerwall` package:

```bash
cd ~/MagicMirror/modules/MMM-PowerWallTV
python3 -m venv .venv
.venv/bin/python -m pip install pypowerwall
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
| `mode` | `"demo"` | `"demo"`, `"local"`, `"tedapi"`, or `"fleet"` |
| `updateInterval` | `10000` | Refresh interval in milliseconds |
| `width` | `"100%"` | CSS width for the 16:9 scene |
| `maxWidth` | `"1050px"` | Maximum scene width; use this to size lower-third tiles |
| `cornerRadius` | `"18px"` | Rounded corner radius for the whole module |
| `domUpdateAnimationSpeed` | `0` | MagicMirror redraw fade speed; keep at `0` to avoid flashing every refresh |
| `animation` | `true` | Enables animated power-flow traces |
| `gridHysteresisWatts` | `30` | Import/export deadband in watts; readings inside the band keep the previous grid direction to avoid flicker |
| `gridAnimationThresholdWatts` | `30` | Minimum raw grid import/export watts required before grid flow animations are shown |
| `staleDataOnError` | `true` | Keeps the last good snapshot visible when a refresh fails |
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

TEDAPI-specific options:

| Option | Default | Notes |
| --- | --- | --- |
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
