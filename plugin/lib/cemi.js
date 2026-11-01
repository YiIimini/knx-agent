/**
 * cEMI codec for KNX (KNX 3/6/3 EMI, 3/5/x application layer services).
 *
 * Byte-for-byte port of the verified Python implementation (`knxagent/cemi.py`),
 * including the two traps that cost real debugging time:
 *   1. the APCI is 10 bit and services with a 4 bit parameter field (memory
 *      services: element count, group value: 6 bit form) must be matched on a
 *      masked value, while property/IA/restart services must be matched on the
 *      full value - masking those turns A_PropertyValue_Write (0x03D7) into
 *      A_MemoryBit_Write (0x03D0);
 *   2. an NPDU longer than 15 octets needs an L_Data_Extended frame (Ctrl1 bit 7
 *      clear), which every multi-block download hits.
 */

export const L_RAW_REQ = 0x10;
export const L_DATA_REQ = 0x11;
export const L_POLL_DATA_REQ = 0x13;
export const L_DATA_IND = 0x29;
export const L_BUSMON_IND = 0x2b;
export const L_DATA_CON = 0x2e;

export const APCI_GROUP_READ = 0x0000;
export const APCI_GROUP_RESPONSE = 0x0040;
export const APCI_GROUP_WRITE = 0x0080;
export const APCI_IA_WRITE = 0x00c0;
export const APCI_IA_READ = 0x0100;
export const APCI_IA_RESPONSE = 0x0140;
export const APCI_MEMORY_READ = 0x0200;
export const APCI_MEMORY_RESPONSE = 0x0240;
export const APCI_MEMORY_WRITE = 0x0280;
export const APCI_DESCRIPTOR_READ = 0x0300;
export const APCI_DESCRIPTOR_RESPONSE = 0x0340;
export const APCI_RESTART = 0x0380;
export const APCI_RESTART_MASTER = 0x0381;
export const APCI_MEMORY_BIT_WRITE = 0x03d0;
export const APCI_PROPERTY_VALUE_READ = 0x03d5;
export const APCI_PROPERTY_VALUE_RESPONSE = 0x03d6;
export const APCI_PROPERTY_VALUE_WRITE = 0x03d7;
export const APCI_PROPERTY_DESCRIPTION_READ = 0x03d8;
export const APCI_IA_SERIAL_READ = 0x03dc;
export const APCI_IA_SERIAL_WRITE = 0x03dd;
export const APCI_MEMORY_EXT_READ = 0x01fd;
export const APCI_MEMORY_EXT_READ_RESPONSE = 0x01fe;
export const APCI_MEMORY_EXT_WRITE = 0x01fb;
export const APCI_MEMORY_EXT_WRITE_RESPONSE = 0x01fc;

export const STANDARD_FRAME_MAX_NPDU = 15;
export const MAX_NPDU = 254;
export const IA_BROADCAST = 0x0000;

/** '1.1.5' -> 0x1105 */
export function parseIA(text) {
  const parts = String(text).trim().split('.');
  if (parts.length !== 3) throw new Error(`individual address must be A.L.D, got ${JSON.stringify(text)}`);
  const [area, line, device] = parts.map((p) => Number(p));
  for (const value of [area, line, device]) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`invalid individual address ${JSON.stringify(text)}`);
  }
  if (area > 15 || line > 15 || device > 255) throw new Error(`individual address out of range: ${text}`);
  return (area << 12) | (line << 8) | device;
}

export function formatIA(value) {
  return `${(value >> 12) & 0x0f}.${(value >> 8) & 0x0f}.${value & 0xff}`;
}

/** '1/2/3', '1/3' or a raw integer -> 16 bit group address */
export function parseGA(text) {
  const raw = String(text).trim();
  if (raw.includes('/')) {
    const parts = raw.split('/').map((p) => Number(p));
    if (parts.length === 3) {
      const [main, middle, sub] = parts;
      if (!(main >= 0 && main <= 31 && middle >= 0 && middle <= 7 && sub >= 0 && sub <= 255)) {
        throw new Error(`3-level group address out of range: ${raw}`);
      }
      return (main << 11) | (middle << 8) | sub;
    }
    if (parts.length === 2) {
      const [main, sub] = parts;
      if (!(main >= 0 && main <= 31 && sub >= 0 && sub <= 2047)) {
        throw new Error(`2-level group address out of range: ${raw}`);
      }
      return (main << 11) | sub;
    }
    throw new Error(`group address must be M/M/S, M/S or raw: ${raw}`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error(`group address out of range: ${raw}`);
  return value;
}

export function formatGA(value) {
  return `${(value >> 11) & 0x1f}/${(value >> 8) & 0x07}/${value & 0xff}`;
}

/** Build a raw APDU from an APCI value, its second octet and the payload octets. */
export function apdu(apci, second, rest = [], tpci = 0x00) {
  return Buffer.concat([
    Buffer.from([((tpci & 0x3f) << 2) | ((apci >> 8) & 0x03), second & 0xff]),
    Buffer.from(rest),
  ]);
}

export function apduMemoryRead(address, count) {
  if (!(count >= 1 && count <= 15)) throw new Error('A_Memory_Read count must be 1..15; use the extended service above that');
  assert16(address, 'A_Memory_Read address');
  return apdu(APCI_MEMORY_READ, (APCI_MEMORY_READ & 0xf0) | count, [address >> 8, address & 0xff]);
}

export function apduMemoryWrite(address, data) {
  if (!(data.length >= 1 && data.length <= 15)) throw new Error('A_Memory_Write count must be 1..15; use the extended service above that');
  assert16(address, 'A_Memory_Write address');
  return apdu(APCI_MEMORY_WRITE, (APCI_MEMORY_WRITE & 0xf0) | data.length,
    [address >> 8, address & 0xff, ...data]);
}

export function apduMemoryResponse(address, data) {
  return apdu(APCI_MEMORY_RESPONSE, (APCI_MEMORY_RESPONSE & 0xf0) | data.length,
    [address >> 8, address & 0xff, ...data]);
}

export function apduMemoryExtRead(address, count) {
  return apdu(APCI_MEMORY_EXT_READ, 0x00, [(address >> 16) & 0xff, (address >> 8) & 0xff, address & 0xff, count & 0xff]);
}

export function apduMemoryExtWrite(address, data) {
  return apdu(APCI_MEMORY_EXT_WRITE, 0x00,
    [(address >> 16) & 0xff, (address >> 8) & 0xff, address & 0xff, data.length & 0xff, ...data]);
}

export function apduGroupRead() {
  return apdu(APCI_GROUP_READ, 0x00);
}

export function apduGroupWrite(data) {
  if (data.length === 1 && data[0] <= 0x3f) return apdu(APCI_GROUP_WRITE, 0x80 | data[0]);
  if (data.length === 1) return apdu(APCI_GROUP_WRITE, 0x80, [data[0]]);
  return apdu(APCI_GROUP_WRITE, 0x00, [...data]);
}

export function apduGroupResponse(data) {
  if (data.length === 1 && data[0] <= 0x3f) return apdu(APCI_GROUP_RESPONSE, 0x40 | data[0]);
  return apdu(APCI_GROUP_RESPONSE, 0x40, [...data]);
}

export function apduIAWrite(ia) {
  return apdu(APCI_IA_WRITE, 0xc0, [(ia >> 8) & 0xff, ia & 0xff]);
}

export function apduIARead() {
  return apdu(APCI_IA_READ, 0x00);
}

export function apduRestart(master = false) {
  return apdu(master ? APCI_RESTART_MASTER : APCI_RESTART, master ? 0x81 : 0x80);
}

export function apduDescriptorRead(type = 0) {
  return apdu(APCI_DESCRIPTOR_READ, 0x00, [type & 0x3f]);
}

export function apduPropertyRead(objectIndex, propertyId, count = 1, startIndex = 1) {
  if (!(count >= 1 && count <= 15)) throw new Error('property element count must be 1..15');
  return apdu(APCI_PROPERTY_VALUE_READ, 0xd5,
    [objectIndex & 0xff, propertyId & 0xff, ((count & 0x0f) << 4) | ((startIndex >> 8) & 0x0f), startIndex & 0xff]);
}

/**
 * A_PropertyValue_Write. The high nibble of the third octet is the number of
 * ELEMENTS written, not the number of octets - a 4 octet single-element property
 * must declare count 1 or a device will reject the write as out of range.
 */
export function apduPropertyWrite(objectIndex, propertyId, data, startIndex = 1, count = 1) {
  if (!(count >= 1 && count <= 0x0f)) throw new Error('property element count must be 1..15');
  return apdu(APCI_PROPERTY_VALUE_WRITE, 0xd7,
    [objectIndex & 0xff, propertyId & 0xff, ((count & 0x0f) << 4) | ((startIndex >> 8) & 0x0f),
      startIndex & 0xff, ...data]);
}

export function apduIASerialRead() {
  return apdu(APCI_IA_SERIAL_READ, 0xdc);
}

function assert16(value, what) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error(`${what} must be 16 bit, got ${value}`);
}

/** Build a complete cEMI L_Data.req. Control octets match what ETS emits. */
export function ldata(dst, apduBytes, group, { source = 0x0000, sysBroadcast = false, ackRequested = false } = {}) {
  const body = Buffer.from(apduBytes);
  if (!(body.length >= 1 && body.length <= MAX_NPDU)) throw new Error('NPDU length out of range');
  const standard = body.length <= STANDARD_FRAME_MAX_NPDU;
  const ctrl1 = (standard ? 0x80 : 0x00) | 0x20 | (sysBroadcast ? 0x00 : 0x10) | (3 << 2) | (ackRequested ? 0x02 : 0x00);
  const ctrl2 = 0x60 | (group ? 0x80 : 0x00);
  return Buffer.concat([Buffer.from([
    L_DATA_REQ, 0x00, ctrl1, ctrl2,
    (source >> 8) & 0xff, source & 0xff,
    (dst >> 8) & 0xff, dst & 0xff,
    body.length,
  ]), body]);
}

/** Rewrite an L_Data.req as the L_Data.ind a data link layer forwards. */
export function asInd(frame) {
  const out = Buffer.from(frame);
  if (out.length && out[0] === L_DATA_REQ) out[0] = L_DATA_IND;
  return out;
}

/** Build the L_Data.con a data link layer emits for a request. */
export function ldataConfirm(frame) {
  const body = frame.apdu ?? Buffer.alloc(0);
  const standard = body.length <= STANDARD_FRAME_MAX_NPDU;
  const ctrl1 = (standard ? 0x80 : 0x00) | 0x20 | 0x10 | (3 << 2) | (frame.conError ? 0x01 : 0x00);
  const ctrl2 = 0x60 | (frame.group ? 0x80 : 0x00);
  return Buffer.concat([Buffer.from([
    L_DATA_CON, 0x00, ctrl1, ctrl2,
    (frame.src >> 8) & 0xff, frame.src & 0xff,
    (frame.dst >> 8) & 0xff, frame.dst & 0xff,
    body.length,
  ]), body]);
}

export function parse(data) {
  if (!data || !data.length) return null;
  const buf = Buffer.from(data);
  const code = buf[0];
  try {
    if (code === L_DATA_REQ || code === L_DATA_IND || code === L_DATA_CON) return parseLData(buf);
    if (code === L_BUSMON_IND) {
      const frame = parseBusmon(buf);
      return { code, kind: 'busmon', frame, raw: buf };
    }
    return { code, kind: 'other', raw: buf };
  } catch {
    return { code, kind: 'error', raw: buf };
  }
}

function parseBusmon(buf) {
  if (buf.length < 8) return null;
  const offset = buf[1] & 0x80 ? 9 : 7;
  try {
    return parseLData(buf.subarray(offset));
  } catch {
    return null;
  }
}

function parseLData(buf) {
  const infoLen = buf[1];
  const pos = 2 + infoLen;
  const ctrl1 = buf[pos];
  const ctrl2 = buf[pos + 1];
  const src = (buf[pos + 2] << 8) | buf[pos + 3];
  const dst = (buf[pos + 4] << 8) | buf[pos + 5];
  const length = buf[pos + 6];
  const apduBytes = buf.subarray(pos + 7, pos + 7 + length);
  const group = Boolean(ctrl2 & 0x80);
  const out = {
    code: buf[0],
    kind: 'ldata',
    ctrl1,
    ctrl2,
    src,
    dst,
    srcIA: formatIA(src),
    dstText: group ? formatGA(dst) : formatIA(dst),
    group,
    npduLen: length,
    apdu: Buffer.from(apduBytes),
    conError: Boolean(ctrl1 & 0x01),
    priority: (ctrl1 >> 2) & 0x03,
    hopCount: (ctrl2 >> 4) & 0x07,
    service: null,
    value: null,
    address: null,
    raw: buf,
  };
  out.service = decodeService(apduBytes, out);
  return out;
}

function decodeService(apduBytes, out) {
  if (apduBytes.length < 2) return null;
  const full = ((apduBytes[0] & 0x03) << 8) | apduBytes[1];
  const masked = full & 0xfff0;
  const payload = apduBytes.subarray(2);

  const exact = new Map([
    [APCI_IA_WRITE, 'A_IndividualAddress_Write'],
    [APCI_IA_READ, 'A_IndividualAddress_Read'],
    [APCI_IA_RESPONSE, 'A_IndividualAddress_Response'],
    [APCI_DESCRIPTOR_READ, 'A_DeviceDescriptor_Read'],
    [APCI_DESCRIPTOR_RESPONSE, 'A_DeviceDescriptor_Response'],
    [APCI_RESTART, 'A_Restart'],
    [APCI_RESTART_MASTER, 'A_Restart'],
    [APCI_PROPERTY_VALUE_READ, 'A_PropertyValue_Read'],
    [APCI_PROPERTY_VALUE_RESPONSE, 'A_PropertyValue_Response'],
    [APCI_PROPERTY_VALUE_WRITE, 'A_PropertyValue_Write'],
    [APCI_PROPERTY_DESCRIPTION_READ, 'A_PropertyDescription_Read'],
    [APCI_IA_SERIAL_READ, 'A_IndividualAddressSerialNumber_Read'],
    [APCI_IA_SERIAL_WRITE, 'A_IndividualAddressSerialNumber_Write'],
    [APCI_MEMORY_EXT_READ, 'A_MemoryExtended_Read'],
    [APCI_MEMORY_EXT_READ_RESPONSE, 'A_MemoryExtended_Read_Response'],
    [APCI_MEMORY_EXT_WRITE, 'A_MemoryExtended_Write'],
    [APCI_MEMORY_EXT_WRITE_RESPONSE, 'A_MemoryExtended_Write_Response'],
  ]);

  if (exact.has(full)) {
    const name = exact.get(full);
    if (full === APCI_IA_WRITE && payload.length >= 2) {
      out.address = (payload[0] << 8) | payload[1];
      out.value = out.address;
    } else if (full === APCI_IA_RESPONSE && payload.length >= 2) {
      out.address = (payload[0] << 8) | payload[1];
    } else if (full === APCI_RESTART) {
      out.masterReset = false;
    } else if (full === APCI_RESTART_MASTER) {
      out.masterReset = true;
    } else if (full === APCI_DESCRIPTOR_RESPONSE && payload.length >= 2) {
      out.descriptor = (payload[0] << 8) | payload[1];
      out.value = Buffer.from(payload.subarray(0, 2));
    } else if ((full === APCI_PROPERTY_VALUE_READ || full === APCI_PROPERTY_VALUE_WRITE
      || full === APCI_PROPERTY_VALUE_RESPONSE) && payload.length >= 4) {
      out.objectIndex = payload[0];
      out.propertyId = payload[1];
      out.count = payload[2] >> 4;
      out.startIndex = ((payload[2] & 0x0f) << 8) | payload[3];
      if (full !== APCI_PROPERTY_VALUE_READ) out.value = Buffer.from(payload.subarray(4));
    } else if (full === APCI_IA_SERIAL_WRITE) {
      out.value = Buffer.from(payload);
    } else if (full === APCI_MEMORY_EXT_READ || full === APCI_MEMORY_EXT_WRITE) {
      if (payload.length >= 4) {
        out.address = (payload[0] << 16) | (payload[1] << 8) | payload[2];
        out.count = payload[3];
        out.value = Buffer.from(payload.subarray(4, 4 + payload[3]));
      }
    }
    return name;
  }

  if (masked === APCI_GROUP_READ) {
    if (!payload.length) return 'A_GroupValue_Read';
    out.value = Buffer.from(payload);
    out.smallForm = false;
    return 'A_GroupValue_Write';
  }
  if (masked === APCI_GROUP_WRITE || masked === APCI_GROUP_RESPONSE) {
    const small = !payload.length;
    out.value = small ? Buffer.from([apduBytes[1] & 0x3f]) : Buffer.from(payload);
    out.smallForm = small;
    return masked === APCI_GROUP_WRITE ? 'A_GroupValue_Write' : 'A_GroupValue_Response';
  }
  if (masked === APCI_MEMORY_READ) {
    out.count = apduBytes[1] & 0x0f;
    if (payload.length >= 2) out.address = (payload[0] << 8) | payload[1];
    return 'A_Memory_Read';
  }
  if (masked === APCI_MEMORY_WRITE || masked === APCI_MEMORY_RESPONSE) {
    const count = apduBytes[1] & 0x0f;
    out.count = count;
    if (payload.length >= 2) {
      out.address = (payload[0] << 8) | payload[1];
      out.value = Buffer.from(payload.subarray(2, 2 + count));
    }
    return masked === APCI_MEMORY_WRITE ? 'A_Memory_Write' : 'A_Memory_Response';
  }
  if (masked === APCI_MEMORY_BIT_WRITE) return 'A_MemoryBit_Write';
  return `A_Unknown(0x${full.toString(16).toUpperCase().padStart(4, '0')})`;
}

/** Human readable one-line summary used in reports and tool output. */
export function describeFrame(frame) {
  if (!frame || frame.kind !== 'ldata') return String(frame?.kind ?? 'unknown');
  const value = frame.value ? Buffer.from(frame.value).toString('hex') : '';
  return `${frame.srcIA} -> ${frame.dstText} ${frame.service ?? '?'}${value ? ` ${value}` : ''}`;
}
