"""End-to-end tests: client stack against the loopback KNXnet/IP gateway.

Every test exercises the real wire format - tunnelling ACKs, sequence numbers,
local confirmations, cEMI services - not mocks of the client API.
"""

import unittest

from knxagent import cemi, dpt, knxip, link, simulate


class TestTunnelEndToEnd(unittest.TestCase):
    def setUp(self):
        self.dev_a = simulate.VirtualDevice(0x1101, descriptor=0x07B0, name="MDT-actor")
        self.dev_b = simulate.VirtualDevice(0x1102, descriptor=0x0705, name="MDT-dimmer")
        self.sim = simulate.GatewaySim([self.dev_a, self.dev_b])
        self.sim.start()
        self.tunnel = knxip.Tunnel("127.0.0.1", self.sim.port, connect_timeout=3.0)
        self.link = link.DeviceLink(self.tunnel)
        self.bus = link.GroupBus(self.tunnel)

    def tearDown(self):
        self.tunnel.close()
        self.sim.stop()

    # -- transport
    def test_connect_allocates_channel(self):
        self.assertIsNotNone(self.tunnel.channel)
        self.assertEqual(self.tunnel.stats()["rx_errors"], 0)

    def test_heartbeat(self):
        self.assertTrue(self.tunnel.heartbeat())

    def test_search_unicast(self):
        found = knxip.search(timeout=1.0, multicast=False,
                             unicast_targets=[("127.0.0.1", self.sim.port)])
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["friendly_name"], "MDT-actor")

    # -- memory services
    def test_memory_write_then_read(self):
        payload = bytes.fromhex("1122334455")
        self.assertTrue(self.link.memory_write(0x1101, 0x4000, payload))
        self.assertEqual(self.dev_a.dump(0x4000, 5), payload)
        self.assertEqual(self.link.memory_read(0x1101, 0x4000, 5), payload)

    def test_memory_read_is_chunked_above_15_octets(self):
        self.dev_a.fill(0x0100, bytes(range(40)))
        value = self.link.memory_read(0x1101, 0x0100, 40)
        self.assertEqual(value, bytes(range(40)))
        self.assertEqual(self.sim.errors, [])

    def test_memory_read_of_absent_device_times_out(self):
        self.assertIsNone(self.link.memory_read(0x1109, 0x4000, 4, timeout=0.15, retries=0))

    def test_descriptor_read(self):
        self.assertEqual(self.link.descriptor_read(0x1101), 0x07B0)
        self.assertEqual(self.link.descriptor_read(0x1102), 0x0705)

    def test_property_read_write(self):
        self.assertTrue(self.link.property_write(0x1101, 12, 51, b"\x01\x02\x03\x04"))
        self.assertEqual(self.link.property_read(0x1101, 12, 51), b"\x01\x02\x03\x04")

    # -- addressing / restart
    def test_assign_individual_address(self):
        self.assertTrue(self.link.assign_ia(0x110F))
        self.assertEqual(self.dev_a.ia, 0x110F)

    def test_restart_master_resets_memory(self):
        self.link.memory_write(0x1101, 0x4000, b"\xAA")
        self.assertTrue(self.link.restart(0x1101, master=True))
        self.assertEqual(self.dev_a.restarts, [True])
        self.assertEqual(self.dev_a.dump(0x4000, 1), b"\xFF")

    def test_scan_finds_both_devices(self):
        self.sim.clear()
        found = self.link.scan("1.1", range(1, 8), window=8, settle=0.4)
        self.assertEqual([d["ia"] for d in found], [0x1101, 0x1102])
        self.assertEqual(found[0]["descriptor"], 0x07B0)

    # -- group traffic + DPT
    def test_group_write_and_read_back(self):
        ga = cemi.parse_ga("1/2/3")
        self.assertTrue(self.bus.write(ga, b"\x01"))
        self.assertEqual(self.dev_a.group_values[ga], b"\x01")
        response = self.bus.read(ga)
        self.assertIsNotNone(response)
        self.assertEqual(dpt.decode("1.001", response["value"]), True)

    def test_dpt_write(self):
        ga = cemi.parse_ga("2/1/1")
        self.bus.write_dpt(ga, "9.001", 21.5)
        self.assertAlmostEqual(round(dpt.decode("9.001", self.dev_b.group_values[ga]), 2), 21.5, 2)

    # -- failure paths
    def test_sequence_error_from_gateway_is_reported(self):
        self.sim.set_ack_status(knxip.E_SEQ)
        self.assertFalse(self.link.memory_write(0x1101, 0x4000, b"\x01"))
        self.sim.set_ack_status(knxip.E_NO_ERROR)

    def test_reconnect_after_disconnect(self):
        self.tunnel.close()
        self.tunnel = knxip.Tunnel("127.0.0.1", self.sim.port)
        self.link = link.DeviceLink(self.tunnel)
        self.assertEqual(self.link.descriptor_read(0x1101), 0x07B0)


class TestDptCodec(unittest.TestCase):
    def test_roundtrips(self):
        cases = [("1.001", True), ("5.001", 42), ("9.001", -12.34), ("14.056", 1234.5),
                 ("7.001", 3000)]
        for dpt_id, value in cases:
            raw = dpt.encode(dpt_id, value)
            back = dpt.decode(dpt_id, raw)
            if isinstance(value, float):
                self.assertAlmostEqual(round(float(back), 2), round(value, 2))
            else:
                self.assertEqual(back, value)


if __name__ == "__main__":
    unittest.main()
