"""KNX data point type codec (the subset a commissioning agent needs).

Only the types that appear in acceptance tests and read-back verification:
DPT1 (bool), DPT5 (8 bit unsigned), DPT9 (2 octet float), DPT12/13 (32 bit),
DPT14 (4 octet float), DPT16/DPT20 as raw.
"""

from __future__ import annotations

import struct
from typing import Tuple


def encode(dpt: str, value) -> bytes:
    dpt = dpt.strip()
    main = int(dpt.split(".")[0])
    if main == 1:
        if isinstance(value, str):
            return bytes([1 if value.strip().lower() in ("1", "true", "on", "yes") else 0])
        return bytes([1 if value else 0])
    if main == 5:
        return bytes([int(round(float(value))) & 0xFF])
    if main in (6, 8):
        return struct.pack(">b", int(value))
    if main == 7:
        return struct.pack(">H", int(value) & 0xFFFF)
    if main == 9:
        return _encode_dpt9(float(value))
    if main in (12, 13):
        return struct.pack(">I", int(value) & 0xFFFFFFFF)
    if main == 14:
        return struct.pack(">f", float(value))
    if main in (16, 20):
        if isinstance(value, (bytes, bytearray)):
            return bytes(value)
        return bytes.fromhex(str(value))
    raise ValueError("unsupported DPT %r" % (dpt,))


def decode(dpt: str, data: bytes):
    dpt = dpt.strip()
    main = int(dpt.split(".")[0])
    if main == 1:
        return bool(data and data[0] & 0x01)
    if main == 5:
        return data[0]
    if main in (6, 8):
        return struct.unpack(">b", data[:1])[0]
    if main == 7:
        return struct.unpack(">H", data[:2])[0]
    if main == 9:
        return _decode_dpt9(data)
    if main in (12, 13):
        return struct.unpack(">I", data[:4])[0]
    if main == 14:
        return struct.unpack(">f", data[:4])[0]
    if main in (16, 20):
        return data.hex()
    return data.hex()


def _encode_dpt9(value: float) -> bytes:
    mantissa = int(round(value * 100))
    exponent = 0
    while mantissa < -2048 or mantissa > 2047:
        mantissa = int(round(mantissa / 2.0))
        exponent += 1
        if exponent > 15:
            raise ValueError("DPT9 value out of range")
    sign = 0x8000 if mantissa < 0 else 0
    return struct.pack(">H", sign | ((exponent & 0x0F) << 11) | (mantissa & 0x07FF))


def _decode_dpt9(data: bytes) -> float:
    raw = struct.unpack(">H", data[:2])[0]
    exponent = (raw >> 11) & 0x0F
    mantissa = raw & 0x07FF
    if raw & 0x8000:
        mantissa -= 2048
    return (mantissa << exponent) / 100.0


def describe(dpt: str) -> Tuple[str, str]:
    """Short human label used in reports."""
    dpt = dpt.strip()
    known = {
        "1": ("DPT1", "boolean / switch"),
        "5": ("DPT5", "8 bit unsigned (%, scene, 0..255)"),
        "9": ("DPT9", "2 octet float (temperature, lux)"),
        "7": ("DPT7", "2 octet unsigned (time period)"),
        "12": ("DPT12", "4 octet unsigned"),
        "13": ("DPT13", "4 octet signed"),
        "14": ("DPT14", "4 octet IEEE float"),
        "16": ("DPT16", "14 octet string"),
    }
    return known.get(dpt.split(".")[0], ("DPT?", "raw"))
