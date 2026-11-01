"""Project parsing, recipe capture/replay and the agent tool surface."""

import json
import os
import tempfile
import unittest
import zipfile

from knxagent import agent, cemi, download, knxip, link, project, simulate


KNXPROJ_XML = """<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20">
  <Project ProjectNumber="1019" Id="P-0001">
    <Installations>
      <Installation Name="Site">
        <Topology>
          <Area Address="1" Name="Ground floor">
            <Line Address="1" Name="Line 1">
              <DeviceInstance Id="di-1" Address="4354" Name="Dimmer EG" Comment="1.1.2"
                             ProductRefId="M-0002_H-0003_P-0004"
                             Hardware2ProgramRefId="M-0002_H-0003_HP-0004">
                <ComObjectInstanceRefs>
                  <ComObjectInstanceRef RefId="O-1" Text="Switch" DatapointType="DPST-1-1"
                                        Links="ga-switch ga-status"/>
                </ComObjectInstanceRefs>
              </DeviceInstance>
              <DeviceInstance Id="di-2" Address="4355" Name="Switch EG"
                             ProductRefId="M-0002_H-0005_P-0006"/>
              <ComObjectInstanceRef RefId="O-2" Text="Legacy sibling form"
                                    Links="ga-dim"/>
            </Line>
          </Area>
        </Topology>
        <GroupAddresses>
          <GroupAddresses>
            <GroupAddress Id="ga-switch" Address="2307" Name="EG Licht schalten"
                          DatapointType="DPST-1-1"/>
            <GroupAddress Id="ga-status" Address="2308" Name="EG Licht Status"
                          DatapointType="DPST-1-1"/>
            <GroupAddress Id="ga-dim" Address="2309" Name="EG Dimmen relativ"
                          DatapointType="DPST-3-7"/>
          </GroupAddresses>
        </GroupAddresses>
      </Installation>
    </Installations>
  </Project>
</KNX>
"""

KNXPROD_XML = """<?xml version="1.0" encoding="utf-8"?>
<KNX xmlns="http://knx.org/xml/project/20">
  <Manufacturer Name="ACME KNX">
    <ApplicationPrograms>
      <ApplicationProgram Id="M-0002_A-1234" Name="Dimmer 4f" MaskVersion="MV-07B0">
        <Static>
          <CodeSegment Address="4000" Size="2048" Name="application"/>
          <AbsoluteSegment Address="4700" Size="16" Name="parameters"/>
        </Static>
        <Parameters>
          <Parameter Id="P-dim-time" Name="Dim time" ParameterType="ParameterBlock" Offset="4700"/>
        </Parameters>
      </ApplicationProgram>
    </ApplicationPrograms>
  </Manufacturer>
</KNX>
"""


def make_knxproj(path: str) -> str:
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("P-0001/project.xml", KNXPROJ_XML)
        archive.writestr("P-0001/0.xml", "<KNX/>")
    return path


class TestProject(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.path = os.path.join(self.tmp, "site.knxproj")
        make_knxproj(self.path)

    def test_parses_devices_and_group_addresses(self):
        parsed = project.KnxProject(self.path)
        self.assertEqual(parsed.summary()["devices"], 2)
        self.assertEqual([d.ia_text for d in parsed.devices], ["1.1.2", "1.1.3"])
        self.assertEqual(len(parsed.group_addresses), 3)
        switch = [g for g in parsed.group_addresses if g.name.startswith("EG Licht schalten")][0]
        self.assertEqual(switch.number, 2307)
        self.assertEqual(switch.text, cemi.format_ga(2307))

    def test_com_objects_are_linked_to_group_addresses(self):
        parsed = project.KnxProject(self.path)
        device = [d for d in parsed.devices if d.id == "di-1"][0]
        self.assertEqual(len(device.com_objects), 1)
        self.assertEqual(device.com_objects[0]["group_addresses"],
                         [cemi.format_ga(2307), cemi.format_ga(2308)])

    def test_product_database_parameter_layout(self):
        path = os.path.join(self.tmp, "acme.knxprod")
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("M-0002/knxprod.xml", KNXPROD_XML)
        database = project.ProductDatabase(path)
        summary = database.summary()
        self.assertEqual(summary["manufacturer"], "ACME KNX")
        self.assertEqual(len(summary["applications"]), 1)
        self.assertEqual(summary["applications"][0]["parameters"], 1)


class TestRecipeFromCapture(unittest.TestCase):
    def _frames(self):
        ia = 0x1102
        base = 0x4000
        frames = []
        for offset in range(0, 22, 11):   # two contiguous blocks, 22 octets total
            apdu = cemi.apdu_memory_write(base + offset, bytes(range(offset, offset + 11)))
            frames.append(cemi.parse(cemi.ldata(ia, apdu, group=False)))
        frames.append(cemi.parse(cemi.ldata(ia, cemi.apdu_restart(), group=False)))
        frames.append(cemi.parse(cemi.ldata(cemi.parse_ga("1/2/3"),
                                            cemi.apdu_group_write(b"\x01"), group=True)))
        return frames

    def test_capture_merges_blocks_and_keeps_order(self):
        recipe = download.capture_to_recipe(self._frames(), 0x1102)
        ops = [step["op"] for step in recipe["steps"]]
        self.assertEqual(ops[0], "memory_write")
        self.assertEqual(ops[1], "restart")
        self.assertEqual(ops[2], "group_write")
        merged = bytes.fromhex(recipe["steps"][0]["data"])
        self.assertEqual(merged, bytes(range(22)))
        self.assertEqual(recipe["steps"][0]["address"], 0x4000)

    def test_capture_of_unknown_device_fails_loudly(self):
        with self.assertRaises(download.RecipeError):
            download.capture_to_recipe([], 0x1123)

    def test_placeholders_resolve(self):
        recipe = download.validate({
            "device": {"ia": "1.1.9", "group": "1/2/3"},
            "steps": [{"op": "group_write", "ga": "{{group}}", "data": "01"}],
        })
        runner = download.DownloadRunner(None, None)
        resolved = download._resolve(recipe["steps"][0], recipe["device"])
        self.assertEqual(resolved["ga"], "1/2/3")


class TestRecipeAgainstSimulator(unittest.TestCase):
    def setUp(self):
        self.device = simulate.VirtualDevice(0x1102, programming_mode=True)
        self.sim = simulate.GatewaySim([self.device])
        self.sim.start()
        self.transport = knxip.Tunnel("127.0.0.1", self.sim.port)
        self.runner = download.DownloadRunner(link.DeviceLink(self.transport),
                                             link.GroupBus(self.transport))

    def tearDown(self):
        self.transport.close()
        self.sim.stop()

    def test_download_recipe_runs_and_verifies(self):
        payload = bytes(range(32))
        recipe = download.validate({
            "device": {"ia": "1.1.2", "name": "sim"},
            "steps": [
                {"op": "note", "text": "smoke test"},
                {"op": "memory_write", "address": "0x4000", "data": payload.hex()},
                {"op": "memory_expect", "address": "0x4000", "data": payload.hex()},
                {"op": "memory_write", "address": "0x4700", "data": "01020304"},
                {"op": "restart", "master": False},
                {"op": "group_write", "ga": "1/2/3", "dpt": "1.001", "value": 1},
                {"op": "group_expect", "ga": "1/2/3", "dpt": "1.001", "value": 1},
            ],
        })
        report = self.runner.run(recipe)
        self.assertTrue(report["ok"], report)
        self.assertEqual(self.device.dump(0x4000, 32), payload)
        self.assertEqual(self.device.restarts, [False])
        self.assertEqual(self.device.group_values[cemi.parse_ga("1/2/3")], b"\x01")

    def test_failed_verification_stops_the_run(self):
        recipe = download.validate({
            "device": {"ia": "1.1.2"},
            "steps": [
                {"op": "memory_write", "address": "0x4000", "data": "aabb"},
                {"op": "memory_expect", "address": "0x4000", "data": "ccdd"},
            ],
        })
        report = self.runner.run(recipe)
        self.assertFalse(report["ok"])
        self.assertEqual(report["failed_step"], 1)

    def test_dry_run_touches_nothing(self):
        recipe = download.validate({
            "device": {"ia": "1.1.2"},
            "steps": [{"op": "memory_write", "address": "0x4000", "data": "aabb"}],
        })
        report = self.runner.run(recipe, dry_run=True)
        self.assertTrue(report["ok"])
        self.assertEqual(self.device.memory_write_calls, 0)


class TestAgentRuntime(unittest.TestCase):
    def setUp(self):
        self.device = simulate.VirtualDevice(0x1101, descriptor=0x07B0, name="sim-actor")
        self.sim = simulate.GatewaySim([self.device])
        self.sim.start()
        self.runtime = agent.KnxAgentRuntime("127.0.0.1:%d" % self.sim.port)

    def tearDown(self):
        self.runtime.close()
        self.sim.stop()

    def test_scan_and_group_tools(self):
        scanned = self.runtime.call("knx_scan", {"line": "1.1", "start": 1, "end": 4, "window": 4})
        self.assertTrue(scanned["ok"])
        self.assertEqual(scanned["count"], 1)
        written = self.runtime.call("knx_ga_write", {"ga": "1/2/3", "dpt": "5.001", "value": 80})
        self.assertTrue(written["ok"])
        read_back = self.runtime.call("knx_ga_read", {"ga": "1/2/3", "dpt": "5.001"})
        self.assertTrue(read_back["ok"])
        self.assertEqual(read_back["value"], 80)

    def test_memory_tools_and_audit_trail(self):
        wrote = self.runtime.call("knx_memory_write",
                                  {"ia": "1.1.1", "address": "0x4000", "data": "0a0b0c"})
        self.assertTrue(wrote["ok"])
        read = self.runtime.call("knx_memory_read",
                                 {"ia": "1.1.1", "address": "0x4000", "count": 3})
        self.assertEqual(read["data"], "0a0b0c")
        self.assertEqual([entry["tool"] for entry in self.runtime.audit][-2:],
                         ["knx_memory_write", "knx_memory_read"])

    def test_unknown_tool_is_reported_not_raised(self):
        result = self.runtime.call("knx_nope", {})
        self.assertFalse(result["ok"])
        self.assertIn("unknown tool", result["error"])

    def test_diagnose_flags_empty_scan(self):
        result = self.runtime.call("knx_diagnose", {"scan": []})
        self.assertTrue(result["ok"])
        codes = [f["code"] for f in result["findings"]]
        self.assertIn("NO_DEVICES", codes)

    def test_plan_for_site_has_expected_shape(self):
        plan = agent.plan_for_site({
            "gateway": "127.0.0.1",
            "lines": [{"line": "1.1", "devices": [
                {"ia": "1.1.2", "recipe": "r.json",
                 "verify": [{"ga": "1/2/3", "dpt": "1.001", "value": 1}]}]}],
        })
        tools = [step["tool"] for step in plan]
        self.assertEqual(tools[0], "knx_connect")
        self.assertIn("knx_scan", tools)
        self.assertIn("knx_download", tools)
        self.assertEqual(tools[-1], "knx_diagnose")

    def test_tool_schemas_are_mcp_shaped(self):
        for tool in agent.TOOLS:
            self.assertIn("name", tool)
            self.assertIn("description", tool)
            self.assertIn("inputSchema", tool)
            self.assertEqual(tool["inputSchema"]["type"], "object")


if __name__ == "__main__":
    unittest.main()
