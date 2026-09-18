/* global Module */

Module.register("MMM-PowerWallTV", {
  defaults: {
    mode: "demo",
    updateInterval: 10 * 1000,
    retryInterval: 30 * 1000,
    staleDataOnError: true,
    BatteryExportToGridLimit: {
      active: false,
      lowerThreshold: 70,
      upperThreshold: 90
    },
    width: "100%",
    maxWidth: "1050px",
    cornerRadius: "18px",
    domUpdateAnimationSpeed: 0,
    animation: true,
    imageScale: 1.2,
    imageHorizontalOffset: "-2%",
    imageVerticalOffset: "3%",
    showSummary: true,
    GridExportWindow: {
      show: true,
      start: "17:00",
      end: "21:00"
    },
    showGridCarbon: true,
    showVehicle: true,
    showHistory: false,
    historyLimit: 120,
    powerThresholdWatts: 10,
    gridHysteresisWatts: 30,
    gridAnimationThresholdWatts: 30,
    showLessPrecision: false,
    scale: 1,
    horizontalOffset: 0,
    verticalOffset: 0,
    local: {
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
    },
    tedapi: {
      gatewayIP: "192.168.91.1",
      gatewayPassword: "",
      gatewayPasswordFile: "",
      rsaKeyPath: "",
      gwPwd: "",
      python: "python3",
      siteName: "",
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
      solarStringExpectedOutputFactor: 0.72,
      aggregateHistoryPath: "~/.cache/MMM-PowerWallTV/tedapi-aggregates.json",
      aggregateHistoryDays: 30,
      solarIntegrationMaxGapSeconds: 300
    },
    fleet: {
      baseURL: "https://fleet-api.prd.na.vn.cloud.tesla.com",
      accessToken: "",
      refreshToken: "",
      clientId: "",
      tokenURL: "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token",
      tokenStorePath: ".pwtv-fleet-tokens.json",
      persistTokens: true,
      energySiteId: "",
      siteName: ""
    },
    electricityMaps: {
      apiKey: "",
      zone: ""
    }
  },

  start() {
    this.snapshot = null;
    this.errorMessage = null;
    this.infoMessage = null;
    this.loaded = false;
    this.history = [];
    this.fetchTimer = null;
    this.fetchInFlight = false;
    this.instanceId = this.identifier || this.name;
    this.domRefs = null;
    this.preloadImages();
    this.fetchNow();
  },

  getStyles() {
    return ["MMM-PowerWallTV.css"];
  },

  suspend() {
    if (this.fetchTimer) {
      clearTimeout(this.fetchTimer);
      this.fetchTimer = null;
    }
  },

  resume() {
    this.fetchNow();
  },

  socketNotificationReceived(notification, payload) {
    if (!payload || payload.instanceId !== this.instanceId) {
      return;
    }

    if (notification === "PWTV_DATA") {
      this.fetchInFlight = false;
      const previousSnapshot = this.snapshot;
      const nextSnapshot = this.applyGridHysteresis(payload.snapshot, previousSnapshot);
      const previousFlowSignature = previousSnapshot ? this.flowSignature(previousSnapshot) : "";
      const nextFlowSignature = this.flowSignature(nextSnapshot);
      const canPatch = this.canPatchSnapshotUpdate(previousSnapshot, nextSnapshot, previousFlowSignature, nextFlowSignature);

      this.loaded = true;
      this.errorMessage = null;
      this.infoMessage = nextSnapshot.infoMessage || null;
      this.snapshot = nextSnapshot;
      this.recordHistory(nextSnapshot);

      if (!canPatch || !this.updateSnapshotDom(nextSnapshot)) {
        this.updateDom(this.config.domUpdateAnimationSpeed);
      }

      this.scheduleFetch(this.config.updateInterval);
    }

    if (notification === "PWTV_ERROR") {
      this.fetchInFlight = false;
      this.loaded = true;
      const message = this.compactErrorMessage(payload.error || "Unable to fetch Powerwall data.");
      if (this.snapshot && this.config.staleDataOnError) {
        this.errorMessage = null;
        this.infoMessage = `Powerwall data delayed; showing last update from ${this.formatTimestamp(this.snapshot.fetchedAt)}.`;
      } else {
        this.errorMessage = message;
        this.infoMessage = null;
      }

      if (!this.snapshot || !this.updateSnapshotDom(this.snapshot)) {
        this.updateDom(this.config.domUpdateAnimationSpeed);
      }

      this.scheduleFetch(this.config.retryInterval);
    }
  },

  notificationReceived(notification) {
    if (notification === "DOM_OBJECTS_CREATED") {
      this.fetchNow();
    }
  },

  scheduleFetch(delay) {
    if (this.fetchTimer) {
      clearTimeout(this.fetchTimer);
    }
    this.fetchTimer = setTimeout(() => this.fetchNow(), Math.max(1000, delay || this.config.updateInterval));
  },

  fetchNow() {
    if (this.fetchInFlight) {
      return;
    }
    this.fetchInFlight = true;
    this.sendSocketNotification("PWTV_FETCH", {
      instanceId: this.instanceId,
      config: this.config
    });
  },

  getDom() {
    const wrapper = this.el("div", "pwtv");
    this.domRefs = {
      wrapper,
      scene: null,
      stage: null
    };

    wrapper.style.setProperty("--pwtv-width", this.config.width);
    wrapper.style.setProperty("--pwtv-max-width", this.config.maxWidth);
    wrapper.style.setProperty("--pwtv-radius", this.config.cornerRadius);
    wrapper.style.setProperty("--pwtv-scale", String(this.config.scale));
    wrapper.style.setProperty("--pwtv-x", `${this.config.horizontalOffset}px`);
    wrapper.style.setProperty("--pwtv-y", `${this.config.verticalOffset}px`);
    wrapper.style.setProperty("--pwtv-image-scale", String(this.config.imageScale));
    wrapper.style.setProperty("--pwtv-image-x", this.config.imageHorizontalOffset);
    wrapper.style.setProperty("--pwtv-image-y", this.config.imageVerticalOffset);

    const scene = this.el("div", "pwtv-scene");
    this.domRefs.scene = scene;
    wrapper.appendChild(scene);

    const stage = this.el("div", "pwtv-stage");
    this.domRefs.stage = stage;
    scene.appendChild(stage);

    const image = this.el("img", "pwtv-home-image");
    image.src = this.file(`assets/${this.homeImageName()}`);
    image.alt = "";
    stage.appendChild(image);

    if (!this.snapshot) {
      scene.appendChild(this.renderLoading());
      return wrapper;
    }

    stage.appendChild(this.renderFlows(this.snapshot));
    stage.appendChild(this.renderBatteryFill(this.snapshot));

    if (this.config.showSummary) {
      scene.appendChild(this.renderSummary(this.snapshot));
    }

    scene.appendChild(this.renderSolarMetric(this.snapshot));
    scene.appendChild(this.renderMetric("home", this.formatPower(this.homePowerToDisplay(this.snapshot)), "HOME"));
    scene.appendChild(this.renderBatteryMetric(this.snapshot));
    scene.appendChild(this.renderMetric("grid", this.renderGridValue(this.snapshot), this.gridLabel(this.snapshot), true));

    if (this.config.showVehicle && this.hasWallConnector(this.snapshot)) {
      stage.appendChild(this.renderMetric("vehicle", this.vehicleValue(this.snapshot), this.vehicleLabel(this.snapshot)));
    }

    if (this.isOffGrid(this.snapshot)) {
      const offGrid = this.el("img", "pwtv-off-grid");
      offGrid.src = this.file("assets/off-grid.png");
      offGrid.alt = "";
      stage.appendChild(offGrid);
    }

    if (this.config.showHistory) {
      scene.appendChild(this.renderHistory());
    }

    return wrapper;
  },

  canPatchSnapshotUpdate(previousSnapshot, nextSnapshot, previousFlowSignature, nextFlowSignature) {
    if (!previousSnapshot || !nextSnapshot || !this.domRefs || !this.domRefs.scene || !this.domRefs.stage) {
      return false;
    }

    return previousFlowSignature === nextFlowSignature &&
      this.homeImageNameFor(previousSnapshot) === this.homeImageNameFor(nextSnapshot) &&
      this.isOffGrid(previousSnapshot) === this.isOffGrid(nextSnapshot) &&
      this.hasWallConnector(previousSnapshot) === this.hasWallConnector(nextSnapshot);
  },

  updateSnapshotDom(snapshot) {
    if (!this.domRefs || !this.domRefs.scene || !this.domRefs.stage) {
      return false;
    }

    const scene = this.domRefs.scene;
    const stage = this.domRefs.stage;

    this.replaceElement(stage, ".pwtv-battery-fill", this.renderBatteryFill(snapshot));
    this.replaceElement(scene, ".pwtv-summary", this.config.showSummary ? this.renderSummary(snapshot) : null);
    this.replaceElement(scene, ".pwtv-metric-solar", this.renderSolarMetric(snapshot));
    this.replaceElement(scene, ".pwtv-metric-home", this.renderMetric("home", this.formatPower(this.homePowerToDisplay(snapshot)), "HOME"));
    this.replaceElement(scene, ".pwtv-metric-battery", this.renderBatteryMetric(snapshot));
    this.replaceElement(scene, ".pwtv-metric-grid", this.renderMetric("grid", this.renderGridValue(snapshot), this.gridLabel(snapshot), true));

    const vehicleMetric = this.config.showVehicle && this.hasWallConnector(snapshot)
      ? this.renderMetric("vehicle", this.vehicleValue(snapshot), this.vehicleLabel(snapshot))
      : null;
    this.replaceElement(stage, ".pwtv-metric-vehicle", vehicleMetric);

    const offGrid = this.isOffGrid(snapshot) ? this.el("img", "pwtv-off-grid") : null;
    if (offGrid) {
      offGrid.src = this.file("assets/off-grid.png");
      offGrid.alt = "";
    }
    this.replaceElement(stage, ".pwtv-off-grid", offGrid);
    this.replaceElement(scene, ".pwtv-history", this.config.showHistory ? this.renderHistory() : null);

    return true;
  },

  replaceElement(parent, selector, replacement) {
    const existing = parent.querySelector(selector);
    if (existing && replacement) {
      existing.replaceWith(replacement);
      return;
    }
    if (existing) {
      existing.remove();
      return;
    }
    if (replacement) {
      parent.appendChild(replacement);
    }
  },

  renderLoading() {
    const loading = this.el("div", "pwtv-loading");
    const title = this.el("div", "pwtv-loading-title", this.loaded ? "Waiting for data" : "Loading...");
    const detail = this.el("div", "pwtv-loading-detail", this.errorMessage || "Powerwall TV");
    loading.appendChild(title);
    loading.appendChild(detail);
    return loading;
  },

  compactErrorMessage(message) {
    const text = String(message || "").replace(/\s+/g, " ").trim();
    if (!text) {
      return "Unable to fetch Powerwall data.";
    }
    if (text.includes("TEDAPI helper failed")) {
      if (text.toLowerCase().includes("timed out")) {
        return "TEDAPI fetch timed out.";
      }
      return "TEDAPI fetch failed.";
    }
    return text.length > 160 ? `${text.slice(0, 157)}...` : text;
  },

  formatTimestamp(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) {
      return "the last successful refresh";
    }
    return date.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit"
    });
  },

  renderSummary(snapshot) {
    const summary = this.el("div", "pwtv-summary");
    const siteName = snapshot.siteName || this.config.local.siteName || this.config.fleet.siteName;
    if (siteName) {
      summary.appendChild(this.el("div", "pwtv-summary-site", siteName));
    }

    const generatedToday = this.generatedTodayValue(snapshot);
    if (generatedToday) {
      const generated = this.el("div", "pwtv-summary-generated");
      generated.appendChild(this.el("div", "pwtv-summary-label pwtv-summary-generated-label",
        snapshot.solarEnergyPartial ? "GENERATED TODAY (PARTIAL)" : "GENERATED TODAY"));
      generated.appendChild(this.el("div", "pwtv-summary-energy pwtv-summary-generated-value", generatedToday));
      summary.appendChild(generated);
    }

    if (["v1r", "tedapi"].includes(snapshot.source)) {
      const reading = snapshot.gridExportToday;
      const block = this.el("div", "pwtv-summary-generated pwtv-summary-export-today");
      block.appendChild(this.el("div", "pwtv-summary-label pwtv-summary-generated-label",
        "EXPORTED TODAY" + (reading && reading.partial ? " (PARTIAL)" : "")));
      const value = reading && Number.isFinite(reading.energyWh)
        ? `${reading.estimated ? "≈ " : ""}${this.formatNumber(reading.energyWh / 1000)} kWh` : "— kWh";
      block.appendChild(this.el("div", "pwtv-summary-energy pwtv-summary-generated-value", value));
      summary.appendChild(block);
    }

    const exportWindow = Object.assign({ show: true, start: "17:00", end: "21:00" }, this.config.GridExportWindow || {});
    if (exportWindow.show && ["v1r", "tedapi"].includes(snapshot.source)) {
      const reading = snapshot.gridExportWindow;
      const block = this.el("div", "pwtv-summary-generated pwtv-summary-export-window");
      const label = `EXPORTED ${this.exportWindowLabel(exportWindow.start, exportWindow.end)}`;
      block.appendChild(this.el("div", "pwtv-summary-label pwtv-summary-generated-label",
        label + (reading && reading.partial ? " (PARTIAL)" : "")));
      const value = reading && Number.isFinite(reading.energyWh)
        ? `${reading.estimated ? "≈ " : ""}${this.formatNumber(reading.energyWh / 1000)} kWh` : "— kWh";
      block.appendChild(this.el("div", "pwtv-summary-energy pwtv-summary-generated-value", value));
      summary.appendChild(block);
    }

    if (!snapshot.solarEnergyToday && Number.isFinite(snapshot.solarEnergyExportedWh) && snapshot.solarEnergyExportedWh > 0) {
      const kwh = snapshot.solarEnergyExportedWh / 1000;
      summary.appendChild(this.el("div", "pwtv-summary-energy", `${this.formatNumber(kwh)} kWh`));
      const energyLabel = this.el("div", "pwtv-summary-label");
      energyLabel.textContent = "ENERGY GENERATED";
      summary.appendChild(energyLabel);
    }

    const message = this.errorMessage || snapshot.errorMessage || this.infoMessage;
    if (message) {
      const node = this.el("div", this.errorMessage || snapshot.errorMessage ? "pwtv-summary-message pwtv-error" : "pwtv-summary-message", message);
      summary.appendChild(node);
    }

    return summary;
  },

  renderMetric(kind, value, label, valueIsNode) {
    const metric = this.el("div", `pwtv-metric pwtv-metric-${kind}`);
    const valueNode = this.el("div", "pwtv-metric-value");
    if (valueIsNode) {
      valueNode.appendChild(value);
    } else {
      valueNode.textContent = value;
    }
    metric.appendChild(valueNode);
    metric.appendChild(this.el("div", "pwtv-metric-label", label));
    return metric;
  },

  renderSolarMetric(snapshot) {
    const metric = this.el("div", "pwtv-metric pwtv-metric-solar");
    const main = this.el("div", "pwtv-solar-main");
    const valueNode = this.el("div", "pwtv-metric-value", this.formatPower(snapshot.solarPower));
    main.appendChild(valueNode);

    const strings = this.solarStringStats(snapshot);
    main.appendChild(this.el("div", "pwtv-metric-label", "SOLAR"));
    metric.appendChild(main);
    if (!strings.length) {
      return metric;
    }

    const showLabels = this.showSolarStringLabels();
    const list = this.el("div", `pwtv-metric-label pwtv-solar-strings${showLabels ? "" : " pwtv-solar-strings-values-only"}`);
    strings.forEach((string) => {
      const row = this.el("div", "pwtv-solar-string");
      if (showLabels && string.label) {
        row.appendChild(this.el("span", "pwtv-solar-string-name", string.label));
      }
      row.appendChild(this.el("span", "pwtv-solar-string-value", this.formatSolarStringProduction(string)));
      list.appendChild(row);
    });
    metric.appendChild(list);
    return metric;
  },

  renderBatteryMetric(snapshot) {
    const metric = this.el("div", "pwtv-metric pwtv-metric-battery");
    const valueNode = this.el("div", "pwtv-metric-value");
    valueNode.appendChild(this.renderBatteryValue(snapshot));
    metric.appendChild(valueNode);
    metric.appendChild(this.el("div", "pwtv-metric-label", this.batteryLabel(snapshot)));

    return metric;
  },

  renderBatteryValue(snapshot) {
    const fragment = document.createDocumentFragment();
    fragment.appendChild(document.createTextNode(`${this.formatPower(snapshot.batteryPower)} `));

    const arrow = this.el("span", `pwtv-battery-arrow ${this.batteryArrowClass(snapshot)}`);
    fragment.appendChild(arrow);
    fragment.appendChild(document.createTextNode(` ${this.formatPercent(snapshot.batteryPercentage, 1)}`));

    const wrapper = this.el("span");
    wrapper.appendChild(fragment);
    return wrapper;
  },

  renderGridValue(snapshot) {
    const wrapper = this.el("span");
    wrapper.appendChild(document.createTextNode(this.formatGridPower(snapshot)));

    if (this.config.showGridCarbon && Number.isFinite(snapshot.gridFossilFuelPercentage)) {
      const renewables = Math.max(0, Math.min(100, 100 - snapshot.gridFossilFuelPercentage));
      wrapper.appendChild(document.createTextNode(" / "));
      const renewableNode = this.el("span", `pwtv-renewables ${this.renewablesClass(renewables)}`, `${this.formatNumber(renewables, 1)}%`);
      wrapper.appendChild(renewableNode);
    }

    return wrapper;
  },

  renderBatteryFill(snapshot) {
    const frame = this.el("div", "pwtv-battery-fill");
    const fill = this.el("div", "pwtv-battery-fill-inner");
    const percentage = Math.max(0, Math.min(100, Number(snapshot.batteryPercentage) || 0));
    fill.style.height = `${percentage}%`;
    frame.appendChild(fill);
    return frame;
  },

  renderFlows(snapshot) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", `pwtv-flow-layer${this.config.animation ? "" : " pwtv-flow-paused"}`);
    svg.setAttribute("viewBox", "0 0 1280 720");
    svg.setAttribute("preserveAspectRatio", "none");
    const maskId = `${this.instanceId}-pwtv-flow-mask`.replace(/[^a-zA-Z0-9_-]/g, "-");

    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    const mask = document.createElementNS("http://www.w3.org/2000/svg", "mask");
    mask.setAttribute("id", maskId);
    mask.setAttribute("maskUnits", "userSpaceOnUse");

    const visible = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    visible.setAttribute("x", "0");
    visible.setAttribute("y", "0");
    visible.setAttribute("width", "1280");
    visible.setAttribute("height", "720");
    visible.setAttribute("fill", "white");
    mask.appendChild(visible);

    const connectorOccluder = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    connectorOccluder.setAttribute("points", "762.5,430 778.5,425.5 778.5,472.5 762.5,476.5");
    connectorOccluder.setAttribute("fill", "black");
    mask.appendChild(connectorOccluder);

    defs.appendChild(mask);
    svg.appendChild(defs);

    const threshold = Number(this.config.powerThresholdWatts) || 10;
    const flows = this.flowRoutes(snapshot, threshold);

    flows.forEach((flow) => {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("class", "pwtv-flow");
      path.setAttribute("d", flow.d);
      path.setAttribute("pathLength", String(flow.pathLength || 200));
      path.setAttribute("mask", `url(#${maskId})`);
      path.style.setProperty("--flow-color", flow.color);
      svg.appendChild(path);
    });

    return svg;
  },

  flowRoutes(snapshot, threshold) {
    const flows = [];
    const keys = new Set();
    const add = (source, destination) => {
      const route = this.flowRoute(source, destination);
      if (!route || keys.has(`${source}-${destination}`)) {
        return;
      }
      keys.add(`${source}-${destination}`);
      flows.push(route);
    };

    if (this.homePowerToDisplay(snapshot) > threshold) {
      this.activeHomeSources(snapshot, threshold).forEach((source) => add(source, "home"));
    }

    if ((Number(snapshot.batteryPower) || 0) < -threshold) {
      this.activeBatteryChargeSources(snapshot, threshold).forEach((source) => add(source, "battery"));
    }

    if (!this.isOffGrid(snapshot) && this.gridFlowDirection(snapshot) < 0) {
      this.activeGridExportSources(snapshot, threshold).forEach((source) => add(source, "grid"));
    }

    return flows;
  },

  flowSignature(snapshot) {
    const threshold = Number(this.config.powerThresholdWatts) || 10;
    return this.flowRoutes(snapshot, threshold)
      .map((flow) => `${flow.color}|${flow.d}|${flow.pathLength || 200}`)
      .join("||");
  },

  flowRoute(source, destination) {
    const solarToConnector = "M 764.2 366.5 C 767.5 375.6 770.9 375.6 770.9 427.5";
    const batteryToConnector = "M 671.9 472.5 Q 672.2 463.1 684.9 461.8 L 760.4 443.2";
    const connectorJoin = "771.0 466.0";
    const gridToConnector = `M 954.5 568.0 L 784.2 506.2 C 775.6 503.0 771.0 499.0 771.0 493.6 L ${connectorJoin}`;
    const connectorToHome = "L 781.8 438.6 L 853.1 421.3";
    const connectorToBattery = "L 760.4 443.2 L 684.9 461.8 Q 672.2 463.1 671.9 472.5";
    const connectorToGrid = `L ${connectorJoin} L 771.0 493.6 C 771.0 499.0 775.6 503.0 784.2 506.2 L 954.5 568.0`;

    const routes = {
      solar: {
        home: {
          color: "#ffd84d",
          d: `${solarToConnector} ${connectorToHome}`
        },
        battery: {
          color: "#ffd84d",
          d: `${solarToConnector} ${connectorToBattery}`
        },
        grid: {
          color: "#ffd84d",
          d: `${solarToConnector} ${connectorToGrid}`
        }
      },
      battery: {
        home: {
          color: "#4fd26b",
          d: `${batteryToConnector} ${connectorToHome}`
        },
        grid: {
          color: "#4fd26b",
          d: `${batteryToConnector} ${connectorToGrid}`
        }
      },
      grid: {
        home: {
          color: "#9aa0a6",
          d: `${gridToConnector} ${connectorToHome}`
        },
        battery: {
          color: "#9aa0a6",
          d: `${gridToConnector} ${connectorToBattery}`
        }
      }
    };

    const route = routes[source] && routes[source][destination];
    if (!route) {
      return null;
    }

    return {
      color: route.color,
      d: route.d,
      pathLength: 200
    };
  },

  activeHomeSources(snapshot, threshold) {
    const solarPower = Number(snapshot.solarPower) || 0;
    const batteryPower = Number(snapshot.batteryPower) || 0;
    const sources = [];

    if (solarPower > threshold) {
      sources.push("solar");
    }
    if (batteryPower > threshold) {
      sources.push("battery");
    }
    if (this.gridFlowDirection(snapshot) > 0) {
      sources.push("grid");
    }

    return sources;
  },

  activeBatteryChargeSources(snapshot, threshold) {
    const solarPower = Number(snapshot.solarPower) || 0;
    const sources = [];

    if (solarPower > threshold) {
      sources.push("solar");
    }
    if (this.gridFlowDirection(snapshot) > 0) {
      sources.push("grid");
    }

    return sources;
  },

  activeGridExportSources(snapshot, threshold) {
    const solarPower = Number(snapshot.solarPower) || 0;
    const batteryPower = Number(snapshot.batteryPower) || 0;
    const sources = [];

    if (solarPower > threshold) {
      sources.push("solar");
    }
    if (batteryPower > threshold) {
      sources.push("battery");
    }

    return sources;
  },

  applyGridHysteresis(snapshot, previousSnapshot) {
    const normalized = Object.assign({}, snapshot);
    const rawGridPower = Number(snapshot.gridPower) || 0;
    const currentDirection = this.powerDirection(rawGridPower, this.gridHysteresisWatts());

    normalized.gridPowerRaw = rawGridPower;

    if (currentDirection !== 0) {
      normalized.gridPower = rawGridPower;
      normalized.gridPowerDirection = currentDirection;
      return normalized;
    }

    const previousDirection = previousSnapshot ? this.gridPowerDirection(previousSnapshot) : 0;
    normalized.gridPower = this.gridPowerWithDirection(rawGridPower, previousDirection);
    normalized.gridPowerDirection = previousDirection;
    return normalized;
  },

  gridHysteresisWatts() {
    return Math.max(0, Number(this.config.gridHysteresisWatts) || 30);
  },

  gridAnimationThresholdWatts() {
    const configured = Number(this.config.gridAnimationThresholdWatts);
    if (Number.isFinite(configured)) {
      return Math.max(0, configured);
    }
    return this.gridHysteresisWatts();
  },

  gridFlowDirection(snapshot) {
    const rawGridPower = Number(snapshot && snapshot.gridPowerRaw);
    const gridPower = Number.isFinite(rawGridPower) ? rawGridPower : Number(snapshot && snapshot.gridPower) || 0;
    return this.powerDirection(gridPower, this.gridAnimationThresholdWatts());
  },

  gridPowerDirection(snapshot) {
    const explicitDirection = Number(snapshot && snapshot.gridPowerDirection);
    if (explicitDirection > 0) {
      return 1;
    }
    if (explicitDirection < 0) {
      return -1;
    }
    return this.powerDirection(Number(snapshot && snapshot.gridPower) || 0, this.gridHysteresisWatts());
  },

  gridPowerWithDirection(watts, direction) {
    if (direction < 0) {
      return -Math.abs(watts);
    }
    if (direction > 0) {
      return Math.abs(watts);
    }
    return 0;
  },

  powerDirection(watts, threshold) {
    if (watts > threshold) {
      return 1;
    }
    if (watts < -threshold) {
      return -1;
    }
    return 0;
  },

  preloadImages() {
    this.preloadedImages = [
      "home-large.png",
      "home-charger.png",
      "home-charger-empty.png",
      "home-charger-cybertruck.png",
      "off-grid.png"
    ].map((name) => {
      const image = new Image();
      image.src = this.file(`assets/${name}`);
      return image;
    });
  },

  renderHistory() {
    const box = this.el("div", "pwtv-history");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 300 70");
    svg.setAttribute("preserveAspectRatio", "none");

    [
      ["solarPower", "#ffd84d"],
      ["homePower", "#ffffff"],
      ["batteryPower", "#4fd26b"],
      ["gridPower", "#9aa0a6"]
    ].forEach(([key, color]) => {
      const d = this.historyPath(key, 300, 70);
      if (!d) {
        return;
      }
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", color);
      path.setAttribute("stroke-width", "2.4");
      path.setAttribute("opacity", key === "homePower" ? "0.55" : "0.9");
      svg.appendChild(path);
    });

    box.appendChild(svg);
    return box;
  },

  recordHistory(snapshot) {
    this.history.push({
      date: Date.now(),
      solarPower: snapshot.solarPower || 0,
      homePower: this.homePowerToDisplay(snapshot),
      batteryPower: snapshot.batteryPower || 0,
      gridPower: snapshot.gridPower || 0
    });

    const limit = Math.max(10, Number(this.config.historyLimit) || 120);
    if (this.history.length > limit) {
      this.history = this.history.slice(this.history.length - limit);
    }
  },

  historyPath(key, width, height) {
    if (this.history.length < 2) {
      return "";
    }

    const max = this.history.reduce((largest, point) => Math.max(largest, Math.abs(point[key] || 0)), 1000);
    return this.history.map((point, index) => {
      const x = (index / (this.history.length - 1)) * width;
      const normalized = (point[key] || 0) / max;
      const y = (height / 2) - (normalized * ((height / 2) - 4));
      return `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(" ");
  },

  homeImageName() {
    return this.homeImageNameFor(this.snapshot);
  },

  homeImageNameFor(snapshot) {
    if (!snapshot || !this.hasWallConnector(snapshot)) {
      return "home-large.png";
    }

    const power = this.wallConnectorPower(snapshot);
    const pluggedIn = snapshot.wallConnectors.some((connector) => Number(connector.wallConnectorState) === 4);
    if (power <= 10 && !pluggedIn) {
      return "home-charger-empty.png";
    }

    return this.hasCybertruck(snapshot) ? "home-charger-cybertruck.png" : "home-charger.png";
  },

  hasCybertruck(snapshot) {
    const liveVin = (snapshot.wallConnectors || [])
      .map((connector) => connector.vin)
      .find((vin) => typeof vin === "string" && vin.trim().length > 0);
    const fallbackVin = this.config.local.lastChargingWallConnectorVIN;
    const vin = String(liveVin || fallbackVin || "").trim().toUpperCase();
    return vin.length === 17 && vin.charAt(3) === "C";
  },

  hasWallConnector(snapshot) {
    return Array.isArray(snapshot.wallConnectors) && snapshot.wallConnectors.length > 0;
  },

  wallConnectorPower(snapshot) {
    return (snapshot.wallConnectors || []).reduce((total, connector) => total + (Number(connector.wallConnectorPower) || 0), 0);
  },

  homePowerToDisplay(snapshot) {
    return Math.max(0, (Number(snapshot.homePower) || 0) - this.wallConnectorPower(snapshot));
  },

  vehicleValue(snapshot) {
    const charging = (snapshot.wallConnectors || []).some((connector) => Number(connector.wallConnectorState) === 1);
    if (charging) {
      return this.formatPower(this.wallConnectorPower(snapshot));
    }
    const pluggedIn = (snapshot.wallConnectors || []).some((connector) => Number(connector.wallConnectorState) === 4);
    return pluggedIn ? "Plugged in" : "Idle";
  },

  vehicleLabel(snapshot) {
    const count = (snapshot.wallConnectors || []).length;
    return count > 1 ? `VEHICLES (${count})` : "VEHICLE";
  },

  batteryLabel(snapshot) {
    const count = Number(snapshot.batteryCount) || 0;
    const capacityKwh = Math.round(count * 13.5);
    return capacityKwh > 0 ? `POWERWALL ${capacityKwh.toFixed(0)} kWh` : "POWERWALL";
  },

  exportWindowLabel(start, end) {
    const format = value => {
      const [hour, minute] = value.split(":").map(Number);
      return { time: `${hour % 12 || 12}${minute ? `:${String(minute).padStart(2, "0")}` : ""}`,
        suffix: hour % 24 < 12 ? "AM" : "PM" };
    };
    const from = format(start), to = format(end);
    return `${from.time}${from.suffix === to.suffix ? "" : from.suffix}-${to.time}${to.suffix}`;
  },

  generatedTodayValue(snapshot) {
    const wh = Number(snapshot.solarEnergyExportedWh);
    if (!snapshot.solarEnergyToday || !Number.isFinite(wh)) {
      return snapshot.source === "v1r" || snapshot.source === "tedapi" ? "— kWh" : "";
    }
    return `${snapshot.solarEnergyEstimated ? "≈ " : ""}${this.formatNumber(Math.max(0, wh) / 1000)} kWh`;
  },

  gridLabel(snapshot) {
    const offGrid = this.isOffGrid(snapshot) ? "OFF-GRID" : "GRID";
    if (this.config.showGridCarbon && Number.isFinite(snapshot.gridCarbonIntensity)) {
      return `${offGrid} / ${snapshot.gridCarbonIntensity.toFixed(0)} gCO2`;
    }
    return offGrid;
  },

  isOffGrid(snapshot) {
    return snapshot.gridStatus === "SystemIslandedActive" || snapshot.gridStatus === "Inactive";
  },

  batteryArrowClass(snapshot) {
    const watts = Number(snapshot.batteryPower) || 0;
    const threshold = Number(this.config.powerThresholdWatts) || 10;
    if (watts > threshold) {
      return "pwtv-arrow-down";
    }
    if (watts < -threshold) {
      return "pwtv-arrow-up";
    }
    return "pwtv-arrow-idle";
  },

  houseFlowColor(snapshot) {
    if ((Number(snapshot.solarPower) || 0) > Math.abs(Number(snapshot.batteryPower) || 0)) {
      return "#ffd84d";
    }
    if ((Number(snapshot.batteryPower) || 0) > (Number(snapshot.gridPower) || 0)) {
      return "#4fd26b";
    }
    return "#9aa0a6";
  },

  chargingColor(snapshot) {
    return (Number(snapshot.solarPower) || 0) > Math.abs(Number(snapshot.batteryPower) || 0) ? "#ffd84d" : "#9aa0a6";
  },

  gridExportColor(snapshot) {
    return (Number(snapshot.solarPower) || 0) > Math.abs(Number(snapshot.batteryPower) || 0) ? "#ffd84d" : "#4fd26b";
  },

  solarStringStats(snapshot) {
    const source = snapshot.solarStrings || {};
    if (!source || !Object.keys(source).length) {
      return [];
    }

    const tedapiConfig = this.config.tedapi || {};
    const groups = this.solarStringGroups(tedapiConfig);
    const labels = Array.isArray(tedapiConfig.solarStringLabels) ? tedapiConfig.solarStringLabels : [];
    const expectedOutputFactor = this.solarStringExpectedOutputFactor(tedapiConfig);
    const maxWatts = (Number(tedapiConfig.solarStringPanelCount) || 12) *
      (Number(tedapiConfig.solarStringPanelWatts) || 480) *
      expectedOutputFactor;

    return groups.map((group, index) => {
      const label = labels[index] || group.join("+");
      const power = group.reduce((total, key) => total + this.solarStringPower(source, key), 0);
      const percent = maxWatts > 0 ? Math.max(0, power / maxWatts * 100) : 0;
      return {
        label,
        power,
        percent
      };
    });
  },

  solarStringGroups(tedapiConfig) {
    if (Array.isArray(tedapiConfig.solarStringGroups) && tedapiConfig.solarStringGroups.length) {
      return tedapiConfig.solarStringGroups
        .map((group) => Array.isArray(group) ? group : [group])
        .map((group) => group.map((key) => String(key)).filter(Boolean))
        .filter((group) => group.length);
    }

    return [["A", "B"], ["C", "D"], ["E", "F"]];
  },

  solarStringPower(source, key) {
    const reading = source[key] || source[String(key).toUpperCase()] || source[String(key).toLowerCase()] || {};
    return Number(reading.Power ?? reading.power ?? reading.PVAC_PVMeasuredPower ?? 0) || 0;
  },

  solarStringExpectedOutputFactor(tedapiConfig) {
    const factor = Number(tedapiConfig && tedapiConfig.solarStringExpectedOutputFactor);
    if (Number.isFinite(factor) && factor > 0) {
      return factor;
    }
    return 0.72;
  },

  showSolarStringLabels() {
    return this.config.tedapi && this.config.tedapi.showSolarStringLabels === true;
  },

  formatSolarStringProduction(string) {
    const watts = Math.round(Number(string.power) || 0);
    const percent = Math.round(Number(string.percent) || 0);
    return `${watts}W / ${percent}%`;
  },

  renewablesClass(value) {
    if (value < 25) {
      return "pwtv-renewables-low";
    }
    if (value < 50) {
      return "pwtv-renewables-mid";
    }
    if (value < 75) {
      return "pwtv-renewables-good";
    }
    return "pwtv-renewables-great";
  },

  formatPower(watts) {
    return `${this.withoutNegativeZero(this.formatNumber((Number(watts) || 0) / 1000))} kW`;
  },

  formatGridPower(snapshot) {
    const watts = Number(snapshot && snapshot.gridPower) || 0;
    const direction = this.gridPowerDirection(snapshot);
    if (direction < 0 && Math.abs(watts) < this.gridHysteresisWatts()) {
      const displayValue = this.formatNumber(Math.abs(watts) / 1000);
      const sign = this.isZeroDisplayValue(displayValue) ? "" : "-";
      return `${sign}${displayValue} kW`;
    }
    return this.formatPower(watts);
  },

  withoutNegativeZero(value) {
    const text = String(value);
    return this.isZeroDisplayValue(text) ? text.replace(/^-/, "") : text;
  },

  isZeroDisplayValue(value) {
    return Number(value) === 0;
  },

  formatPercent(value, digits) {
    return `${this.formatNumber(Number(value) || 0, digits)}%`;
  },

  formatNumber(value, fixedDigits) {
    const digits = Number.isFinite(fixedDigits) ? fixedDigits : 1;
    return (Number(value) || 0).toFixed(digits);
  },

  el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }
});
