/**
 * Group address table and association table: the part of a device that decides
 * which telegrams it answers at all.
 *
 * Model (confirmed against a real stack implementation, thelsing/knx):
 *   - AddressTableObject keeps `uint16_t[] groupAddresses`; the TSAP is the
 *     1-based index into that array.
 *   - AssociationTableObject keeps `uint16_t[]` read as (TSAP, ASAP) pairs,
 *     sorted by TSAP because lookup is a binary search. ASAP is the
 *     communication object number inside the device.
 *   - TableObject is "configured by ETS with MemoryWrite": both tables are
 *     written as plain memory writes at an address the *device* owns, which is
 *     why a table download always shows up as A_Memory_Write traffic.
 *
 * What that means for us: the entry format is simple and deterministic, but the
 * base addresses are device/firmware specific. They are therefore never assumed:
 * a profile supplies them, either from the product's own data or - the reliable
 * way - inferred from one recorded ETS "download group addresses" pass.
 */

import * as cemi from './cemi.js';

export const PROFILE_SCHEMA = 'knxagent.grouptable/1';

/** Default System B shape: 2 octet entries, GA 0xFFFF marks an unused slot. */
export const SYSTEM_B = {
  schema: PROFILE_SCHEMA,
  name: 'system-b',
  entrySize: 2,
  unusedEntry: 0xffff,
  leadingUnused: true, // TSAP 0 is not a valid group address slot
  associationEntrySize: 4,
  padByte: 0xff,
};

function gaNumber(groupAddresses, id) {
  const entry = groupAddresses.find((ga) => ga.id === id) ?? groupAddresses.find((ga) => ga.uid === id);
  return entry ? entry.number : null;
}

/**
 * Build the logical tables for one device from a project device plus the
 * application program that supplies object numbers (ASAPs).
 * @param device - project device: {iaText, name, comObjects: [{ref, links:[gaId]}]}
 * @param application - product application: {comObjects: [{id, number}]}
 * @param groupAddresses - project group addresses: [{id, number}]
 */
export function buildTables(device, application, groupAddresses) {
  const asapByRef = new Map((application?.comObjects ?? []).map((object) => [object.id, object.number]));
  const links = [];
  const unknownObjects = [];
  for (const object of device?.comObjects ?? []) {
    const asap = asapByRef.get(object.ref);
    if (!asap) {
      unknownObjects.push(object.ref);
      continue;
    }
    for (const gaId of object.links ?? []) {
      const number = gaNumber(groupAddresses, gaId);
      if (number === null) continue;
      links.push({ ga: number, asap });
    }
  }

  // Deterministic order: group addresses ascending, then by object. TSAP is the
  // 1-based position, so a stable order is what makes a table reproducible.
  const addresses = [...new Set(links.map((link) => link.ga))].sort((a, b) => a - b);
  const tsap = new Map(addresses.map((ga, index) => [ga, index + 1]));
  const associations = links
    .map((link) => ({ tsap: tsap.get(link.ga), asap: link.asap, ga: link.ga }))
    .sort((a, b) => (a.tsap - b.tsap) || (a.asap - b.asap));
  const seen = new Set();
  const uniqueAssociations = associations.filter((entry) => {
    const key = `${entry.tsap}:${entry.asap}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    device: { ia: device?.iaText ?? null, name: device?.name ?? null },
    addresses,
    associations: uniqueAssociations,
    counts: {
      groupAddresses: addresses.length,
      associations: uniqueAssociations.length,
      communicationObjects: (application?.comObjects ?? []).length,
    },
    warnings: unknownObjects.length
      ? [`communication objects without an ASAP in the product data: ${unknownObjects.join(', ')}`]
      : [],
  };
}

/** Encode the address table: uint16 per TSAP slot, preceded by the unused slot. */
export function encodeAddressTable(model, profile = SYSTEM_B) {
  const slots = profile.leadingUnused ? model.addresses.length + 1 : model.addresses.length;
  const buffer = Buffer.alloc(slots * profile.entrySize, profile.padByte ?? 0xff);
  let index = profile.leadingUnused ? 1 : 0;
  if (profile.leadingUnused) buffer.writeUInt16BE(profile.unusedEntry ?? 0xffff, 0);
  for (const ga of model.addresses) {
    buffer.writeUInt16BE(ga, index * profile.entrySize);
    index += 1;
  }
  return buffer;
}

/** Encode the association table: (TSAP, ASAP) pairs, sorted by TSAP. */
export function encodeAssociationTable(model, profile = SYSTEM_B) {
  const buffer = Buffer.alloc(model.associations.length * profile.associationEntrySize, profile.padByte ?? 0xff);
  model.associations.forEach((entry, index) => {
    const at = index * profile.associationEntrySize;
    buffer.writeUInt16BE(entry.tsap, at);
    buffer.writeUInt16BE(entry.asap, at + 2);
  });
  return buffer;
}

/** Decode a table image back into the model shape (used by round-trip tests). */
export function decodeAddressTable(buffer, profile = SYSTEM_B) {
  const addresses = [];
  const limit = Math.floor(buffer.length / profile.entrySize);
  for (let index = profile.leadingUnused ? 1 : 0; index < limit; index += 1) {
    const value = buffer.readUInt16BE(index * profile.entrySize);
    if (value === (profile.unusedEntry ?? 0xffff)) break;
    addresses.push(value);
  }
  return addresses;
}

export function decodeAssociationTable(buffer, profile = SYSTEM_B) {
  const out = [];
  for (let at = 0; at + profile.associationEntrySize <= buffer.length; at += profile.associationEntrySize) {
    const tsap = buffer.readUInt16BE(at);
    const asap = buffer.readUInt16BE(at + 2);
    if (tsap === (profile.unusedEntry ?? 0xffff)) break;
    out.push({ tsap, asap });
  }
  return out;
}

/**
 * Build the download recipe for both tables.
 *
 * Base addresses come from the profile. Without them the call returns the plan
 * only: a table written to the wrong address is worse than no table at all,
 * because the device then answers the wrong group addresses.
 */
export function buildTableRecipe(model, { profile = SYSTEM_B, ia = null } = {}) {
  const addressBase = profile.addressBase;
  const associationBase = profile.associationBase;
  if (!Number.isInteger(addressBase) || !Number.isInteger(associationBase)) {
    return {
      ok: false,
      needsProfile: true,
      error: 'table base addresses are device specific: supply addressBase/associationBase, or calibrate them from a recorded ETS "download group addresses" pass',
      model,
    };
  }
  const addressImage = encodeAddressTable(model, profile);
  const associationImage = encodeAssociationTable(model, profile);
  const steps = [];
  const chunk = 11; // keeps every frame inside an L_Data_Standard telegram
  for (let offset = 0; offset < addressImage.length; offset += chunk) {
    steps.push({
      op: 'memory_write',
      address: `0x${(addressBase + offset).toString(16)}`,
      data: addressImage.subarray(offset, offset + chunk).toString('hex'),
    });
  }
  for (let offset = 0; offset < associationImage.length; offset += chunk) {
    steps.push({
      op: 'memory_write',
      address: `0x${(associationBase + offset).toString(16)}`,
      data: associationImage.subarray(offset, offset + chunk).toString('hex'),
    });
  }
  if (profile.restartAfter !== false) steps.push({ op: 'restart', master: false });
  steps.push({
    op: 'note',
    text: `group address table (${model.counts.groupAddresses} GA, ${model.counts.associations} associations) @0x${addressBase.toString(16)} / 0x${associationBase.toString(16)}`,
  });
  return {
    ok: true,
    model,
    tables: {
      addressHex: addressImage.toString('hex'),
      associationHex: associationImage.toString('hex'),
      addressBytes: addressImage.length,
      associationBytes: associationImage.length,
    },
    recipe: {
      schema: 'knxagent.download/1',
      device: { ia },
      options: { chunk },
      source: `grouptable:${profile.name ?? 'custom'}`,
      steps,
    },
  };
}

/**
 * Infer a profile from recorded traffic.
 *
 * The capture must contain the ETS "download group addresses" pass for a device
 * whose project we already know: we then search the written regions for our own
 * group address list as big-endian uint16 and for the (TSAP, ASAP) pair list, so
 * the base addresses and the entry shape are *observed*, not assumed.
 *
 * @param frames - parsed L_Data frames (as produced by readCapture)
 * @param model - the table model the device should have received
 */
export function inferProfile(frames, model, { ia = null } = {}) {
  // Reassemble the memory image the device received, write by write.
  const regions = [];
  for (const frame of frames) {
    if (frame?.kind !== 'ldata') continue;
    if (frame.service !== 'A_Memory_Write' && frame.service !== 'A_Memory_Extended_Write') continue;
    if (ia !== null && frame.dst !== ia) continue;
    const value = frame.value ?? Buffer.alloc(0);
    if (!value.length) continue;
    const address = frame.service === 'A_Memory_Write'
      ? frame.address
      : (value[0] << 16) | (value[1] << 8) | value[2];
    const payload = frame.service === 'A_Memory_Write' ? value : value.subarray(4);
    const last = regions.find((region) => region.start + region.data.length === address);
    if (last) last.data = Buffer.concat([last.data, Buffer.from(payload)]);
    else regions.push({ start: address, data: Buffer.from(payload) });
  }
  if (!regions.length) {
    return { ok: false, error: 'the capture contains no memory writes; record the group address download, not an application download' };
  }

  const expected = encodeAddressTable(model, SYSTEM_B);
  // The recorded image may be shorter than ours (device table smaller); compare
  // only the prefix that exists on both sides.
  const findIn = (needle, haystack, region) => {
    const limit = haystack.length - needle.length;
    for (let at = 0; at <= limit; at += 1) {
      if (haystack.subarray(at, at + needle.length).equals(needle)) return region.start + at;
    }
    return null;
  };

  let addressBase = null;
  let associationBase = null;
  for (const region of regions) {
    if (addressBase === null) addressBase = findIn(expected, region.data, region);
    if (associationBase === null) {
      const assoc = encodeAssociationTable(model, SYSTEM_B);
      if (assoc.length) associationBase = findIn(assoc, region.data, region);
    }
  }
  if (addressBase === null) {
    return {
      ok: false,
      error: 'the expected group address list was not found in the capture: the project does not match this download, or the device stores tables in another layout',
      regions: regions.map((region) => ({ start: `0x${region.start.toString(16)}`, bytes: region.data.length })),
    };
  }
  return {
    ok: true,
    profile: {
      ...SYSTEM_B,
      name: 'calibrated',
      addressBase,
      associationBase,
      inference: {
        regions: regions.length,
        addressBase: `0x${addressBase.toString(16)}`,
        associationBase: associationBase === null ? null : `0x${associationBase.toString(16)}`,
      },
    },
  };
}

/**
 * A device-side table store, used by the simulator to honour what was written.
 *
 * A real device knows where its own tables live; that is exactly the knowledge we
 * lack, so the store is constructed with the region addresses the firmware would
 * have. It then routes each received memory write into the right region and
 * decodes the result, which lets a test prove the *semantics* of an encoded table
 * (this device now answers these group addresses, and no others).
 */
export class DeviceTableStore {
  constructor({ addressBase, associationBase, profile = SYSTEM_B, addressSize = 0x40, associationSize = 0x100 } = {}) {
    this.profile = profile;
    this.addressBase = addressBase ?? null;
    this.associationBase = associationBase ?? null;
    this.addressBuffer = Buffer.alloc(addressSize, profile.padByte ?? 0xff);
    this.associationBuffer = Buffer.alloc(associationSize, profile.padByte ?? 0xff);
    this.addresses = [];
    this.associations = [];
    this.writes = 0;
  }

  /** Absorb one memory write that falls inside a table region. */
  write(address, data) {
    const payload = Buffer.from(data ?? []);
    if (!payload.length) return false;
    const place = (base, buffer) => {
      if (base === null || address < base || address >= base + buffer.length) return false;
      const offset = address - base;
      const take = Math.min(payload.length, buffer.length - offset);
      payload.copy(buffer, offset, 0, take);
      this.writes += 1;
      return true;
    };
    const hitAddress = place(this.addressBase, this.addressBuffer);
    const hitAssociation = hitAddress ? false : place(this.associationBase, this.associationBuffer);
    if (hitAddress) this.addresses = decodeAddressTable(this.addressBuffer, this.profile);
    if (hitAssociation) this.associations = decodeAssociationTable(this.associationBuffer, this.profile);
    return hitAddress || hitAssociation;
  }

  reload() {
    this.addresses = decodeAddressTable(this.addressBuffer, this.profile);
    this.associations = decodeAssociationTable(this.associationBuffer, this.profile);
    return this;
  }

  /** The device answers a group address only when its table lists it. */
  listens(ga) {
    return this.addresses.includes(ga);
  }

  summary() {
    return {
      addresses: this.addresses.map((ga) => cemi.formatGA(ga)),
      associations: this.associations.length,
      writes: this.writes,
      addressBase: this.addressBase === null ? null : `0x${this.addressBase.toString(16)}`,
      associationBase: this.associationBase === null ? null : `0x${this.associationBase.toString(16)}`,
    };
  }
}
