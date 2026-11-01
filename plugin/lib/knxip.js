/**
 * KNXnet/IP transport (core services 2.1): discovery, tunnelling, bus monitor,
 * routing. Uses only `node:dgram`.
 *
 * The wire format is the interesting part: a 6 octet header (0x0610, service id,
 * total length), tunnelling requests carry a 4 octet connection header with a
 * sequence number that must increase per channel and be acknowledged by the
 * peer; a frame we do not acknowledge makes the gateway retransmit and eventually
 * drop the connection, so the receive loop ACKs before it parses.
 */

import dgram from 'node:dgram';
import * as cemi from './cemi.js';

export const MULTICAST = { host: '224.0.23.12', port: 3671 };

export const SVC = {
  SEARCH_REQUEST: 0x0201,
  SEARCH_RESPONSE: 0x0202,
  DESCRIPTION_REQUEST: 0x0203,
  DESCRIPTION_RESPONSE: 0x0204,
  CONNECT_REQUEST: 0x0205,
  CONNECT_RESPONSE: 0x0206,
  CONNECTIONSTATE_REQUEST: 0x0207,
  CONNECTIONSTATE_RESPONSE: 0x0208,
  DISCONNECT_REQUEST: 0x0209,
  DISCONNECT_RESPONSE: 0x020a,
  TUNNELLING_REQUEST: 0x0420,
  TUNNELLING_ACK: 0x0421,
  ROUTING_INDICATION: 0x0530,
  ROUTING_LOST: 0x0531,
};

export const LAYER = { LINK: 0x02, RAW: 0x04, BUSMON: 0x80 };
export const CONN = { TUNNEL: 0x04, DEVICE_MGMT: 0x03 };

export const ERR = {
  NO_ERROR: 0x00,
  HOST_PROTOCOL: 0x01,
  VERSION: 0x02,
  SEQUENCE: 0x04,
  CONNECTION_ID: 0x21,
  CONNECTION_TYPE: 0x22,
  CONNECTION_OPTION: 0x23,
  NO_MORE_CONNECTIONS: 0x24,
  NO_MORE_UNIQUE_CONNECTIONS: 0x25,
  DATA_CONNECTION: 0x26,
  KNX_CONNECTION: 0x27,
  TUNNELLING_LAYER: 0x29,
};

export const ERROR_NAMES = {
  0x00: 'E_NO_ERROR',
  0x01: 'E_HOST_PROTOCOL_TYPE',
  0x02: 'E_VERSION_NOT_SUPPORTED',
  0x04: 'E_SEQUENCE_NUMBER',
  0x21: 'E_CONNECTION_ID',
  0x22: 'E_CONNECTION_TYPE',
  0x23: 'E_CONNECTION_OPTION',
  0x24: 'E_NO_MORE_CONNECTIONS',
  0x25: 'E_NO_MORE_UNIQUE_CONNECTIONS',
  0x26: 'E_DATA_CONNECTION',
  0x27: 'E_KNX_CONNECTION',
  0x29: 'E_TUNNELLING_LAYER',
};

export class KnxIpError extends Error {}

export function header(service, bodyLength) {
  const buf = Buffer.alloc(6);
  buf[0] = 0x06;
  buf[1] = 0x10;
  buf.writeUInt16BE(service, 2);
  buf.writeUInt16BE(bodyLength + 6, 4);
  return buf;
}

export function hpai(address, port, protocol = 0x01) {
  const buf = Buffer.alloc(8);
  buf[0] = 0x08;
  buf[1] = 0x01;
  for (const [index, part] of address.split('.').entries()) buf[2 + index] = Number(part);
  buf.writeUInt16BE(port, 6);
  buf[7] = protocol;
  return buf;
}

export function parseHpai(buf) {
  return {
    ip: `${buf[2]}.${buf[3]}.${buf[4]}.${buf[5]}`,
    port: buf.readUInt16BE(6),
    protocol: buf[7],
  };
}

/** Parse the description information blocks of SEARCH/DESCRIPTION responses. */
export function parseDibs(buf) {
  const out = [];
  let index = 0;
  while (index + 2 <= buf.length) {
    const length = buf[index];
    if (!length) break;
    const block = buf.subarray(index, index + length);
    const type = block[1];
    if (type === 0x01 && block.length >= 54) {
      out.push({
        type: 'device_info',
        medium: block[2],
        status: block[3],
        individualAddress: (block[4] << 8) | block[5],
        iaText: cemi.formatIA((block[4] << 8) | block[5]),
        projectInstallationId: (block[6] << 8) | block[7],
        serial: block.subarray(8, 14).toString('hex').toUpperCase(),
        multicast: `${block[14]}.${block[15]}.${block[16]}.${block[17]}`,
        mac: [...block.subarray(18, 24)].map((b) => b.toString(16).padStart(2, '0')).join(':'),
        friendlyName: block.subarray(24, 54).toString('utf8').replace(/\0.*$/, ''),
      });
    } else if (type === 0x02) {
      const families = [];
      for (let i = 2; i + 1 < block.length; i += 2) families.push([block[i], block[i + 1]]);
      out.push({ type: 'supp_svc_families', families });
    } else {
      out.push({ type: 'unknown', descType: type });
    }
    index += length;
  }
  return out;
}

function openSocket(port = 0) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(port, '0.0.0.0', () => {
      socket.removeListener('error', reject);
      socket.unref?.();
      resolve(socket);
    });
  });
}

/** Wait for an item in an inbox matching `predicate`, or resolve null on timeout. */
function makeInbox() {
  const items = [];
  const waiters = [];
  const settle = () => {
    for (let w = waiters.length - 1; w >= 0; w -= 1) {
      const waiter = waiters[w];
      const index = items.findIndex(waiter.predicate);
      if (index >= 0) {
        const [found] = items.splice(index, 1);
        waiters.splice(w, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(found);
      }
    }
  };
  return {
    push(item) {
      items.push(item);
      if (items.length > 512) items.splice(0, items.length - 512);
      settle();
    },
    wait(predicate, timeoutMs) {
      const index = items.findIndex(predicate);
      if (index >= 0) {
        const [found] = items.splice(index, 1);
        return Promise.resolve(found);
      }
      return new Promise((resolve) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at >= 0) waiters.splice(at, 1);
          resolve(null);
        }, Math.max(1, timeoutMs));
        waiters.push(waiter);
      });
    },
    drain() {
      const taken = items.splice(0, items.length);
      return taken;
    },
    size() {
      return items.length;
    },
  };
}

const isLData = (item) => item?.kind === 'ldata';
export const isInbound = (item) => isLData(item)
  && (item.code === cemi.L_DATA_IND || item.code === cemi.L_DATA_REQ)
  && item.src !== 0;

/** One KNXnet/IP tunnelling connection (one channel, one sequence counter). */
export class Tunnel {
  /** A tunnel confirms each transmitted frame with L_Data.con. */
  get confirms() {
    return true;
  }

  constructor({ host, port = 3671, layer = LAYER.LINK, connectTimeoutMs = 4000 } = {}) {
    this.gateway = { host, port };
    this.layer = layer;
    this.connectTimeoutMs = connectTimeoutMs;
    this.channel = null;
    this.sequence = 0;
    this.inbox = makeInbox();
    this.socket = null;
    this.advertised = null;
    this.stats = { rx: 0, rxErrors: 0, acksSent: 0, ackTimeouts: 0, frames: 0 };
  }

  static async open(options) {
    const tunnel = new Tunnel(options);
    await tunnel.connect();
    return tunnel;
  }

  async connect() {
    this.socket = await openSocket();
    const local = this.socket.address();
    this.advertised = local.address === '0.0.0.0' ? this.localAddressTowards() : local.address;
    this.localPort = local.port;
    this.socket.on('message', (buf) => this.onMessage(buf));
    this.socket.on('error', () => { this.stats.rxErrors += 1; });
    const body = Buffer.concat([
      hpai(this.advertised || '0.0.0.0', this.localPort),
      hpai(this.advertised || '0.0.0.0', this.localPort),
      Buffer.from([0x04, CONN.TUNNEL, this.layer, 0x00]),
    ]);
    this.send(header(SVC.CONNECT_REQUEST, body.length), body);
    const reply = await this.inbox.wait((item) => item.kind === 'connect', this.connectTimeoutMs);
    if (!reply) throw new KnxIpError(`no CONNECT_RESPONSE from ${this.gateway.host}:${this.gateway.port}`);
    if (reply.status !== ERR.NO_ERROR) {
      throw new KnxIpError(`connect refused: ${ERROR_NAMES[reply.status] ?? reply.status} (0x${reply.status.toString(16)})`);
    }
    this.channel = reply.channel;
    return this;
  }

  localAddressTowards() {
    // A UDP socket bound to 0.0.0.0 reports 0.0.0.0; the gateway needs a routable
    // HPAI, so fall back to the socket's own family address after a throwaway
    // connect on a probe socket.
    const probe = dgram.createSocket('udp4');
    try {
      probe.connect(this.gateway.port, this.gateway.host, () => {});
      const address = probe.address().address;
      return address === '0.0.0.0' ? '127.0.0.1' : address;
    } catch {
      return '127.0.0.1';
    } finally {
      try { probe.close(); } catch { /* ignore */ }
    }
  }

  send(buf, body) {
    const packet = Buffer.concat([buf, body]);
    this.socket.send(packet, this.gateway.port, this.gateway.host, () => {});
  }

  packet(service, body) {
    this.send(header(service, body.length), body);
  }

  onMessage(buf) {
    this.stats.rx += 1;
    if (buf.length < 6) return;
    const service = buf.readUInt16BE(2);
    const body = buf.subarray(6);
    try {
      switch (service) {
        case SVC.TUNNELLING_REQUEST: {
          if (body.length < 4) return;
          const channel = body[1];
          const seq = body[2];
          this.ack(channel, seq);
          const frame = cemi.parse(body.subarray(4));
          if (frame) {
            this.stats.frames += 1;
            this.inbox.push(frame);
          }
          break;
        }
        case SVC.TUNNELLING_ACK:
          if (body.length >= 4) this.inbox.push({ kind: 'tunnelling_ack', seq: body[2], status: body[3] });
          break;
        case SVC.CONNECT_RESPONSE:
          if (body.length >= 2) this.inbox.push({ kind: 'connect', channel: body[0], status: body[1] });
          break;
        case SVC.CONNECTIONSTATE_RESPONSE:
          this.inbox.push({ kind: 'connectionstate', status: body.length > 1 ? body[1] : 0xff });
          break;
        case SVC.ROUTING_INDICATION: {
          const frame = cemi.parse(body.subarray(4));
          if (frame) this.inbox.push(frame);
          break;
        }
        case SVC.DISCONNECT_REQUEST:
          this.channel = null;
          this.inbox.push({ kind: 'disconnected' });
          break;
        default:
          break;
      }
    } catch {
      this.stats.rxErrors += 1;
    }
  }

  ack(channel, seq) {
    this.packet(SVC.TUNNELLING_ACK, Buffer.from([0x04, channel, seq, ERR.NO_ERROR]));
    this.stats.acksSent += 1;
  }

  async sendCemi(frame, timeoutMs = 3000) {
    if (this.channel === null) throw new KnxIpError('tunnel is not connected');
    const seq = this.sequence;
    this.sequence = (this.sequence + 1) & 0xff;
    const body = Buffer.concat([Buffer.from([0x04, this.channel, seq, 0x00]), Buffer.from(frame)]);
    this.packet(SVC.TUNNELLING_REQUEST, body);
    const ack = await this.inbox.wait((item) => item.kind === 'tunnelling_ack' && item.seq === seq, timeoutMs);
    if (!ack) {
      this.stats.ackTimeouts += 1;
      return false;
    }
    return ack.status === ERR.NO_ERROR;
  }

  wait(predicate, timeoutMs) {
    return this.inbox.wait(predicate, timeoutMs);
  }

  drain() {
    return this.inbox.drain();
  }

  async heartbeat(timeoutMs = 2000) {
    if (this.channel === null) return false;
    this.packet(SVC.CONNECTIONSTATE_REQUEST,
      Buffer.concat([Buffer.from([this.channel, 0x00]), hpai('0.0.0.0', 0)]));
    const reply = await this.wait((item) => item.kind === 'connectionstate', timeoutMs);
    return Boolean(reply && reply.status === ERR.NO_ERROR);
  }

  async close() {
    if (this.channel !== null && this.socket) {
      this.packet(SVC.DISCONNECT_REQUEST, Buffer.concat([Buffer.from([this.channel, 0x00]), hpai('0.0.0.0', 0)]));
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    this.channel = null;
    if (this.socket) {
      try { this.socket.close(); } catch { /* ignore */ }
      this.socket = null;
    }
  }
}

/** Discover KNXnet/IP servers by multicast search and/or unicast targets. */
export async function search({ timeoutMs = 3000, multicast = true, unicastTargets = [] } = {}) {
  const targets = [];
  if (multicast) targets.push(MULTICAST);
  for (const target of unicastTargets) {
    if (Array.isArray(target)) targets.push({ host: target[0], port: Number(target[1]) || 3671 });
    else if (target.includes(':')) {
      const [host, port] = target.split(':');
      targets.push({ host, port: Number(port) || 3671 });
    } else targets.push({ host: target, port: 3671 });
  }

  const results = [];
  const seen = new Set();
  for (const target of targets) {
    const socket = await openSocket();
    try {
      if (multicast && target === MULTICAST) {
        try { socket.setMulticastTTL(2); } catch { /* ignore */ }
      }
      const body = hpai('0.0.0.0', 0);
      socket.send(Buffer.concat([header(SVC.SEARCH_REQUEST, body.length), body]), target.port, target.host);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const packet = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), Math.max(20, deadline - Date.now()));
          socket.once('message', (buf) => { clearTimeout(timer); resolve(buf); });
        });
        if (!packet) continue;
        if (packet.length < 6 || packet.readUInt16BE(2) !== SVC.SEARCH_RESPONSE) continue;
        const key = packet.subarray(6).toString('hex');
        if (seen.has(key)) continue;
        seen.add(key);
        const dibs = parseDibs(packet.subarray(6));
        const entry = { ip: target.host === MULTICAST.host ? null : target.host, port: target.port, dibs };
        const info = dibs.find((dib) => dib.type === 'device_info');
        if (info) Object.assign(entry, info);
        results.push(entry);
      }
    } finally {
      try { socket.close(); } catch { /* ignore */ }
    }
  }
  return results;
}

/** DESCRIPTION_REQUEST against one host: DIBs without opening a tunnel. */
export async function describe(host, timeoutMs = 2000) {
  const socket = await openSocket();
  try {
    const body = hpai('0.0.0.0', 0);
    socket.send(Buffer.concat([header(SVC.DESCRIPTION_REQUEST, body.length), body]), 3671, host);
    const packet = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      socket.once('message', (buf) => { clearTimeout(timer); resolve(buf); });
    });
    if (!packet) throw new KnxIpError(`no DESCRIPTION_RESPONSE from ${host}`);
    return { host, dibs: parseDibs(packet.subarray(6)) };
  } finally {
    try { socket.close(); } catch { /* ignore */ }
  }
}


/**
 * KNXnet/IP routing: group-addressed telegrams over multicast, no tunnel channel.
 *
 * Worth having in the field: a plain interface usually offers four tunnels and ETS
 * holds them, while multicast routing needs none. Individual-addressed frames do
 * traverse routing only when the gateway is a real KNX/IP *router*, so management
 * work still prefers a tunnel.
 */
export class Router {
  /** Routing has no channel acknowledgement: the frame is emitted, not confirmed. */
  get confirms() {
    return false;
  }

  constructor({ group = MULTICAST.host, port = MULTICAST.port, localInterface = null } = {}) {
    this.target = { host: group, port };
    this.socket = null;
    this.inbox = makeInbox();
    this.stats = { rx: 0, rxErrors: 0, acksSent: 0, ackTimeouts: 0, frames: 0 };
  }

  static async open(options) {
    const router = new Router(options);
    await router.connect();
    return router;
  }

  async connect() {
    // Multicast delivery needs the socket bound to the routing port; when that port
    // is already taken without reuse, fall back to an ephemeral one and record it.
    try {
      this.socket = await openSocket(this.target.port);
    } catch (error) {
      this.socket = await openSocket(0);
      this.stats.rxErrors += 1;
      this.bindFallback = error.message;
    }
    this.localPort = this.socket.address().port;
    try {
      this.socket.addMembership(this.target.host);
    } catch (error) {
      this.stats.rxErrors += 1;
      throw new KnxIpError(`cannot join ${this.target.host}: ${error.message}`);
    }
    this.socket.on('message', (buf) => {
      this.stats.rx += 1;
      if (buf.length < 6) return;
      this.stats.frames += 1;
      if (buf.readUInt16BE(2) !== SVC.ROUTING_INDICATION) return;
      try {
        const frame = cemi.parse(buf.subarray(6 + 4));
        if (frame) this.inbox.push(frame);
      } catch {
        this.stats.rxErrors += 1;
      }
    });
    this.socket.on('error', () => { this.stats.rxErrors += 1; });
    return this;
  }

  /** Routing has no channel and no per-frame ACK: the frame is simply emitted. */
  async sendCemi(frame) {
    if (!this.socket) throw new KnxIpError('router is not connected');
    const body = Buffer.concat([Buffer.from([0x04, 0x00, 0x00, 0x00]), Buffer.from(frame)]);
    this.socket.send(Buffer.concat([header(SVC.ROUTING_INDICATION, body.length), body]),
      this.target.port, this.target.host);
    return true;
  }

  wait(predicate, timeoutMs) {
    return this.inbox.wait(predicate, timeoutMs);
  }

  drain() {
    return this.inbox.drain();
  }

  async heartbeat() {
    return Boolean(this.socket);
  }

  async close() {
    if (this.socket) {
      try { this.socket.dropMembership(this.target.host); } catch { /* ignore */ }
      try { this.socket.close(); } catch { /* ignore */ }
      this.socket = null;
    }
  }
}
