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
    width: "1050px",
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
    width: "1050px",
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

This module does not implement Tesla OAuth. If you already manage a Fleet API token elsewhere, you can display live status with:

```js
{
  module: "MMM-PowerWallTV",
  position: "fullscreen_above",
  config: {
    mode: "fleet",
    fleet: {
      baseURL: "https://fleet-api.prd.na.vn.cloud.tesla.com",
      accessToken: "paste-token-here",
      energySiteId: "123456789",
      siteName: "Home sweet home"
    }
  }
}
```

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `mode` | `"demo"` | `"demo"`, `"local"`, or `"fleet"` |
| `updateInterval` | `10000` | Refresh interval in milliseconds |
| `width` | `"1050px"` | CSS width for the 16:9 scene |
| `animation` | `true` | Enables animated power-flow traces |
| `showSummary` | `true` | Shows site name, generated energy, and status message |
| `showGridCarbon` | `true` | Shows renewables percentage and carbon intensity when electricityMaps is configured |
| `showVehicle` | `true` | Shows Wall Connector vehicle label |
| `showHistory` | `false` | Adds a compact live sparkline overlay |
| `showLessPrecision` | `false` | Uses one decimal place for power values |
| `scale` | `1` | Scales the scene without changing layout |
| `horizontalOffset` | `0` | Pixel offset for placement tuning |
| `verticalOffset` | `0` | Pixel offset for placement tuning |

## Notes

Powerwall Gateway certificates are usually self-signed, so `rejectUnauthorized: false` is the practical default for local mode. Keep your MagicMirror `config.js` private because it contains Gateway credentials or Fleet API tokens.

Visual assets are from the MIT-licensed Powerwall-TV project; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
