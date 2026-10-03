import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location("discovery", Path(__file__).resolve().parents[1] / "scripts/pwtv_discovery.py")
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.cache = str(Path(self.temp.name) / "cache.json")
        self.pw = Mock(tedapi_mode="v1r")
        self.pw.din.return_value = "expected-din"
        self.pw.poll.return_value = {"site": {"instant_power": 1}}
        self.factory = Mock(return_value=self.pw)
        self.scanner = Mock(return_value=[{"ip": "10.0.0.75"}])
        self.probe = lambda host: host == "10.0.0.75"

    def run_connect(self):
        return d.connect("10.0.0.98", "expected-din", "10.0.0.0/24", self.cache,
                         self.factory, self.scanner, self.probe, lambda: 1000)

    def test_rediscovery_then_cached_address_and_permissions(self):
        with self.assertRaises(RuntimeError):
            self.run_connect()
        self.scanner.assert_not_called()
        pw, address, lock = self.run_connect()
        self.assertEqual(address, "10.0.0.75")
        lock.close()
        self.scanner.reset_mock()
        pw, address, lock = self.run_connect()
        lock.close()
        self.scanner.assert_not_called()
        self.assertEqual(Path(self.cache).stat().st_mode & 0o777, 0o600)
        pw.post.assert_not_called()

    def test_wrong_identity_and_cooldown(self):
        self.pw.din.return_value = "wrong"
        for _ in range(3):
            with self.assertRaises(RuntimeError):
                self.run_connect()
        self.scanner.assert_called_once()
        self.pw.post.assert_not_called()
        self.assertNotIn("host", json.loads(Path(self.cache).read_text()))

    def test_ambiguous_matches_are_rejected(self):
        self.probe = lambda host: host != "10.0.0.98"
        self.scanner.return_value = [{"ip": "10.0.0.75"}, {"ip": "10.0.0.76"}]
        for _ in range(2):
            with self.assertRaises(RuntimeError):
                self.run_connect()
        self.assertNotIn("host", json.loads(Path(self.cache).read_text()))

    def test_unbounded_network_rejected_before_probe(self):
        with self.assertRaises(ValueError):
            d.connect("10.0.0.98", "expected-din", "10.0.0.0/8", self.cache,
                      self.factory, self.scanner, self.probe)
        self.factory.assert_not_called()
        self.scanner.assert_not_called()

    def test_overlapping_control_cycle_is_locked(self):
        self.probe = lambda host: True
        _, _, lock = self.run_connect()
        try:
            with self.assertRaises(BlockingIOError):
                self.run_connect()
        finally:
            lock.close()
