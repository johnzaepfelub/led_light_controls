import asyncio
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from mac_service import (
    Controller, Store, WRITE, blend, color_frame, create_app, play, validate_saved, validate_sequence,
)


def sequence(repeat=True):
    return {
        "name": "Test fade", "repeat": repeat,
        "steps": [
            {"color": "#ffffff", "hold": 0, "fade": 0.3},
            {"color": "#0000ff", "hold": 0, "fade": 0.3},
        ],
    }


class StoreTests(unittest.TestCase):
    def test_persistence_and_stop_intent(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            store = Store(path)
            self.assertFalse(store.data["enabled"])
            store.update(
                device={"address": "office-id", "name": "BLEDOM"},
                sequence=sequence(), enabled=True, saved=[sequence()],
            )
            restored = Store(path)
            self.assertTrue(restored.data["enabled"])
            self.assertEqual(restored.data["saved"], [sequence()])
            restored.update(enabled=False)
            self.assertFalse(Store(path).data["enabled"])
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_failed_save_keeps_original_memory_and_disk(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            store = Store(path)
            store.update(saved=[sequence()])
            original = path.read_text()
            with patch("mac_service.os.replace", side_effect=OSError("Disk full")):
                with self.assertRaisesRegex(OSError, "Disk full"):
                    store.update(saved=[])
            self.assertEqual(store.data["saved"], [sequence()])
            self.assertEqual(path.read_text(), original)
            self.assertEqual(list(Path(directory).iterdir()), [path])

    def test_corruption_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            for text in ("{broken", '{"version":2}'):
                path.write_text(text)
                with self.assertRaises((ValueError, KeyError)):
                    Store(path)
                self.assertEqual(path.read_text(), text)

    def test_validation_and_frames(self):
        self.assertEqual(validate_sequence(sequence()), sequence())
        for value in (-1, 3601, True, float("nan"), "5"):
            invalid = sequence()
            invalid["steps"][0]["hold"] = value
            with self.assertRaises(ValueError):
                validate_sequence(invalid)
        with self.assertRaises(ValueError):
            validate_saved([sequence(), sequence()])
        self.assertEqual(color_frame("#ff0099"), bytes([0x7e, 7, 5, 3, 255, 0, 153, 16, 0xef]))
        self.assertEqual(blend("#ffffff", "#0000ff", 0.5), "#8080ff")


class PlayerTests(unittest.IsolatedAsyncioTestCase):
    async def test_fades_endpoints_and_once_completion(self):
        clock = 0
        writes = []
        steps = []

        async def sleep(duration):
            nonlocal clock
            clock += duration

        async def send(frame):
            writes.append(frame)

        await play(sequence(False), send, steps.append, sleep=sleep, clock=lambda: clock)
        self.assertEqual(writes, [color_frame("#ffffff"), color_frame("#8080ff"), color_frame("#0000ff")])
        self.assertEqual(steps, [0, 1])
        self.assertAlmostEqual(clock, 0.3)

    async def test_repeat_wrap_and_cancellation(self):
        clock = 0
        writes = []

        async def sleep(duration):
            nonlocal clock
            clock += duration

        async def send(frame):
            writes.append(frame)
            if len(writes) == 5:
                raise asyncio.CancelledError()

        with self.assertRaises(asyncio.CancelledError):
            await play(sequence(), send, lambda _step: None, sleep=sleep, clock=lambda: clock)
        self.assertEqual(writes[-1], color_frame("#ffffff"))


async def eventually(predicate):
    for _ in range(300):
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("Timed out waiting for service state")


class ControllerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.directory.name) / "state.json")
        self.device = SimpleNamespace(address="office-id", name="BLEDOM")
        self.in_range = False
        self.searched = []
        self.writes = []
        self.clients = []
        owner = self

        class Scanner:
            @staticmethod
            async def discover(timeout):
                return [owner.device, SimpleNamespace(address="unrelated", name="Headphones")]

            @staticmethod
            async def find_device_by_address(address, timeout):
                owner.searched.append(address)
                await asyncio.sleep(0)
                return owner.device if owner.in_range else None

        class Client:
            def __init__(self, device):
                self.is_connected = False
                self.services = self
                owner.clients.append(self)

            async def connect(self):
                self.is_connected = True

            async def disconnect(self):
                self.is_connected = False

            def get_characteristic(self, uuid):
                assert uuid == WRITE
                return SimpleNamespace(properties=["write-without-response"])

            async def write_gatt_char(self, characteristic, command, response):
                if not self.is_connected:
                    raise ConnectionError("Disconnected")
                owner.writes.append(command)

        self.scanner, self.factory = Scanner, Client
        self.controller = Controller(self.store, Scanner, Client, retry=0.01)

    async def asyncTearDown(self):
        await self.controller.close()
        self.directory.cleanup()

    async def configure(self):
        results = await self.controller.scan()
        self.assertEqual(results, [{"address": "office-id", "name": "BLEDOM"}])
        await self.controller.select("office-id")

    async def test_wait_at_home_resume_office_drop_and_resume_again(self):
        await self.configure()
        await self.controller.enable(sequence())
        await eventually(lambda: self.controller.phase == "waiting")
        self.assertTrue(self.store.data["enabled"])
        self.assertEqual(self.writes, [])
        self.in_range = True
        await eventually(lambda: len(self.writes) > 0)
        self.assertEqual(self.writes[0], color_frame("#ffffff"))
        self.in_range = False
        self.clients[-1].is_connected = False
        with self.assertLogs("lotuslantern", level="ERROR"):
            await eventually(lambda: self.controller.phase == "waiting")
        count = len(self.writes)
        self.in_range = True
        await eventually(lambda: len(self.writes) > count)
        self.assertEqual(self.writes[count], color_frame("#ffffff"))
        self.assertEqual(set(self.searched), {"office-id"})

    async def test_stop_at_home_survives_restart_and_never_resumes(self):
        await self.configure()
        await self.controller.enable(sequence())
        await eventually(lambda: self.controller.phase == "waiting")
        await self.controller.stop()
        await self.controller.close()
        restored = Store(self.store.path)
        self.assertFalse(restored.data["enabled"])
        self.in_range = True
        self.controller = Controller(restored, self.scanner, self.factory, retry=0.01)
        self.controller.start()
        await eventually(lambda: self.controller.connected)
        self.assertEqual(self.writes, [])

    async def test_enabled_playback_survives_service_restart(self):
        await self.configure()
        await self.controller.enable(sequence())
        await self.controller.close()
        restored = Store(self.store.path)
        self.in_range = True
        self.controller = Controller(restored, self.scanner, self.factory, retry=0.01)
        self.controller.start()
        await eventually(lambda: bool(self.writes))
        self.assertTrue(restored.data["enabled"])

    async def test_one_shot_disables_auto_resume_after_completion(self):
        self.in_range = True
        await self.configure()
        await self.controller.enable(sequence(False))
        await eventually(lambda: not self.store.data["enabled"])
        self.assertEqual(self.writes[-1], color_frame("#0000ff"))

    async def test_manual_rejected_during_playback_and_stop_releases_writer(self):
        self.in_range = True
        await self.configure()
        await self.controller.enable(sequence())
        await eventually(lambda: bool(self.writes))
        with self.assertRaisesRegex(ValueError, "Stop automatic"):
            await self.controller.manual(list(color_frame("#ffffff")))
        await self.controller.stop()
        count = len(self.writes)
        await asyncio.sleep(0.2)
        self.assertEqual(len(self.writes), count)
        await self.controller.manual(list(color_frame("#ff0000")))
        self.assertEqual(self.writes[-1], color_frame("#ff0000"))
        with self.assertRaises(ValueError):
            await self.controller.manual([0] * 9)

    async def test_selection_is_explicit_and_disconnect_disables_resume(self):
        with self.assertRaises(ValueError):
            await self.controller.select("unrelated")
        with self.assertRaises(ValueError):
            await self.controller.enable(sequence())
        await self.configure()
        await self.controller.enable(sequence())
        await self.controller.stop(disconnect=True)
        self.assertFalse(self.store.data["enabled"])
        self.assertFalse(self.controller.connected)
        self.assertIsNone(self.controller.task)


class HttpTests(unittest.IsolatedAsyncioTestCase):
    async def test_api_origin_validation_and_persistence(self):
        from aiohttp.test_utils import TestClient, TestServer
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / "state.json")
            controller = Controller(store, None, None)
            # TestServer binds a random port; use an explicit Host to test policy.
            client = TestClient(TestServer(create_app(controller, 49174)))
            await client.start_server()
            try:
                host = {"Host": "localhost:49174"}
                response = await client.get("/", headers=host)
                self.assertEqual(response.status, 200)
                self.assertIn('data-backend="python"', await response.text())
                self.assertEqual((await client.get("/mac_service.py", headers=host)).status, 404)
                self.assertEqual((await client.get("/api/state", headers={"Host": "evil.example"})).status, 403)
                self.assertEqual((await client.post("/api/stop", json={}, headers=host)).status, 403)
                headers = {**host, "Origin": "http://localhost:49174", "X-Lotus-Client": "local"}
                response = await client.post("/api/sequences", json={"sequences": [sequence()]}, headers=headers)
                self.assertEqual(response.status, 200)
                self.assertEqual(Store(store.path).data["saved"], [sequence()])
                response = await client.get("/api/sequences", headers=host)
                self.assertEqual(await response.json(), [sequence()])
                response = await client.post("/api/play", json={"sequence": sequence()}, headers=headers)
                self.assertEqual(response.status, 400)
                headers["Origin"] = "https://evil.example"
                response = await client.post("/api/stop", json={}, headers=headers)
                self.assertEqual(response.status, 403)
            finally:
                await client.close()


if __name__ == "__main__":
    unittest.main()
