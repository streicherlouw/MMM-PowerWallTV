import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "fetch-tedapi.py"


class FetchTests(unittest.TestCase):
    def setUp(self):
        self.pw = Mock()
        self.pw.tedapi_mode = "v1r"
        self.pw.poll.return_value = {
            name: {"instant_power": value, "energy_exported": 12345}
            for name, value in {"solar": 5000, "load": 600, "battery": -100, "site": -4300}.items()
        }
        self.pw.get_mode.return_value = "autonomous"
        self.pw.level.return_value = 100.0
        self.pw.strings.return_value = {"A": {"Power": 1000}}
        self.pw.battery_blocks.return_value = {"primary": {}, "expansion": {}}
        self.pw.get_time_remaining.return_value = 40
        self.pw.grid_status.return_value = "UP"
        self.pw.site_name.return_value = "Home"
        self.pw.client.get_grid_export.return_value = "pv_only"
        self.package = types.SimpleNamespace(version_tuple=(0, 17, 3), Powerwall=Mock(return_value=self.pw))

    def run_script(self, args=(), password="example-secret"):
        out, err = io.StringIO(), io.StringIO()
        with patch.dict(sys.modules, {"pypowerwall": self.package}), \
             patch.dict(os.environ, {"PWTV_TEDAPI_GATEWAY_PASSWORD": password}), \
             patch.object(sys, "argv", [str(SCRIPT), "--host", "10.0.0.98", *args]), \
             contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                runpy.run_path(str(SCRIPT), run_name="__main__")
            except SystemExit as exc:
                return exc.code, out.getvalue(), err.getvalue()
        return 0, out.getvalue(), err.getvalue()

    def test_v1r_key_and_snapshot(self):
        with tempfile.NamedTemporaryFile() as key:
            code, out, err = self.run_script(["--transport", "v1r", "--rsa-key-path", key.name])
        self.assertEqual(code, 0, err)
        self.assertEqual(self.package.Powerwall.call_args.kwargs["rsa_key_path"], key.name)
        data = json.loads(out)
        self.assertEqual(data["source"], "v1r")
        self.assertEqual(data["gridExportMode"], "pv_only")
        self.assertEqual(data["batteryExportToGridLimit"]["action"], "inactive")
        self.pw.level.assert_called_once_with(scale=True)
        self.pw.client.get_grid_export.assert_called_once_with(force=True)
        self.pw.set_grid_export.assert_not_called()
        self.assertEqual(data["gridPower"], -4300)
        self.assertEqual(data["batteryPower"], -100)
        self.assertEqual(data["batteryCount"], 2)
        self.assertEqual(data["solarStrings"]["A"]["Power"], 1000)
        self.assertNotIn("example-secret", out + err)

    def test_wifi_remains_default(self):
        self.pw.tedapi_mode = "full"
        code, out, err = self.run_script()
        self.assertEqual(code, 0, err)
        self.assertNotIn("rsa_key_path", self.package.Powerwall.call_args.kwargs)
        self.assertEqual(json.loads(out)["source"], "tedapi")

    def test_missing_key_fails_before_connecting(self):
        code, _, _ = self.run_script(["--transport", "v1r"])
        self.assertEqual(code, 1)
        self.package.Powerwall.assert_not_called()

    def test_fallback_transport_rejected(self):
        self.pw.tedapi_mode = "off"
        with tempfile.NamedTemporaryFile() as key:
            code, out, _ = self.run_script(["--transport", "v1r", "--rsa-key-path", key.name])
        self.assertEqual(code, 1)
        self.assertEqual(out, "")

    def test_missing_and_invalid_meter_data_fail(self):
        for value in (None, {}, {"solar": None}, {"solar": {"instant_power": float("nan")}}):
            with self.subTest(value=value):
                self.pw.poll.return_value = value
                code, out, _ = self.run_script()
                self.assertEqual(code, 1)
                self.assertEqual(out, "")

    def test_zero_is_valid_but_missing_battery_is_not(self):
        for meter in self.pw.poll.return_value.values():
            meter["instant_power"] = 0
        self.pw.level.return_value = 0
        code, out, _ = self.run_script()
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["batteryPercentage"], 0)
        self.pw.level.return_value = None
        self.assertEqual(self.run_script()[0], 1)

    def test_password_file_overrides_environment(self):
        with tempfile.NamedTemporaryFile(mode="w") as secret:
            secret.write("file-secret\n")
            secret.flush()
            code, out, err = self.run_script(["--password-file", secret.name])
        self.assertEqual(code, 0, err)
        self.assertEqual(self.package.Powerwall.call_args.kwargs["gw_pwd"], "file-secret")
        self.assertNotIn("file-secret", out + err)

    def test_connection_error_does_not_echo_credentials(self):
        self.package.Powerwall.side_effect = ValueError("example-secret")
        code, out, err = self.run_script()
        self.assertEqual(code, 1)
        self.assertNotIn("example-secret", out + err)

    def test_old_library_fails_with_upgrade_message(self):
        self.package.version_tuple = (0, 16, 0)
        with tempfile.NamedTemporaryFile() as key:
            code, _, err = self.run_script(["--transport", "v1r", "--rsa-key-path", key.name])
        self.assertEqual(code, 1)
        self.assertIn("upgrade", err)
        self.package.Powerwall.assert_not_called()

    def test_cli_enables_policy_and_confirms_write(self):
        self.pw.client.get_grid_export.side_effect = ["pv_only", "battery_ok"]
        with tempfile.NamedTemporaryFile() as key:
            code, out, err = self.run_script(["--transport", "v1r", "--rsa-key-path", key.name,
                                              "--battery-export-limit", "--export-window-start", "00:00",
                                              "--export-window-end", "24:00"])
        self.assertEqual(code, 0, err)
        self.pw.set_grid_export.assert_called_once_with("battery_ok")
        self.assertEqual(json.loads(out)["batteryExportToGridLimit"]["action"], "enabled")

    def test_cli_invalid_policy_never_connects(self):
        for args in (["--battery-export-limit"], ["--export-lower-threshold", "95"],
                     ["--export-upper-threshold", "nan"]):
            self.assertEqual(self.run_script(args)[0], 1)
        self.package.Powerwall.assert_not_called()


class ExportLimitTests(unittest.TestCase):
    def setUp(self):
        self.policy = runpy.run_path(str(SCRIPT))["battery_export_limit"]
        self.pw = Mock()

    def test_full_cycle_with_state_preserved_across_polls(self):
        state = {"mode": "pv_only"}
        self.pw.client.get_grid_export.side_effect = lambda **kwargs: state["mode"]
        self.pw.set_grid_export.side_effect = lambda mode: state.update(mode=mode)
        readings = [95, 89, 70, 69.9, 75, 89.9, 90, 100]
        expected = ["enabled", "unchanged", "unchanged", "disabled", "unchanged", "unchanged", "enabled", "unchanged"]
        for percentage, action in zip(readings, expected):
            self.assertEqual(self.policy(self.pw, percentage, True)["action"], action)
        self.assertEqual([c.args[0] for c in self.pw.set_grid_export.call_args_list],
                         ["battery_ok", "pv_only", "battery_ok"])

    def test_deadband_keeps_existing_state_on_startup(self):
        for mode in ("pv_only", "battery_ok"):
            self.pw.client.get_grid_export.return_value = mode
            result = self.policy(self.pw, 80, True)
            self.assertEqual(result["exportMode"], mode)
            self.assertEqual(result["action"], "unchanged")
        self.pw.set_grid_export.assert_not_called()

    def test_inactive_reads_current_setting_but_never_writes(self):
        self.pw.client.get_grid_export.return_value = "pv_only"
        result = self.policy(self.pw, 100, False)
        self.assertEqual(result["action"], "inactive")
        self.pw.client.get_grid_export.assert_called_once_with(force=True)
        self.pw.set_grid_export.assert_not_called()

    def test_never_rule_is_not_overridden(self):
        self.pw.client.get_grid_export.return_value = "never"
        self.assertEqual(self.policy(self.pw, 100, True)["action"], "blocked")
        self.pw.set_grid_export.assert_not_called()

    def test_invalid_charge_and_export_readings_prevent_writes(self):
        self.pw.client.get_grid_export.return_value = "battery_ok"
        for percentage in (None, float("nan"), -1, 101, True):
            self.assertEqual(self.policy(self.pw, percentage, True)["action"], "error")
        for mode in (None, "", "unknown"):
            self.pw.client.get_grid_export.return_value = mode
            self.assertEqual(self.policy(self.pw, 100, True)["action"], "error")
        self.pw.client.get_grid_export.side_effect = TimeoutError()
        self.assertEqual(self.policy(self.pw, 100, True)["action"], "error")
        self.pw.set_grid_export.assert_not_called()

    def test_invalid_thresholds_prevent_writes(self):
        for lower, upper in ((70, 70), (90, 70), (-1, 90), (70, 101), (True, 90), (70, float("inf"))):
            self.assertEqual(self.policy(self.pw, 100, True, lower, upper)["action"], "error")
        self.pw.set_grid_export.assert_not_called()

    def test_write_must_be_verified(self):
        self.pw.client.get_grid_export.return_value = "pv_only"
        result = self.policy(self.pw, 100, True)
        self.assertEqual(result["action"], "error")
        self.assertEqual(result["exportMode"], "pv_only")
        self.pw.set_grid_export.assert_called_once_with("battery_ok")
        self.assertEqual(self.pw.client.get_grid_export.call_count, 2)

    def test_failed_write_is_not_reported_as_success(self):
        self.pw.client.get_grid_export.return_value = "battery_ok"
        self.pw.set_grid_export.side_effect = TimeoutError()
        result = self.policy(self.pw, 50, True)
        self.assertEqual(result["action"], "error")
        self.assertIsNone(result["exportMode"])

    def test_custom_thresholds(self):
        self.pw.client.get_grid_export.side_effect = ["battery_ok", "pv_only"]
        result = self.policy(self.pw, 39, True, 40, 60)
        self.assertEqual(result["action"], "disabled")
        self.pw.set_grid_export.assert_called_once_with("pv_only")



class ScheduledControlTests(unittest.TestCase):
    def setUp(self):
        helpers = runpy.run_path(str(SCRIPT))
        self.control = helpers["scheduled_battery_control"]
        self.window = helpers["premium_window"]
        self.pw = Mock()
        self.state = {"export": "pv_only", "mode": "self_consumption"}
        self.pw.client.get_grid_export.side_effect = lambda **kw: self.state["export"]
        self.pw.get_mode.side_effect = lambda **kw: self.state["mode"]
        self.pw.set_grid_export.side_effect = lambda value: self.state.update(export=value)
        self.pw.post.side_effect = lambda **kw: self.state.update(mode=kw["payload"]["real_mode"])

    def test_day_cycle_and_thresholds(self):
        for inside, charge, export, mode in [
            (False, 100, "pv_only", "self_consumption"),
            (True, 95, "battery_ok", "autonomous"),
            (True, 70, "battery_ok", "autonomous"),
            (True, 69, "pv_only", "autonomous"),
            (True, 80, "pv_only", "autonomous"),
            (True, 90, "battery_ok", "autonomous"),
            (False, 95, "pv_only", "self_consumption"),
            (True, 80, "pv_only", "autonomous")]:
            result = self.control(self.pw, charge, True, 70, 90, inside)
            self.assertNotEqual(result["action"], "error")
            self.assertEqual(self.state, {"export": export, "mode": mode})
        for call in self.pw.post.call_args_list:
            self.assertEqual(set(call.kwargs["payload"]), {"real_mode"})

    def test_inactive_and_blocked_never_write_modes(self):
        self.control(self.pw, 100, False, 70, 90, True)
        self.state["export"] = "never"
        self.control(self.pw, 100, True, 70, 90, True)
        self.pw.post.assert_not_called()
        self.pw.set_grid_export.assert_not_called()

    def test_unknown_mode_and_invalid_charge_prevent_writes(self):
        for mode in (None, "backup"):
            self.state["mode"] = mode
            self.assertEqual(self.control(self.pw, 100, True, 70, 90, True)["action"], "error")
        self.state["mode"] = "self_consumption"
        self.control(self.pw, None, True, 70, 90, True)
        self.pw.post.assert_not_called()
        self.pw.set_grid_export.assert_not_called()

    def test_unconfirmed_mode_retries_next_poll(self):
        self.pw.post.side_effect = None
        self.assertEqual(self.control(self.pw, 100, True, 70, 90, True)["action"], "error")
        self.pw.post.side_effect = lambda **kw: self.state.update(mode=kw["payload"]["real_mode"])
        self.assertNotEqual(self.control(self.pw, 100, True, 70, 90, True)["action"], "error")
        self.assertEqual(self.state["mode"], "autonomous")

    def test_window_boundaries_timezone_and_dst(self):
        from datetime import datetime
        for stamp, expected in [("2026-09-20T06:59:59+00:00", False),
                                ("2026-09-20T07:00:00+00:00", True),
                                ("2026-09-20T11:00:00+00:00", False),
                                ("2026-10-04T06:00:00+00:00", True)]:
            self.assertEqual(self.window("Australia/Melbourne", now=datetime.fromisoformat(stamp)), expected)
        self.assertTrue(self.window("UTC", "00:00", "24:00"))
        for start, end in [("21:00", "17:00"), ("bad", "21:00")]:
            with self.assertRaises(ValueError):
                self.window("UTC", start, end)


    def test_independent_levers_and_custom_targets(self):
        self.control(self.pw, 100, True, 70, 90, True, {
            "gridExport": {"enabled": False}, "operationalMode": {"inside": "self_consumption"}})
        self.pw.set_grid_export.assert_not_called()
        self.pw.post.assert_not_called()
        self.state["mode"] = "backup"
        self.control(self.pw, 100, True, 70, 90, False, {
            "gridExport": {"outside": "battery_ok"}, "operationalMode": {"enabled": False}})
        self.assertEqual(self.state["export"], "battery_ok")
        self.pw.post.assert_not_called()

    def test_invalid_control_targets(self):
        for options in ({"gridExport": {"inside": "invalid"}},
                        {"operationalMode": {"enabled": "yes"}}):
            with self.assertRaises(ValueError):
                self.control(self.pw, 100, True, 70, 90, True, options)
        self.pw.post.assert_not_called()
        self.pw.set_grid_export.assert_not_called()

if __name__ == "__main__":
    unittest.main()
