"""Download recipes: record what ETS sends once, replay it forever.

The hard part of replacing ETS is not the protocol, it is the *content* of the
download: ETS composes the application program image and the parameter block
from the product database. There are two honest ways to get that content onto a
device from macOS:

  A. capture    - put the real ETS (in a VM) behind a logging KNXnet/IP proxy,
                  record the download once per product/parameter set, turn the
                  capture into a recipe, replay and parameterise it afterwards.
  B. reconstruct - derive the same telegrams from .knxproj + .knxprod and the
                  KNX specifications, which needs the product database to carry
                  the memory layout (it usually does for the parameter block, not
                  always for the full application image).

Both end up as the same declarative recipe, so the runtime only speaks one
format: `knxagent.download/1`.
"""

from __future__ import annotations

import json
import re
import time
from typing import Dict, List, Optional

from . import cemi, dpt

SCHEMA = "knxagent.download/1"

_PLACEHOLDER = re.compile(r"\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}")


class RecipeError(Exception):
    pass


# ------------------------------------------------------------------ helpers
def _resolve(value, context: Dict):
    if isinstance(value, str):
        def sub(match):
            key = match.group(1)
            if key not in context:
                raise RecipeError("unknown placeholder {{%s}}" % key)
            return str(context[key])
        return _PLACEHOLDER.sub(sub, value)
    if isinstance(value, list):
        return [_resolve(v, context) for v in value]
    if isinstance(value, dict):
        return {k: _resolve(v, context) for k, v in value.items()}
    return value


def load_recipe(path: str) -> Dict:
    with open(path, "r", encoding="utf-8") as handle:
        recipe = json.load(handle)
    return validate(recipe)


def validate(recipe: Dict) -> Dict:
    if not isinstance(recipe, dict):
        raise RecipeError("recipe must be an object")
    steps = recipe.get("steps")
    if not isinstance(steps, list) or not steps:
        raise RecipeError("recipe needs a non-empty 'steps' list")
    known = {"ia_write", "memory_write", "memory_write_ext", "memory_read", "memory_expect",
             "property_write", "property_read", "restart", "group_write", "group_expect",
             "wait", "scan", "note"}
    for index, step in enumerate(steps):
        if "op" not in step:
            raise RecipeError("step %d has no 'op'" % index)
        if step["op"] not in known:
            raise RecipeError("step %d: unknown op %r" % (index, step["op"]))
    recipe.setdefault("schema", SCHEMA)
    recipe.setdefault("options", {})
    return recipe


def _to_int(value, default: Optional[int] = None) -> int:
    if value is None:
        return default
    if isinstance(value, int):
        return value
    return int(str(value), 0)


def _to_bytes(value) -> bytes:
    if isinstance(value, (bytes, bytearray)):
        return bytes(value)
    text = str(value).strip().replace(" ", "").replace(":", "")
    if text.startswith("0x"):
        text = text[2:]
    if len(text) % 2:
        raise RecipeError("hex payload must have an even number of digits: %r" % value)
    return bytes.fromhex(text)


# ------------------------------------------------------- capture -> recipe
def capture_to_recipe(frames: List[Dict], ia: int, name: str = "",
                      chunk: int = 11) -> Dict:
    """Turn captured L_Data frames of one device's ETS download into a recipe.

    `frames` may mix plain L_Data frames and busmonitor frames (each with a
    'frame' key); frames not addressed to `ia` are ignored.
    """
    collected: List[Dict] = []
    group_tail: List[Dict] = []
    for item in frames:
        frame = item.get("frame") if item.get("kind") == "busmon" else item
        if not frame or frame.get("kind") != "ldata":
            continue
        service = frame.get("service")
        if frame.get("group"):
            if service in ("A_GroupValue_Write", "A_GroupValue_Read"):
                group_tail.append(frame)
            continue
        if frame.get("dst") != ia and service != "A_IndividualAddress_Write":
            continue
        if service == "A_Memory_Write":
            collected.append({"op": "memory_write",
                              "address": _to_int(frame["address"]),
                              "data": (frame.get("value") or b"").hex()})
        elif service == "A_Memory_Extended_Write":
            collected.append({"op": "memory_write_ext",
                              "address": _to_int(frame["address"]),
                              "data": (frame.get("value") or b"").hex()})
        elif service == "A_IndividualAddress_Write":
            collected.append({"op": "ia_write",
                              "ia": "%d.%d.%d" % ((frame["address"] >> 12) & 0xF,
                                                  (frame["address"] >> 8) & 0xF,
                                                  frame["address"] & 0xFF)})
        elif service == "A_Restart":
            collected.append({"op": "restart", "master": bool(frame.get("master_reset"))})

    merged = _merge_memory_writes(collected, chunk)
    steps = merged + [{"op": "group_write",
                       "ga": frame["dst_text"],
                       "data": (frame.get("value") or b"").hex()} for frame in group_tail]
    if not steps:
        raise RecipeError("no download traffic for %s found in the capture"
                          % cemi.format_ia(ia))
    steps.append({"op": "note", "text": "captured from ETS for %s" % cemi.format_ia(ia)})
    return validate({
        "schema": SCHEMA,
        "device": {"ia": cemi.format_ia(ia), "name": name},
        "options": {"chunk": chunk},
        "source": "capture",
        "steps": steps,
    })


def _merge_memory_writes(steps: List[Dict], chunk: int = 11) -> List[Dict]:
    """Splice contiguous memory writes into chunk sized blocks."""
    blocks: List[Dict] = []
    pending: Optional[Dict] = None
    for step in steps:
        if step["op"] not in ("memory_write", "memory_write_ext"):
            if pending:
                blocks.append(pending)
                pending = None
            blocks.append(step)
            continue
        address, data = step["address"], _to_bytes(step["data"])
        if pending and address == pending["address"] + len(_to_bytes(pending["data"])):
            pending["data"] = (_to_bytes(pending["data"]) + data).hex()
        else:
            if pending:
                blocks.append(pending)
            pending = {"op": step["op"], "address": address, "data": data.hex()}
    if pending:
        blocks.append(pending)
    return blocks


def save_recipe(recipe: Dict, path: str) -> str:
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(recipe, handle, indent=2, ensure_ascii=False)
    return path


# ------------------------------------------------------------------ runner
class DownloadRunner(object):
    """Executes a recipe against one device. Every step is reported."""

    def __init__(self, link, bus, inter_step_delay: float = 0.01):
        self.link = link
        self.bus = bus
        self.inter_step_delay = inter_step_delay
        self.report: List[Dict] = []

    def run(self, recipe: Dict, context: Optional[Dict] = None,
            dry_run: bool = False) -> Dict:
        recipe = validate(recipe)
        context = dict(recipe.get("device") or {})
        context.update(context or {})
        ia_text = context.get("ia")
        if not ia_text:
            raise RecipeError("recipe has no device.ia")
        ia = cemi.parse_ia(str(ia_text))
        started = time.time()
        self.report = []
        for index, raw_step in enumerate(recipe["steps"]):
            step = _resolve(raw_step, context)
            entry = {"index": index, "op": step["op"]}
            t0 = time.time()
            try:
                ok, detail = self._execute(ia, step, dry_run)
                entry.update({"ok": ok, "detail": detail})
            except Exception as exc:  # noqa: BLE001 - report, do not abort the run
                entry.update({"ok": False, "detail": "%s: %s" % (type(exc).__name__, exc)})
            entry["ms"] = int((time.time() - t0) * 1000)
            self.report.append(entry)
            if not entry["ok"]:
                return {"ok": False, "device": cemi.format_ia(ia), "failed_step": index,
                        "steps": self.report, "seconds": round(time.time() - started, 2)}
            if self.inter_step_delay:
                time.sleep(self.inter_step_delay)
        return {"ok": True, "device": cemi.format_ia(ia), "steps": self.report,
                "seconds": round(time.time() - started, 2)}

    # -- one step
    def _execute(self, ia: int, step: Dict, dry_run: bool):
        op = step["op"]
        if op == "note":
            return True, step.get("text", "")
        if dry_run:
            return True, "dry-run"
        if op == "ia_write":
            target = cemi.parse_ia(str(step["ia"]))
            return self.link.assign_ia(target), "-> %s" % cemi.format_ia(target)
        if op == "memory_write":
            data = _to_bytes(step["data"])
            ok = self.link.memory_write(ia, _to_int(step["address"]), data,
                                        retries=_to_int(step.get("retries"), 2))
            return ok, "%d octets @0x%04X" % (len(data), _to_int(step["address"]))
        if op == "memory_write_ext":
            data = _to_bytes(step["data"])
            ok = self.link.memory_write_ext(ia, _to_int(step["address"]), data)
            return ok, "%d octets @0x%X" % (len(data), _to_int(step["address"]))
        if op == "memory_read":
            value = self.link.memory_read(ia, _to_int(step["address"]),
                                          _to_int(step.get("count"), 1))
            return value is not None, (value or b"").hex()
        if op == "memory_expect":
            expected = _to_bytes(step["data"])
            value = self.link.memory_read(ia, _to_int(step["address"]), len(expected))
            return value == expected, "got %s" % ((value or b"").hex() or "None")
        if op == "property_write":
            ok = self.link.property_write(ia, _to_int(step.get("object"), 1),
                                          _to_int(step["property"]),
                                          _to_bytes(step["data"]))
            return ok, "prop %s" % step["property"]
        if op == "property_read":
            value = self.link.property_read(ia, _to_int(step.get("object"), 1),
                                            _to_int(step["property"]))
            return value is not None, (value or b"").hex()
        if op == "restart":
            ok = self.link.restart(ia, master=bool(step.get("master", False)))
            return ok, "master reset" if step.get("master") else "application start"
        if op == "group_write":
            ga = cemi.parse_ga(str(step["ga"]))
            value = _to_bytes(step["data"]) if "data" in step else \
                dpt.encode(step.get("dpt", "1.001"), step.get("value"))
            return self.bus.write(ga, value), "%s = %s" % (step["ga"], value.hex())
        if op == "group_expect":
            ga = cemi.parse_ga(str(step["ga"]))
            expected = _to_bytes(step["data"]) if "data" in step else \
                dpt.encode(step.get("dpt", "1.001"), step.get("value"))
            timeout = float(step.get("timeout", 3.0))
            deadline = time.time() + timeout
            last = None
            while time.time() < deadline:
                response = self.bus.read(ga, timeout=max(0.2, deadline - time.time()))
                if response is None:
                    break
                last = response.get("value") or b""
                if last == expected:
                    return True, "confirmed %s" % last.hex()
            return False, "expected %s, got %s" % (expected.hex(), (last or b"").hex() or "no answer")
        if op == "wait":
            time.sleep(float(step.get("seconds", 1.0)))
            return True, "waited"
        if op == "scan":
            found = self.link.scan(step.get("line", "1.1"))
            return True, "%d devices" % len(found)
        raise RecipeError("unhandled op %r" % op)
