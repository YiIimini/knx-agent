"""Device management and group-value access on top of a KNXnet/IP transport.

Everything ETS does to a device that a commissioning agent needs is one of:
  A_Memory_Read / A_Memory_Write          - memory mapped download + parameter blocks
  A_MemoryExtended_Read / _Write          - the same above 64 KiB or > 15 octets
  A_PropertyValue_Read / _Write           - interface object properties (identity, tables)
  A_IndividualAddress_Write / _Read       - addressing, line scan
  A_IndividualAddressSerialNumber_Read    - identify a device in programming mode
  A_DeviceDescriptor_Read                 - mask version / device family
  A_Restart                               - application start, master reset
  A_GroupValue_Read / _Write / _Response  - functional acceptance test
"""

from __future__ import annotations

import time
from typing import Callable, Dict, List, Optional

from . import cemi, dpt


class LinkError(Exception):
    pass


def _is_ldata(item: Dict) -> bool:
    return item.get("kind") == "ldata"


def _is_inbound(item: Dict) -> bool:
    """Bus traffic forwarded to us. Some interfaces re-emit it as L_Data.req."""
    return (item.get("kind") == "ldata"
            and item.get("code") in (cemi.L_DATA_IND, cemi.L_DATA_REQ)
            and item.get("src", 0) != 0)


class DeviceLink(object):
    """Management access to individual addressed devices over one transport."""

    def __init__(self, transport, ack_timeout: float = 1.5, confirm_timeout: float = 0.4):
        self.transport = transport
        self.ack_timeout = ack_timeout
        self.confirm_timeout = confirm_timeout
        self.log: List[Dict] = []

    # ---------------------------------------------------------------- core
    def _request(self, frame: bytes, accept: Callable[[Dict], bool],
                 timeout: float = 2.0, retries: int = 2,
                 ack_timeout: Optional[float] = None) -> Optional[Dict]:
        """Send a cEMI frame, wait for the local confirmation, then the response."""
        for attempt in range(retries + 1):
            if attempt == 0:
                self.transport.drain()  # do not attribute a stale frame to this request
            sent = self.transport.send_cemi(frame, timeout=ack_timeout or self.ack_timeout)
            if not sent:
                self.log.append({"attempt": attempt, "result": "no tunnelling ack"})
                continue
            con = self.transport.wait(
                lambda i: _is_ldata(i) and i["code"] == cemi.L_DATA_CON, self.confirm_timeout)
            if con is not None and con.get("con_error"):
                self.log.append({"attempt": attempt, "result": "negative confirmation"})
                continue
            resp = self.transport.wait(accept, timeout)
            if resp is not None:
                return resp
            self.log.append({"attempt": attempt, "result": "timeout"})
        return None

    @staticmethod
    def _from_ia(ia: int) -> Callable[[Dict], bool]:
        return lambda i: _is_inbound(i) and i["src"] == ia

    # -------------------------------------------------------------- memory
    def memory_read(self, ia: int, address: int, count: int,
                    timeout: float = 2.0, retries: int = 2) -> Optional[bytes]:
        """Read @count octets; transparently chunks to the service limits."""
        out = bytearray()
        remaining = count
        addr = address
        while remaining > 0:
            chunk = min(remaining, 15)
            apdu = cemi.apdu_memory_read(addr, chunk)
            frame = cemi.ldata(ia, apdu, group=False)
            resp = self._request(
                frame,
                lambda i, a=addr, n=chunk: (self._from_ia(ia)(i)
                                            and i.get("service") == "A_Memory_Response"
                                            and i.get("address") == a
                                            and len(i.get("value") or b"") >= n),
                timeout, retries)
            if resp is None:
                return None
            value = resp.get("value") or b""
            if len(value) < chunk:
                return None
            out.extend(value[:chunk])
            addr = (addr + chunk) & 0xFFFF
            remaining -= chunk
        return bytes(out)

    def memory_write(self, ia: int, address: int, data: bytes,
                     timeout: float = 2.0, retries: int = 2) -> bool:
        for offset in range(0, len(data), 15):
            chunk = data[offset:offset + 15]
            addr = (address + offset) & 0xFFFF
            apdu = cemi.apdu_memory_write(addr, chunk)
            frame = cemi.ldata(ia, apdu, group=False)
            sent = self.transport.send_cemi(frame, timeout=self.ack_timeout)
            if not sent:
                return False
            con = self.transport.wait(
                lambda i: _is_ldata(i) and i["code"] == cemi.L_DATA_CON, self.confirm_timeout)
            if con is None:
                return False
            if con.get("con_error"):
                return False
            # drains any device echo / response noise before the next block
            time.sleep(0.005)
        return True

    def memory_write_ext(self, ia: int, address: int, data: bytes,
                         chunk_size: int = 220) -> bool:
        for offset in range(0, len(data), chunk_size):
            chunk = data[offset:offset + chunk_size]
            apdu = cemi.apdu_memory_ext_write(address + offset, chunk)
            frame = cemi.ldata(ia, apdu, group=False)
            if not self.transport.send_cemi(frame, timeout=self.ack_timeout):
                return False
            con = self.transport.wait(
                lambda i: _is_ldata(i) and i["code"] == cemi.L_DATA_CON, self.confirm_timeout)
            if con is None or con.get("con_error"):
                return False
        return True

    # ---------------------------------------------------------- addressing
    def descriptor_read(self, ia: int, descriptor_type: int = 0,
                        timeout: float = 1.0, retries: int = 1) -> Optional[int]:
        frame = cemi.ldata(ia, cemi.apdu_descriptor_read(descriptor_type), group=False)
        resp = self._request(
            frame,
            lambda i: self._from_ia(ia)(i) and i.get("service") == "A_DeviceDescriptor_Response",
            timeout, retries)
        return resp.get("descriptor") if resp else None

    def read_ia(self, ia: int, timeout: float = 1.0) -> Optional[int]:
        frame = cemi.ldata(ia, cemi.apdu_ia_read(), group=False)
        resp = self._request(
            frame,
            lambda i: self._from_ia(ia)(i) and i.get("service") == "A_IndividualAddress_Response",
            timeout, 1)
        return resp.get("address") if resp else None

    def assign_ia(self, new_ia: int, old_ia: int = cemi.IA_BROADCAST,
                  timeout: float = 2.0) -> bool:
        """A_IndividualAddress_Write. The device must be in programming mode."""
        frame = cemi.ldata(old_ia, cemi.apdu_ia_write(new_ia), group=False)
        sent = self.transport.send_cemi(frame, timeout=self.ack_timeout)
        if not sent:
            return False
        con = self.transport.wait(
            lambda i: _is_ldata(i) and i["code"] == cemi.L_DATA_CON, self.confirm_timeout)
        return bool(con and not con.get("con_error"))

    def serial_number(self, timeout: float = 1.0) -> Optional[Dict]:
        """Broadcast read: works for any device currently in programming mode."""
        frame = cemi.ldata(cemi.IA_BROADCAST, cemi.apdu_ia_serial_read(), group=False,
                           sys_broadcast=False)
        resp = self._request(
            frame,
            lambda i: _is_inbound(i)
            and i.get("service") == "A_IndividualAddressSerialNumber_Write",
            timeout, 2)
        if not resp:
            return None
        value = resp.get("value") or b""
        if len(value) < 10:
            return {"src": resp["src_ia"], "raw": value.hex()}
        return {
            "src": resp["src_ia"],
            "domain_address": value[0:2].hex(),
            "serial": value[2:8].hex().upper(),
            "individual_address": cemi.format_ia((value[8] << 8) | value[9]),
            "raw": value.hex(),
        }

    def restart(self, ia: int, master: bool = False) -> bool:
        frame = cemi.ldata(ia, cemi.apdu_restart(master), group=False)
        sent = self.transport.send_cemi(frame, timeout=self.ack_timeout)
        if not sent:
            return False
        con = self.transport.wait(
            lambda i: _is_ldata(i) and i["code"] == cemi.L_DATA_CON, max(self.confirm_timeout, 1.0))
        return bool(con and not con.get("con_error"))

    # ---------------------------------------------------------- properties
    def property_read(self, ia: int, object_index: int, property_id: int,
                      count: int = 1, start_index: int = 1,
                      timeout: float = 1.5) -> Optional[bytes]:
        apdu = cemi.apdu_property_read(object_index, property_id, count, start_index)
        frame = cemi.ldata(ia, apdu, group=False)
        resp = self._request(
            frame,
            lambda i: self._from_ia(ia)(i)
            and i.get("service") == "A_PropertyValue_Response"
            and i.get("object_index") == object_index
            and i.get("property_id") == property_id,
            timeout, 2)
        return (resp.get("value") if resp else None)

    def property_write(self, ia: int, object_index: int, property_id: int,
                       data: bytes, start_index: int = 1, timeout: float = 1.5) -> bool:
        apdu = cemi.apdu_property_write(object_index, property_id, data, start_index)
        frame = cemi.ldata(ia, apdu, group=False)
        resp = self._request(
            frame,
            lambda i: self._from_ia(ia)(i)
            and i.get("service") == "A_PropertyValue_Response"
            and i.get("property_id") == property_id,
            timeout, 2)
        return resp is not None

    # -------------------------------------------------------------- scan
    def scan(self, line: str = "1.1", device_range: range = range(0, 256),
             window: int = 48, settle: float = 0.6) -> List[Dict]:
        """Pipeline A_DeviceDescriptor_Read across a line; collect responders.

        Pipelining matters: a sequential scan with a 1 s timeout per address takes
        four minutes per line. Here each IP frame is acknowledged (1-2 ms) and the
        responses are collected afterwards.
        """
        area, line_no = [int(x) for x in line.split(".")]
        found: Dict[int, Dict] = {}
        addrs = [(area << 12) | (line_no << 8) | d for d in device_range]
        for start in range(0, len(addrs), window):
            batch = addrs[start:start + window]
            for addr in batch:
                frame = cemi.ldata(addr, cemi.apdu_descriptor_read(0), group=False)
                self.transport.send_cemi(frame, timeout=0.8)
            deadline = time.time() + settle
            while time.time() < deadline:
                item = self.transport.wait(
                    lambda i: _is_inbound(i)
                    and i.get("service") == "A_DeviceDescriptor_Response",
                    max(0.05, deadline - time.time()))
                if item is None:
                    break
                found[item["src"]] = {"ia": item["src"], "ia_text": item["src_ia"],
                                      "descriptor": item.get("descriptor")}
        self.transport.drain()
        return sorted(found.values(), key=lambda d: d["ia"])


class GroupBus(object):
    """Group addressed traffic: functional test, acceptance, monitoring."""

    def __init__(self, transport, response_timeout: float = 2.0):
        self.transport = transport
        self.response_timeout = response_timeout

    def write(self, ga: int, value: bytes) -> bool:
        """Write a group value; True means the link layer confirmed the frame."""
        frame = cemi.ldata(ga, cemi.apdu_group_write(value), group=True)
        if not self.transport.send_cemi(frame, timeout=1.5):
            return False
        con = self.transport.wait(
            lambda i: _is_ldata(i) and i["code"] == cemi.L_DATA_CON, 1.0)
        return bool(con and not con.get("con_error"))

    def write_dpt(self, ga: int, dpt_id: str, value) -> bool:
        return self.write(ga, dpt.encode(dpt_id, value))

    def read(self, ga: int, timeout: Optional[float] = None) -> Optional[Dict]:
        frame = cemi.ldata(ga, cemi.apdu_group_read(), group=True)
        if not self.transport.send_cemi(frame, timeout=1.5):
            return None
        resp = self.transport.wait(
            lambda i: _is_inbound(i)
            and i["group"] and i["dst"] == ga
            and i.get("service") == "A_GroupValue_Response",
            timeout or self.response_timeout)
        return resp

    def read_dpt(self, ga: int, dpt_id: str, timeout: Optional[float] = None):
        resp = self.read(ga, timeout)
        if resp is None:
            return None
        return dpt.decode(dpt_id, resp.get("value") or b"")

    def listen(self, seconds: float = 5.0,
               predicate: Optional[Callable[[Dict], bool]] = None) -> List[Dict]:
        """Collect inbound frames for @seconds.

        On a bus monitor tunnel this is every frame on the bus, including the
        individual addressed management traffic of a download; on a normal data
        link only the group traffic the interface forwards. Pass @predicate to
        narrow further (e.g. only group frames, or one source address).
        """
        out: List[Dict] = []
        deadline = time.time() + seconds
        while time.time() < deadline:
            item = self.transport.wait(
                lambda i: _is_inbound(i) and (predicate is None or predicate(i)),
                max(0.05, deadline - time.time()))
            if item is not None:
                out.append(item)
        return out
