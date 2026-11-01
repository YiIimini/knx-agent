"""Read an ETS project (.knxproj) and manufacturer product data (.knxprod).

Why this matters: ETS is the only tool that understands these files, and the
download a device needs is *derived from them*. A commissioning agent that can
read them keeps working after the Windows machine is gone.

The parser is deliberately structure tolerant. It walks every XML part of the
archive and matches elements/attributes by local name, so it survives the
schema differences between ETS4, ETS5 and ETS6 exports and the per-installation
split of the numbered XML parts. It does not pretend to validate the schema:
what it cannot find stays absent and is reported as such.
"""

from __future__ import annotations

import io
import json
import os
import re
import zipfile
import xml.etree.ElementTree as ET
from typing import Dict, List, Optional


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _attr(element, *names, default=None):
    """Namespace agnostic attribute lookup."""
    for key, value in element.attrib.items():
        if _local(key) in names:
            return value
    return default


def _xml_parts(archive: zipfile.ZipFile) -> List[str]:
    return [n for n in archive.namelist()
            if n.lower().endswith(".xml") and not n.startswith("__MACOSX")]


class Device(object):
    def __init__(self, device_id: str):
        self.id = device_id
        self.ia: Optional[int] = None
        self.name: str = ""
        self.comment: str = ""
        self.product_ref: str = ""
        self.order_number: str = ""
        self.manufacturer: str = ""
        self.application_ref: str = ""
        self.line: str = ""
        self.com_objects: List[Dict] = []

    @property
    def ia_text(self) -> str:
        if self.ia is None:
            return ""
        return "%d.%d.%d" % ((self.ia >> 12) & 0xF, (self.ia >> 8) & 0xF, self.ia & 0xFF)

    def to_dict(self) -> Dict:
        return {
            "id": self.id, "ia": self.ia, "ia_text": self.ia_text, "name": self.name,
            "comment": self.comment, "order_number": self.order_number,
            "manufacturer": self.manufacturer, "application_ref": self.application_ref,
            "product_ref": self.product_ref, "line": self.line,
            "com_objects": self.com_objects,
        }


class GroupAddress(object):
    def __init__(self, number: int, name: str = "", dpt: str = "", uid: str = ""):
        self.number = number
        self.name = name
        self.dpt = dpt
        self.uid = uid

    @property
    def text(self) -> str:
        return "%d/%d/%d" % ((self.number >> 11) & 0x1F, (self.number >> 8) & 0x07,
                             self.number & 0xFF)

    def to_dict(self) -> Dict:
        return {"number": self.number, "text": self.text, "name": self.name,
                "dpt": self.dpt, "id": self.uid}


class KnxProject(object):
    def __init__(self, path: Optional[str] = None):
        self.path = path
        self.name = ""
        self.devices: List[Device] = []
        self.group_addresses: List[GroupAddress] = []
        self.lines: Dict[str, Dict] = {}
        self.source_files: List[str] = []
        self.warnings: List[str] = []
        if path:
            self.load(path)

    # ------------------------------------------------------------------ load
    def load(self, path: str) -> "KnxProject":
        if not zipfile.is_zipfile(path):
            raise ValueError("not a .knxproj archive: %s" % path)
        self.path = path
        self.name = os.path.splitext(os.path.basename(path))[0]
        devices: Dict[str, Device] = {}
        gas: Dict[str, GroupAddress] = {}
        with zipfile.ZipFile(path) as archive:
            parts = _xml_parts(archive)
            self.source_files = parts
            for part in parts:
                try:
                    root = ET.fromstring(archive.read(part))
                except ET.ParseError as exc:
                    self.warnings.append("%s: %s" % (part, exc))
                    continue
                self._walk(root, devices, gas)
        self.devices = sorted(devices.values(), key=lambda d: (d.ia if d.ia is not None else 0xFFFF))
        self.group_addresses = sorted(gas.values(), key=lambda g: g.number)
        self._resolve_links()
        return self

    def _walk(self, root, devices: Dict[str, Device], gas: Dict[str, GroupAddress],
              current: Optional[Device] = None) -> None:
        """Recursive, namespace agnostic walk that preserves element nesting.

        Nesting matters: a ComObjectInstanceRef belongs either to the enclosing
        DeviceInstance (schema v20) or, in some exports, sits as its sibling
        inside the Line - in the second case it belongs to the preceding device.
        """
        for element in root:
            tag = _local(element.tag)
            if tag == "DeviceInstance":
                device = self._load_device(element, devices)
                self._walk(element, devices, gas, device)
                current = device  # later sibling ComObjectInstanceRefs belong here too
                continue
            if tag == "ComObjectInstanceRef":
                if current is not None:
                    ref = _attr(element, "RefId", default="")
                    if ref:
                        links = _attr(element, "Links", default="") or ""
                        current.com_objects.append({
                            "ref": ref,
                            "text": _attr(element, "Text", default=""),
                            "dpt": _attr(element, "DatapointType", default=""),
                            "links": [x for x in links.split() if x],
                        })
                continue
            if tag == "GroupAddress":
                number = _attr(element, "Address")
                uid = _attr(element, "Id", default="")
                if number is not None and uid not in gas:
                    gas[uid] = GroupAddress(int(number), _attr(element, "Name", default=""),
                                            _attr(element, "DatapointType", default=""), uid)
            elif tag in ("Line", "LineSegment"):
                address = _attr(element, "Address", default="")
                if address:
                    self.lines[address] = {"name": _attr(element, "Name", default=""),
                                           "medium": _attr(element, "MediumTypeRefId", default="")}
            elif tag == "Product":
                uid = _attr(element, "Id", default="")
                if uid:
                    self.lines.setdefault("product:%s" % uid, {
                        "order": _attr(element, "OrderNumber", default=""),
                        "manufacturer": _attr(element, "ManufacturerRefId", default=""),
                        "name": _attr(element, "Name", default=""),
                    })
            elif tag == "Project":
                self.name = _attr(element, "ProjectNumber", default="") or self.name
            self._walk(element, devices, gas, current)

    def _load_device(self, element, devices: Dict[str, Device]) -> Device:
        uid = _attr(element, "Id", default="")
        device = devices.get(uid) or Device(uid)
        devices[uid] = device
        address = _attr(element, "Address")
        if address is not None:
            device.ia = int(address)
        device.name = _attr(element, "Name", default=device.name) or device.name
        device.comment = _attr(element, "Comment", default=device.comment) or device.comment
        device.product_ref = _attr(element, "ProductRefId", default=device.product_ref) or device.product_ref
        device.application_ref = _attr(element, "Hardware2ProgramRefId", "ApplicationProgramRef",
                                       default=device.application_ref) or device.application_ref
        return device

    def _resolve_links(self) -> None:
        by_uid = {g.uid: g for g in self.group_addresses}
        for device in self.devices:
            for obj in device.com_objects:
                obj["group_addresses"] = [
                    by_uid[link].text for link in obj["links"] if link in by_uid]

    # ------------------------------------------------------------- reporting
    def summary(self) -> Dict:
        return {
            "project": self.name,
            "path": self.path,
            "devices": len(self.devices),
            "group_addresses": len(self.group_addresses),
            "lines": len([k for k in self.lines if not k.startswith(("ga-range:", "product:"))]),
            "devices_with_ia": len([d for d in self.devices if d.ia is not None]),
            "com_objects": sum(len(d.com_objects) for d in self.devices),
            "warnings": self.warnings,
        }

    def to_dict(self) -> Dict:
        return {
            "summary": self.summary(),
            "lines": self.lines,
            "group_addresses": [g.to_dict() for g in self.group_addresses],
            "devices": [d.to_dict() for d in self.devices],
        }

    def write_json(self, path: str) -> str:
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(self.to_dict(), handle, indent=2, ensure_ascii=False)
        return path


class ProductDatabase(object):
    """Best effort view of a manufacturer .knxprod archive.

    What we need from it for automated commissioning is the parameter memory
    layout: which absolute address holds which parameter, so a value change can
    be written without a full application download.
    """

    def __init__(self, path: Optional[str] = None):
        self.path = path
        self.manufacturer = ""
        self.applications: List[Dict] = []
        self.warnings: List[str] = []
        if path:
            self.load(path)

    def load(self, path: str) -> "ProductDatabase":
        self.path = path
        if not zipfile.is_zipfile(path):
            raise ValueError("not a .knxprod archive: %s" % path)
        with zipfile.ZipFile(path) as archive:
            for part in _xml_parts(archive):
                try:
                    root = ET.fromstring(archive.read(part))
                except ET.ParseError as exc:
                    self.warnings.append("%s: %s" % (part, exc))
                    continue
                for element in root.iter():
                    tag = _local(element.tag)
                    if tag == "Manufacturer":
                        self.manufacturer = _attr(element, "Name", default=self.manufacturer)
                    elif tag == "ApplicationProgram":
                        self.applications.append({
                            "id": _attr(element, "Id", default=""),
                            "name": _attr(element, "Name", default=""),
                            "mask": _attr(element, "MaskVersion", default=""),
                            "segments": self._segments(element),
                            "parameters": self._parameters(element, part),
                        })
        return self

    def _segments(self, application) -> List[Dict]:
        out = []
        for element in application.iter():
            if _local(element.tag) in ("Static", "Code", "AbsoluteSegment"):
                segment = {
                    "kind": _local(element.tag),
                    "address": _attr(element, "Address", default=""),
                    "size": _attr(element, "Size", default=""),
                    "name": _attr(element, "Name", default=""),
                }
                if any(segment.values()):
                    out.append(segment)
        return out

    def _parameters(self, application, part: str) -> List[Dict]:
        out = []
        for element in application.iter():
            if _local(element.tag) == "Parameter":
                out.append({
                    "id": _attr(element, "Id", default=""),
                    "name": _attr(element, "Name", default=""),
                    "type": _attr(element, "ParameterType", default=""),
                    "offset": _attr(element, "Offset", default=""),
                    "bit": _attr(element, "BitOffset", default=""),
                    "part": part,
                })
        return out

    def summary(self) -> Dict:
        return {
            "path": self.path,
            "manufacturer": self.manufacturer,
            "applications": [
                {"id": a["id"], "name": a["name"], "mask": a["mask"],
                 "segments": len(a["segments"]), "parameters": len(a["parameters"])}
                for a in self.applications
            ],
            "warnings": self.warnings,
        }


_HEX = re.compile(r"^(0x)?[0-9a-fA-F]+$")


def parse_hex(text: str) -> bytes:
    cleaned = text.strip().replace(" ", "").replace(":", "").replace("\n", "")
    if cleaned.startswith("0x"):
        cleaned = cleaned[2:]
    if len(cleaned) % 2:
        raise ValueError("hex payload must have an even number of digits")
    return bytes.fromhex(cleaned)
