"""cEMI (common External Message Interface) codec for KNX.

Pure stdlib. Byte layouts follow KNX 3/6/3 (EMI / cEMI) and 3/5/x (application
layer services). The two L_Data control octets are reproduced exactly as ETS
emits them: 0xBC / 0xE0 for a standard group frame, 0xBC / 0x60 for a standard
individual-addressed frame (KNX 3/2/2 §2.2.2, 3/6/3 §4.1.4.3.2).

Verified byte vectors live in tests/test_codec.py.
"""

from __future__ import annotations

from typing import Dict, Optional

# ---------------------------------------------------------------- cEMI codes
L_RAW_REQ = 0x10
L_DATA_REQ = 0x11
L_POLL_DATA_REQ = 0x13
L_POLL_DATA_CON = 0x25
L_DATA_IND = 0x29
L_BUSMON_IND = 0x2B
L_RAW_IND = 0x2D
L_DATA_CON = 0x2E
L_RAW_CON = 0x2F

# ------------------------------------------------------------ APCI services
APCI_GROUP_READ = 0x0000
APCI_GROUP_RESPONSE = 0x0040
APCI_GROUP_WRITE = 0x0080
APCI_IA_WRITE = 0x00C0
APCI_IA_READ = 0x0100
APCI_IA_RESPONSE = 0x0140
APCI_MEMORY_READ = 0x0200
APCI_MEMORY_RESPONSE = 0x0240
APCI_MEMORY_WRITE = 0x0280
APCI_DESCRIPTOR_READ = 0x0300
APCI_DESCRIPTOR_RESPONSE = 0x0340
APCI_RESTART = 0x0380
APCI_RESTART_MASTER = 0x0381
APCI_MEMORY_BIT_WRITE = 0x03D0
APCI_AUTHORIZE_REQUEST = 0x03D1
APCI_KEY_WRITE = 0x03D3
APCI_PROPERTY_VALUE_READ = 0x03D5
APCI_PROPERTY_VALUE_RESPONSE = 0x03D6
APCI_PROPERTY_VALUE_WRITE = 0x03D7
APCI_PROPERTY_DESCRIPTION_READ = 0x03D8
APCI_IA_SERIAL_READ = 0x03DC
APCI_IA_SERIAL_WRITE = 0x03DD
APCI_MEMORY_EXT_READ = 0x01FD
APCI_MEMORY_EXT_READ_RESPONSE = 0x01FE
APCI_MEMORY_EXT_WRITE = 0x01FB
APCI_MEMORY_EXT_WRITE_RESPONSE = 0x01FC

PRIORITY_LOW = 3
STANDARD_FRAME_MAX_NPDU = 15
MAX_NPDU = 254

IA_BROADCAST = 0x0000


# ---------------------------------------------------------------- addresses
def parse_ia(text: str) -> int:
    """'1.1.5' -> 0x1105."""
    parts = [int(p) for p in str(text).strip().split(".")]
    if len(parts) != 3:
        raise ValueError("individual address must be A.L.D: %r" % (text,))
    area, line, dev = parts
    if not (0 <= area <= 15 and 0 <= line <= 15 and 0 <= dev <= 255):
        raise ValueError("individual address out of range: %r" % (text,))
    return (area << 12) | (line << 8) | dev


def format_ia(value: int) -> str:
    return "%d.%d.%d" % ((value >> 12) & 0x0F, (value >> 8) & 0x0F, value & 0xFF)


def parse_ga(text: str) -> int:
    """'1/2/3' (3-level), '1/3' (2-level) or raw integer."""
    text = str(text).strip()
    if "/" in text:
        parts = [int(p) for p in text.split("/")]
        if len(parts) == 3:
            main, middle, sub = parts
            if not (0 <= main <= 31 and 0 <= middle <= 7 and 0 <= sub <= 255):
                raise ValueError("3-level group address out of range: %r" % (text,))
            return (main << 11) | (middle << 8) | sub
        if len(parts) == 2:
            main, sub = parts
            if not (0 <= main <= 31 and 0 <= sub <= 2047):
                raise ValueError("2-level group address out of range: %r" % (text,))
            return (main << 11) | sub
        raise ValueError("group address must be M/M/S, M/S or raw: %r" % (text,))
    value = int(text, 0)
    if not 0 <= value <= 0xFFFF:
        raise ValueError("group address out of range: %r" % (text,))
    return value


def format_ga(value: int) -> str:
    return "%d/%d/%d" % ((value >> 11) & 0x1F, (value >> 8) & 0x07, value & 0xFF)


# ------------------------------------------------------------------- APDUs
# APDU layout: octet0 = TPCI(6) | APCI[9:8], octet1 = APCI[7:0] with the low
# nibble replaced by the service's 4 bit parameter field where the service has
# one (memory services: element count; group value: 6 bit optimised value).
def _apdu(apci: int, second: int, rest: bytes = b"", tpci: int = 0x00) -> bytes:
    first = ((tpci & 0x3F) << 2) | ((apci >> 8) & 0x03)
    return bytes([first, second & 0xFF]) + bytes(rest)


def apdu_memory_read(address: int, count: int) -> bytes:
    if not 1 <= count <= 0x0F:
        raise ValueError("A_Memory_Read element count must be 1..15; use apdu_memory_ext_read above that")
    if not 0 <= address <= 0xFFFF:
        raise ValueError("A_Memory_Read address must be 16 bit")
    return _apdu(APCI_MEMORY_READ, (APCI_MEMORY_READ & 0xF0) | count,
                 bytes([address >> 8, address & 0xFF]))


def apdu_memory_write(address: int, data: bytes) -> bytes:
    data = bytes(data)
    if not 1 <= len(data) <= 0x0F:
        raise ValueError("A_Memory_Write element count must be 1..15; use apdu_memory_ext_write above that")
    if not 0 <= address <= 0xFFFF:
        raise ValueError("A_Memory_Write address must be 16 bit")
    return _apdu(APCI_MEMORY_WRITE, (APCI_MEMORY_WRITE & 0xF0) | len(data),
                 bytes([address >> 8, address & 0xFF]) + data)


def apdu_memory_response(address: int, data: bytes) -> bytes:
    data = bytes(data)
    return _apdu(APCI_MEMORY_RESPONSE, (APCI_MEMORY_RESPONSE & 0xF0) | len(data),
                 bytes([address >> 8, address & 0xFF]) + data)


def apdu_memory_ext_read(address: int, count: int) -> bytes:
    return _apdu(APCI_MEMORY_EXT_READ, 0x00,
                 bytes([(address >> 16) & 0xFF, (address >> 8) & 0xFF, address & 0xFF, count & 0xFF]))


def apdu_memory_ext_write(address: int, data: bytes) -> bytes:
    data = bytes(data)
    return _apdu(APCI_MEMORY_EXT_WRITE, 0x00,
                 bytes([(address >> 16) & 0xFF, (address >> 8) & 0xFF, address & 0xFF,
                        len(data) & 0xFF]) + data)


def apdu_group_read() -> bytes:
    return _apdu(APCI_GROUP_READ, 0x00)


def apdu_group_write(data: bytes) -> bytes:
    data = bytes(data)
    if len(data) == 1 and data[0] <= 0x3F:
        return _apdu(APCI_GROUP_WRITE, 0x80 | data[0])
    if len(data) == 1:
        return _apdu(APCI_GROUP_WRITE, 0x80, data)
    return _apdu(APCI_GROUP_WRITE, 0x00, data)


def apdu_group_response(data: bytes) -> bytes:
    data = bytes(data)
    if len(data) == 1 and data[0] <= 0x3F:
        return _apdu(APCI_GROUP_RESPONSE, 0x40 | data[0])
    return _apdu(APCI_GROUP_RESPONSE, 0x40, data)


def apdu_ia_write(ia: int) -> bytes:
    return _apdu(APCI_IA_WRITE, 0xC0, bytes([(ia >> 8) & 0xFF, ia & 0xFF]))


def apdu_ia_read() -> bytes:
    return _apdu(APCI_IA_READ, 0x00)


def apdu_restart(master: bool = False) -> bytes:
    return _apdu(APCI_RESTART_MASTER if master else APCI_RESTART, 0x81 if master else 0x80)


def apdu_descriptor_read(descriptor_type: int = 0) -> bytes:
    return _apdu(APCI_DESCRIPTOR_READ, 0x00, bytes([descriptor_type & 0x3F]))


def apdu_property_read(object_index: int, property_id: int, count: int = 1,
                       start_index: int = 1) -> bytes:
    if not 1 <= count <= 0x0F:
        raise ValueError("property element count must be 1..15")
    return _apdu(APCI_PROPERTY_VALUE_READ, 0xD5,
                 bytes([object_index & 0xFF, property_id & 0xFF,
                        ((count & 0x0F) << 4) | ((start_index >> 8) & 0x0F),
                        start_index & 0xFF]))


def apdu_property_write(object_index: int, property_id: int, data: bytes,
                        start_index: int = 1) -> bytes:
    data = bytes(data)
    return _apdu(APCI_PROPERTY_VALUE_WRITE, 0xD7,
                 bytes([object_index & 0xFF, property_id & 0xFF,
                        ((len(data) & 0x0F) << 4) | ((start_index >> 8) & 0x0F),
                        start_index & 0xFF]) + data)


def apdu_ia_serial_read() -> bytes:
    return _apdu(APCI_IA_SERIAL_READ, 0xDC)


# -------------------------------------------------------------- L_Data cEMI
def ldata(dst: int, apdu: bytes, group: bool, source: int = 0x0000,
          sys_broadcast: bool = False, ack_requested: bool = False) -> bytes:
    """Build a complete cEMI L_Data.req."""
    apdu = bytes(apdu)
    if not 1 <= len(apdu) <= MAX_NPDU:
        raise ValueError("NPDU length out of range")
    standard = len(apdu) <= STANDARD_FRAME_MAX_NPDU
    ctrl1 = (0x80 if standard else 0x00) | 0x20 | (0x00 if sys_broadcast else 0x10) \
        | (PRIORITY_LOW << 2) | (0x02 if ack_requested else 0x00)
    ctrl2 = 0x60 | (0x80 if group else 0x00)
    return bytes([
        L_DATA_REQ, 0x00, ctrl1, ctrl2,
        (source >> 8) & 0xFF, source & 0xFF,
        (dst >> 8) & 0xFF, dst & 0xFF,
        len(apdu) & 0xFF,
    ]) + apdu


def as_ind(frame: bytes) -> bytes:
    """Rewrite an L_Data.req as the L_Data.ind a data link layer would forward."""
    body = bytearray(frame)
    if body and body[0] == L_DATA_REQ:
        body[0] = L_DATA_IND
    return bytes(body)


def ldata_confirm(frame: Dict) -> bytes:
    """Build the L_Data.con a data link layer emits for a request."""
    apdu = bytes(frame.get("apdu") or b"")
    ctrl1 = (frame.get("ctrl1", 0xBC) & 0x7E) | 0x80 if len(apdu) <= STANDARD_FRAME_MAX_NPDU \
        else (frame.get("ctrl1", 0x3C) & 0x7E)
    ctrl2 = frame.get("ctrl2", 0x60)
    dst = frame.get("dst", 0)
    src = frame.get("src", 0)
    return bytes([L_DATA_CON, 0x00, ctrl1 & 0x7F | (0x80 if len(apdu) <= STANDARD_FRAME_MAX_NPDU else 0),
                  ctrl2, (src >> 8) & 0xFF, src & 0xFF,
                  (dst >> 8) & 0xFF, dst & 0xFF, len(apdu) & 0xFF]) + apdu


LISTEN_GROUP = 0x00
LISTEN_INDIVIDUAL = 0x01


def ldata_listen(dst: int, group: bool = True) -> bytes:
    """A listen-only L_Data.req used to request a device response (A_*_Read)."""
    return ldata(dst, apdu_group_read() if group else apdu_ia_read(), group)


# ---------------------------------------------------------------- parsing
def parse(data: bytes) -> Optional[Dict]:
    if not data:
        return None
    code = data[0]
    try:
        if code in (L_DATA_REQ, L_DATA_IND, L_DATA_CON):
            return _parse_ldata(bytes(data))
        if code == L_BUSMON_IND:
            frame = _parse_busmon(bytes(data))
            return {"code": code, "kind": "busmon", "frame": frame, "raw": bytes(data)}
        return {"code": code, "kind": "other", "raw": bytes(data)}
    except (IndexError, ValueError):
        return {"code": code, "kind": "error", "raw": bytes(data)}


def _parse_busmon(data: bytes) -> Optional[Dict]:
    if len(data) < 8:
        return None
    offset = 9 if (data[1] & 0x80) else 7
    try:
        return _parse_ldata(data[offset:])
    except (IndexError, ValueError):
        return None


def _parse_ldata(data: bytes) -> Dict:
    info_len = data[1]
    pos = 2 + info_len
    ctrl1, ctrl2 = data[pos], data[pos + 1]
    src = (data[pos + 2] << 8) | data[pos + 3]
    dst = (data[pos + 4] << 8) | data[pos + 5]
    length = data[pos + 6]
    apdu = bytes(data[pos + 7:pos + 7 + length])
    group = bool(ctrl2 & 0x80)
    out = {
        "code": data[0],
        "kind": "ldata",
        "ctrl1": ctrl1,
        "ctrl2": ctrl2,
        "src": src,
        "dst": dst,
        "src_ia": format_ia(src),
        "dst_text": format_ga(dst) if group else format_ia(dst),
        "group": group,
        "npdu_len": length,
        "apdu": apdu,
        "con_error": bool(ctrl1 & 0x01),
        "priority": (ctrl1 >> 2) & 0x03,
        "hop_count": (ctrl2 >> 4) & 0x07,
        "service": None,
        "value": None,
        "address": None,
        "raw": data,
    }
    out["service"] = _decode_service(apdu, out)
    return out


def _decode_service(apdu: bytes, out: Dict) -> Optional[str]:
    """Decode the APCI of an APDU.

    The APCI is 10 bit: octet0 bits 1..0 carry the high bits, octet1 all eight
    low bits. Services with a 4 bit parameter field (memory services: element
    count, group value: 6 bit optimised value) put that parameter in the low
    nibble of octet1, so they must be matched on a masked value; services
    without one (A_PropertyValue_*, A_IndividualAddressSerialNumber_*, A_Restart,
    descriptors) must be matched on the full value - masking those would turn
    A_PropertyValue_Write (0x03D7) into A_MemoryBit_Write (0x03D0).
    """
    if len(apdu) < 2:
        return None
    full = ((apdu[0] & 0x03) << 8) | apdu[1]
    masked = full & 0xFFF0
    payload = apdu[2:]

    exact = {
        APCI_IA_WRITE: "A_IndividualAddress_Write",
        APCI_IA_READ: "A_IndividualAddress_Read",
        APCI_IA_RESPONSE: "A_IndividualAddress_Response",
        APCI_DESCRIPTOR_READ: "A_DeviceDescriptor_Read",
        APCI_DESCRIPTOR_RESPONSE: "A_DeviceDescriptor_Response",
        APCI_RESTART: "A_Restart",
        APCI_RESTART_MASTER: "A_Restart",
        APCI_PROPERTY_VALUE_READ: "A_PropertyValue_Read",
        APCI_PROPERTY_VALUE_RESPONSE: "A_PropertyValue_Response",
        APCI_PROPERTY_VALUE_WRITE: "A_PropertyValue_Write",
        APCI_PROPERTY_DESCRIPTION_READ: "A_PropertyDescription_Read",
        APCI_IA_SERIAL_READ: "A_IndividualAddressSerialNumber_Read",
        APCI_IA_SERIAL_WRITE: "A_IndividualAddressSerialNumber_Write",
        APCI_MEMORY_EXT_READ: "A_MemoryExtended_Read",
        APCI_MEMORY_EXT_READ_RESPONSE: "A_MemoryExtended_Read_Response",
        APCI_MEMORY_EXT_WRITE: "A_MemoryExtended_Write",
        APCI_MEMORY_EXT_WRITE_RESPONSE: "A_MemoryExtended_Write_Response",
    }
    if full in exact and full not in (APCI_GROUP_READ,):
        name = exact[full]
        if full == APCI_IA_WRITE and len(payload) >= 2:
            out["address"] = (payload[0] << 8) | payload[1]
            out["value"] = out["address"]
        elif full == APCI_IA_READ:
            pass
        elif full == APCI_IA_RESPONSE and len(payload) >= 2:
            out["address"] = (payload[0] << 8) | payload[1]
        elif full == APCI_RESTART:
            out["master_reset"] = False
        elif full == APCI_RESTART_MASTER:
            out["master_reset"] = True
        elif full in (APCI_DESCRIPTOR_RESPONSE,) and len(payload) >= 2:
            out["value"] = payload[:2]
            out["descriptor"] = (payload[0] << 8) | payload[1]
        elif full in (APCI_PROPERTY_VALUE_READ, APCI_PROPERTY_VALUE_WRITE,
                      APCI_PROPERTY_VALUE_RESPONSE) and len(payload) >= 4:
            out["object_index"] = payload[0]
            out["property_id"] = payload[1]
            out["count"] = payload[2] >> 4
            out["start_index"] = ((payload[2] & 0x0F) << 8) | payload[3]
            if full == APCI_PROPERTY_VALUE_RESPONSE:
                out["value"] = payload[4:]
            elif full == APCI_PROPERTY_VALUE_WRITE:
                out["value"] = payload[4:]
        elif full in (APCI_IA_SERIAL_WRITE,):
            out["value"] = payload
        elif full in (APCI_MEMORY_EXT_READ, APCI_MEMORY_EXT_WRITE) and len(payload) >= 4:
            out["address"] = (payload[0] << 16) | (payload[1] << 8) | payload[2]
            out["count"] = payload[3]
            out["value"] = payload[4:4 + payload[3]]
        return name

    if masked == APCI_GROUP_READ:
        if not payload:
            return "A_GroupValue_Read"
        # multi-octet group value: APCI 0x0000 followed by the data octets
        out["value"] = payload
        out["small_form"] = False
        return "A_GroupValue_Write"
    if masked in (APCI_GROUP_WRITE, APCI_GROUP_RESPONSE):
        # 6 bit optimised form carries the value in apdu[1] and has no payload;
        # otherwise the data octets follow the APCI octet directly.
        small = not payload
        out["value"] = bytes([apdu[1] & 0x3F]) if small else payload
        out["small_form"] = small
        return "A_GroupValue_Write" if masked == APCI_GROUP_WRITE else "A_GroupValue_Response"
    if masked == APCI_MEMORY_READ:
        out["count"] = apdu[1] & 0x0F
        if len(payload) >= 2:
            out["address"] = (payload[0] << 8) | payload[1]
        return "A_Memory_Read"
    if masked in (APCI_MEMORY_WRITE, APCI_MEMORY_RESPONSE):
        count = apdu[1] & 0x0F
        out["count"] = count
        if len(payload) >= 2:
            out["address"] = (payload[0] << 8) | payload[1]
            out["value"] = payload[2:2 + count]
        return "A_Memory_Write" if masked == APCI_MEMORY_WRITE else "A_Memory_Response"
    if masked == APCI_MEMORY_BIT_WRITE:
        return "A_MemoryBit_Write"
    return "A_Unknown(0x%04X)" % full
