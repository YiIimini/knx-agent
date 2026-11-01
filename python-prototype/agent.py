"""Agent-facing control plane: typed tools, a dispatcher and a diagnostic rulebook.

The point of this module is that an LLM (or any planner) never has to emit raw
telegrams. It calls named tools with JSON arguments; the runtime turns them into
KNXnet/IP + cEMI traffic, records every exchange, and returns structured evidence
the model can reason about. That keeps the model's job at the level of intent,
which is the only level at which it is reliable.

The tool schemas below are MCP-compatible (name/description/inputSchema), so the
same runtime can be exposed by an MCP server, a LangChain tool list or a local CLI.
"""

from __future__ import annotations

import json
import time
from typing import Callable, Dict, List, Optional

from . import cemi, knxip, link, download as recipe_mod, project as project_mod
from . import dpt as dpt_codec


# ------------------------------------------------------------------- tools
TOOLS: List[Dict] = [
    {
        "name": "knx_search",
        "description": "Discover KNXnet/IP gateways on the local network (multicast and/or unicast).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "timeout": {"type": "number", "default": 3.0},
                "multicast": {"type": "boolean", "default": True},
                "unicast_targets": {"type": "array", "items": {"type": "string"}},
            },
        },
    },
    {
        "name": "knx_connect",
        "description": "Open a KNXnet/IP tunnelling connection to a gateway ('ip' or 'ip:port'). "
                       "Use layer 'busmonitor' to receive all bus traffic.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "gateway": {"type": "string"},
                "layer": {"type": "string", "enum": ["link", "busmonitor"], "default": "link"},
            },
            "required": ["gateway"],
        },
    },
    {
        "name": "knx_scan",
        "description": "Scan one line for devices by pipelined device descriptor reads.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "line": {"type": "string", "default": "1.1"},
                "start": {"type": "integer", "default": 0},
                "end": {"type": "integer", "default": 256},
                "window": {"type": "integer", "default": 48},
            },
        },
    },
    {
        "name": "knx_device_info",
        "description": "Identity of one device: descriptor, individual address, optional serial number.",
        "inputSchema": {
            "type": "object",
            "properties": {"ia": {"type": "string"}, "serial": {"type": "boolean", "default": False}},
            "required": ["ia"],
        },
    },
    {
        "name": "knx_memory_read",
        "description": "Read device memory (hex). Management access, address space 0x0000-0xFFFF.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "ia": {"type": "string"},
                "address": {"type": "string"},
                "count": {"type": "integer"},
            },
            "required": ["ia", "address", "count"],
        },
    },
    {
        "name": "knx_memory_write",
        "description": "Write device memory from hex data. Used by a download; verify by read-back.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "ia": {"type": "string"},
                "address": {"type": "string"},
                "data": {"type": "string"},
            },
            "required": ["ia", "address", "data"],
        },
    },
    {
        "name": "knx_ga_read",
        "description": "Group value read with a data point type, e.g. dpt '9.001' for temperature.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "ga": {"type": "string"},
                "dpt": {"type": "string", "default": "1.001"},
                "timeout": {"type": "number", "default": 3.0},
            },
            "required": ["ga"],
        },
    },
    {
        "name": "knx_ga_write",
        "description": "Group value write, value decoded through the data point type.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "ga": {"type": "string"},
                "dpt": {"type": "string", "default": "1.001"},
                "value": {},
            },
            "required": ["ga", "value"],
        },
    },
    {
        "name": "knx_monitor",
        "description": "Collect group traffic for N seconds; returns decoded frames.",
        "inputSchema": {
            "type": "object",
            "properties": {"seconds": {"type": "number", "default": 5.0},
                           "only_group": {"type": "boolean", "default": True}},
        },
    },
    {
        "name": "knx_download",
        "description": "Execute a download recipe against one device. dry_run validates the plan only.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "recipe": {"type": "object"},
                "recipe_path": {"type": "string"},
                "ia": {"type": "string"},
                "dry_run": {"type": "boolean", "default": False},
            },
        },
    },
    {
        "name": "knx_capture",
        "description": "Monitor the bus and turn the download traffic of one device into a reusable recipe.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "ia": {"type": "string"},
                "seconds": {"type": "number", "default": 60.0},
                "out": {"type": "string"},
            },
            "required": ["ia"],
        },
    },
    {
        "name": "knx_project",
        "description": "Summarise or dump an ETS project (.knxproj) or product database (.knxprod).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "detail": {"type": "string", "enum": ["summary", "full"], "default": "summary"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "knx_diagnose",
        "description": "Diagnose the current observations: scan result, monitor frames, failed steps.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "scan": {"type": "array", "items": {"type": "object"}},
                "frames": {"type": "array", "items": {"type": "object"}},
                "failed_steps": {"type": "array", "items": {"type": "object"}},
            },
        },
    },
]


# ------------------------------------------------------------- diagnostics
def diagnose(scan: Optional[List[Dict]] = None,
             frames: Optional[List[Dict]] = None,
             failed_steps: Optional[List[Dict]] = None,
             transport_stats: Optional[Dict] = None) -> List[Dict]:
    """Rule book over observed evidence. Each finding names its next probe."""
    findings: List[Dict] = []

    if transport_stats is not None:
        if transport_stats.get("tx_ack_timeouts", 0) > 0:
            findings.append({
                "code": "GATEWAY_NO_ACK",
                "severity": "high",
                "evidence": "gateway did not acknowledge %d tunnelling requests"
                            % transport_stats["tx_ack_timeouts"],
                "next": "check the KNXnet/IP interface, its IP route and whether the "
                        "device's tunnel limit is exhausted (default 4); retry with routing.",
            })
        if transport_stats.get("rx_errors", 0) > 0:
            findings.append({
                "code": "MALFORMED_INBOUND",
                "severity": "medium",
                "evidence": "%d unparsable inbound frames" % transport_stats["rx_errors"],
                "next": "capture raw frames and compare with the cEMI layout; "
                        "the interface may use a different frame variant.",
            })

    if scan is not None:
        if not scan:
            findings.append({
                "code": "NO_DEVICES",
                "severity": "high",
                "evidence": "line scan found no device answers",
                "next": "verify bus power (29 V), termination and that the interface is "
                        "on the same line; then retry with a larger settle window.",
            })
        addresses = [d.get("ia") for d in scan]
        if len(addresses) != len(set(addresses)):
            findings.append({
                "code": "DUPLICATE_INDIVIDUAL_ADDRESS",
                "severity": "high",
                "evidence": "the same individual address answered more than once",
                "next": "read the serial number of each device in programming mode and "
                        "re-assign one of them; duplicate IAs break downloads silently.",
            })
        for device in scan:
            if device.get("descriptor") is None:
                findings.append({
                    "code": "NO_DESCRIPTOR",
                    "severity": "medium",
                    "evidence": "%s answered but returned no device descriptor"
                                % device.get("ia_text", "?"),
                    "next": "device may be in an error state; read its serial number and "
                            "compare with the project.",
                })

    for step in (failed_steps or []):
        if step.get("detail", "").startswith("Timeout") or step.get("detail") == "timeout":
            findings.append({
                "code": "STEP_TIMEOUT",
                "severity": "high",
                "evidence": "step %s timed out" % step.get("op"),
                "next": "device stopped answering: power cycle, then re-read the memory "
                        "block to see how far the download got before retrying.",
            })
        if step.get("detail", "").startswith("negative confirmation"):
            findings.append({
                "code": "NEGATIVE_CONFIRMATION",
                "severity": "high",
                "evidence": "the link layer refused step %s" % step.get("op"),
                "next": "bus level problem (collision, no free address, frame too long) - "
                        "check the interface's error counters and the bus termination.",
            })

    for frame in (frames or []):
        if frame.get("con_error"):
            findings.append({
                "code": "TRANSMISSION_ERROR",
                "severity": "medium",
                "evidence": "L_Data.con with error bit for %s" % frame.get("dst_text"),
                "next": "repeat measurement with busmonitor; a single error is normal, "
                        "a pattern points at cabling or a missing choke.",
            })
        if frame.get("hop_count") == 0:
            findings.append({
                "code": "HOP_COUNT_EXHAUSTED",
                "severity": "medium",
                "evidence": "frame reached the bus with hop count 0",
                "next": "coupler or line repeater is dropping the frame; check the "
                        "topology (max 3 couplers) or the interface's hop count setting.",
            })

    if not findings:
        findings.append({"code": "NO_FINDING", "severity": "info",
                         "evidence": "no rule matched the supplied observations",
                         "next": "supply scan output, monitor frames or failed steps."})
    return findings


# ----------------------------------------------------------------- runtime
class KnxAgentRuntime(object):
    """Holds one transport and exposes the tool surface above."""

    def __init__(self, gateway: Optional[str] = None, layer: str = "link",
                 auto_connect: bool = True):
        self.gateway = gateway
        self.layer = layer
        self.transport = None
        self.device_link = None
        self.bus = None
        self.audit: List[Dict] = []
        self._monitor_buffer: List[Dict] = []
        if gateway and auto_connect:
            self.connect(gateway, layer)

    # -- lifecycle
    def connect(self, gateway: str, layer: str = "link") -> Dict:
        if self.transport is not None:
            self.close()
        host, _, port = gateway.partition(":")
        knx_layer = knxip.LAYER_BUSMON if layer == "busmonitor" else knxip.LAYER_LINK
        self.transport = knxip.Tunnel(host, int(port or 3671), layer=knx_layer)
        self.device_link = link.DeviceLink(self.transport)
        self.bus = link.GroupBus(self.transport)
        self.gateway = gateway
        self.layer = layer
        info = {"connected": True, "gateway": gateway, "layer": layer,
                "channel": getattr(self.transport, "channel", None)}
        self._record("knx_connect", {"gateway": gateway, "layer": layer}, info)
        return info

    def close(self) -> None:
        if self.transport is not None:
            self.transport.close()
            self.transport = None
            self.device_link = None
            self.bus = None

    def _require_link(self):
        if self.device_link is None:
            raise RuntimeError("not connected: call knx_connect first")
        return self.device_link

    def _record(self, name: str, args: Dict, result) -> None:
        self.audit.append({"tool": name, "args": args, "result": result,
                           "at": time.strftime("%Y-%m-%dT%H:%M:%S")})

    # -- dispatch
    def call(self, name: str, args: Optional[Dict] = None) -> Dict:
        args = dict(args or {})
        try:
            handler = getattr(self, "_tool_%s" % name.replace("knx_", ""), None)
            if handler is None:
                raise ValueError("unknown tool %r" % name)
            result = handler(**args)
        except Exception as exc:  # noqa: BLE001 - a tool error is evidence, not a crash
            result = {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}
        self._record(name, args, result)
        return result

    # -- tools
    def _tool_search(self, timeout: float = 3.0, multicast: bool = True,
                     unicast_targets: Optional[List[str]] = None) -> Dict:
        found = knxip.search(timeout=timeout, multicast=multicast,
                             unicast_targets=unicast_targets)
        return {"ok": True, "gateways": found, "count": len(found)}

    def _tool_connect(self, gateway: str, layer: str = "link") -> Dict:
        return self.connect(gateway, layer)

    def _tool_scan(self, line: str = "1.1", start: int = 0, end: int = 256,
                   window: int = 48) -> Dict:
        found = self._require_link().scan(line, range(int(start), int(end)),
                                          window=int(window))
        return {"ok": True, "line": line, "devices": found, "count": len(found)}

    def _tool_device_info(self, ia: str, serial: bool = False) -> Dict:
        device_link = self._require_link()
        ia_int = cemi.parse_ia(ia)
        info = {"ok": True, "ia": ia, "descriptor": device_link.descriptor_read(ia_int)}
        if serial:
            info["serial"] = device_link.serial_number()
        return info

    def _tool_memory_read(self, ia: str, address: str, count: int) -> Dict:
        value = self._require_link().memory_read(cemi.parse_ia(ia), int(address, 0), int(count))
        if value is None:
            return {"ok": False, "error": "no answer from %s" % ia}
        return {"ok": True, "ia": ia, "address": address, "data": value.hex()}

    def _tool_memory_write(self, ia: str, address: str, data: str) -> Dict:
        raw = bytes.fromhex(data.replace("0x", "").replace(" ", ""))
        ok = self._require_link().memory_write(cemi.parse_ia(ia), int(address, 0), raw)
        return {"ok": ok, "ia": ia, "address": address, "octets": len(raw)}

    def _tool_ga_read(self, ga: str, dpt: str = "1.001", timeout: float = 3.0) -> Dict:
        self._require_link()
        dpt_id = dpt or "1.001"
        response = self.bus.read(cemi.parse_ga(ga), timeout)
        if response is None:
            return {"ok": False, "ga": ga, "error": "no response"}
        raw = response.get("value") or b""
        return {"ok": True, "ga": ga, "dpt": dpt_id,
                "value": dpt_codec.decode(dpt_id, raw), "raw": raw.hex(),
                "source": response.get("src_ia")}

    def _tool_ga_write(self, ga: str, value, dpt: str = "1.001") -> Dict:
        self._require_link()
        dpt_id = dpt or "1.001"
        raw = dpt_codec.encode(dpt_id, value)
        ok = self.bus.write(cemi.parse_ga(ga), raw)
        return {"ok": ok, "ga": ga, "dpt": dpt_id, "raw": raw.hex()}

    def _tool_monitor(self, seconds: float = 5.0, only_group: bool = True) -> Dict:
        predicate = (lambda f: f["group"]) if only_group else None
        frames = self.bus.listen(seconds, predicate)
        decoded = [{"src": f["src_ia"], "dst": f["dst_text"], "service": f.get("service"),
                    "value": (f.get("value") or b"").hex()} for f in frames]
        return {"ok": True, "seconds": seconds, "frames": decoded, "count": len(decoded)}

    def _tool_download(self, recipe: Optional[Dict] = None, recipe_path: Optional[str] = None,
                       ia: Optional[str] = None, dry_run: bool = False) -> Dict:
        if recipe is None and recipe_path is None:
            raise ValueError("provide recipe or recipe_path")
        if recipe is None:
            recipe = recipe_mod.load_recipe(recipe_path)
        context = {"ia": ia} if ia else None
        runner = recipe_mod.DownloadRunner(self._require_link(), self.bus)
        return runner.run(recipe, context=context, dry_run=dry_run)

    def _tool_capture(self, ia: str, seconds: float = 60.0, out: Optional[str] = None) -> Dict:
        if self.bus is None:
            raise RuntimeError("not connected")
        saved_layer = self.layer
        if saved_layer != "busmonitor":
            # a bus monitor tunnel is required to see the traffic of a download
            self.connect(self.gateway, "busmonitor")
        try:
            frames = self.bus.listen(seconds)
        finally:
            if saved_layer != "busmonitor":
                self.connect(self.gateway, saved_layer)
        recipe = recipe_mod.capture_to_recipe(frames, cemi.parse_ia(ia))
        if out:
            recipe_mod.save_recipe(recipe, out)
        return {"ok": True, "steps": len(recipe["steps"]), "recipe": recipe, "saved": out}

    def _tool_project(self, path: str, detail: str = "summary") -> Dict:
        if path.lower().endswith(".knxprod"):
            database = project_mod.ProductDatabase(path)
            return {"ok": True, "kind": "knxprod", "summary": database.summary()}
        parsed = project_mod.KnxProject(path)
        if detail == "full":
            return {"ok": True, "kind": "knxproj", "project": parsed.to_dict()}
        return {"ok": True, "kind": "knxproj", "summary": parsed.summary(),
                "devices": [{"ia": d.ia_text, "name": d.name, "order": d.order_number}
                            for d in parsed.devices[:50]]}

    def _tool_diagnose(self, scan: Optional[List[Dict]] = None,
                       frames: Optional[List[Dict]] = None,
                       failed_steps: Optional[List[Dict]] = None) -> Dict:
        stats = self.transport.stats() if self.transport is not None else None
        findings = diagnose(scan=scan, frames=frames, failed_steps=failed_steps,
                            transport_stats=stats)
        return {"ok": True, "findings": findings, "transport": stats}


# ------------------------------------------------------------------- plans
def plan_for_site(intent: Dict) -> List[Dict]:
    """Turn a declarative commissioning intent into an ordered tool-call plan.

    intent = {
      "gateway": "192.168.1.50",
      "lines": [{"line": "1.1", "devices": [
          {"ia": "1.1.10", "recipe": "recipes/actor.json", "verify": [
              {"ga": "1/2/3", "dpt": "1.001", "value": 1}]}]}]
    }
    """
    plan: List[Dict] = []
    if intent.get("gateway"):
        plan.append({"tool": "knx_connect", "args": {"gateway": intent["gateway"]}})
    for line in intent.get("lines", []):
        plan.append({"tool": "knx_scan", "args": {"line": line.get("line", "1.1")}})
        for device in line.get("devices", []):
            if device.get("recipe"):
                plan.append({"tool": "knx_download",
                             "args": {"recipe_path": device["recipe"],
                                      "ia": device["ia"], "dry_run": True}})
                plan.append({"tool": "knx_download",
                             "args": {"recipe_path": device["recipe"], "ia": device["ia"]}})
            for check in device.get("verify", []):
                plan.append({"tool": "knx_ga_write",
                             "args": {"ga": check["ga"], "dpt": check.get("dpt", "1.001"),
                                      "value": check["value"]}})
                plan.append({"tool": "knx_ga_read",
                             "args": {"ga": check["ga"], "dpt": check.get("dpt", "1.001")}})
    plan.append({"tool": "knx_diagnose", "args": {}})
    return plan


def run_plan(runtime: KnxAgentRuntime, plan: List[Dict], stop_on_error: bool = False) -> Dict:
    results = []
    for step in plan:
        result = runtime.call(step["tool"], step.get("args", {}))
        results.append({"tool": step["tool"], "ok": result.get("ok", True), "result": result})
        if stop_on_error and not result.get("ok", True):
            break
    return {"ok": all(r["ok"] for r in results), "steps": results}
