/**
 * A KNXnet/IP gateway with virtual KNX devices, on loopback.
 *
 * Same purpose as the Python harness: let the whole stack be exercised (sequence
 * numbers, tunnelling ACKs, local confirmations, memory services, addressing,
 * restart, properties, group traffic, bus monitor) without hardware, and let a
 * user dry-run a commissioning plan before touching a real bus.
 */

import dgram from 'node:dgram';
import * as cemi from './cemi.js';
import * as knxip from './knxip.js';

export class VirtualDevice {
  constructor(ia, { descriptor = 0x07b0, name = 'virtual-device', programmingMode = true } = {}) {
    this.ia = ia;
    this.descriptor = descriptor;
    this.name = name;
    this.programmingMode = programmingMode;
    this.memory = new Map();
    this.properties = new Map();
    this.groupValues = new Map();
    this.writes = [];
    this.restarts = [];
    this.memoryWriteCalls = 0;
    // When attached, the device answers only group addresses its table lists -
    // which is what a real device does and what makes a table download testable.
    this.tables = null;
  }

  attachTables(store) {
    this.tables = store;
    return this;
  }

  fill(start, data) {
    for (const [offset, byte] of [...data].entries()) this.memory.set((start + offset) & 0xffff, byte);
  }

  dump(start, count) {
    const out = Buffer.alloc(count);
    for (let i = 0; i < count; i += 1) out[i] = this.memory.get((start + i) & 0xffff) ?? 0xff;
    return out;
  }

  handle(frame) {
    const out = [];
    const service = frame.service;
    const respond = (apduBytes, { group = false, dst = this.ia, source = this.ia } = {}) => {
      out.push(cemi.parse(cemi.asInd(cemi.ldata(dst, apduBytes, group, { source }))));
    };

    switch (service) {
      case 'A_Memory_Read': {
        const count = frame.count ?? 0;
        respond(cemi.apduMemoryResponse(frame.address, this.dump(frame.address, count)));
        break;
      }
      case 'A_Memory_Write': {
        const data = frame.value ?? Buffer.alloc(0);
        this.memoryWriteCalls += 1;
        this.writes.push({ address: frame.address, data: Buffer.from(data) });
        this.fill(frame.address, data);
        this.tables?.write(frame.address, data);
        break;
      }
      case 'A_MemoryExtended_Write': {
        const payload = frame.value ?? Buffer.alloc(0);
        if (payload.length >= 4) this.fill((payload[0] << 16) | (payload[1] << 8) | payload[2], payload.subarray(4));
        break;
      }
      case 'A_DeviceDescriptor_Read': {
        const buf = Buffer.alloc(2);
        buf.writeUInt16BE(this.descriptor, 0);
        respond(cemi.apdu(cemi.APCI_DESCRIPTOR_RESPONSE, 0x40, [...buf]));
        break;
      }
      case 'A_IndividualAddress_Write': {
        if (frame.address !== null && frame.address !== undefined && this.programmingMode) {
          this.ia = frame.address;
          this.programmingMode = false;
        }
        break;
      }
      case 'A_IndividualAddress_Read': {
        const buf = Buffer.alloc(2);
        buf.writeUInt16BE(this.ia, 0);
        respond(cemi.apdu(cemi.APCI_IA_RESPONSE, 0x40, [...buf]));
        break;
      }
      case 'A_Restart': {
        this.restarts.push(Boolean(frame.masterReset));
        if (frame.masterReset) {
          this.memory.clear();
          this.properties.clear();
          this.groupValues.clear();
        }
        break;
      }
      case 'A_PropertyValue_Read': {
        const value = this.properties.get(`${frame.objectIndex}:${frame.propertyId}`) ?? Buffer.from([0xff, 0xff, 0xff, 0xff]);
        respond(cemi.apdu(cemi.APCI_PROPERTY_VALUE_RESPONSE, 0xd6,
          [frame.objectIndex ?? 0, frame.propertyId ?? 0, (Math.max(1, value.length) & 0x0f) << 4, 0x01, ...value]));
        break;
      }
      case 'A_PropertyValue_Write': {
        this.properties.set(`${frame.objectIndex}:${frame.propertyId}`, Buffer.from(frame.value ?? []));
        respond(cemi.apdu(cemi.APCI_PROPERTY_VALUE_RESPONSE, 0xd6,
          [frame.objectIndex ?? 0, frame.propertyId ?? 0, 0x10, 0x01]));
        break;
      }
      case 'A_GroupValue_Write':
        if (this.tables && !this.tables.listens(frame.dst)) break;
        this.groupValues.set(frame.dst, Buffer.from(frame.value ?? []));
        break;
      case 'A_GroupValue_Read':
        if (this.tables && !this.tables.listens(frame.dst)) break;
        if (this.groupValues.has(frame.dst)) {
          respond(cemi.apduGroupResponse(this.groupValues.get(frame.dst)), { group: true, dst: frame.dst });
        }
        break;
      case 'A_IndividualAddressSerialNumber_Read':
        if (this.programmingMode) {
          const value = [0x00, 0x00, 0x00, 0x11, 0x22, 0x33, 0x44, this.ia >> 8, this.ia & 0xff];
          respond(cemi.apdu(cemi.APCI_IA_SERIAL_WRITE, 0xdd, value), { dst: cemi.IA_BROADCAST });
        }
        break;
      default:
        break;
    }
    return out;
  }
}

export class GatewaySim {
  constructor({ devices = [new VirtualDevice(0x1101)], port = 0, ackStatus = 0, busmonitor = true } = {}) {
    this.devices = new Map(devices.map((device) => [device.ia, device]));
    this.port = port;
    this.ackStatus = ackStatus;
    this.busmonitor = busmonitor;
    this.channels = new Map();
    this.sequences = new Map();
    this.frames = [];
    this.errors = [];
    this.nextChannel = 1;
    this.socket = null;
  }

  async start() {
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    await new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.bind(this.port, '127.0.0.1', () => {
        this.socket.removeListener('error', reject);
        resolve();
      });
    });
    this.socket.on('message', (buf, rinfo) => {
      try {
        this.handle(buf, rinfo);
      } catch (error) {
        this.errors.push(`${error.name}: ${error.message}`);
      }
    });
    this.socket.on('error', () => {});
    this.socket.unref?.();
    this.port = this.socket.address().port;
    return this;
  }

  stop() {
    if (this.socket) {
      try { this.socket.close(); } catch { /* ignore */ }
      this.socket = null;
    }
  }

  handle(buf, addr) {
    if (buf.length < 6) return;
    const service = buf.readUInt16BE(2);
    const body = buf.subarray(6);
    switch (service) {
      case knxip.SVC.SEARCH_REQUEST: {
        const payload = Buffer.concat([knxip.hpai('127.0.0.1', this.port), this.deviceInfoDib(),
          Buffer.from([0x04, 0x02, 0x02, 0x01])]);
        this.socket.send(Buffer.concat([knxip.header(knxip.SVC.SEARCH_RESPONSE, payload.length), payload]),
          addr.port, addr.address);
        break;
      }
      case knxip.SVC.DESCRIPTION_REQUEST: {
        const payload = Buffer.concat([knxip.hpai('127.0.0.1', this.port), this.deviceInfoDib()]);
        this.socket.send(Buffer.concat([knxip.header(knxip.SVC.DESCRIPTION_RESPONSE, payload.length), payload]),
          addr.port, addr.address);
        break;
      }
      case knxip.SVC.CONNECT_REQUEST: {
        const channel = this.nextChannel;
        this.nextChannel = (this.nextChannel % 200) + 1;
        this.channels.set(channel, { port: addr.port, address: addr.address, layer: body[18] ?? 2 });
        this.sequences.set(channel, 0);
        const payload = Buffer.concat([Buffer.from([channel, knxip.ERR.NO_ERROR]),
          knxip.hpai('127.0.0.1', this.port), Buffer.from([0x04, 0x04, 0x02, 0x00])]);
        this.socket.send(Buffer.concat([knxip.header(knxip.SVC.CONNECT_RESPONSE, payload.length), payload]),
          addr.port, addr.address);
        break;
      }
      case knxip.SVC.CONNECTIONSTATE_REQUEST: {
        const channel = body[0];
        const status = this.channels.has(channel) ? knxip.ERR.NO_ERROR : knxip.ERR.CONNECTION_ID;
        const payload = Buffer.from([channel, status]);
        this.socket.send(Buffer.concat([knxip.header(knxip.SVC.CONNECTIONSTATE_RESPONSE, payload.length), payload]),
          addr.port, addr.address);
        break;
      }
      case knxip.SVC.DISCONNECT_REQUEST: {
        this.channels.delete(body[0]);
        const payload = Buffer.from([body[0], knxip.ERR.NO_ERROR]);
        this.socket.send(Buffer.concat([knxip.header(knxip.SVC.DISCONNECT_RESPONSE, payload.length), payload]),
          addr.port, addr.address);
        break;
      }
      case knxip.SVC.TUNNELLING_REQUEST:
        this.handleTunnelling(body, addr);
        break;
      default:
        break;
    }
  }

  handleTunnelling(body, addr) {
    const channel = body[1];
    const seq = body[2];
    this.socket.send(Buffer.concat([knxip.header(knxip.SVC.TUNNELLING_ACK, 4),
      Buffer.from([0x04, channel, seq, this.ackStatus])]), addr.port, addr.address);
    if (this.ackStatus !== knxip.ERR.NO_ERROR) return;
    if (!this.channels.has(channel)) return;
    const frame = cemi.parse(body.subarray(4));
    if (!frame || frame.kind !== 'ldata') return;

    // A data link layer puts the frame on the bus (devices react) and only then
    // confirms it, so a client that waits for the confirmation knows the device acted.
    this.frames.push(frame);
    this.broadcastBusmon(body.subarray(4));
    const targets = frame.group || frame.dst === cemi.IA_BROADCAST
      ? [...this.devices.values()]
      : [...this.devices.values()].filter((device) => device.ia === frame.dst);
    for (const device of targets) {
      for (const response of device.handle(frame)) {
        this.sendFrame(response.raw, addr, channel);
        this.broadcastBusmon(response.raw);
      }
    }
    this.sendFrame(cemi.ldataConfirm(frame), addr, channel);
  }

  sendFrame(frame, addr, channel) {
    const seq = this.sequences.get(channel) ?? 0;
    this.sequences.set(channel, (seq + 1) & 0xff);
    const body = Buffer.concat([Buffer.from([0x04, channel, seq, 0x00]), Buffer.from(frame)]);
    try {
      this.socket.send(Buffer.concat([knxip.header(knxip.SVC.TUNNELLING_REQUEST, body.length), body]),
        addr.port, addr.address);
    } catch { /* ignore */ }
  }

  broadcastBusmon(frame) {
    if (!this.busmonitor) return;
    for (const [channel, info] of this.channels) {
      if (info.layer !== knxip.LAYER.BUSMON) continue;
      const busmon = Buffer.concat([Buffer.from([cemi.L_BUSMON_IND, 0, 0, 0, 0, 0, 0]), Buffer.from(frame)]);
      this.sendFrame(busmon, info, channel);
    }
  }

  deviceInfoDib() {
    const first = [...this.devices.values()][0];
    const name = Buffer.alloc(30);
    name.write(first.name.slice(0, 29), 0, 'utf8');
    const body = Buffer.concat([
      Buffer.from([0x02, 0x00]), Buffer.from([first.ia >> 8, first.ia & 0xff]),
      Buffer.from([0x00, 0x00]), Buffer.from('001122334455', 'hex'),
      Buffer.from([224, 0, 23, 12]), Buffer.from('020000000001', 'hex'), name,
    ]);
    return Buffer.concat([Buffer.from([2 + body.length, 0x01]), body]);
  }
}

/** Start a simulator and return it with its bound port. */
export async function startSimulator(options = {}) {
  const gateway = new GatewaySim(options);
  await gateway.start();
  return gateway;
}

/**
 * Give every simulated device a table store at the given addresses, so a table
 * download can be rehearsed with its real consequence: the device answers only
 * the group addresses its table lists.
 */
export async function attachTablesToAll(gateway, tables) {
  const { DeviceTableStore } = await import('./gatable.js');
  for (const device of gateway.devices.values()) {
    device.attachTables(new DeviceTableStore({
      addressBase: tables.addressBase,
      associationBase: tables.associationBase,
    }));
  }
  return gateway;
}
