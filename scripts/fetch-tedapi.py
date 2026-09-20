#!/usr/bin/env python3
import argparse
import json
import math
import os
import sys
import re
from datetime import datetime
from zoneinfo import ZoneInfo


def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)


def safe(callable_, default=None):
    try:
        value = callable_()
        return default if value is None else value
    except Exception:
        return default


def number_at(mapping, key, default=0):
    try:
        value = mapping.get(key, default)
        return float(value)
    except Exception:
        return default


def valid_percentage(value):
    return (not isinstance(value, bool) and isinstance(value, (int, float))
            and math.isfinite(value) and 0 <= value <= 100)


def battery_export_limit(powerwall, percentage, active=False, lower=70, upper=90, allow_export=True):
    """Use the gateway's export rule as the durable hysteresis state.

    pv_only stays off until the upper threshold, even after a module restart.
    battery_ok stays on until the lower threshold is crossed. Never change a
    site-wide 'never' rule: that also prohibits solar export.
    """
    status = {"active": active, "lowerThreshold": lower, "upperThreshold": upper,
              "chargePercent": percentage, "exportModeBefore": None, "exportMode": None,
              "action": "inactive", "error": ""}
    if not isinstance(active, bool) or not valid_percentage(lower) or not valid_percentage(upper) or lower >= upper:
        status.update(action="error", error="BatteryExportToGridLimit: invalid thresholds.")
        return status
    try:
        current = powerwall.client.get_grid_export(force=True)
    except Exception:
        current = None
    status.update(exportModeBefore=current, exportMode=current)
    if current not in ("battery_ok", "pv_only", "never"):
        status.update(action="error", error="BatteryExportToGridLimit: export setting unavailable; no change sent.")
        return status
    if not active:
        return status
    if not valid_percentage(percentage):
        status.update(action="error", error="BatteryExportToGridLimit: charge level unavailable; no change sent.")
        return status
    if current == "never":
        status.update(action="blocked", error="BatteryExportToGridLimit: preserving the site's no-export rule (never).")
        return status
    target = current
    if not allow_export or percentage < lower:
        target = "pv_only"
    elif percentage >= upper:
        target = "battery_ok"
    status["action"] = "unchanged"
    if target == current:
        return status
    try:
        powerwall.set_grid_export(target)
        actual = powerwall.client.get_grid_export(force=True)
        status["exportMode"] = actual
        if actual != target:
            status.update(action="error", error="BatteryExportToGridLimit: export change was not confirmed; will recheck next refresh.")
        else:
            status["action"] = "enabled" if target == "battery_ok" else "disabled"
    except Exception:
        status.update(exportMode=None, action="error",
                      error="BatteryExportToGridLimit: export update failed; will recheck next refresh.")
    return status


def premium_window(timezone, start="17:00", end="21:00", now=None):
    def minutes(value):
        if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value):
            raise ValueError("Invalid export window time")
        return int(value[:2]) * 60 + int(value[3:])
    first, last = minutes(start), 1440 if end == "24:00" else minutes(end)
    if first >= last:
        raise ValueError("Export window must start before it ends")
    zone = ZoneInfo(timezone)
    local = datetime.now(zone) if now is None else now.astimezone(zone)
    return first <= local.hour * 60 + local.minute < last


def control_settings(options=None):
    options = options or {}
    result = {}
    for name, inside, outside, allowed in (
        ("gridExport", "battery_ok", "pv_only", ("battery_ok", "pv_only")),
        ("operationalMode", "autonomous", "self_consumption", ("autonomous", "self_consumption"))):
        value = {"enabled": True, "inside": inside, "outside": outside}
        value.update(options.get(name, {}))
        if type(value["enabled"]) is not bool or value["inside"] not in allowed or value["outside"] not in allowed:
            raise ValueError("Invalid premium control settings")
        result[name] = value
    return result


def scheduled_battery_control(powerwall, percentage, active, lower, upper, in_window, settings=None):
    controls = control_settings(settings)
    export, operation = controls["gridExport"], controls["operationalMode"]
    period = "inside" if in_window else "outside"
    mode = safe(lambda: powerwall.get_mode(force=True))
    mode = mode if isinstance(mode, str) else None
    writable = mode in ("self_consumption", "autonomous")
    can_write = active and valid_percentage(percentage)
    if operation["enabled"] and not writable:
        can_write = False
    status = battery_export_limit(powerwall, percentage, can_write and export["enabled"], lower, upper,
                                  allow_export=export[period] == "battery_ok")
    status.update(active=active, inPremiumWindow=in_window, operationalModeBefore=mode,
                  operationalMode=mode, operationalModeTarget=operation[period],
                  gridExportControlEnabled=export["enabled"], modeControlEnabled=operation["enabled"])
    if not active:
        return status
    if not can_write:
        status.update(action="error", error="BatteryExportToGridLimit: charge or operational mode unavailable/unsupported; no change sent.")
        return status
    if status["exportMode"] == "never":
        status.update(action="blocked", error="BatteryExportToGridLimit: preserving the site's no-export rule (never).")
    if status["action"] in ("error", "blocked"):
        return status
    if not export["enabled"]:
        status["action"] = "unchanged"
    if not operation["enabled"]:
        status["modeAction"] = "inactive"
        return status
    target = operation[period]
    if mode != target:
        try:
            # Mode-only payload avoids reserve back-fill in older set_mode().
            powerwall.post(api="/api/operation", payload={"real_mode": target})
            actual = powerwall.get_mode(force=True)
            status["operationalMode"] = actual
            if actual != target:
                raise ValueError("Mode not confirmed")
            status["modeAction"] = "changed"
        except Exception:
            status.update(action="error", modeAction="error",
                          error="BatteryExportToGridLimit: mode change not confirmed; will recheck next refresh.")
    else:
        status["modeAction"] = "unchanged"
    return status


def main():
    parser = argparse.ArgumentParser(description="Fetch a Powerwall snapshot through TEDAPI.")
    parser.add_argument("--host", required=True)
    parser.add_argument("--site-name", default="")
    parser.add_argument("--timezone", default="")
    parser.add_argument("--timeout", type=int, default=9)
    parser.add_argument("--transport", choices=("wifi", "v1r"), default="wifi")
    parser.add_argument("--rsa-key-path", default="")
    parser.add_argument("--password-file", default="")
    parser.add_argument("--battery-export-limit", action="store_true")
    parser.add_argument("--export-lower-threshold", type=float, default=70)
    parser.add_argument("--export-upper-threshold", type=float, default=90)
    parser.add_argument("--export-window-start", default="17:00")
    parser.add_argument("--export-window-end", default="21:00")
    parser.add_argument("--premium-controls", default="{}")
    args = parser.parse_args()
    try:
        controls = control_settings(json.loads(args.premium_controls))
        premium_window(args.timezone or "Etc/UTC", args.export_window_start, args.export_window_end)
    except (ValueError, KeyError, TypeError, AttributeError):
        fail("Invalid export window or timezone; no connection attempted.")
    if (not valid_percentage(args.export_lower_threshold) or not valid_percentage(args.export_upper_threshold)
            or args.export_lower_threshold >= args.export_upper_threshold):
        fail("BatteryExportToGridLimit requires 0 <= lowerThreshold < upperThreshold <= 100.")
    if args.battery_export_limit and args.transport != "v1r":
        fail("BatteryExportToGridLimit requires v1r transport.")

    gateway_password = os.environ.get("PWTV_TEDAPI_GATEWAY_PASSWORD", "")
    if args.password_file:
        try:
            with open(os.path.expanduser(args.password_file), encoding="utf-8") as password_file:
                gateway_password = password_file.read().strip()
        except OSError:
            fail("Unable to read gateway password file.")
    if not gateway_password:
        fail("PWTV_TEDAPI_GATEWAY_PASSWORD is not set.")

    try:
        import pypowerwall
    except Exception as exc:
        fail(f"Python package pypowerwall is not installed: {exc}")

    timezone = args.timezone or "Etc/UTC"
    options = {}
    if args.transport == "v1r":
        key_path = os.path.expanduser(args.rsa_key_path)
        if not key_path or not os.path.isfile(key_path):
            fail("v1r requires a readable registered RSA private key (--rsa-key-path).")
        if tuple(pypowerwall.version_tuple) < (0, 17, 3):
            fail("Option 5 requires pypowerwall>=0.17.3; upgrade the module's Python environment.")
        options["rsa_key_path"] = key_path

    try:
        powerwall = pypowerwall.Powerwall(
            host=args.host,
            password="",
            email="",
            timezone=timezone,
            timeout=args.timeout,
            poolmaxsize=0,
            gw_pwd=gateway_password,
            **options,
        )
    except Exception as exc:
        fail(f"Unable to connect to TEDAPI ({type(exc).__name__}); check host, password and RSA registration.")

    if args.transport == "v1r" and getattr(powerwall, "tedapi_mode", "") != "v1r":
        fail("v1r connection failed; refusing a fallback transport.")

    # power() supplies zero defaults when reads fail. Validate the underlying
    # meters so an outage preserves MagicMirror's last good snapshot instead.
    aggregate_meters = safe(lambda: powerwall.poll("/api/meters/aggregates"), None)
    power = {}
    for channel in ("solar", "load", "battery", "site"):
        reading = aggregate_meters.get(channel) if isinstance(aggregate_meters, dict) else None
        value = reading.get("instant_power") if isinstance(reading, dict) else None
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            fail("TEDAPI power readings unavailable.")
        power[channel] = value
    # Match Tesla's app percentage for both the v1r display and its thresholds.
    percentage = safe(lambda: powerwall.level(scale=args.transport == "v1r"), None)
    if not valid_percentage(percentage):
        fail("TEDAPI battery percentage unavailable.")
    solar_strings = safe(powerwall.strings, {}) or {}
    battery_blocks = safe(lambda: powerwall.battery_blocks(False), []) or []
    if isinstance(battery_blocks, dict):
        battery_count = len(battery_blocks)
    elif isinstance(battery_blocks, list):
        battery_count = len(battery_blocks)
    else:
        battery_count = 0
    time_remaining_hours = safe(powerwall.get_time_remaining, 0) or 0

    export_status = None
    if args.transport == "v1r":
        export_status = scheduled_battery_control(
            powerwall, percentage, args.battery_export_limit,
            args.export_lower_threshold, args.export_upper_threshold,
            premium_window(timezone, args.export_window_start, args.export_window_end), controls)

    output = {
        "source": "v1r" if args.transport == "v1r" else "tedapi",
        "siteName": args.site_name or safe(powerwall.site_name, "") or "",
        "solarPower": number_at(power, "solar"),
        "homePower": number_at(power, "load"),
        "batteryPower": number_at(power, "battery"),
        "gridPower": number_at(power, "site"),
        "batteryPercentage": percentage,
        "batteryPercentageScale": "tesla_app" if args.transport == "v1r" else "raw",
        "gridExportMode": export_status["exportMode"] if export_status else None,
        "batteryExportToGridLimit": export_status,
        "batteryCount": battery_count,
        "timeRemainingHours": time_remaining_hours,
        "solarStrings": solar_strings,
        "aggregateMeters": aggregate_meters,
        "solarEnergyExportedWh": number_at(aggregate_meters.get("solar", {}) if isinstance(aggregate_meters, dict) else {}, "energy_exported"),
        "gridStatus": safe(lambda: powerwall.grid_status("string"), "") or "",
        "raw": {
            "power": power,
            "aggregateMeters": aggregate_meters,
            "solarStrings": solar_strings,
            "tedapiMode": getattr(powerwall, "tedapi_mode", ""),
        },
    }

    print(json.dumps(output))


if __name__ == "__main__":
    main()
