"""Install or remove the optional per-user login service. Never uses sudo."""

import argparse
import os
from pathlib import Path
import plistlib
import subprocess
import sys

LABEL = "com.local.lotuslantern"
ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["install", "remove"])
    args = parser.parse_args()
    domain = f"gui/{os.getuid()}"
    plist = Path.home() / "Library/LaunchAgents" / f"{LABEL}.plist"
    loaded = subprocess.run(
        ["launchctl", "print", f"{domain}/{LABEL}"], capture_output=True,
    ).returncode == 0
    if args.action == "remove":
        if loaded:
            subprocess.run(["launchctl", "bootout", f"{domain}/{LABEL}"], check=True)
        if plist.exists():
            plist.unlink()
        print("Login service removed. Saved sequences and playback settings were retained.")
        return
    python = ROOT / ".venv/bin/python"
    if not python.exists():
        parser.error("Create .venv and install requirements.txt before installing the login service.")
    if loaded:
        parser.error("The login service is already loaded. Remove it before reinstalling.")
    logs = Path.home() / "Library/Logs/LotusLantern"
    logs.mkdir(parents=True, exist_ok=True)
    plist.parent.mkdir(parents=True, exist_ok=True)
    if plist.exists():
        parser.error(f"{plist} already exists. Remove the old installation first.")
    definition = {
        "Label": LABEL,
        "ProgramArguments": [str(python), str(ROOT / "mac_service.py"), "--log", str(logs / "bluetooth.log")],
        "WorkingDirectory": str(ROOT),
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 30,
        "StandardOutPath": str(logs / "service.log"),
        "StandardErrorPath": str(logs / "error.log"),
        "EnvironmentVariables": {"PYTHONUNBUFFERED": "1"},
    }
    with plist.open("xb") as file:
        plistlib.dump(definition, file)
    os.chmod(plist, 0o600)
    subprocess.run(["launchctl", "bootstrap", domain, str(plist)], check=True)
    print("Login service installed. Open http://lotuslantern.localhost:49174")
    print(f"Logs: {logs}")


if __name__ == "__main__":
    main()
