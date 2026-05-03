/* global Module */

Module.register("MMM-PowerWallTV", {
  defaults: {
    mode: "demo",
    updateInterval: 10 * 1000,
    retryInterval: 30 * 1000,
    width: "100%",
    maxWidth: "1050px",
    cornerRadius: "18px",
    domUpdateAnimationSpeed: 0,
    animation: true,
    imageScale: 1.2,
    imageHorizontalOffset: "-8%",
    imageVerticalOffset: "0%",
    showSummary: true,
    showGridCarbon: true,
    showVehicle: true,
    showHistory: false,
    historyLimit: 120,
    powerThresholdWatts: 10,
    showLessPrecision: false,
    scale: 1,
    horizontalOffset: 0,
    verticalOffset: 0,
    local: {
      gatewayIP: "demo",
      email: "",
      password: "",
      protocol: "https",
      rejectUnauthorized: false,
      siteName: "",
      wallConnectorIP: "",
      lastChargingWallConnectorVIN: ""
    },
    fleet: {
      baseURL: "https://fleet-api.prd.na.vn.cloud.tesla.com",
      accessToken: "",
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
    this.instanceId = this.identifier || this.name;
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
      this.loaded = true;
      this.errorMessage = null;
      this.infoMessage = payload.snapshot.infoMessage || null;
      this.snapshot = payload.snapshot;
      this.recordHistory(payload.snapshot);
      this.updateDom(this.config.domUpdateAnimationSpeed);
      this.scheduleFetch(this.config.updateInterval);
    }

    if (notification === "PWTV_ERROR") {
      this.loaded = true;
      this.errorMessage = payload.error || "Unable to fetch Powerwall data.";
      this.infoMessage = null;
      this.updateDom(this.config.domUpdateAnimationSpeed);
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
    this.sendSocketNotification("PWTV_FETCH", {
      instanceId: this.instanceId,
      config: this.config
    });
  },

  getDom() {
    const wrapper = this.el("div", "pwtv");
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
    wrapper.appendChild(scene);

    const stage = this.el("div", "pwtv-stage");
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

    stage.appendChild(this.renderMetric("solar", this.formatPower(this.snapshot.solarPower), "SOLAR"));
    stage.appendChild(this.renderMetric("home", this.formatPower(this.homePowerToDisplay(this.snapshot)), "HOME"));
    stage.appendChild(this.renderMetric("battery", this.renderBatteryValue(this.snapshot), this.batteryLabel(this.snapshot), true));
    stage.appendChild(this.renderMetric("grid", this.renderGridValue(this.snapshot), this.gridLabel(this.snapshot), true));

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

  renderLoading() {
    const loading = this.el("div", "pwtv-loading");
    const title = this.el("div", "pwtv-loading-title", this.loaded ? "Waiting for data" : "Loading...");
    const detail = this.el("div", "pwtv-loading-detail", this.errorMessage || "Powerwall TV");
    loading.appendChild(title);
    loading.appendChild(detail);
    return loading;
  },

  renderSummary(snapshot) {
    const summary = this.el("div", "pwtv-summary");
    const siteName = snapshot.siteName || this.config.local.siteName || this.config.fleet.siteName;
    if (siteName) {
      summary.appendChild(this.el("div", "pwtv-summary-site", siteName));
    }

    if (Number.isFinite(snapshot.solarEnergyExportedWh) && snapshot.solarEnergyExportedWh > 0) {
      const kwh = snapshot.solarEnergyExportedWh / 1000;
      summary.appendChild(this.el("div", "pwtv-summary-energy", `${this.formatNumber(kwh)} kWh`));
      summary.appendChild(this.el("div", "pwtv-summary-label", snapshot.solarEnergyToday ? "ENERGY GENERATED TODAY" : "ENERGY GENERATED"));
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
    wrapper.appendChild(document.createTextNode(this.formatPower(snapshot.gridPower)));

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

    const threshold = Number(this.config.powerThresholdWatts) || 10;
    const flows = this.flowRoutes(snapshot, threshold);

    flows.forEach((flow) => {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("class", "pwtv-flow");
      path.setAttribute("d", flow.d);
      path.setAttribute("pathLength", String(flow.pathLength || 200));
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

    const homeSource = this.dominantPowerSource(snapshot, threshold);
    if (this.homePowerToDisplay(snapshot) > threshold && homeSource) {
      add(homeSource, "home");
    }

    if ((Number(snapshot.batteryPower) || 0) < -threshold) {
      const batterySource = this.chargingSource(snapshot, threshold);
      if (batterySource) {
        add(batterySource, "battery");
      }
    }

    if (!this.isOffGrid(snapshot) && (Number(snapshot.gridPower) || 0) < -threshold) {
      const exportSource = this.exportSource(snapshot, threshold);
      if (exportSource) {
        add(exportSource, "grid");
      }
    }

    return flows;
  },

  flowRoute(source, destination) {
    const routes = {
      solar: {
        home: {
          color: "#ffd84d",
          d: "M 764.2 366.5 C 767.5 375.6 770.9 375.6 770.9 427.5 L 781.8 438.6 L 853.1 421.3"
        },
        battery: {
          color: "#ffd84d",
          d: "M 764.2 366.5 C 767.5 375.6 770.9 375.6 770.9 427.5 L 760.4 443.2 L 684.9 461.8 Q 672.2 463.1 671.9 472.5"
        },
        grid: {
          color: "#ffd84d",
          d: "M 764.2 366.5 C 767.5 375.6 770.9 375.6 770.9 427.5 L 769.3 476.3 L 769.3 494.0 A 5.0 5.0 0 0 1 772.8 504.3 L 894.8 548.2"
        }
      },
      battery: {
        home: {
          color: "#4fd26b",
          d: "M 671.9 472.5 Q 672.2 463.1 684.9 461.8 L 760.4 443.2 L 781.8 438.6 L 853.1 421.3"
        },
        grid: {
          color: "#4fd26b",
          d: "M 671.9 472.5 Q 672.2 463.1 684.9 461.8 L 760.4 443.2 L 769.3 476.3 L 769.3 494.0 A 5.0 5.0 0 0 1 772.8 504.3 L 894.8 548.2"
        }
      },
      grid: {
        home: {
          color: "#9aa0a6",
          d: "M 894.8 548.2 L 772.8 504.3 A 5.0 5.0 0 0 0 769.3 494.0 L 769.3 476.3 L 781.8 438.6 L 853.1 421.3"
        },
        battery: {
          color: "#9aa0a6",
          d: "M 894.8 548.2 L 772.8 504.3 A 5.0 5.0 0 0 0 769.3 494.0 L 769.3 476.3 L 760.4 443.2 L 684.9 461.8 Q 672.2 463.1 671.9 472.5"
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

  dominantPowerSource(snapshot, threshold) {
    const solarPower = Number(snapshot.solarPower) || 0;
    const batteryPower = Number(snapshot.batteryPower) || 0;
    const gridPower = Number(snapshot.gridPower) || 0;

    if (solarPower > threshold && solarPower >= batteryPower && solarPower >= gridPower) {
      return "solar";
    }
    if (batteryPower > threshold && batteryPower >= gridPower) {
      return "battery";
    }
    if (gridPower > threshold) {
      return "grid";
    }
    if (solarPower > threshold) {
      return "solar";
    }
    if (batteryPower > threshold) {
      return "battery";
    }
    return null;
  },

  chargingSource(snapshot, threshold) {
    const solarPower = Number(snapshot.solarPower) || 0;
    const gridPower = Number(snapshot.gridPower) || 0;

    if (solarPower > threshold && solarPower >= gridPower) {
      return "solar";
    }
    if (gridPower > threshold) {
      return "grid";
    }
    return solarPower > threshold ? "solar" : null;
  },

  exportSource(snapshot, threshold) {
    const solarPower = Number(snapshot.solarPower) || 0;
    const batteryPower = Number(snapshot.batteryPower) || 0;

    if (solarPower > threshold && solarPower >= batteryPower) {
      return "solar";
    }
    if (batteryPower > threshold) {
      return "battery";
    }
    return solarPower > threshold ? "solar" : null;
  },

  preloadImages() {
    this.preloadedImages = [
      "home.png",
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
    if (!this.snapshot || !this.hasWallConnector(this.snapshot)) {
      return "home.png";
    }

    const power = this.wallConnectorPower(this.snapshot);
    const pluggedIn = this.snapshot.wallConnectors.some((connector) => Number(connector.wallConnectorState) === 4);
    if (power <= 10 && !pluggedIn) {
      return "home-charger-empty.png";
    }

    return this.hasCybertruck(this.snapshot) ? "home-charger-cybertruck.png" : "home-charger.png";
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
    return count > 0 ? `POWERWALL / ${count.toFixed(0)}x` : "POWERWALL";
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
    return `${this.formatNumber((Number(watts) || 0) / 1000)} kW`;
  },

  formatPercent(value, digits) {
    return `${this.formatNumber(Number(value) || 0, digits)}%`;
  },

  formatNumber(value, fixedDigits) {
    const digits = Number.isFinite(fixedDigits) ? fixedDigits : (this.config.showLessPrecision ? 1 : 3);
    const abs = Math.abs(Number(value) || 0);
    if (abs >= 1000) {
      return (Number(value) || 0).toFixed(0);
    }
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
