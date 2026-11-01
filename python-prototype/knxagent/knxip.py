"""KNXnet/IP transport: discovery, tunnelling, routing, bus monitor.

Implements the KNXnet/IP core services needed for commissioning:
  * SEARCH_REQUEST / SEARCH_RESPONSE (+ DESCRIPTION_REQUEST)
  * CONNECT_REQUEST / CONNECT_RESPONSE, CONNECTIONSTATE, DISCONNECT
  * TUNNELLING_REQUEST / TUNNELLING_ACK (layer 0x02 data link, 0x80 bus monitor)
  * ROUTING_INDICATION (multicast 224.0.23.12:3671) as a fallback transport

Reference: KNXnet/IP core spec 2.1 (AN117), service IDs per 3/8/2.
"""

from __future__ import annotations

import socket
import struct
import threading
import time
from typing import Callable, Dict, List, Optional, Tuple

from . import cemi

# --------------------------------------------------------------- constants
MULTICAST = ("224.0.23.12", 3671)

SVC_SEARCH_REQUEST = 0x0201
SVC_SEARCH_RESPONSE = 0x0202
SVC_DESCRIPTION_REQUEST = 0x0203
SVC_DESCRIPTION_RESPONSE = 0x0204
SVC_CONNECT_REQUEST = 0x0205
SVC_CONNECT_RESPONSE = 0x0206
SVC_CONNECTIONSTATE_REQUEST = 0x0207
SVC_CONNECTIONSTATE_RESPONSE = 0x0208
SVC_DISCONNECT_REQUEST = 0x0209
SVC_DISCONNECT_RESPONSE = 0x020A
SVC_TUNNELLING_REQUEST = 0x0420
SVC_TUNNELLING_ACK = 0x0421
SVC_ROUTING_INDICATION = 0x0530
SVC_ROUTING_LOST = 0x0531
SVC_ROUTING_BUSY = 0x0532

LAYER_LINK = 0x02
LAYER_RAW = 0x04
LAYER_BUSMON = 0x80

CONN_TUNNEL = 0x04
CONN_DEVICE_MGMT = 0x03

E_NO_ERROR = 0x00
E_HOST_PROTOCOL = 0x01
E_VERSION = 0x02
E_SEQ = 0x04
E_CONN_ID = 0x21
E_CONN_TYPE = 0x22
E_CONN_OPTION = 0x23
E_NO_MORE_CONN = 0x24
E_NO_MORE_UNIQUE = 0x25
E_DATA_CONN = 0x26
E_KNX_CONN = 0x27
E_TUNNEL_ADDR = 0x29

ERROR_NAMES = {
    E_NO_ERROR: "E_NO_ERROR",
    E_HOST_PROTOCOL: "E_HOST_PROTOCOL_TYPE",
    E_VERSION: "E_VERSION_NOT_SUPPORTED",
    E_SEQ: "E_SEQUENCE_NUMBER",
    E_CONN_ID: "E_CONNECTION_ID",
    E_CONN_TYPE: "E_CONNECTION_TYPE",
    E_CONN_OPTION: "E_CONNECTION_OPTION",
    E_NO_MORE_CONN: "E_NO_MORE_CONNECTIONS",
    E_NO_MORE_UNIQUE: "E_NO_MORE_UNIQUE_CONNECTIONS",
    E_DATA_CONN: "E_DATA_CONNECTION",
    E_KNX_CONN: "E_KNX_CONNECTION",
    E_TUNNEL_ADDR: "E_TUNNELLING_LAYER",
}


class KnxIpError(Exception):
    pass


# ------------------------------------------------------------------ framing
def header(service: int, body_len: int) -> bytes:
    return struct.pack("!BBHH", 0x06, 0x10, service, body_len + 6)


def hpai(ip: str, port: int, protocol: int = 0x01) -> bytes:
    return struct.pack("!BB4sHB", 0x08, 0x01, socket.inet_aton(ip), port, protocol)


def parse_hpai(data: bytes) -> Dict:
    length, code, ip, port, proto = struct.unpack("!BB4sHB", data[:8])
    return {"length": length, "code": code, "ip": socket.inet_ntoa(ip),
            "port": port, "protocol": proto}


def parse_dib(data: bytes) -> Dict:
    """Parse one description information block (device info / service families)."""
    if len(data) < 2:
        return {}
    length, desc_type = data[0], data[1]
    body = data[2:length]
    if desc_type == 0x01 and len(body) >= 52:
        medium, status = body[0], body[1]
        ia = (body[2] << 8) | body[3]
        project_install_id = (body[4] << 8) | body[5]
        serial = body[6:12]
        mcast = socket.inet_ntoa(body[12:16])
        mac = ":".join("%02x" % b for b in body[16:22])
        name = body[22:52].split(b"\x00")[0].decode("utf-8", "replace")
        return {"type": "device_info", "medium": medium, "status": status,
                "project_installation_id": project_install_id,
                "individual_address": ia, "ia_text": cemi.format_ia(ia),
                "serial": serial.hex().upper(), "multicast": mcast, "mac": mac,
                "friendly_name": name}
    if desc_type == 0x02:
        families = []
        for i in range(0, len(body) - 1, 2):
            families.append((body[i], body[i + 1]))
        return {"type": "supp_svc_families", "families": families}
    return {"type": "unknown", "desc_type": desc_type, "raw": data[:length].hex()}


def parse_dibs(data: bytes) -> List[Dict]:
    out, i = [], 0
    while i + 2 <= len(data):
        length = data[i]
        if length == 0:
            break
        out.append(parse_dib(data[i:i + length]))
        i += length
    return out


# ---------------------------------------------------------------- discovery
def search(timeout: float = 3.0, multicast: bool = True,
           unicast_targets: Optional[List[str]] = None) -> List[Dict]:
    """Discover KNXnet/IP servers by multicast search and/or unicast search."""
    results: List[Dict] = []
    seen = set()
    body = hpai("0.0.0.0", 0)
    packet = header(SVC_SEARCH_REQUEST, len(body)) + body
    targets = []
    if multicast:
        targets.append(MULTICAST)
    for host in (unicast_targets or []):
        targets.append(host if isinstance(host, tuple) else (host, 3671))
    for target in targets:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
        sock.settimeout(0.5)
        try:
            sock.sendto(packet, target)
            deadline = time.time() + timeout
            while time.time() < deadline:
                try:
                    data, addr = sock.recvfrom(2048)
                except socket.timeout:
                    continue
                if len(data) < 6:
                    continue
                svc = struct.unpack("!H", data[2:4])[0]
                if svc != SVC_SEARCH_RESPONSE:
                    continue
                key = (addr[0], data[6:].hex())
                if key in seen:
                    continue
                seen.add(key)
                blocks = parse_dibs(data[6:])
                info = {"ip": addr[0], "port": addr[1], "dibs": blocks}
                for block in blocks:
                    if block.get("type") == "device_info":
                        info.update({k: v for k, v in block.items() if k != "type"})
                results.append(info)
        finally:
            sock.close()
    return results


def describe(host: str, timeout: float = 2.0) -> Dict:
    """DESCRIPTION_REQUEST: returns DIBs from a server without opening a tunnel."""
    body = hpai("0.0.0.0", 0)
    packet = header(SVC_DESCRIPTION_REQUEST, len(body)) + body
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    try:
        sock.sendto(packet, (host, 3671))
        data, _ = sock.recvfrom(2048)
    finally:
        sock.close()
    return {"ip": host, "dibs": parse_dibs(data[6:])}


# --------------------------------------------------------------- transports
class _BaseTransport(object):
    """Common socket plumbing, receive loop and inbox for both transports."""

    def __init__(self, local_ip: str = "0.0.0.0", local_port: int = 0):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind((local_ip, local_port))
        self.sock.settimeout(0.4)
        self.local_ip = local_ip
        self.local_port = self.sock.getsockname()[1]
        self._lock = threading.Lock()
        self._inbox: List[Dict] = []
        self._cv = threading.Condition()
        self._running = True
        self._rx_errors = 0
        self._rx_count = 0
        self._ack_sent = 0
        self.raw_log: List[Dict] = []
        self.log_raw = False
        self._thread = threading.Thread(target=self._rx_loop, name="knx-ip-rx", daemon=True)
        self._thread.start()

    # -- to be implemented by subclasses
    def _handle_packet(self, data: bytes, addr) -> None:
        raise NotImplementedError

    def _send_cemi(self, frame: bytes, timeout: float) -> bool:
        raise NotImplementedError

    # -- plumbing
    def _rx_loop(self) -> None:
        while self._running:
            try:
                data, addr = self.sock.recvfrom(4096)
            except socket.timeout:
                continue
            except OSError:
                return
            self._rx_count += 1
            try:
                self._handle_packet(data, addr)
            except Exception:  # noqa: BLE001 - never kill the receive loop
                self._rx_errors += 1

    def _push(self, item: Dict) -> None:
        with self._cv:
            self._inbox.append(item)
            self._cv.notify_all()

    def send_cemi(self, frame: bytes, timeout: float = 3.0) -> bool:
        return self._send_cemi(frame, timeout)

    def wait(self, predicate: Callable[[Dict], bool], timeout: float = 3.0) -> Optional[Dict]:
        deadline = time.time() + timeout
        with self._cv:
            while True:
                for idx, item in enumerate(self._inbox):
                    if predicate(item):
                        return self._inbox.pop(idx)
                remaining = deadline - time.time()
                if remaining <= 0:
                    return None
                self._cv.wait(remaining)

    def drain(self) -> List[Dict]:
        with self._cv:
            items, self._inbox = self._inbox, []
        return items

    def close(self) -> None:
        self._running = False
        self._thread.join(timeout=2.0)
        try:
            self.sock.close()
        except OSError:
            pass

    def stats(self) -> Dict:
        return {"rx_frames": self._rx_count, "rx_errors": self._rx_errors,
                "acks_sent": self._ack_sent, "local_port": self.local_port}


class Tunnel(_BaseTransport):
    """A KNXnet/IP tunnelling connection (one channel, one sequence counter)."""

    def __init__(self, host: str, port: int = 3671, layer: int = LAYER_LINK,
                 local_ip: str = "0.0.0.0", connect_timeout: float = 4.0):
        self.gateway = (host, port)
        self.layer = layer
        self.channel: Optional[int] = None
        self.sequence = 0
        self.ack_status: Dict[int, int] = {}
        self.cemi: List[Dict] = []
        self._ack_timeout_count = 0
        super(Tunnel, self).__init__(local_ip=local_ip)
        self._connect(connect_timeout)

    # -- lifecycle
    def _connect(self, timeout: float) -> None:
        advertised = self.sock.getsockname()[0]
        if advertised in ("0.0.0.0", ""):
            advertised = self._local_ip_towards(self.gateway[0])
        self.advertised_ip = advertised
        body = (hpai(advertised, self.local_port) + hpai(advertised, self.local_port)
                + struct.pack("!BBBB", 0x04, CONN_TUNNEL, self.layer, 0x00))
        self.sock.sendto(header(SVC_CONNECT_REQUEST, len(body)) + body, self.gateway)
        item = self.wait(lambda i: i.get("kind") == "connect", timeout)
        if item is None:
            raise KnxIpError("no CONNECT_RESPONSE from %s:%d" % self.gateway)
        if item["status"] != E_NO_ERROR:
            raise KnxIpError("connect failed: %s (0x%02X)"
                             % (ERROR_NAMES.get(item["status"], "unknown"), item["status"]))
        self.channel = item["channel"]

    def _local_ip_towards(self, host: str) -> str:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect((host, 3671))
            return probe.getsockname()[0]
        finally:
            probe.close()

    def close(self) -> None:
        if self.channel is not None:
            try:
                body = struct.pack("!BB", self.channel, 0x00) + hpai("0.0.0.0", 0)
                self.sock.sendto(header(SVC_DISCONNECT_REQUEST, len(body)) + body, self.gateway)
                time.sleep(0.05)
            except OSError:
                pass
        super(Tunnel, self).close()

    # -- receive
    def _handle_packet(self, data: bytes, addr) -> None:
        if len(data) < 6:
            return
        svc = struct.unpack("!H", data[2:4])[0]
        body = data[6:]
        if svc == SVC_TUNNELLING_REQUEST:
            if len(body) < 4:
                return
            _l, channel, seq, _r = body[0], body[1], body[2], body[3]
            self._send_ack(channel, seq)
            frame = cemi.parse(body[4:])
            if frame is not None:
                self.cemi.append(frame)
                if self.log_raw:
                    self.raw_log.append({"direction": "in", "cemi": body[4:].hex()})
                self._push(frame)
        elif svc == SVC_TUNNELLING_ACK:
            if len(body) >= 4:
                self.ack_status[body[2]] = body[3]
                self._push({"kind": "tunnelling_ack", "seq": body[2], "status": body[3]})
        elif svc == SVC_ROUTING_INDICATION:
            frame = cemi.parse(body[6:])
            if frame is not None:
                self._push(frame)
        elif svc == SVC_CONNECT_RESPONSE:
            if len(body) >= 2:
                self._push({"kind": "connect", "channel": body[0], "status": body[1]})
        elif svc == SVC_CONNECTIONSTATE_RESPONSE:
            self._push({"kind": "connectionstate", "status": body[1] if len(body) > 1 else 0xFF})
        elif svc == SVC_DISCONNECT_REQUEST:
            self.channel = None
            self._push({"kind": "disconnected"})

    def _send_ack(self, channel: int, seq: int) -> None:
        body = struct.pack("!BBBB", 0x04, channel, seq, E_NO_ERROR)
        with self._lock:
            try:
                self.sock.sendto(header(SVC_TUNNELLING_ACK, len(body)) + body, self.gateway)
                self._ack_sent += 1
            except OSError:
                pass

    # -- send
    def _send_cemi(self, frame: bytes, timeout: float = 3.0) -> bool:
        if self.channel is None:
            raise KnxIpError("tunnel is not connected")
        seq = self.sequence
        self.sequence = (self.sequence + 1) & 0xFF
        body = struct.pack("!BBBB", 0x04, self.channel, seq, 0x00) + bytes(frame)
        packet = header(SVC_TUNNELLING_REQUEST, len(body)) + body
        with self._lock:
            self.sock.sendto(packet, self.gateway)
            if self.log_raw:
                self.raw_log.append({"direction": "out", "cemi": bytes(frame).hex()})
        ack = self.wait(lambda i: i.get("kind") == "tunnelling_ack" and i.get("seq") == seq,
                        timeout)
        if ack is None:
            self._ack_timeout_count += 1
            return False
        return ack.get("status") == E_NO_ERROR

    def heartbeat(self, timeout: float = 2.0) -> bool:
        if self.channel is None:
            return False
        body = struct.pack("!BB", self.channel, 0x00) + hpai("0.0.0.0", 0)
        with self._lock:
            self.sock.sendto(header(SVC_CONNECTIONSTATE_REQUEST, len(body)) + body, self.gateway)
        item = self.wait(lambda i: i.get("kind") == "connectionstate", timeout)
        return bool(item and item.get("status") == E_NO_ERROR)

    def stats(self) -> Dict:
        base = super(Tunnel, self).stats()
        base.update({"channel": self.channel, "sequence": self.sequence,
                     "tx_ack_timeouts": self._ack_timeout_count,
                     "frames": len(self.cemi)})
        return base


class Router(_BaseTransport):
    """KNXnet/IP routing (multicast). Carries group traffic and, via a KNX/IP
    router (not a plain interface), individual-addressed management frames."""

    def __init__(self, group: str = MULTICAST[0], port: int = MULTICAST[1],
                 local_ip: str = "0.0.0.0"):
        self.target = (group, port)
        super(Router, self).__init__(local_ip=local_ip)

    def _handle_packet(self, data: bytes, addr) -> None:
        if struct.unpack("!H", data[2:4])[0] != SVC_ROUTING_INDICATION:
            return
        frame = cemi.parse(data[6 + 4:])
        if frame is not None:
            self._push(frame)

    def _send_cemi(self, frame: bytes, timeout: float = 1.0) -> bool:
        body = struct.pack("!BBBB", 0x04, 0x00, 0x00, 0x00) + bytes(frame)
        with self._lock:
            self.sock.sendto(header(SVC_ROUTING_INDICATION, len(body)) + body, self.target)
        return True


def open_transport(host: Optional[str] = None, layer: int = LAYER_LINK,
                   **kwargs) -> _BaseTransport:
    """Tunnel to @host when given, else KNXnet/IP routing."""
    if host:
        return Tunnel(host, layer=layer, **kwargs)
    return Router(**kwargs)
