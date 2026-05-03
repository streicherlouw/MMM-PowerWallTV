const NodeHelper = require("node_helper");
const http = require("http");
const https = require("https");

module.exports = NodeHelper.create({
  start() {
    this.localSessions = new Map();
    this.gridCache = new Map();
  },

  socketNotificationReceived(notification, payload) {
    if (notification !== "PWTV_FETCH" || !payload) {
      return;
    }

    this.fetchSnapshot(payload.instanceId, payload.config || {})
      .then((snapshot) => {
        this.sendSocketNotification("PWTV_DATA", {
          instanceId: payload.instanceId,
          snapshot
        });
      })
      .catch((error) => {
        this.sendSocketNotification("PWTV_ERROR", {
          instanceId: payload.instanceId,
          error: error.message || String(error)
        });
      });
  },

  async fetchSnapshot(instanceId, config) {
    const startedAt = Date.now();
    const normalized = this.normalizeConfig(config);
    let snapshot;

    if (normalized.mode === "demo" || normalized.local.gatewayIP.toLowerCase() === "demo") {
      snapshot = this.demoSnapshot(normalized);
    } else if (normalized.mode === "fleet") {
      snapshot = await this.fetchFleetSnapshot(normalized);
    } else {
      snapshot = await this.fetchLocalSnapshot(normalized);
    }

    const grid = await this.fetchElectricityMaps(normalized).catch((error) => ({
      errorMessage: `Grid carbon unavailable: ${error.message}`
    }));

    snapshot.instanceId = instanceId;
    snapshot.fetchedAt = new Date().toISOString();
    snapshot.latencyMs = Date.now() - startedAt;

    if (grid) {
      if (Number.isFinite(grid.carbonIntensity)) {
        snapshot.gridCarbonIntensity = grid.carbonIntensity;
      }
      if (Number.isFinite(grid.fossilFuelPercentage)) {
        snapshot.gridFossilFuelPercentage = grid.fossilFuelPercentage;
      }
      if (grid.errorMessage && !snapshot.infoMessage) {
        snapshot.infoMessage = grid.errorMessage;
      }
    }

    return snapshot;
  },

  normalizeConfig(config) {
    const local = Object.assign({
      gatewayIP: "demo",
      email: "",
      password: "",
      protocol: "https",
      rejectUnauthorized: false,
      siteName: "",
      wallConnectorIP: "",
      lastChargingWallConnectorVIN: ""
    }, config.local || {});

    const fleet = Object.assign({
      baseURL: "https://fleet-api.prd.na.vn.cloud.tesla.com",
      accessToken: "",
      energySiteId: "",
      siteName: ""
    }, config.fleet || {});

    const electricityMaps = Object.assign({
      apiKey: "",
      zone: ""
    }, config.electricityMaps || {});

    return {
      mode: String(config.mode || "demo").toLowerCase(),
      local,
      fleet,
      electricityMaps,
      timeoutMs: Number(config.timeoutMs) || 9000
    };
  },

  async fetchLocalSnapshot(config) {
    const gatewayIP = String(config.local.gatewayIP || "").trim();
    if (!gatewayIP) {
      throw new Error("Missing local.gatewayIP.");
    }
    if (!config.local.password) {
      throw new Error("Missing local.password for Gateway login.");
    }

    const protocol = config.local.protocol === "http" ? "http" : "https";
    const baseURL = `${protocol}://${gatewayIP}`;
    const cookie = await this.localLogin(config, baseURL);
    const headers = cookie ? { Cookie: cookie } : {};
    const requestOptions = {
      rejectUnauthorized: config.local.rejectUnauthorized,
      timeoutMs: config.timeoutMs
    };

    const [aggregates, batteryPercentage, gridStatus] = await Promise.all([
      this.requestJson(`${baseURL}/api/meters/aggregates`, { headers }, requestOptions),
      this.requestJson(`${baseURL}/api/system_status/soe`, { headers }, requestOptions),
      this.requestJson(`${baseURL}/api/system_status/grid_status`, { headers }, requestOptions)
    ]);

    const wallConnectors = await this.fetchWallConnector(config).catch(() => []);

    return {
      source: "local",
      siteName: config.local.siteName,
      solarPower: this.numberAt(aggregates, ["solar", "instant_power"]),
      homePower: this.numberAt(aggregates, ["load", "instant_power"]),
      batteryPower: this.numberAt(aggregates, ["battery", "instant_power"]),
      gridPower: this.numberAt(aggregates, ["site", "instant_power"]),
      batteryPercentage: Number(batteryPercentage.percentage) || 0,
      batteryCount: this.numberAt(aggregates, ["battery", "num_meters_aggregated"]),
      solarEnergyExportedWh: this.numberAt(aggregates, ["solar", "energy_exported"]),
      solarEnergyToday: false,
      gridStatus: gridStatus.grid_status || "",
      wallConnectors,
      raw: {
        aggregates,
        batteryPercentage,
        gridStatus
      }
    };
  },

  async localLogin(config, baseURL) {
    const key = `${baseURL}|${config.local.email}`;
    const cached = this.localSessions.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.cookie;
    }

    const body = JSON.stringify({
      username: "customer",
      password: config.local.password,
      email: config.local.email,
      force_sm_off: false
    });

    const response = await this.requestJson(`${baseURL}/api/login/Basic`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      },
      body
    }, {
      rejectUnauthorized: config.local.rejectUnauthorized,
      timeoutMs: config.timeoutMs,
      includeHeaders: true
    });

    const setCookie = response.headers["set-cookie"] || [];
    const cookieList = Array.isArray(setCookie) ? setCookie : [setCookie];
    const authCookie = cookieList
      .map((cookie) => String(cookie).split(";")[0])
      .find((cookie) => cookie.indexOf("AuthCookie=") === 0);

    if (!authCookie) {
      throw new Error("Gateway login failed: no AuthCookie received.");
    }

    this.localSessions.set(key, {
      cookie: authCookie,
      expiresAt: Date.now() + 5 * 60 * 1000
    });

    return authCookie;
  },

  async fetchWallConnector(config) {
    const ip = String(config.local.wallConnectorIP || "").trim();
    if (!ip) {
      return [];
    }

    const vitals = await this.requestJson(`http://${ip}/api/1/vitals`, {}, {
      rejectUnauthorized: false,
      timeoutMs: config.timeoutMs
    });

    return [{
      vin: vitals.vin || config.local.lastChargingWallConnectorVIN || "",
      din: vitals.din || "",
      wallConnectorState: Number(vitals.contactor_closed) ? 1 : Number(vitals.vehicle_connected) ? 4 : 0,
      wallConnectorPower: this.estimateWallConnectorPower(vitals)
    }];
  },

  estimateWallConnectorPower(vitals) {
    const explicit = Number(vitals.wall_connector_power);
    if (Number.isFinite(explicit) && explicit > 0) {
      return explicit;
    }

    const gridVolts = Number(vitals.grid_v);
    const vehicleCurrent = Number(vitals.vehicle_current_a);
    if (Number.isFinite(gridVolts) && Number.isFinite(vehicleCurrent)) {
      return gridVolts * vehicleCurrent;
    }

    return 0;
  },

  async fetchFleetSnapshot(config) {
    const token = String(config.fleet.accessToken || "").trim();
    const energySiteId = String(config.fleet.energySiteId || "").trim();
    if (!token) {
      throw new Error("Missing fleet.accessToken.");
    }
    if (!energySiteId) {
      throw new Error("Missing fleet.energySiteId.");
    }

    const baseURL = String(config.fleet.baseURL || "").replace(/\/$/, "");
    const live = await this.requestJson(`${baseURL}/api/1/energy_sites/${energySiteId}/live_status`, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }, {
      rejectUnauthorized: true,
      timeoutMs: config.timeoutMs
    });

    const response = live.response || {};
    return {
      source: "fleet",
      siteName: config.fleet.siteName || `Energy Site ${energySiteId}`,
      solarPower: Number(response.solar_power) || 0,
      homePower: Number(response.load_power) || 0,
      batteryPower: Number(response.battery_power) || 0,
      gridPower: Number(response.grid_power) || 0,
      batteryPercentage: Number(response.percentage_charged) || 0,
      batteryCount: Number(response.battery_count) || 0,
      solarEnergyExportedWh: 0,
      solarEnergyToday: true,
      gridStatus: response.grid_status || "",
      wallConnectors: Array.isArray(response.wall_connectors) ? response.wall_connectors : [],
      raw: {
        live
      }
    };
  },

  async fetchElectricityMaps(config) {
    const apiKey = String(config.electricityMaps.apiKey || "").trim();
    const zone = String(config.electricityMaps.zone || "").trim();
    if (!apiKey || !zone) {
      return null;
    }

    const cacheKey = `${apiKey.slice(-6)}|${zone}`;
    const cached = this.gridCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const url = `https://api.electricitymaps.com/v3/home-assistant?zone=${encodeURIComponent(zone)}`;
    const payload = await this.requestJson(url, {
      headers: {
        "auth-token": apiKey
      }
    }, {
      rejectUnauthorized: true,
      timeoutMs: config.timeoutMs
    });

    const data = payload.data || payload;
    const value = {
      carbonIntensity: Number(data.carbonIntensity),
      fossilFuelPercentage: Number(data.fossilFuelPercentage)
    };

    this.gridCache.set(cacheKey, {
      value,
      expiresAt: Date.now() + 15 * 60 * 1000
    });

    return value;
  },

  demoSnapshot(config) {
    const now = Date.now() / 1000;
    const solar = Math.max(0, 4200 + Math.sin(now / 20) * 1600 + Math.sin(now / 7) * 500);
    const home = Math.max(300, 2300 + Math.sin(now / 13) * 700);
    const vehiclePower = Math.sin(now / 45) > 0.2 ? 1800 + Math.sin(now / 8) * 300 : 0;
    const battery = solar - home - vehiclePower - 700;
    const grid = home + vehiclePower - solar - Math.max(0, battery);
    const batteryPercentage = 72 + Math.sin(now / 90) * 11;
    const wallConnectors = config.local.wallConnectorIP || config.mode === "demo" ? [{
      vin: "7G2CEHED0RA000000",
      din: "demo",
      wallConnectorState: vehiclePower > 10 ? 1 : 4,
      wallConnectorPower: Math.max(0, vehiclePower)
    }] : [];

    return {
      source: "demo",
      siteName: config.local.siteName || "Home sweet home",
      solarPower: solar,
      homePower: home + vehiclePower,
      batteryPower: battery,
      gridPower: grid,
      batteryPercentage,
      batteryCount: 1,
      solarEnergyExportedWh: 40960 + (Math.sin(now / 60) + 1) * 2200,
      solarEnergyToday: false,
      gridStatus: "SystemGridConnected",
      gridCarbonIntensity: 187,
      gridFossilFuelPercentage: 34,
      wallConnectors,
      infoMessage: "Demo data"
    };
  },

  requestJson(urlString, requestOptions = {}, transportOptions = {}) {
    const url = new URL(urlString);
    const transport = url.protocol === "http:" ? http : https;
    const method = requestOptions.method || "GET";
    const headers = requestOptions.headers || {};
    const body = requestOptions.body;
    const timeoutMs = transportOptions.timeoutMs || 9000;

    const options = {
      method,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      headers,
      timeout: timeoutMs
    };

    if (url.protocol === "https:") {
      options.rejectUnauthorized = transportOptions.rejectUnauthorized !== false;
    }

    return new Promise((resolve, reject) => {
      const req = transport.request(options, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`${method} ${url.pathname} failed with ${res.statusCode}: ${text.slice(0, 180)}`));
            return;
          }

          let data = {};
          if (text.trim()) {
            try {
              data = JSON.parse(text);
            } catch (error) {
              reject(new Error(`${method} ${url.pathname} returned invalid JSON.`));
              return;
            }
          }

          if (transportOptions.includeHeaders) {
            resolve({ data, headers: res.headers, statusCode: res.statusCode });
            return;
          }

          resolve(data);
        });
      });

      req.on("timeout", () => req.destroy(new Error(`${method} ${url.hostname}${url.pathname} timed out after ${timeoutMs}ms.`)));
      req.on("error", reject);

      if (body) {
        req.write(body);
      }
      req.end();
    });
  },

  numberAt(object, path) {
    const value = path.reduce((current, key) => current && current[key], object);
    return Number(value) || 0;
  }
});
