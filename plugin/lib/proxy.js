/**
 * KNXnet/IP reverse proxy: put ETS behind a recorder.
 *
 * ETS composes the application image and the parameter block from its product
 * database, and that content exists nowhere in a public format. The one honest way
 * to obtain it from macOS is to let ETS do the download once, while recording the
 * telegrams it produces. This proxy is that recorder: ETS discovers it as a
 * gateway, connects to it instead of the real interface, and every tunnelling
 * frame is forwarded unchanged (only the channel id is remapped) and written to a
 * JSONL capture. `captureToRecipe` then turns the recorded traffic of one device
 * into a recipe the plugin can replay on the Mac, without ETS.
 *
 * Two details decide whether this works at all:
 *  - the CONNECT_RESPONSE carries the HPAI the client will send data to, so it is
 *    rewritten to point at this proxy; otherwise ETS would bypass the recorder;
 *  - sequence numbers are forwarded untouched. The proxy is the only client of the
 *    upstream channel, so both directions stay consistent and the per-channel ACK
 *    bookkeeping ETS does keeps matching.
 */

import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import * as cemi from './cemi.js';
import * as knxip from './knxip.js';

const PROXY_NAME = 'knx-agent proxy';
const PROXY_IA = 0xfffe; // 15.15.254: "a gateway that is not a device"
const PROXY_SERIAL = '4b4e5850524f'; // "KNXPRO": the DIB serial field is exactly 6 octets

function nowIso() {
  return new Date().toISOString();
}

/** Open a UDP socket bound to 0.0.0.0:port (0 = ephemeral). */
function bindSocket(port = 0, address = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.once('error', reject);
    socket.bind(port, address, () => {
      socket.removeListener('error', reject);
      resolve(socket);
    });
  });
}

/** Device Info DIB for the proxy itself (54 octets, per KNXnet/IP core 2.1). */
function deviceInfoDib(port, name = PROXY_NAME) {
  const label = Buffer.alloc(30);
  label.write(name.slice(0, 29), 0, 'utf8');
  const body = Buffer.concat([
    Buffer.from([0x02, 0x00]),
    Buffer.from([PROXY_IA >> 8, PROXY_IA & 0xff]),
    Buffer.from([0x00, 0x00]),
    Buffer.from(PROXY_SERIAL, 'hex'),
    Buffer.from([224, 0, 23, 12]),
    Buffer.from('020000000001', 'hex'),
    label,
  ]);
  return Buffer.concat([Buffer.from([2 + body.length, 0x01]), body]);
}

export class KnxProxy {
  /**
   * @param listenPort - UDP port clients (ETS) reach, usually 3671.
   * @param upstream - {host, port} of the real KNXnet/IP interface.
   * @param captureDir - where capture files are written.
   */
  constructor({
    listenPort = 3671,
    upstream = {},
    captureDir = null,
    advertise = null,
    // Loopback by default: a KNXnet/IP gateway exposed to the LAN is an
    // unauthenticated write path to the bus. Exposing it is an explicit choice.
    bind = '127.0.0.1',
    maxChannels = 8,
    channelIdleMs = 300000,
  } = {}) {
    this.listenPort = listenPort;
    this.bind = bind;
    this.maxChannels = Math.max(1, Number(maxChannels) || 8);
    this.channelIdleMs = Math.max(30000, Number(channelIdleMs) || 300000);
    this.sweeper = null;
    this.upstream = { host: upstream.host, port: upstream.port ?? 3671 };
    // '' means "not configured" in the plugin config, so treat it as absent.
    this.captureDir = (captureDir && String(captureDir).trim()) || path.join(os.homedir(), '.dsh', 'knx-library', 'captures');
    this.advertise = advertise;
    this.socket = null;
    this.channels = new Map(); // our channel -> { socket, upstreamChannel, client, layer }
    this.byClient = new Map(); // "ip:port" -> our channel
    this.nextChannel = 1;
    this.captureFile = null;
    this.captureStream = null;
    this.stats = {
      framesFromClient: 0, framesToClient: 0, connects: 0,
      discarded: 0, dropped: 0, errors: [], startedAt: null, capturePath: null,
      boundTo: null, refusedChannels: 0, sweptChannels: 0,
    };
  }

  get running() {
    return Boolean(this.socket);
  }

  /** Start listening, join the KNXnet/IP multicast group, open the capture file. */
  async start() {
    if (this.socket) return this.status();
    fs.mkdirSync(this.captureDir, { recursive: true });
    this.captureFile = path.join(this.captureDir, `proxy-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
    this.captureStream = fs.createWriteStream(this.captureFile, { flags: 'a' });
    this.socket = await bindSocket(this.listenPort, this.bind);
    this.listenPort = this.socket.address().port;
    this.stats.boundTo = `${this.bind}:${this.listenPort}`;
    if (!/^(127\.|::1$|localhost$)/.test(this.bind)) {
      this.stats.errors.push(`bound to ${this.bind}: every host on that network can use this proxy as a KNX gateway`);
    }
    this.sweeper = setInterval(() => this.sweepChannels(), 60000);
    this.sweeper.unref?.();
    try {
      this.socket.addMembership('224.0.23.12');
    } catch (error) {
      // Multicast may be unavailable on a given interface; unicast search still works.
      this.stats.errors.push(`multicast join failed: ${error.message}`);
    }
    this.socket.on('message', (buf, rinfo) => {
      try {
        this.onClientPacket(buf, rinfo);
      } catch (error) {
        this.stats.errors.push(`client: ${error.message}`);
      }
    });
    this.socket.on('error', (error) => { this.stats.errors.push(`socket: ${error.message}`); });
    this.stats.startedAt = nowIso();
    this.stats.capturePath = this.captureFile;
    this.status();
    return this.status();
  }

  /** Stop forwarding, close channels and flush the capture file. */
  async stop() {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    for (const channel of this.channels.values()) {
      try { channel.socket.close(); } catch { /* ignore */ }
    }
    this.channels.clear();
    this.byClient.clear();
    if (this.socket) {
      try {
        this.socket.dropMembership('224.0.23.12');
      } catch { /* ignore */ }
      try { this.socket.close(); } catch { /* ignore */ }
      this.socket = null;
    }
    if (this.captureStream) {
      await new Promise((resolve) => this.captureStream.end(resolve));
      this.captureStream = null;
    }
    return this.status();
  }

  status() {
    return {
      ok: true,
      running: this.running,
      listenPort: this.listenPort,
      upstream: this.upstream,
      capturePath: this.stats.capturePath,
      channels: [...this.channels.entries()].map(([channel, info]) => ({
        channel,
        upstreamChannel: info.upstreamChannel,
        client: `${info.client.address}:${info.client.port}`,
        layer: info.layer,
      })),
      stats: {
        framesFromClient: this.stats.framesFromClient,
        framesToClient: this.stats.framesToClient,
        connects: this.stats.connects,
        refusedChannels: this.stats.refusedChannels,
        sweptChannels: this.stats.sweptChannels,
        droppedCaptureLines: this.stats.dropped,
        boundTo: this.stats.boundTo,
        errors: this.stats.errors.slice(-10),
        startedAt: this.stats.startedAt,
      },
    };
  }

  // ------------------------------------------------------------------ client
  onClientPacket(buf, rinfo) {
    if (buf.length < 6) return;
    const service = buf.readUInt16BE(2);
    const body = buf.subarray(6);
    switch (service) {
      case knxip.SVC.SEARCH_REQUEST:
        this.replySearch(rinfo);
        return;
      case knxip.SVC.DESCRIPTION_REQUEST:
        this.replyDescription(rinfo);
        return;
      case knxip.SVC.CONNECT_REQUEST:
        this.openChannel(buf, rinfo).catch((error) => this.stats.errors.push(`connect: ${error.message}`));
        return;
      case knxip.SVC.TUNNELLING_REQUEST:
      case knxip.SVC.TUNNELLING_ACK:
      case knxip.SVC.CONNECTIONSTATE_REQUEST:
      case knxip.SVC.DISCONNECT_REQUEST:
        this.forwardToUpstream(buf, rinfo);
        return;
      default:
        this.stats.discards += 1;
    }
  }

  replySearch(rinfo) {
    const payload = Buffer.concat([
      knxip.hpai(this.advertisedHost(rinfo.address), this.listenPort),
      deviceInfoDib(this.listenPort),
      Buffer.from([0x04, 0x02, 0x02, 0x01]), // core 2.x, tunnelling, routing, device management
    ]);
    this.send(this.socket, Buffer.concat([knxip.header(knxip.SVC.SEARCH_RESPONSE, payload.length), payload]), rinfo);
  }

  replyDescription(rinfo) {
    const payload = Buffer.concat([
      knxip.hpai(this.advertisedHost(rinfo.address), this.listenPort),
      deviceInfoDib(this.listenPort),
    ]);
    this.send(this.socket, Buffer.concat([knxip.header(knxip.SVC.DESCRIPTION_RESPONSE, payload.length), payload]), rinfo);
  }

  advertisedHost(clientAddress) {
    if (this.advertise) return this.advertise;
    if (clientAddress && !clientAddress.startsWith('127.')) {
      // Best effort: the address ETS reached us on is the one it can answer.
      return clientAddress;
    }
    return '127.0.0.1';
  }

  /** Open one upstream channel per client connection and remap the ids. */
  async openChannel(request, rinfo) {
    if (this.channels.size >= this.maxChannels) {
      // Refuse instead of growing unbounded: each channel owns a socket upstream.
      this.stats.refusedChannels += 1;
      this.sendConnectError(rinfo, 0x24); // E_NO_MORE_CONNECTIONS
      return;
    }
    const upstreamSocket = await bindSocket(0, '0.0.0.0');
    const local = upstreamSocket.address();
    const body = request.subarray(6);
    const layer = body.length > 18 ? body[18] : knxip.LAYER.LINK;
    const connect = Buffer.concat([
      knxip.hpai('0.0.0.0', 0),
      knxip.hpai('0.0.0.0', 0),
      Buffer.from([0x04, body[17] ?? knxip.CONN.TUNNEL, layer, 0x00]),
    ]);
    // Never reuse a channel id that is still live: the client would be mapped onto
    // somebody else's socket.
    let channel = this.nextChannel;
    for (let attempt = 0; attempt < 250 && this.channels.has(channel); attempt += 1) {
      channel = (channel % 250) + 1;
    }
    this.nextChannel = (channel % 250) + 1;

    const reply = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 4000);
      upstreamSocket.once('message', (buf) => {
        clearTimeout(timer);
        resolve(buf);
      });
      upstreamSocket.send(
        Buffer.concat([knxip.header(knxip.SVC.CONNECT_REQUEST, connect.length), connect]),
        this.upstream.port, this.upstream.host,
      );
    });
    if (!reply || reply.readUInt16BE(2) !== knxip.SVC.CONNECT_RESPONSE) {
      try { upstreamSocket.close(); } catch { /* ignore */ }
      this.sendConnectError(rinfo, 0x26); // E_DATA_CONNECTION
      return;
    }
    const upstreamChannel = reply[6];
    const status = reply[7];
    if (status !== 0) {
      try { upstreamSocket.close(); } catch { /* ignore */ }
      this.sendConnectError(rinfo, status);
      return;
    }
    this.channels.set(channel, { socket: upstreamSocket, upstreamChannel, client: rinfo, layer, lastSeen: Date.now() });
    this.byClient.set(`${rinfo.address}:${rinfo.port}`, channel);
    upstreamSocket.on('message', (buf) => {
      try {
        this.onUpstreamPacket(channel, buf);
      } catch (error) {
        this.stats.errors.push(`upstream: ${error.message}`);
      }
    });
    upstreamSocket.on('error', (error) => this.stats.errors.push(`upstream socket: ${error.message}`));

    // Point the client at us: its data endpoint must stay on the proxy.
    const payload = Buffer.concat([
      Buffer.from([channel, 0x00]),
      knxip.hpai(this.advertisedHost(rinfo.address), this.listenPort),
      Buffer.from([0x04, 0x04, layer, 0x00]),
    ]);
    this.send(this.socket, Buffer.concat([knxip.header(knxip.SVC.CONNECT_RESPONSE, payload.length), payload]), rinfo);
    this.stats.connects += 1;
    this.log({ event: 'connect', channel, upstreamChannel, layer, client: `${rinfo.address}:${rinfo.port}` });
  }

  sendConnectError(rinfo, status) {
    const payload = Buffer.concat([
      Buffer.from([0x00, status]),
      knxip.hpai(this.advertisedHost(rinfo.address), this.listenPort),
      Buffer.from([0x04, 0x04, 0x02, 0x00]),
    ]);
    this.send(this.socket, Buffer.concat([knxip.header(knxip.SVC.CONNECT_RESPONSE, payload.length), payload]), rinfo);
  }

  forwardToUpstream(buf, rinfo) {
    const channelId = this.byClient.get(`${rinfo.address}:${rinfo.port}`);
    const channel = channelId ? this.channels.get(channelId) : null;
    if (!channel) {
      this.stats.discards += 1;
      return;
    }
    channel.lastSeen = Date.now();
    const service = buf.readUInt16BE(2);
    const body = Buffer.from(buf.subarray(6));
    if (body.length >= 2) body[1] = channel.upstreamChannel; // channel id only
    if (service === knxip.SVC.TUNNELLING_REQUEST) this.record(channelId, 'from-client', body.subarray(4));
    if (service === knxip.SVC.DISCONNECT_REQUEST) {
      this.channels.delete(channelId);
      this.byClient.delete(`${rinfo.address}:${rinfo.port}`);
    }
    const packet = Buffer.concat([knxip.header(service, body.length), body]);
    channel.socket.send(packet, this.upstream.port, this.upstream.host);
  }

  onUpstreamPacket(channelId, buf) {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    if (buf.length < 6) return;
    channel.lastSeen = Date.now();
    const service = buf.readUInt16BE(2);
    const body = Buffer.from(buf.subarray(6));
    if (body.length >= 2) body[1] = channelId; // our channel id for this client
    if (service === knxip.SVC.TUNNELLING_REQUEST) this.record(channelId, 'to-client', body.subarray(4));
    const packet = Buffer.concat([knxip.header(service, body.length), body]);
    this.send(this.socket, packet, channel.client);
    if (service === knxip.SVC.DISCONNECT_REQUEST) {
      this.channels.delete(channelId);
      try { channel.socket.close(); } catch { /* ignore */ }
    }
  }

  /** Close channels whose client vanished without a DISCONNECT_REQUEST. */
  sweepChannels() {
    const cutoff = Date.now() - this.channelIdleMs;
    for (const [channelId, channel] of [...this.channels]) {
      if (channel.lastSeen >= cutoff) continue;
      this.channels.delete(channelId);
      this.byClient.delete(`${channel.client.address}:${channel.client.port}`);
      try { channel.socket.close(); } catch { /* ignore */ }
      this.stats.sweptChannels += 1;
      this.log({ event: 'sweep', channel: channelId, reason: 'idle' });
    }
  }

  // ----------------------------------------------------------------- capture
  record(channel, direction, cemiBytes) {
    if (direction === 'from-client') this.stats.framesFromClient += 1;
    else this.stats.framesToClient += 1;
    const frame = cemi.parse(cemiBytes);
    const entry = {
      ts: nowIso(),
      channel,
      direction,
      cemi: Buffer.from(cemiBytes).toString('hex'),
      service: frame?.service ?? null,
      src: frame?.srcIA ?? null,
      dst: frame?.dstText ?? null,
      group: frame?.group ?? null,
      summary: frame ? cemi.describeFrame(frame) : null,
    };
    this.log(entry);
  }

  log(entry) {
    if (!this.captureStream) return;
    // A busy bus must not grow an unbounded write buffer; drop with a counter and
    // keep forwarding, because forwarding is the job and the capture is the record.
    if (this.captureStream.writableLength > 4 * 1024 * 1024) {
      this.stats.dropped += 1;
      return;
    }
    this.captureStream.write(`${JSON.stringify(entry)}\n`);
  }

  send(socket, packet, rinfo) {
    if (!socket) return;
    try {
      socket.send(packet, rinfo.port, rinfo.address);
    } catch (error) {
      this.stats.errors.push(`send: ${error.message}`);
    }
  }
}

/** Read a proxy capture file into the frame list `captureToRecipe` consumes. */
export function readCapture(filePath, { direction = 'from-client', maxBytes = 64 * 1024 * 1024 } = {}) {
  const stat = fs.statSync(filePath);
  if (stat.size > maxBytes) {
    throw new Error(`capture ${filePath} is ${stat.size} bytes, above the ${maxBytes} byte read limit`);
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const frames = [];
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a truncated last line must not lose the rest of the capture
    }
    if (entry.event) {
      events.push(entry);
      continue;
    }
    if (entry.direction !== direction || !entry.cemi) continue;
    const parsed = cemi.parse(Buffer.from(entry.cemi, 'hex'));
    if (parsed) frames.push({ ...parsed, ts: entry.ts, channel: entry.channel });
  }
  return { frames, events, path: filePath };
}
