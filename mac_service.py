"""Local Bluetooth playback service. Run with the project's virtual environment."""

import argparse
import asyncio
from contextlib import suppress
import fcntl
import json
import logging
from logging.handlers import RotatingFileHandler
import math
import os
from pathlib import Path
import re
import tempfile
import time

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path.home() / "Library/Application Support/LotusLantern"
SERVICE = "0000fff0-0000-1000-8000-00805f9b34fb"
WRITE = "0000fff3-0000-1000-8000-00805f9b34fb"
LOG = logging.getLogger("lotuslantern")


def validate_sequence(value):
    if not isinstance(value, dict):
        raise ValueError("A sequence must be an object.")
    name = value.get("name")
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80:
        raise ValueError("Sequence name must contain 1 to 80 characters.")
    if type(value.get("repeat")) is not bool:
        raise ValueError("Repeat must be true or false.")
    steps = value.get("steps")
    if not isinstance(steps, list) or not 1 <= len(steps) <= 50:
        raise ValueError("A sequence must contain 1 to 50 steps.")
    result = []
    for step in steps:
        if not isinstance(step, dict) or not re.fullmatch(r"#[0-9a-fA-F]{6}", str(step.get("color", ""))):
            raise ValueError("Each step needs a six-digit hex color.")
        for key in ("hold", "fade"):
            number = step.get(key)
            if type(number) not in (int, float) or not math.isfinite(number) or not 0 <= number <= 3600:
                raise ValueError("Hold and fade must be between 0 and 3600 seconds.")
        result.append({key: step[key] for key in ("color", "hold", "fade")})
    return {"name": name.strip(), "repeat": value["repeat"], "steps": result}


def validate_saved(values):
    if not isinstance(values, list):
        raise ValueError("Saved sequences must be a list.")
    sequences = [validate_sequence(value) for value in values]
    if len({value["name"] for value in sequences}) != len(sequences):
        raise ValueError("Saved sequence names must be unique.")
    return sequences


class Store:
    def __init__(self, path):
        self.path = Path(path)
        if self.path.exists():
            # Invalid state is a startup error, never permission to overwrite it.
            self.data = json.loads(self.path.read_text())
            if not isinstance(self.data, dict) or self.data.get("version") != 1:
                raise ValueError(f"Unsupported state file: {self.path}")
            self.data["saved"] = validate_saved(self.data["saved"])
            if type(self.data["enabled"]) is not bool:
                raise ValueError("Invalid playback state.")
            if self.data["sequence"] is not None:
                self.data["sequence"] = validate_sequence(self.data["sequence"])
            device = self.data["device"]
            if device is not None and (
                not isinstance(device, dict)
                or not isinstance(device.get("address"), str)
                or not device["address"]
                or not isinstance(device.get("name"), str)
            ):
                raise ValueError("Invalid saved device.")
            if self.data["enabled"] and (not device or not self.data["sequence"]):
                raise ValueError("Automatic playback requires a device and sequence.")
        else:
            self.data = {"version": 1, "device": None, "sequence": None, "enabled": False, "saved": []}

    def update(self, **changes):
        updated = {**self.data, **changes}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix=".state-", dir=self.path.parent)
        try:
            with os.fdopen(fd, "w") as file:
                json.dump(updated, file, allow_nan=False)
                file.flush()
                os.fsync(file.fileno())
            os.replace(name, self.path)
        finally:
            if os.path.exists(name):
                os.unlink(name)
        self.data = updated


def color_frame(color):
    return bytes([0x7e, 7, 5, 3, *bytes.fromhex(color[1:]), 0x10, 0xef])


def blend(start, end, fraction):
    first, last = bytes.fromhex(start[1:]), bytes.fromhex(end[1:])
    return "#" + "".join(f"{math.floor(a + (b - a) * fraction + 0.5):02x}" for a, b in zip(first, last))


async def play(sequence, send, step_changed, sleep=asyncio.sleep, clock=time.monotonic):
    steps = sequence["steps"]
    await send(color_frame(steps[0]["color"]))
    index = 0
    while True:
        step_changed(index)
        step = steps[index]
        await sleep(step["hold"])
        if index == len(steps) - 1 and not sequence["repeat"]:
            return
        following = (index + 1) % len(steps)
        duration = step["fade"]
        if duration == 0:
            await sleep(0.15)
            await send(color_frame(steps[following]["color"]))
        else:
            started = clock()
            fraction = 0
            while fraction < 1:
                await sleep(min(0.15, max(0, duration - (clock() - started))))
                fraction = min(1, (clock() - started) / duration)
                await send(color_frame(blend(step["color"], steps[following]["color"], fraction)))
        index = following


class Controller:
    def __init__(self, store, scanner, client_factory, retry=20):
        self.store, self.scanner, self.client_factory = store, scanner, client_factory
        self.retry = retry
        self.client = None
        self.task = None
        self.characteristic = None
        self.last_write = 0
        self.lock = asyncio.Lock()
        self.scan_lock = asyncio.Lock()
        self.discovered = {}
        self.phase = "stopped"
        self.error = None
        self.step = None

    @property
    def connected(self):
        return bool(self.client and self.client.is_connected and self.characteristic is not None)

    def state(self):
        return {
            "connected": self.connected,
            "device": self.store.data["device"],
            "enabled": self.store.data["enabled"],
            "sequence": self.store.data["sequence"],
            "phase": self.phase,
            "step": self.step,
            "error": self.error,
        }

    def start(self):
        if self.store.data["device"]:
            self.task = asyncio.create_task(self.run())

    async def cancel(self):
        if self.task:
            self.task.cancel()
            with suppress(asyncio.CancelledError):
                await self.task
            self.task = None
        self.step = None

    async def close(self):
        await self.cancel()
        if self.client:
            try:
                await asyncio.wait_for(self.client.disconnect(), timeout=10)
            finally:
                self.client = None
                self.characteristic = None

    async def scan(self):
        async with self.scan_lock:
            devices = await self.scanner.discover(timeout=6)
        self.discovered = {
            item.address: item for item in devices
            if (item.name or "").startswith(("BLEDOM", "ELK-BLEDOM"))
        }
        return [{"address": item.address, "name": item.name} for item in self.discovered.values()]

    async def select(self, address):
        async with self.lock:
            if address not in self.discovered:
                raise ValueError("Scan and select a device from the list first.")
            item = self.discovered[address]
            self.store.update(device={"address": item.address, "name": item.name}, enabled=False)
            await self.close()
            self.start()

    async def enable(self, sequence):
        sequence = validate_sequence(sequence)
        async with self.lock:
            if not self.store.data["device"]:
                raise ValueError("Scan and select your lights before starting playback.")
            self.store.update(sequence=sequence, enabled=True)
            await self.cancel()
            self.start()

    async def stop(self, disconnect=False):
        async with self.lock:
            # Persist Stop before cancellation so a restart cannot re-enable it.
            self.store.update(enabled=False)
            await self.cancel()
            if disconnect:
                await self.close()
            else:
                self.start()
            self.phase = "stopped"

    async def send(self, command):
        if not self.connected:
            raise ConnectionError("The selected lights are not connected.")
        await asyncio.sleep(max(0, 0.15 - (time.monotonic() - self.last_write)))
        if not self.connected:
            raise ConnectionError("The lights disconnected before writing.")
        self.last_write = time.monotonic()
        await asyncio.wait_for(
            self.client.write_gatt_char(
                self.characteristic, command,
                response="write-without-response" not in self.characteristic.properties,
            ),
            timeout=10,
        )

    async def connected_sleep(self, duration):
        deadline = time.monotonic() + duration
        while True:
            if not self.connected:
                raise ConnectionError("The lights left Bluetooth range; waiting to reconnect.")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            await asyncio.sleep(min(1, remaining))

    async def manual(self, command):
        if (
            not isinstance(command, list) or len(command) != 9
            or any(type(byte) is not int or not 0 <= byte <= 255 for byte in command)
        ):
            raise ValueError("Invalid command frame.")
        frame = bytes(command)
        color = frame[:4] == bytes([0x7e, 7, 5, 3]) and frame[-2:] == bytes([0x10, 0xef])
        brightness = (
            frame[:3] == bytes([0x7e, 4, 1]) and frame[4:] == bytes([0, 255, 255, 0, 0xef])
        ) or (
            frame[:3] == bytes([0x7e, 7, 1]) and frame[3] <= 100
            and frame[4:] == bytes([255, 255, 255, 0, 0xef])
        )
        power = frame in (
            bytes([0x7e, 4, 4, 1, 0, 1, 255, 0, 0xef]),
            bytes([0x7e, 4, 4, 0, 0, 0, 255, 0, 0xef]),
        )
        if not (color or brightness or power):
            raise ValueError("Only color, brightness, and standard power commands are allowed.")
        async with self.lock:
            if self.store.data["enabled"]:
                raise ValueError("Stop automatic playback before using manual controls.")
            await self.send(frame)

    async def run(self):
        # Only this worker connects or plays. It never adopts a different device.
        while True:
            try:
                if not self.connected:
                    self.phase, self.step = "searching", None
                    target = self.store.data["device"]["address"]
                    async with self.scan_lock:
                        device = await self.scanner.find_device_by_address(target, timeout=6)
                    if device is None:
                        self.phase, self.error = "waiting", None
                        await asyncio.sleep(self.retry)
                        continue
                    if self.client:
                        await asyncio.wait_for(self.client.disconnect(), timeout=10)
                    self.characteristic = None
                    self.client = self.client_factory(device)
                    await asyncio.wait_for(self.client.connect(), timeout=20)
                    self.characteristic = self.client.services.get_characteristic(WRITE)
                    if not self.characteristic or not any(
                        value in self.characteristic.properties for value in ("write", "write-without-response")
                    ):
                        raise ValueError("Controller has no compatible writable FFF3 characteristic.")
                    self.error = None
                if self.store.data["enabled"]:
                    self.phase = "playing"
                    await play(
                        self.store.data["sequence"], self.send,
                        lambda index: setattr(self, "step", index),
                        sleep=self.connected_sleep,
                    )
                    self.store.update(enabled=False)
                    self.step = None
                self.phase = "connected"
                await asyncio.sleep(1)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                # This is the retry boundary: report the failure, retain intent,
                # and release the failed connection before another bounded scan.
                LOG.exception("Bluetooth worker failed; retrying in %ss", self.retry)
                self.phase, self.error, self.step = "error", str(error), None
                client, self.client = self.client, None
                self.characteristic = None
                if client:
                    try:
                        await asyncio.wait_for(client.disconnect(), timeout=10)
                    except Exception:
                        LOG.exception("Failed to release Bluetooth connection")
                await asyncio.sleep(self.retry)


def create_app(controller, port):
    from aiohttp import web

    @web.middleware
    async def protect(request, handler):
        # No CORS. Reject DNS rebinding and cross-origin mutations as well.
        allowed = {f"127.0.0.1:{port}", f"localhost:{port}", f"lotuslantern.localhost:{port}"}
        if request.host not in allowed:
            raise web.HTTPForbidden(text="Invalid local host.")
        if request.method == "POST":
            origin = request.headers.get("Origin")
            if origin != f"http://{request.host}" or request.headers.get("X-Lotus-Client") != "local":
                raise web.HTTPForbidden(text="Local same-origin client required.")
        try:
            response = await handler(request)
            response.headers["Cache-Control"] = "no-store"
            response.headers["X-Content-Type-Options"] = "nosniff"
            response.headers["Content-Security-Policy"] = (
                "default-src 'self'; style-src 'self'; script-src 'self'; "
                "object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
            )
            return response
        except (ValueError, KeyError, TypeError) as error:
            return web.json_response({"error": str(error)}, status=400)
        except (OSError, TimeoutError) as error:
            LOG.exception("Local service operation failed")
            return web.json_response({"error": str(error)}, status=503)
        except web.HTTPException:
            raise
        except Exception as error:
            LOG.exception("Local service request failed")
            return web.json_response({"error": str(error)}, status=500)

    app = web.Application(middlewares=[protect], client_max_size=1024 * 1024)

    async def api(request):
        action = request.match_info["action"]
        if request.method == "GET":
            if action == "state":
                return web.json_response(controller.state())
            if action == "sequences":
                return web.json_response(controller.store.data["saved"])
        else:
            body = await request.json()
            if action == "scan":
                return web.json_response(await controller.scan())
            if action == "select":
                await controller.select(body["address"])
            elif action == "play":
                await controller.enable(body["sequence"])
            elif action == "stop":
                await controller.stop()
            elif action == "disconnect":
                await controller.stop(disconnect=True)
            elif action == "command":
                await controller.manual(body["command"])
            elif action == "sequences":
                async with controller.lock:
                    controller.store.update(saved=validate_saved(body["sequences"]))
            else:
                raise web.HTTPNotFound()
            return web.json_response(controller.state())
        raise web.HTTPNotFound()

    async def static(request):
        name = request.match_info.get("file") or "index.html"
        if name not in {"index.html", "app.js", "lights.js", "sequences.js", "python-client.js", "styles.css"}:
            raise web.HTTPNotFound()
        if name == "index.html":
            text = (ROOT / name).read_text().replace("<body>", '<body data-backend="python">')
            return web.Response(text=text, content_type="text/html", headers={"Cache-Control": "no-store"})
        return web.FileResponse(ROOT / name, headers={"Cache-Control": "no-store"})

    async def lifecycle(_app):
        controller.start()
        yield
        await controller.close()

    app.cleanup_ctx.append(lifecycle)
    app.router.add_route("GET", "/api/{action}", api)
    app.router.add_route("POST", "/api/{action}", api)
    app.router.add_get("/", static)
    app.router.add_get("/{file}", static)
    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=49174)
    parser.add_argument("--state", type=Path, default=DATA_DIR / "state.json")
    parser.add_argument("--log", type=Path, help="Write bounded rotating logs to this file.")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("Port must be between 1024 and 65535.")
    from aiohttp import web
    from bleak import BleakClient, BleakScanner

    handlers = None
    if args.log:
        args.log.parent.mkdir(parents=True, exist_ok=True)
        handlers = [RotatingFileHandler(args.log, maxBytes=2_000_000, backupCount=3)]
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", handlers=handlers)
    args.state.parent.mkdir(parents=True, exist_ok=True)
    with args.state.with_suffix(".lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.error("Another Python service is already using this state file. Stop it first.")
        store = Store(args.state)
        controller = Controller(store, BleakScanner, BleakClient)
        web.run_app(create_app(controller, args.port), host="127.0.0.1", port=args.port, access_log=None)


if __name__ == "__main__":
    main()
