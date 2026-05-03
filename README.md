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

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `mode` | `"demo"` | `"demo"`, `"local"`, or `"fleet"` |
| `updateInterval` | `10000` | Refresh interval in milliseconds |
| `width` | `"100%"` | CSS width for the 16:9 scene |
| `maxWidth` | `"1050px"` | Maximum scene width; use this to size lower-third tiles |
| `cornerRadius` | `"18px"` | Rounded corner radius for the whole module |
| `domUpdateAnimationSpeed` | `0` | MagicMirror redraw fade speed; keep at `0` to avoid flashing every refresh |
| `animation` | `true` | Enables animated power-flow traces |
| `imageScale` | `1.2` | Zooms the home scene artwork and aligned overlays |
| `imageHorizontalOffset` | `"-4%"` | Moves the zoomed home scene left/right |
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
