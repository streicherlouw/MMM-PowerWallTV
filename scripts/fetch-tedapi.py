#!/usr/bin/env python3
import argparse
import json
import os
import sys


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


def main():
    parser = argparse.ArgumentParser(description="Fetch a Powerwall snapshot through TEDAPI.")
    parser.add_argument("--host", required=True)
    parser.add_argument("--site-name", default="")
    parser.add_argument("--timezone", default="")
    parser.add_argument("--timeout", type=int, default=9)
    args = parser.parse_args()

    gateway_password = os.environ.get("PWTV_TEDAPI_GATEWAY_PASSWORD", "")
    if not gateway_password:
        fail("PWTV_TEDAPI_GATEWAY_PASSWORD is not set.")

    try:
        import pypowerwall
    except Exception as exc:
        fail(f"Python package pypowerwall is not installed: {exc}")

    timezone = args.timezone or "Etc/UTC"

    try:
        powerwall = pypowerwall.Powerwall(
            host=args.host,
            password="",
            email="",
            timezone=timezone,
            timeout=args.timeout,
            poolmaxsize=0,
            gw_pwd=gateway_password,
        )
    except Exception as exc:
        fail(f"Unable to connect to TEDAPI at {args.host}: {exc}")

    power = safe(powerwall.power, None)
    if not isinstance(power, dict) or not power:
        fail("TEDAPI power readings unavailable.")

    solar_strings = safe(powerwall.strings, {}) or {}
    aggregate_meters = safe(lambda: powerwall.poll("/api/meters/aggregates"), {}) or {}
    battery_blocks = safe(lambda: powerwall.battery_blocks(False), []) or []
    if isinstance(battery_blocks, dict):
        battery_count = len(battery_blocks)
    elif isinstance(battery_blocks, list):
        battery_count = len(battery_blocks)
    else:
        battery_count = 0
    time_remaining_hours = safe(powerwall.get_time_remaining, 0) or 0

    output = {
        "source": "tedapi",
        "siteName": args.site_name or safe(powerwall.site_name, "") or "",
        "solarPower": number_at(power, "solar"),
        "homePower": number_at(power, "load"),
        "batteryPower": number_at(power, "battery"),
        "gridPower": number_at(power, "site"),
        "batteryPercentage": safe(powerwall.level, 0) or 0,
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
