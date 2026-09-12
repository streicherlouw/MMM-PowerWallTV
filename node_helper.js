const NodeHelper = require("node_helper");
const { execFile } = require("child_process");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");

module.exports = NodeHelper.create({
  start() {
    this.localSessions = new Map();
    this.gridCache = new Map();
    this.fleetTokenMemory = new Map();
    this.fleetSolarEnergyCache = new Map();
    this.tedapiAggregateHistoryMemory = new Map();
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

    if (normalized.mode === "demo" || (normalized.mode === "local" && normalized.local.gatewayIP.toLowerCase() === "demo")) {
      snapshot = this.demoSnapshot(normalized);
    } else if (normalized.mode === "fleet") {
      snapshot = await this.fetchFleetSnapshot(normalized);
    } else if (normalized.mode === "tedapi") {
      snapshot = await this.fetchTedapiSnapshot(normalized);
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
      gatewayPassword: "",
      gwPwd: "",
      protocol: "https",
      rejectUnauthorized: false,
      siteName: "",
      wallConnectorIP: "",
      lastChargingWallConnectorVIN: ""
    }, config.local || {});

    const tedapi = Object.assign({
      gatewayIP: local.gatewayIP || "192.168.91.1",
      gatewayPassword: "",
      gwPwd: "",
      python: "python3",
      siteName: local.siteName || "",
      timezone: "",
      timeoutSeconds: 10,
      retryAttempts: 3,
      retryDelayMs: 1500,
      solarStringKeys: ["A", "B", "C"],
      solarStringGroups: [["A", "B"], ["C", "D"], ["E", "F"]],
      solarStringLabels: [],
      showSolarStringLabels: false,
      solarStringPanelCount: 12,
      solarStringPanelWatts: 480,
      aggregateHistoryPath: "~/.cache/MMM-PowerWallTV/tedapi-aggregates.json",
      aggregateHistoryDays: 30,
      solarIntegrationMaxGapSeconds: 300
    }, config.tedapi || {});
    tedapi.gatewayIP = tedapi.gatewayIP || local.gatewayIP || "192.168.91.1";
    tedapi.siteName = tedapi.siteName || local.siteName || "";
    tedapi.gatewayPassword = tedapi.gatewayPassword || tedapi.gwPwd || local.gatewayPassword || local.gwPwd || (
      String(config.mode || "").toLowerCase() === "tedapi" ? local.password : ""
    );

    const fleet = Object.assign({
      baseURL: "https://fleet-api.prd.na.vn.cloud.tesla.com",
      accessToken: "",
      refreshToken: "",
      clientId: "",
      tokenURL: "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token",
      tokenStorePath: ".pwtv-fleet-tokens.json",
      persistTokens: true,
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
      tedapi,
      fleet,
      electricityMaps,
      timeoutMs: Number(config.timeoutMs) || 9000
    };
  },

  async fetchTedapiSnapshot(config) {
    const gatewayIP = String(config.tedapi.gatewayIP || "").trim();
    const gatewayPassword = String(config.tedapi.gatewayPassword || "").trim();
    if (!gatewayIP) {
      throw new Error("Missing tedapi.gatewayIP.");
    }
    if (!gatewayPassword) {
      throw new Error("Missing tedapi.gatewayPassword.");
    }

    const timeoutSeconds = Math.max(5, Number(config.tedapi.timeoutSeconds) || 10);
    const retryAttempts = Math.max(1, Number(config.tedapi.retryAttempts) || 3);
    const retryDelayMs = Math.max(0, Number(config.tedapi.retryDelayMs) || 1500);
    const payload = await this.execJsonFile(String(config.tedapi.python || "python3"), [
      path.join(__dirname, "scripts", "fetch-tedapi.py"),
      "--host", gatewayIP,
      "--site-name", String(config.tedapi.siteName || ""),
      "--timezone", String(config.tedapi.timezone || this.localTimeZone()),
      "--timeout", String(timeoutSeconds)
    ], {
      timeoutMs: Math.max(config.timeoutMs, timeoutSeconds * 1000 + 10000),
      attempts: retryAttempts,
      retryDelayMs,
      env: {
        PWTV_TEDAPI_GATEWAY_PASSWORD: gatewayPassword
      }
    });

    const aggregateMeters = payload.aggregateMeters && typeof payload.aggregateMeters === "object" && !Array.isArray(payload.aggregateMeters)
      ? payload.aggregateMeters
      : {};
    let tedapiEnergy = {
      hasBaseline: false,
      solarEnergyTodayWh: 0,
      solarEnergyCumulativeWh: Number(payload.solarEnergyExportedWh) || 0,
      solarEnergyEstimated: false,
      solarEnergySource: "meter"
    };
    let infoMessage = "";
    try {
      tedapiEnergy = this.updateTedapiAggregateHistory(config, aggregateMeters, Number(payload.solarPower) || 0);
    } catch (error) {
      infoMessage = `TEDAPI aggregate cache unavailable: ${error.message}`;
    }

    return {
      source: "tedapi",
      siteName: config.tedapi.siteName || payload.siteName || "",
      solarPower: Number(payload.solarPower) || 0,
      homePower: Number(payload.homePower) || 0,
      batteryPower: Number(payload.batteryPower) || 0,
      gridPower: Number(payload.gridPower) || 0,
      batteryPercentage: Number(payload.batteryPercentage) || 0,
      batteryCount: Number(payload.batteryCount) || 0,
      timeRemainingHours: Number(payload.timeRemainingHours) || 0,
      solarStrings: payload.solarStrings || {},
      solarEnergyExportedWh: tedapiEnergy.hasBaseline ? tedapiEnergy.solarEnergyTodayWh : 0,
      solarEnergyToday: tedapiEnergy.hasBaseline,
      solarEnergyCumulativeWh: tedapiEnergy.solarEnergyCumulativeWh,
      solarEnergyEstimated: tedapiEnergy.solarEnergyEstimated,
      solarEnergySource: tedapiEnergy.solarEnergySource,
      gridStatus: this.normalizeTedapiGridStatus(payload.gridStatus),
      wallConnectors: [],
      infoMessage,
      raw: {
        tedapi: payload.raw || payload,
        tedapiAggregateHistory: {
          hasBaseline: tedapiEnergy.hasBaseline,
          baselineObservedAt: tedapiEnergy.baselineObservedAt || "",
          baselineHourKey: tedapiEnergy.baselineHourKey || "",
          currentHourKey: tedapiEnergy.currentHourKey || "",
          solarEnergySource: tedapiEnergy.solarEnergySource || "",
          historyPath: tedapiEnergy.historyPath || ""
        }
      }
    };
  },

  updateTedapiAggregateHistory(config, aggregateMeters, solarPowerW = 0) {
    const currentWh = this.numberAt(aggregateMeters, ["solar", "energy_exported"]);
    const currentPowerW = Math.max(0, Number(solarPowerW) || this.numberAt(aggregateMeters, ["solar", "instant_power"]));
    if (!aggregateMeters || !Object.keys(aggregateMeters).length) {
      return {
        hasBaseline: false,
        solarEnergyTodayWh: 0,
        solarEnergyCumulativeWh: Math.max(0, currentWh || 0),
        solarEnergyEstimated: false,
        solarEnergySource: "unavailable"
      };
    }

    const observedAt = new Date();
    const timeZone = this.effectiveTedapiTimeZone(config);
    const local = this.localTimeParts(observedAt, timeZone);
    const hourKey = `${local.date}T${String(local.hour).padStart(2, "0")}`;
    const historyPath = this.resolveTedapiAggregateHistoryPath(config);
    const store = this.loadTedapiAggregateHistoryStore(config);
    const siteKey = this.tedapiAggregateHistoryKey(config, timeZone);
    const siteHistory = store.sites[siteKey] || {
      gatewayIP: String(config.tedapi.gatewayIP || ""),
      siteName: String(config.tedapi.siteName || ""),
      timeZone,
      readings: [],
      daily: {
        localDate: local.date,
        solarEnergyTodayWh: 0
      }
    };

    const readings = Array.isArray(siteHistory.readings) ? siteHistory.readings : [];
    const hasUsableMeterCounter = Number.isFinite(currentWh) && currentWh > 0;
    let solarEnergyTodayWh = 0;
    let hasBaseline = false;
    let baseline = null;
    let source = "integrated_power";

    if (hasUsableMeterCounter) {
      source = "meter";
      baseline = this.tedapiTodayBaseline(readings, local.date);
      if (baseline) {
        solarEnergyTodayWh = Math.max(0, currentWh - (Number(baseline.solarEnergyExportedWh) || 0));
        hasBaseline = true;
      }
    } else {
      const daily = siteHistory.daily && siteHistory.daily.localDate === local.date
        ? siteHistory.daily
        : {
          localDate: local.date,
          solarEnergyTodayWh: 0
        };
      solarEnergyTodayWh = Math.max(0, Number(daily.solarEnergyTodayWh) || 0);
      const previousSample = siteHistory.lastSample || null;
      if (previousSample && previousSample.localDate === local.date) {
        const previousAt = Date.parse(previousSample.observedAt);
        const elapsedSeconds = (observedAt.getTime() - previousAt) / 1000;
        const maxGapSeconds = Math.max(10, Number(config.tedapi.solarIntegrationMaxGapSeconds) || 300);
        if (Number.isFinite(elapsedSeconds) && elapsedSeconds > 0 && elapsedSeconds <= maxGapSeconds) {
          const previousPowerW = Math.max(0, Number(previousSample.solarPowerW) || 0);
          solarEnergyTodayWh += ((previousPowerW + currentPowerW) / 2) * (elapsedSeconds / 3600);
        }
      }
      siteHistory.daily = {
        localDate: local.date,
        solarEnergyTodayWh
      };
      siteHistory.lastSample = {
        observedAt: observedAt.toISOString(),
        localDate: local.date,
        localHour: local.hour,
        solarPowerW: currentPowerW
      };
      hasBaseline = true;
    }

    const nextReading = {
      hourKey,
      localDate: local.date,
      localHour: local.hour,
      observedAt: observedAt.toISOString(),
      solarEnergyExportedWh: currentWh,
      solarEnergyTodayWh,
      solarPowerW: currentPowerW,
      solarEnergySource: source,
      solarEnergyEstimated: source !== "meter",
      aggregates: aggregateMeters
    };
    const existingIndex = readings.findIndex((reading) => reading && reading.hourKey === hourKey);
    if (existingIndex >= 0) {
      readings[existingIndex] = nextReading;
    } else {
      readings.push(nextReading);
    }

    const retentionDays = Math.max(1, Number(config.tedapi.aggregateHistoryDays) || 30);
    const cutoffMs = observedAt.getTime() - retentionDays * 24 * 60 * 60 * 1000;
    siteHistory.readings = readings
      .filter((reading) => reading && Date.parse(reading.observedAt) >= cutoffMs)
      .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
    siteHistory.gatewayIP = String(config.tedapi.gatewayIP || "");
    siteHistory.siteName = String(config.tedapi.siteName || "");
    siteHistory.timeZone = timeZone;
    siteHistory.updatedAt = observedAt.toISOString();
    store.version = 1;
    store.sites[siteKey] = siteHistory;
    store.updatedAt = observedAt.toISOString();
    this.saveTedapiAggregateHistoryStore(config, store);

    if (!hasBaseline) {
      return {
        hasBaseline: false,
        solarEnergyTodayWh: 0,
        solarEnergyCumulativeWh: currentWh,
        currentHourKey: hourKey,
        solarEnergyEstimated: false,
        solarEnergySource: source,
        historyPath
      };
    }

    return {
      hasBaseline: true,
      solarEnergyTodayWh,
      solarEnergyCumulativeWh: currentWh,
      solarEnergyEstimated: source !== "meter",
      solarEnergySource: source,
      baselineObservedAt: baseline ? baseline.observedAt || "" : "",
      baselineHourKey: baseline ? baseline.hourKey || "" : "",
      currentHourKey: hourKey,
      historyPath
    };
  },

  tedapiTodayBaseline(readings, todayDate) {
    const usable = (Array.isArray(readings) ? readings : [])
      .filter((reading) => reading && Number.isFinite(Number(reading.solarEnergyExportedWh)));
    const previous = usable
      .filter((reading) => String(reading.localDate || "") < todayDate)
      .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
    if (previous.length) {
      return previous[0];
    }

    return usable
      .filter((reading) => String(reading.localDate || "") === todayDate && Number(reading.localHour) === 0)
      .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))[0] || null;
  },

  loadTedapiAggregateHistoryStore(config) {
    const historyPath = this.resolveTedapiAggregateHistoryPath(config);
    const memoryKey = historyPath || "default";
    const memoryStore = this.tedapiAggregateHistoryMemory.get(memoryKey);
    if (memoryStore) {
      return memoryStore;
    }

    let store = { version: 1, sites: {} };
    if (historyPath && fs.existsSync(historyPath)) {
      try {
        store = JSON.parse(fs.readFileSync(historyPath, "utf8"));
      } catch (error) {
        throw new Error(`Unable to read TEDAPI aggregate history ${historyPath}: ${error.message}`);
      }
    }

    if (!store || typeof store !== "object") {
      store = { version: 1, sites: {} };
    }
    if (!store.sites || typeof store.sites !== "object") {
      store.sites = {};
    }

    this.tedapiAggregateHistoryMemory.set(memoryKey, store);
    return store;
  },

  saveTedapiAggregateHistoryStore(config, store) {
    const historyPath = this.resolveTedapiAggregateHistoryPath(config);
    const memoryKey = historyPath || "default";
    this.tedapiAggregateHistoryMemory.set(memoryKey, store);
    if (!historyPath) {
      return;
    }

    const directory = path.dirname(historyPath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = `${historyPath}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, historyPath);
    try {
      fs.chmodSync(historyPath, 0o600);
    } catch (error) {
      // Best-effort permissions; Windows and some filesystems may not support chmod.
    }
  },

  resolveTedapiAggregateHistoryPath(config) {
    const configuredPath = String(config.tedapi.aggregateHistoryPath || "").trim();
    if (!configuredPath) {
      return "";
    }
    if (configuredPath === "~" || configuredPath.startsWith("~/")) {
      return path.join(os.homedir(), configuredPath.slice(2));
    }
    return path.isAbsolute(configuredPath) ? configuredPath : path.join(__dirname, configuredPath);
  },

  tedapiAggregateHistoryKey(config, timeZone) {
    return [
      String(config.tedapi.gatewayIP || ""),
      String(config.tedapi.siteName || ""),
      timeZone
    ].join("|");
  },

  effectiveTedapiTimeZone(config) {
    const configured = String(config.tedapi.timezone || this.localTimeZone() || "Etc/UTC").trim() || "Etc/UTC";
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: configured }).format(new Date());
      return configured;
    } catch (error) {
      return this.localTimeZone();
    }
  },

  localTimeParts(date, timeZone) {
    const parts = {};
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23"
    });
    formatter.formatToParts(date).forEach((part) => {
      if (part.type !== "literal") {
        parts[part.type] = part.value;
      }
    });
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      hour: Number(parts.hour) || 0
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
    const energySiteId = String(config.fleet.energySiteId || "").trim();
    if (!energySiteId) {
      throw new Error("Missing fleet.energySiteId.");
    }

    const baseURL = String(config.fleet.baseURL || "").replace(/\/$/, "");
    let tokenState = await this.getFleetToken(config);
    let live;
    let solarEnergyTodayWh = 0;

    try {
      live = await this.fetchFleetLiveStatus(config, baseURL, energySiteId, tokenState.accessToken);
    } catch (error) {
      if (!this.isAuthError(error) || !tokenState.refreshToken) {
        throw error;
      }
      tokenState = await this.getFleetToken(config, true);
      live = await this.fetchFleetLiveStatus(config, baseURL, energySiteId, tokenState.accessToken);
    }

    solarEnergyTodayWh = await this.fetchFleetSolarEnergyToday(config, baseURL, energySiteId, tokenState.accessToken)
      .catch(() => 0);

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
      solarEnergyExportedWh: solarEnergyTodayWh,
      solarEnergyToday: true,
      gridStatus: response.grid_status || "",
      wallConnectors: Array.isArray(response.wall_connectors) ? response.wall_connectors : [],
      raw: {
        live
      }
    };
  },

  fetchFleetLiveStatus(config, baseURL, energySiteId, accessToken) {
    if (!accessToken) {
      throw new Error("Missing fleet.accessToken or refreshable fleet.refreshToken.");
    }

    return this.requestJson(`${baseURL}/api/1/energy_sites/${energySiteId}/live_status`, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }, {
      rejectUnauthorized: true,
      timeoutMs: config.timeoutMs
    });
  },

  async fetchFleetSolarEnergyToday(config, baseURL, energySiteId, accessToken) {
    if (!accessToken) {
      return 0;
    }

    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    const timeZone = this.localTimeZone();
    const cacheKey = `${baseURL}|${energySiteId}|${startOfDay.toISOString()}|${timeZone}`;
    const cached = this.fleetSolarEnergyCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const params = new URLSearchParams({
      kind: "energy",
      period: "day",
      start_date: startOfDay.toISOString(),
      end_date: now.toISOString(),
      time_zone: timeZone
    });

    const payload = await this.requestJson(`${baseURL}/api/1/energy_sites/${energySiteId}/calendar_history?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }, {
      rejectUnauthorized: true,
      timeoutMs: config.timeoutMs
    });

    const points = payload && payload.response && Array.isArray(payload.response.time_series)
      ? payload.response.time_series
      : [];

    const value = points.reduce((total, point) => total + (Number(point.solar_energy_exported) || 0), 0);
    this.fleetSolarEnergyCache.set(cacheKey, {
      value,
      expiresAt: Date.now() + 60 * 1000
    });
    return value;
  },

  localTimeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC";
    } catch (error) {
      return "Etc/UTC";
    }
  },

  async getFleetToken(config, forceRefresh = false) {
    const stored = this.loadFleetTokenStore(config);
    const accessToken = String(stored.accessToken || config.fleet.accessToken || "").trim();
    const refreshToken = String(stored.refreshToken || config.fleet.refreshToken || "").trim();
    const clientId = String(config.fleet.clientId || stored.clientId || this.clientIdFromAccessToken(accessToken) || "").trim();
    const expiresAt = Number(stored.expiresAt) || this.expiresAtFromAccessToken(accessToken) || 0;
    const refreshMarginMs = 60 * 1000;

    if (!forceRefresh && accessToken && (!expiresAt || Date.now() < expiresAt - refreshMarginMs)) {
      return {
        accessToken,
        refreshToken,
        clientId,
        expiresAt
      };
    }

    if (!refreshToken) {
      if (accessToken) {
        return {
          accessToken,
          refreshToken: "",
          clientId,
          expiresAt
        };
      }
      throw new Error("Missing fleet.accessToken or fleet.refreshToken.");
    }

    if (!clientId) {
      throw new Error("Missing fleet.clientId for refresh-token exchange.");
    }

    return this.refreshFleetToken(config, refreshToken, clientId);
  },

  async refreshFleetToken(config, refreshToken, clientId) {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken
    }).toString();

    const tokenURL = String(config.fleet.tokenURL || "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token");
    const payload = await this.requestJson(tokenURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body)
      },
      body
    }, {
      rejectUnauthorized: true,
      timeoutMs: config.timeoutMs
    });

    const accessToken = String(payload.access_token || "").trim();
    const nextRefreshToken = String(payload.refresh_token || refreshToken).trim();
    if (!accessToken) {
      throw new Error("Refresh-token exchange did not return an access token.");
    }

    const expiresAt = Number(payload.expires_in)
      ? Date.now() + (Number(payload.expires_in) * 1000)
      : this.expiresAtFromAccessToken(accessToken);

    const tokenState = {
      accessToken,
      refreshToken: nextRefreshToken,
      clientId,
      expiresAt,
      updatedAt: new Date().toISOString()
    };

    this.saveFleetTokenStore(config, tokenState);
    return tokenState;
  },

  loadFleetTokenStore(config) {
    const tokenStorePath = this.resolveTokenStorePath(config);
    const memoryKey = tokenStorePath || "default";
    const memoryTokenState = this.fleetTokenMemory.get(memoryKey);
    if (memoryTokenState) {
      return memoryTokenState;
    }

    if (!config.fleet.persistTokens || !tokenStorePath || !fs.existsSync(tokenStorePath)) {
      return {};
    }

    try {
      return JSON.parse(fs.readFileSync(tokenStorePath, "utf8"));
    } catch (error) {
      throw new Error(`Unable to read Fleet token store ${tokenStorePath}: ${error.message}`);
    }
  },

  saveFleetTokenStore(config, tokenState) {
    const tokenStorePath = this.resolveTokenStorePath(config);
    const memoryKey = tokenStorePath || "default";
    this.fleetTokenMemory.set(memoryKey, tokenState);

    if (!config.fleet.persistTokens) {
      return;
    }

    if (!tokenStorePath) {
      return;
    }

    const directory = path.dirname(tokenStorePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = `${tokenStorePath}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(tokenState, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryPath, tokenStorePath);
    try {
      fs.chmodSync(tokenStorePath, 0o600);
    } catch (error) {
      // Best-effort permissions; Windows and some filesystems may not support chmod.
    }
  },

  resolveTokenStorePath(config) {
    const configuredPath = String(config.fleet.tokenStorePath || "").trim();
    if (!configuredPath) {
      return "";
    }
    return path.isAbsolute(configuredPath) ? configuredPath : path.join(__dirname, configuredPath);
  },

  isAuthError(error) {
    return error && (error.statusCode === 401 || error.statusCode === 403);
  },

  clientIdFromAccessToken(accessToken) {
    const claims = this.decodeJwt(accessToken);
    return claims ? claims.azp || claims.client_id || "" : "";
  },

  expiresAtFromAccessToken(accessToken) {
    const claims = this.decodeJwt(accessToken);
    return claims && Number(claims.exp) ? Number(claims.exp) * 1000 : 0;
  },

  decodeJwt(token) {
    const parts = String(token || "").split(".");
    if (parts.length < 2) {
      return null;
    }

    try {
      const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
      return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    } catch (error) {
      return null;
    }
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

  normalizeTedapiGridStatus(status) {
    const value = String(status || "").trim().toUpperCase();
    if (value === "DOWN" || value === "OFF_GRID" || value === "ISLANDED") {
      return "SystemIslandedActive";
    }
    if (value === "UP" || value === "CONNECTED" || value === "GRID_CONNECTED") {
      return "SystemGridConnected";
    }
    return status || "";
  },

  async execJsonFile(command, args, options = {}) {
    const env = Object.assign({}, process.env, options.env || {});
    const attempts = Math.max(1, Number(options.attempts) || 1);
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await new Promise((resolve, reject) => {
          execFile(command, args, {
            env,
            timeout: options.timeoutMs || 15000,
            maxBuffer: 1024 * 1024
          }, (error, stdout, stderr) => {
            if (error) {
              reject(this.helperError(error, stdout, stderr));
              return;
            }

            try {
              resolve(JSON.parse(stdout));
            } catch (parseError) {
              reject(new Error(`TEDAPI helper returned invalid JSON: ${String(stdout).slice(0, 180)}`));
            }
          });
        });
      } catch (error) {
        lastError = error;
        if (attempt < attempts) {
          await this.delay(options.retryDelayMs || 0);
        }
      }
    }

    throw lastError;
  },

  helperError(error, stdout, stderr) {
    const details = String(stderr || stdout || "").trim();
    if (details) {
      return new Error(`TEDAPI helper failed: ${details}`);
    }
    if (error.killed || error.signal) {
      return new Error("TEDAPI helper failed: timed out waiting for the gateway.");
    }
    return new Error(`TEDAPI helper failed: exited with code ${error.code || "unknown"}.`);
  },

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
            const error = new Error(`${method} ${url.pathname} failed with ${res.statusCode}: ${text.slice(0, 180)}`);
            error.statusCode = res.statusCode;
            error.responseText = text;
            reject(error);
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
