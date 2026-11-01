/**
 * Device management and group access on top of a KNXnet/IP tunnel.
 *
 * Everything a commissioning agent does to a device is one of: memory read/write
 * (the download itself), property read/write (identity and tables), individual
 * address write/read (addressing and scanning), descriptor read (mask version),
 * restart (application start / master reset), group value read/write (acceptance).
 */

import * as cemi from './cemi.js';
import * as dpt from './dpt.js';
import { isInbound } from './knxip.js';

const isLData = (item) => item?.kind === 'ldata';

/** Bus frames arrive either directly (data link) or wrapped in L_Busmon.ind. */
export function unwrap(entry) {
  if (!entry) return null;
  if (entry.kind === 'ldata') return entry;
  if (entry.kind === 'busmon' && entry.frame) return entry.frame;
  return null;
}

export class DeviceLink {
  constructor(tunnel, { ackTimeoutMs = 1500, confirmTimeoutMs = 400, log = [] } = {}) {
    this.tunnel = tunnel;
    this.ackTimeoutMs = ackTimeoutMs;
    this.confirmTimeoutMs = confirmTimeoutMs;
    this.log = log;
  }

  /**
   * Send a cEMI frame, wait for the local confirmation, then for the response.
   * A stale frame from a previous call would be indistinguishable from this one's
   * answer (property write and read responses are structurally identical), so the
   * inbox is drained first.
   */
  async request(frame, accept, { timeoutMs = 2000, retries = 2, ackTimeoutMs = null } = {}) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt === 0) this.tunnel.drain();
      const sent = await this.tunnel.sendCemi(frame, ackTimeoutMs ?? this.ackTimeoutMs);
      if (!sent) {
        this.log.push({ attempt, result: 'no tunnelling ack' });
        continue;
      }
      const con = await this.tunnel.wait((item) => isLData(item) && item.code === cemi.L_DATA_CON,
        this.confirmTimeoutMs);
      if (con && con.conError) {
        this.log.push({ attempt, result: 'negative confirmation' });
        continue;
      }
      const response = await this.tunnel.wait(accept, timeoutMs);
      if (response) return response;
      this.log.push({ attempt, result: 'timeout' });
    }
    return null;
  }

  static fromIA(ia) {
    return (item) => isInbound(item) && item.src === ia;
  }

  async memoryRead(ia, address, count, { timeoutMs = 2000, retries = 2 } = {}) {
    const chunks = [];
    let addr = address;
    let remaining = count;
    while (remaining > 0) {
      const size = Math.min(remaining, 15);
      const frame = cemi.ldata(ia, cemi.apduMemoryRead(addr, size), false);
      const response = await this.request(frame, (item) => DeviceLink.fromIA(ia)(item)
        && item.service === 'A_Memory_Response'
        && item.address === addr
        && (item.value?.length ?? 0) >= size, { timeoutMs, retries });
      if (!response) return null;
      chunks.push(Buffer.from(response.value.subarray(0, size)));
      addr = (addr + size) & 0xffff;
      remaining -= size;
    }
    return Buffer.concat(chunks);
  }

  async memoryWrite(ia, address, data, { ackTimeoutMs = null } = {}) {
    const buf = Buffer.from(data);
    for (let offset = 0; offset < buf.length; offset += 15) {
      const chunk = buf.subarray(offset, Math.min(offset + 15, buf.length));
      const frame = cemi.ldata(ia, cemi.apduMemoryWrite((address + offset) & 0xffff, chunk), false);
      const sent = await this.tunnel.sendCemi(frame, ackTimeoutMs ?? this.ackTimeoutMs);
      if (!sent) return false;
      if (this.tunnel.confirms === false) continue; // routing: no local confirmation
      const con = await this.tunnel.wait((item) => isLData(item) && item.code === cemi.L_DATA_CON,
        this.confirmTimeoutMs);
      if (!con || con.conError) return false;
    }
    return true;
  }

  async memoryWriteExt(ia, address, data, { chunkSize = 220 } = {}) {
    const buf = Buffer.from(data);
    for (let offset = 0; offset < buf.length; offset += chunkSize) {
      const chunk = buf.subarray(offset, Math.min(offset + chunkSize, buf.length));
      const frame = cemi.ldata(ia, cemi.apduMemoryExtWrite(address + offset, chunk), false);
      if (!await this.tunnel.sendCemi(frame, this.ackTimeoutMs)) return false;
      const con = await this.tunnel.wait((item) => isLData(item) && item.code === cemi.L_DATA_CON,
        this.confirmTimeoutMs);
      if (!con || con.conError) return false;
    }
    return true;
  }

  async descriptorRead(ia, type = 0, { timeoutMs = 1000, retries = 1 } = {}) {
    const frame = cemi.ldata(ia, cemi.apduDescriptorRead(type), false);
    const response = await this.request(frame, (item) => DeviceLink.fromIA(ia)(item)
      && item.service === 'A_DeviceDescriptor_Response', { timeoutMs, retries });
    return response?.descriptor ?? null;
  }

  async readIA(ia, { timeoutMs = 1000 } = {}) {
    const frame = cemi.ldata(ia, cemi.apduIARead(), false);
    const response = await this.request(frame, (item) => DeviceLink.fromIA(ia)(item)
      && item.service === 'A_IndividualAddress_Response', { timeoutMs, retries: 1 });
    return response?.address ?? null;
  }

  /** A_IndividualAddress_Write; the device must be in programming mode. */
  async assignIA(newIA, { oldIA = cemi.IA_BROADCAST } = {}) {
    const frame = cemi.ldata(oldIA, cemi.apduIAWrite(newIA), false);
    if (!await this.tunnel.sendCemi(frame, this.ackTimeoutMs)) return false;
    if (this.tunnel.confirms === false) return true;
    const con = await this.tunnel.wait((item) => isLData(item) && item.code === cemi.L_DATA_CON,
      this.confirmTimeoutMs);
    return Boolean(con && !con.conError);
  }

  /** Broadcast serial number read; answers only from a device in programming mode. */
  async serialNumber({ timeoutMs = 1000 } = {}) {
    const frame = cemi.ldata(cemi.IA_BROADCAST, cemi.apduIASerialRead(), false);
    const response = await this.request(frame, (item) => isInbound(item)
      && item.service === 'A_IndividualAddressSerialNumber_Write', { timeoutMs, retries: 2 });
    if (!response) return null;
    const value = response.value ?? Buffer.alloc(0);
    if (value.length < 10) return { src: response.srcIA, raw: value.toString('hex') };
    return {
      src: response.srcIA,
      domainAddress: value.subarray(0, 2).toString('hex'),
      serial: value.subarray(2, 8).toString('hex').toUpperCase(),
      individualAddress: cemi.formatIA((value[8] << 8) | value[9]),
      raw: value.toString('hex'),
    };
  }

  async restart(ia, { master = false } = {}) {
    const frame = cemi.ldata(ia, cemi.apduRestart(master), false);
    if (!await this.tunnel.sendCemi(frame, this.ackTimeoutMs)) return false;
    if (this.tunnel.confirms === false) return true;
    const con = await this.tunnel.wait((item) => isLData(item) && item.code === cemi.L_DATA_CON,
      Math.max(this.confirmTimeoutMs, 1000));
    return Boolean(con && !con.conError);
  }

  async propertyRead(ia, objectIndex, propertyId, { count = 1, startIndex = 1, timeoutMs = 1500 } = {}) {
    const frame = cemi.ldata(ia, cemi.apduPropertyRead(objectIndex, propertyId, count, startIndex), false);
    const response = await this.request(frame, (item) => DeviceLink.fromIA(ia)(item)
      && item.service === 'A_PropertyValue_Response'
      && item.objectIndex === objectIndex
      && item.propertyId === propertyId, { timeoutMs, retries: 2 });
    return response?.value ?? null;
  }

  async propertyWrite(ia, objectIndex, propertyId, data, { startIndex = 1, count = 1, timeoutMs = 1500 } = {}) {
    const frame = cemi.ldata(ia, cemi.apduPropertyWrite(objectIndex, propertyId, Buffer.from(data), startIndex, count), false);
    const response = await this.request(frame, (item) => DeviceLink.fromIA(ia)(item)
      && item.service === 'A_PropertyValue_Response'
      && item.propertyId === propertyId, { timeoutMs, retries: 2 });
    return Boolean(response);
  }

  /**
   * Pipelined scan of one line by device descriptor reads.
   *
   * Sequential scanning with a 1 s timeout takes four minutes per line; here each
   * frame is acknowledged in the IP layer (1-2 ms) and the answers are collected
   * in a settle window afterwards.
   */
  async scan(line = '1.1', { start = 0, end = 256, window = 48, settleMs = 600 } = {}) {
    const [area, lineNo] = line.split('.').map(Number);
    const found = new Map();
    const addresses = [];
    for (let device = start; device < end; device += 1) addresses.push((area << 12) | (lineNo << 8) | device);
    for (let index = 0; index < addresses.length; index += window) {
      const batch = addresses.slice(index, index + window);
      for (const address of batch) {
        await this.tunnel.sendCemi(cemi.ldata(address, cemi.apduDescriptorRead(0), false), 800);
      }
      const deadline = Date.now() + settleMs;
      while (Date.now() < deadline) {
        const item = await this.tunnel.wait((frame) => isInbound(frame)
          && frame.service === 'A_DeviceDescriptor_Response', Math.max(20, deadline - Date.now()));
        if (!item) break;
        found.set(item.src, { ia: item.src, iaText: item.srcIA, descriptor: item.descriptor ?? null });
      }
    }
    this.tunnel.drain();
    return [...found.values()].sort((a, b) => a.ia - b.ia);
  }
}

export class GroupBus {
  constructor(tunnel, { responseTimeoutMs = 2000 } = {}) {
    this.tunnel = tunnel;
    this.responseTimeoutMs = responseTimeoutMs;
  }

  /**
   * Write a group value. On a tunnel, true means the link layer confirmed the
   * frame; on routing there is no local confirmation, so a successful emit is the
   * whole acknowledgement the medium offers.
   */
  async write(ga, value) {
    const frame = cemi.ldata(ga, cemi.apduGroupWrite(Buffer.from(value)), true);
    if (!await this.tunnel.sendCemi(frame, 1500)) return false;
    if (this.tunnel.confirms === false) return true;
    const con = await this.tunnel.wait((item) => isLData(item) && item.code === cemi.L_DATA_CON, 1000);
    return Boolean(con && !con.conError);
  }

  async writeDpt(ga, dptId, value) {
    return this.write(ga, dpt.encode(dptId, value));
  }

  async read(ga, { timeoutMs = null } = {}) {
    const frame = cemi.ldata(ga, cemi.apduGroupRead(), true);
    if (!await this.tunnel.sendCemi(frame, 1500)) return null;
    return this.tunnel.wait((item) => isInbound(item)
      && item.group && item.dst === ga
      && item.service === 'A_GroupValue_Response', timeoutMs ?? this.responseTimeoutMs);
  }

  async readDpt(ga, dptId, options) {
    const response = await this.read(ga, options);
    if (!response) return null;
    return dpt.decode(dptId, response.value ?? Buffer.alloc(0));
  }

  /**
   * Collect inbound frames for `seconds`.
   *
   * On a bus monitor tunnel this is every frame on the bus, including the
   * individual-addressed management traffic of a download; on a data link only
   * what the interface forwards.
   */
  async listen(seconds, predicate = null) {
    const out = [];
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      // A bus monitor tunnel wraps the bus frame in L_Busmon.ind; unwrap it so the
      // capture sees the same shape a data link delivers.
      const item = await this.tunnel.wait((entry) => {
        const frame = unwrap(entry);
        return Boolean(frame) && (!predicate || predicate(frame));
      }, Math.max(50, deadline - Date.now()));
      if (item) out.push(item.kind === 'busmon' ? item.frame : item);
    }
    return out;
  }
}
