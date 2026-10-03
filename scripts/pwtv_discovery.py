"""Bounded, identity-verified LAN discovery; never issues control writes."""
import fcntl
import ipaddress
import json
import os
import socket
import tempfile
import time


def save(path, state):
    fd, temporary = tempfile.mkstemp(prefix=".discovery-", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(state, stream)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def reachable(host):
    try:
        with socket.create_connection((host, 443), timeout=2):
            return True
    except OSError:
        return False


def connect(host, expected, cidr, cache_path, factory, scanner, probe=reachable, now=time.time):
    network = ipaddress.ip_network(cidr, strict=False)
    if network.version != 4 or network.num_addresses > 1024 or not expected or expected == "Powerwall-3":
        raise ValueError("Discovery requires a unique expected DIN and IPv4 network of at most 1024 addresses.")
    path = os.path.abspath(os.path.expanduser(cache_path))
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    lock = os.fdopen(os.open(path + ".lock", os.O_CREAT | os.O_RDWR, 0o600), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = {}
        if os.path.exists(path):
            with open(path) as stream:
                state = json.load(stream)
            if state.get("din") != expected or state.get("cidr") != str(network):
                state = {}
        state.update(din=expected, cidr=str(network))

        def verify(address):
            if not probe(address):
                raise RuntimeError("Unreachable")
            pw = factory(address)
            if getattr(pw, "tedapi_mode", None) != "v1r" or pw.din() != expected:
                raise RuntimeError("Identity or transport mismatch")
            # A signed telemetry read must succeed before caching or control.
            data = pw.poll("/api/meters/aggregates")
            if not isinstance(data, dict) or not isinstance(data.get("site"), dict):
                raise RuntimeError("Telemetry unavailable")
            return pw

        address = state.get("host") or host
        try:
            pw = verify(address)
        except Exception:
            state["failures"] = state.get("failures", 0) + 1
            save(path, state)
            if state["failures"] < 2 or now() - state.get("lastScan", 0) < 300:
                raise RuntimeError("Powerwall unavailable; discovery waiting for failure threshold or cooldown.") from None
            state["lastScan"] = now()
            save(path, state)
            matches = []
            candidates = scanner(cidr=str(network), timeout=0.4, max_threads=30, json_output=True)
            addresses = sorted({row.get("ip") for row in candidates if isinstance(row.get("ip"), str)})
            if len(addresses) > 8:
                raise RuntimeError("Too many discovery candidates; refusing automatic selection.")
            for candidate in addresses:
                if ipaddress.ip_address(candidate) not in network:
                    continue
                try:
                    matches.append((candidate, verify(candidate)))
                except Exception:
                    continue
            if len(matches) != 1:
                raise RuntimeError("Discovery did not find exactly one verified gateway; controls suspended.")
            address, pw = matches[0]
        state.update(host=address, failures=0, verifiedAt=now())
        save(path, state)
        # Retain the lock through the caller's telemetry/control cycle.
        return pw, address, lock
    except Exception:
        lock.close()
        raise
