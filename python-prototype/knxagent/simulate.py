"""A KNXnet/IP gateway and virtual KNX devices, for tests and for dry runs.

This is deliberately small but wire-accurate: it speaks the same KNXnet/IP core
services and cEMI frames a real interface (MDT, Gira, Weinzierl, Zennio ...)
speaks, so the client code under test is exercised end to end - sequence
numbers, tunnelling ACKs, local confirmations, memory services, addressing,
restart, properties and group traffic.
"""

from __future__ import annotations

import socket
import struct
import threading
import time
from typing import Dict, List, Optional

from . import cemi, knxip


class VirtualDevice(object):
    def __init__(self, ia: int, descriptor: int = 0x07B0, name: str = "virtual-device",
                 programming_mode: bool = True):
        self.ia = ia
        self.descriptor = descriptor
        self.name = name
        self.programming_mode = programming_mode
        self.memory: Dict[int, int] = {}
        self.properties: Dict[tuple, bytes] = {}
        self.group_values: Dict[int, bytes] = {}
        self.apply_on_write = True   # group write -> store, and answer reads
        self.writes: List[Dict] = []
        self.restarts: List[bool] = []
        self.memory_write_calls = 0

    # -- helpers
    def fill(self, start: int, data: bytes) -> None:
        for offset, byte in enumerate(data):
            self.memory[(start + offset) & 0xFFFF] = byte

    def dump(self, start: int, count: int) -> bytes:
        return bytes(self.memory.get((start + i) & 0xFFFF, 0xFF) for i in range(count))

    def mem_read(self, address: int, count: int) -> bytes:
        return self.dump(address, count)

    def mem_write(self, address: int, data: bytes) -> None:
        self.memory_write_calls += 1
        self.writes.append({"address": address, "data": bytes(data)})
        self.fill(address, data)

    # -- services
    def handle(self, frame: Dict) -> List[Dict]:
        """Return the frames this device emits for an incoming L_Data frame."""
        service = frame.get("service")
        out: List[Dict] = []
        if service == "A_Memory_Read":
            addr, count = frame.get("address"), frame.get("count", 0)
            if addr is None or count is None:
                return out
            out.append(self._ldata(cemi.ldata(self.ia, cemi.apdu_memory_response(
                addr, self.mem_read(addr, count)), group=False, source=self.ia)))
        elif service == "A_Memory_Write":
            addr, data = frame.get("address"), frame.get("value") or b""
            if addr is not None:
                self.mem_write(addr, data)
        elif service == "A_MemoryExtended_Write":
            payload = frame.get("value") or b""
            if len(payload) >= 4:
                addr = (payload[0] << 16) | (payload[1] << 8) | payload[2]
                self.mem_write(addr, payload[4:])
        elif service == "A_DeviceDescriptor_Read":
            out.append(self._ldata(cemi.ldata(self.ia, cemi._apdu(
                cemi.APCI_DESCRIPTOR_RESPONSE, 0x40,
                struct.pack("!H", self.descriptor)), group=False, source=self.ia)))
        elif service == "A_IndividualAddress_Write":
            new_ia = frame.get("address")
            if new_ia is not None and self.programming_mode:
                self.ia = new_ia
                self.programming_mode = False
        elif service == "A_IndividualAddress_Read":
            out.append(self._ldata(cemi.ldata(self.ia, cemi._apdu(
                cemi.APCI_IA_RESPONSE, 0x40,
                struct.pack("!H", self.ia)), group=False, source=self.ia)))
        elif service == "A_Restart":
            self.restarts.append(bool(frame.get("master_reset")))
            if frame.get("master_reset"):
                self.memory.clear()
                self.properties.clear()
                self.group_values.clear()
        elif service == "A_PropertyValue_Read":
            key = (frame.get("object_index"), frame.get("property_id"))
            value = self.properties.get(key, b"\xff\xff\xff\xff")
            count = frame.get("count", 1)
            start = frame.get("start_index", 1)
            payload = value[(start - 1) * count:] if start else value
            out.append(self._ldata(cemi.ldata(self.ia, cemi._apdu(
                cemi.APCI_PROPERTY_VALUE_RESPONSE, 0xD6,
                bytes([frame.get("object_index", 0), frame.get("property_id", 0),
                       (max(1, len(payload)) & 0x0F) << 4, 0x01]) + payload),
                group=False, source=self.ia)))
        elif service == "A_PropertyValue_Write":
            key = (frame.get("object_index"), frame.get("property_id"))
            self.properties[key] = frame.get("value") or b""
            out.append(self._ldata(cemi.ldata(self.ia, cemi._apdu(
                cemi.APCI_PROPERTY_VALUE_RESPONSE, 0xD6,
                bytes([frame.get("object_index", 0), frame.get("property_id", 0), 0x10, 0x01])),
                group=False, source=self.ia)))
        elif service == "A_GroupValue_Write":
            ga = frame.get("dst")
            self.group_values[ga] = frame.get("value") or b""
        elif service == "A_GroupValue_Read":
            ga = frame.get("dst")
            if ga in self.group_values:
                out.append(self._ldata(cemi.ldata(
                    ga, cemi.apdu_group_response(self.group_values[ga]), group=True,
                    source=self.ia)))
        elif service == "A_IndividualAddressSerialNumber_Read":
            if self.programming_mode:
                body = b"\x00\x00" + bytes.fromhex("0011223344") + bytes([self.ia >> 8, self.ia & 0xFF])
                out.append(self._ldata(cemi.ldata(
                    cemi.IA_BROADCAST, cemi._apdu(cemi.APCI_IA_SERIAL_WRITE, 0xDD, body),
                    group=False, source=self.ia)))
        return out

    def _ldata(self, frame: bytes) -> Dict:
        parsed = cemi.parse(cemi.as_ind(frame))
        parsed["_emit"] = True
        return parsed


class GatewaySim(threading.Thread):
    """KNXnet/IP gateway on loopback, hosting one or more VirtualDevice objects."""

    def __init__(self, devices: Optional[List[VirtualDevice]] = None, port: int = 0,
                 busmonitor: bool = True, ack_status: int = 0):
        super(GatewaySim, self).__init__(name="knx-gateway-sim", daemon=True)
        self.devices = {d.ia: d for d in (devices or [VirtualDevice(0x1101)])}
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", port))
        self.sock.settimeout(0.2)
        self.port = self.sock.getsockname()[1]
        self.busmonitor = busmonitor
        self.ack_status = ack_status
        self.channels: Dict[int, Dict] = {}
        self._seq = {}
        self._running = True
        self.frames: List[Dict] = []
        self.errors: List[str] = []
        self._next_channel = 1

    # -- lifecycle
    def run(self) -> None:
        while self._running:
            try:
                data, addr = self.sock.recvfrom(4096)
            except socket.timeout:
                continue
            except OSError:
                return
            try:
                self._handle(data, addr)
            except Exception as exc:  # noqa: BLE001
                self.errors.append("%s: %s" % (type(exc).__name__, exc))

    def stop(self) -> None:
        self._running = False
        try:
            self.join(timeout=2.0)
        finally:
            self.sock.close()

    # -- protocol
    def _handle(self, data: bytes, addr) -> None:
        if len(data) < 6:
            return
        svc = struct.unpack("!H", data[2:4])[0]
        body = data[6:]
        if svc == knxip.SVC_SEARCH_REQUEST:
            dib = self._device_info_dib()
            fam = bytes([0x04, 0x02, 0x02, 0x01])
            payload = knxip.hpai("127.0.0.1", self.port) + dib + fam
            self.sock.sendto(knxip.header(knxip.SVC_SEARCH_RESPONSE, len(payload)) + payload, addr)
        elif svc == knxip.SVC_DESCRIPTION_REQUEST:
            payload = knxip.hpai("127.0.0.1", self.port) + self._device_info_dib()
            self.sock.sendto(knxip.header(knxip.SVC_DESCRIPTION_RESPONSE, len(payload)) + payload, addr)
        elif svc == knxip.SVC_CONNECT_REQUEST:
            channel = self._next_channel
            self._next_channel = (self._next_channel % 200) + 1
            self.channels[channel] = {"addr": addr, "layer": body[18] if len(body) > 18 else 2}
            self._seq[channel] = 0
            payload = bytes([channel, knxip.E_NO_ERROR]) + knxip.hpai("127.0.0.1", self.port) \
                + bytes([0x04, 0x04, 0x02, 0x00])
            self.sock.sendto(knxip.header(knxip.SVC_CONNECT_RESPONSE, len(payload)) + payload, addr)
        elif svc == knxip.SVC_CONNECTIONSTATE_REQUEST:
            channel = body[0]
            status = knxip.E_NO_ERROR if channel in self.channels else knxip.E_CONN_ID
            payload = bytes([channel, status])
            self.sock.sendto(knxip.header(knxip.SVC_CONNECTIONSTATE_RESPONSE, len(payload)) + payload, addr)
        elif svc == knxip.SVC_DISCONNECT_REQUEST:
            self.channels.pop(body[0], None)
            payload = bytes([body[0], knxip.E_NO_ERROR])
            self.sock.sendto(knxip.header(knxip.SVC_DISCONNECT_RESPONSE, len(payload)) + payload, addr)
        elif svc == knxip.SVC_TUNNELLING_REQUEST:
            self._handle_tunnelling(body, addr)

    def _handle_tunnelling(self, body: bytes, addr) -> None:
        channel, seq = body[1], body[2]
        ack = struct.pack("!BBBB", 0x04, channel, seq, self.ack_status)
        self.sock.sendto(knxip.header(knxip.SVC_TUNNELLING_ACK, len(ack)) + ack, addr)
        if self.ack_status != knxip.E_NO_ERROR:
            return
        if channel not in self.channels:
            return
        frame = cemi.parse(body[4:])
        if frame is None or frame.get("kind") != "ldata":
            return
        # a real data link layer puts the frame on the bus (which is what makes
        # devices react) and only then confirms it locally; mirror that order so a
        # client that waits for the confirmation is guaranteed the device acted.
        self.frames.append(frame)
        self._broadcast_busmon(body[4:])
        if frame["group"] or frame["dst"] == cemi.IA_BROADCAST:
            targets = list(self.devices.values())
        else:
            targets = [d for d in self.devices.values() if d.ia == frame["dst"]]
        for dev in targets:
            for response in dev.handle(frame):
                self._send(response["raw"], addr, channel)
                self._broadcast_busmon(response["raw"])
        self._send(cemi.ldata_confirm(frame), addr, channel)

    def _send(self, frame, addr, channel: int) -> None:
        seq = self._seq.get(channel, 0)
        self._seq[channel] = (seq + 1) & 0xFF
        body = struct.pack("!BBBB", 0x04, channel, seq, 0x00) + bytes(frame)
        try:
            self.sock.sendto(knxip.header(knxip.SVC_TUNNELLING_REQUEST, len(body)) + body, addr)
        except OSError:
            pass

    def _broadcast_busmon(self, frame: bytes) -> None:
        if not self.busmonitor:
            return
        for channel, info in list(self.channels.items()):
            if info.get("layer") != knxip.LAYER_BUSMON:
                continue
            busmon = bytes([cemi.L_BUSMON_IND, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]) + bytes(frame)
            self._send(busmon, info["addr"], channel)

    def _device_info_dib(self) -> bytes:
        first = next(iter(self.devices.values()))
        name = first.name.encode("utf-8")[:29].ljust(30, b"\x00")
        body = bytes([0x02, 0x00]) + struct.pack("!H", first.ia) \
            + bytes.fromhex("0000") + bytes.fromhex("001122334455") \
            + socket.inet_aton("224.0.23.12") + bytes.fromhex("020000000001") + name
        return bytes([2 + len(body), 0x01]) + body

    # -- inspection helpers used by tests
    def set_ack_status(self, status: int) -> None:
        self.ack_status = status

    def clear(self) -> None:
        self.frames = []
        self.errors = []
        for device in self.devices.values():
            device.writes = []
            device.restarts = []
            device.memory_write_calls = 0
