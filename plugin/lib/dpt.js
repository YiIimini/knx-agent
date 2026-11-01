/** KNX data point types: the subset that appears in commissioning and acceptance. */

export function encode(dpt, value) {
  const main = Number(String(dpt).split('.')[0]);
  switch (main) {
    case 2: {
      // 2 bit: control + value
      const bits = typeof value === 'number' ? value & 0x03
        : ((value?.control ? 0x02 : 0) | (value?.value ? 0x01 : 0));
      return Buffer.from([bits]);
    }
    case 3: {
      // 4 bit dimming/step control: direction (bit 3) + step code (bits 2..0)
      let raw;
      if (typeof value === 'number') raw = value & 0x0f;
      else if (typeof value === 'string') raw = Number.parseInt(value, 0) & 0x0f;
      else raw = ((value?.direction === 'down' ? 0x08 : 0) | ((Number(value?.step) || 0) & 0x07));
      return Buffer.from([raw]);
    }
    case 4:
      return Buffer.from([String(value).charCodeAt(0) & 0xff]);
    case 10: {
      const time = typeof value === 'string'
        ? { day: 0, hour: Number(value.split(':')[0]), minute: Number(value.split(':')[1]), second: Number(value.split(':')[2] ?? 0) }
        : { day: value?.day ?? 0, hour: value?.hour ?? 0, minute: value?.minute ?? 0, second: value?.second ?? 0 };
      return Buffer.from([((time.day & 0x07) << 5) | (time.hour & 0x1f), time.minute & 0x3f, time.second & 0x3f]);
    }
    case 11: {
      const date = typeof value === 'string'
        ? (([year, month, day]) => ({ year: Number(year), month: Number(month), day: Number(day) }))(value.split('-'))
        : { day: value?.day ?? 1, month: value?.month ?? 1, year: value?.year ?? 2000 };
      return Buffer.from([date.day & 0x1f, date.month & 0x0f, date.year % 100]);
    }
    case 1: {
      if (typeof value === 'string') {
        return Buffer.from([['1', 'true', 'on', 'yes'].includes(value.trim().toLowerCase()) ? 1 : 0]);
      }
      return Buffer.from([value ? 1 : 0]);
    }
    case 5:
      return Buffer.from([Math.round(Number(value)) & 0xff]);
    case 6:
    case 8: {
      const buf = Buffer.alloc(1);
      buf.writeInt8(Math.trunc(Number(value)), 0);
      return buf;
    }
    case 7: {
      const buf = Buffer.alloc(2);
      buf.writeUInt16BE(Math.trunc(Number(value)) & 0xffff, 0);
      return buf;
    }
    case 9:
      return encodeDpt9(Number(value));
    case 12:
    case 13: {
      const buf = Buffer.alloc(4);
      buf.writeUInt32BE(Math.trunc(Number(value)) >>> 0, 0);
      return buf;
    }
    case 14: {
      const buf = Buffer.alloc(4);
      buf.writeFloatBE(Number(value), 0);
      return buf;
    }
    case 16:
    case 20: {
      if (Buffer.isBuffer(value)) return value;
      return Buffer.from(String(value), 'hex');
    }
    default:
      throw new Error(`unsupported DPT ${dpt}`);
  }
}

export function decode(dpt, data) {
  const buf = Buffer.from(data ?? []);
  const main = Number(String(dpt).split('.')[0]);
  switch (main) {
    case 2: return { control: Boolean(buf[0] & 0x02), value: Boolean(buf[0] & 0x01), raw: buf[0] };
    case 3: return { direction: buf[0] & 0x08 ? 'down' : 'up', step: buf[0] & 0x07, raw: buf[0] };
    case 4: return String.fromCharCode(buf[0]);
    case 10: return {
      day: (buf[0] >> 5) & 0x07,
      hour: buf[0] & 0x1f,
      minute: buf[1] & 0x3f,
      second: buf[2] & 0x3f,
      text: `${String(buf[0] & 0x1f).padStart(2, '0')}:${String(buf[1] & 0x3f).padStart(2, '0')}:${String(buf[2] & 0x3f).padStart(2, '0')}`,
    };
    case 11: return {
      day: buf[0] & 0x1f,
      month: buf[1] & 0x0f,
      year: 2000 + buf[2],
      text: `${2000 + buf[2]}-${String(buf[1] & 0x0f).padStart(2, '0')}-${String(buf[0] & 0x1f).padStart(2, '0')}`,
    };
    case 1: return Boolean(buf.length && buf[0] & 0x01);
    case 5: return buf[0];
    case 6:
    case 8: return buf.readInt8(0);
    case 7: return buf.readUInt16BE(0);
    case 9: return decodeDpt9(buf);
    case 12:
    case 13: return buf.readUInt32BE(0);
    case 14: return buf.readFloatBE(0);
    default: return buf.toString('hex');
  }
}

export function encodeDpt9(value) {
  let mantissa = Math.round(value * 100);
  let exponent = 0;
  while (mantissa < -2048 || mantissa > 2047) {
    mantissa = Math.round(mantissa / 2);
    exponent += 1;
    if (exponent > 15) throw new Error('DPT9 value out of range');
  }
  const sign = mantissa < 0 ? 0x8000 : 0;
  const raw = sign | ((exponent & 0x0f) << 11) | (mantissa & 0x07ff);
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(raw, 0);
  return buf;
}

export function decodeDpt9(data) {
  const buf = Buffer.from(data);
  const raw = buf.readUInt16BE(0);
  const exponent = (raw >> 11) & 0x0f;
  let mantissa = raw & 0x07ff;
  if (raw & 0x8000) mantissa -= 2048;
  return (mantissa * 2 ** exponent) / 100;
}

export function describe(dpt) {
  const known = {
    1: 'boolean / switch',
    2: '1 bit controlled (control + value)',
    3: '4 bit dimming / step control',
    4: '1 octet character',
    10: 'time of day (3 octets)',
    11: 'date (3 octets)',
    5: '8 bit unsigned',
    6: '8 bit signed',
    7: '2 octet unsigned',
    9: '2 octet float',
    12: '4 octet unsigned',
    13: '4 octet signed',
    14: '4 octet IEEE float',
    16: '14 octet string',
  };
  return known[Number(String(dpt).split('.')[0])] ?? 'raw';
}
