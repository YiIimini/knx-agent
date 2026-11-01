/**
 * Read an ETS project (.knxproj) and a manufacturer product database (.knxprod).
 *
 * Both are ZIP archives of XML. This module stays dependency free: a minimal
 * central-directory ZIP reader plus tolerant, namespace agnostic tag scanning.
 * It is deliberately not a schema validator - what it cannot find it reports as
 * missing, because a commissioning agent that invents a memory map writes to the
 * wrong address and bricks a parameter block.
 *
 * Known limitation, stated rather than hidden: communication objects are attached
 * to the device that precedes them in document order (which matches ETS 5/6
 * exports, where they are nested inside DeviceInstance, and most legacy exports
 * where they follow their device inside Line).
 */

import zlib from 'node:zlib';

const EOCD = 0x06054b50;

/** Minimal ZIP reader: central directory, stored (0) and deflate (8) entries. */
export function readZip(buffer) {
  const buf = Buffer.from(buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a ZIP archive (no end of central directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buf.subarray(start, start + compressedSize);
    let data;
    try {
      data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    } catch {
      continue; // encrypted or unsupported entry: skip, do not invent content
    }
    entries.push({ name, data });
  }
  return entries;
}

const TAG = (name) => new RegExp(`<(?:[\\w.-]+:)?${name}\\b([^>]*)>`, 'g');

function attrs(text) {
  const out = {};
  for (const match of String(text).matchAll(/([\w.:-]+)\s*=\s*"([^"]*)"/g)) out[match[1]] = match[2];
  return out;
}

function pick(attributes, ...names) {
  for (const name of names) if (attributes[name] !== undefined) return attributes[name];
  return undefined;
}

export function parseProject(buffer, { name = '' } = {}) {
  const entries = readZip(buffer);
  const xmlParts = entries.filter((entry) => entry.name.toLowerCase().endsWith('.xml'));
  const devices = new Map();
  const groupAddresses = new Map();
  const warnings = [];
  let order = [];

  for (const part of xmlParts) {
    const text = part.data.toString('utf8');
    // device order matters for attaching communication objects
    const devicePositions = [];
    for (const match of text.matchAll(TAG('DeviceInstance'))) {
      devicePositions.push({ index: match.index, attributes: attrs(match[1]) });
    }
    for (const { attributes } of devicePositions) {
      const id = pick(attributes, 'Id');
      if (!id) continue;
      const device = devices.get(id) ?? { id, comObjects: [] };
      const address = pick(attributes, 'Address');
      if (address !== undefined) device.ia = Number(address);
      device.name = pick(attributes, 'Name') ?? device.name ?? '';
      device.comment = pick(attributes, 'Comment') ?? device.comment ?? '';
      device.productRef = pick(attributes, 'ProductRefId') ?? device.productRef ?? '';
      device.applicationRef = pick(attributes, 'Hardware2ProgramRefId', 'ApplicationProgramRef')
        ?? device.applicationRef ?? '';
      devices.set(id, device);
    }
    for (const match of text.matchAll(TAG('ComObjectInstanceRef'))) {
      const attributes = attrs(match[1]);
      const owner = [...devicePositions].reverse().find((entry) => entry.index < match.index);
      const device = owner ? devices.get(pick(owner.attributes, 'Id')) : null;
      if (!device) continue;
      const links = (pick(attributes, 'Links') ?? '').split(/\s+/).filter(Boolean);
      device.comObjects.push({
        ref: pick(attributes, 'RefId') ?? '',
        text: pick(attributes, 'Text') ?? '',
        dpt: pick(attributes, 'DatapointType') ?? '',
        links,
      });
    }
    // Parameter values the device was commissioned with. The project is the only
    // public source for "what belongs in the parameter block", so a download
    // rebuilt from a project uses these instead of hand-entered values.
    for (const match of text.matchAll(TAG('ParameterInstanceRef'))) {
      const attributes = attrs(match[1]);
      const owner = [...devicePositions].reverse().find((entry) => entry.index < match.index);
      const device = owner ? devices.get(pick(owner.attributes, 'Id')) : null;
      const refId = pick(attributes, 'RefId');
      if (!device || !refId) continue;
      device.parameterValues = device.parameterValues ?? {};
      device.parameterValues[refId] = pick(attributes, 'Value') ?? '';
    }

    for (const match of text.matchAll(TAG('GroupAddress'))) {
      const attributes = attrs(match[1]);
      const address = pick(attributes, 'Address');
      const id = pick(attributes, 'Id') ?? `${part.name}:${match.index}`;
      if (address === undefined) continue;
      groupAddresses.set(id, {
        id,
        number: Number(address),
        name: pick(attributes, 'Name') ?? '',
        dpt: pick(attributes, 'DatapointType') ?? '',
      });
    }
    for (const match of text.matchAll(TAG('ApplicationProgram'))) {
      const attributes = attrs(match[1]);
      order.push({
        id: pick(attributes, 'Id') ?? '',
        name: pick(attributes, 'Name') ?? '',
        mask: pick(attributes, 'MaskVersion') ?? '',
        parameters: [...text.matchAll(TAG('Parameter'))].map((p) => {
          const a = attrs(p[1]);
          return {
            id: pick(a, 'Id') ?? '',
            name: pick(a, 'Name') ?? '',
            type: pick(a, 'ParameterType') ?? '',
            offset: pick(a, 'Offset') ?? '',
            bit: pick(a, 'BitOffset') ?? '',
          };
        }),
        segments: [...text.matchAll(TAG('(?:CodeSegment|AbsoluteSegment|Static)'))].map((s) => {
          const a = attrs(s[1]);
          return { address: pick(a, 'Address') ?? '', size: pick(a, 'Size') ?? '', name: pick(a, 'Name') ?? '' };
        }),
      });
    }
  }

  const byUid = groupAddresses;
  const deviceList = [...devices.values()].map((device) => ({
    ...device,
    iaText: device.ia === undefined ? '' : `${(device.ia >> 12) & 0x0f}.${(device.ia >> 8) & 0x0f}.${device.ia & 0xff}`,
    comObjects: device.comObjects.map((object) => ({
      ...object,
      groupAddresses: object.links
        .map((link) => byUid.get(link))
        .filter(Boolean)
        .map((ga) => `${(ga.number >> 11) & 0x1f}/${(ga.number >> 8) & 0x07}/${ga.number & 0xff}`),
    })),
  })).sort((a, b) => (a.ia ?? 0xffff) - (b.ia ?? 0xffff));

  if (!deviceList.length && !groupAddresses.size) {
    warnings.push('no DeviceInstance or GroupAddress element found; the archive may be encrypted or not an ETS project');
  }

  return {
    name: name || 'project',
    summary: {
      devices: deviceList.length,
      devicesWithAddress: deviceList.filter((d) => d.ia !== undefined).length,
      groupAddresses: groupAddresses.size,
      comObjects: deviceList.reduce((sum, d) => sum + d.comObjects.length, 0),
      applications: order.length,
      parts: xmlParts.length,
      warnings,
    },
    applications: order,
    devices: deviceList,
    groupAddresses: [...groupAddresses.values()].sort((a, b) => a.number - b.number),
  };
}

export function parseProductDatabase(buffer) {
  const project = parseProject(buffer, { name: 'knxprod' });
  return {
    summary: {
      ...project.summary,
      applications: project.applications.length,
    },
    applications: project.applications,
    devices: project.devices,
  };
}
