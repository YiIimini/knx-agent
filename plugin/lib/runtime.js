/**
 * Connection state for the KNX tools: one tunnel, the management/bus facades on
 * top of it, an audit trail, and the optional in-process simulator.
 *
 * The runtime is deliberately the only mutable state in the plugin. Tools read
 * it, never own sockets, and every call is appended to the audit trail so a
 * commissioning run can be replayed on paper.
 */

import * as cemi from './cemi.js';
import * as knxip from './knxip.js';
import { DeviceLink, GroupBus } from './link.js';
import { GatewaySim, VirtualDevice } from './simulator.js';
import { KnxLibrary } from './library.js';
import { KnxProxy } from './proxy.js';
import { RecipeCatalog } from './catalog.js';
import { TableProfileStore } from './profiles.js';

export class KnxRuntime {
  constructor(config = {}) {
    // A blank string in a patch means "not configured"; normalising once here keeps
    // every `?? default` downstream honest instead of treating '' as a value.
    this.config = Object.fromEntries(
      Object.entries(config ?? {}).filter(([, value]) => value !== '' && value !== null && value !== undefined),
    );
    this.tunnel = null;
    this.link = null;
    this.bus = null;
    this.simulator = null;
    this.audit = [];
    this.gateway = null;
    this.layer = ['busmonitor', 'routing', 'link'].includes(config.layer) ? config.layer : 'link';
    this._library = null;
    this.proxy = null;
    this._catalog = null;
    this._profiles = null;
    this._tail = Promise.resolve();
  }

  /** Imported product data and projects, persisted under `libraryPath`. */
  library() {
    if (!this._library) this._library = new KnxLibrary(this.config.libraryPath || undefined);
    return this._library;
  }

  /**
   * Run one bus operation at a time.
   *
   * The plugin holds a single tunnel with a single sequence counter, and a
   * capture temporarily reopens it on the bus monitor layer. Two concurrent
   * operations would interleave frames on that tunnel and corrupt the capture, so
   * tool calls and panel calls share this queue.
   */
  serialize(task) {
    const run = this._tail.then(task, task);
    this._tail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Saved group table profiles (table base addresses per product family). */
  profiles() {
    if (!this._profiles) this._profiles = new TableProfileStore(this.config.libraryPath || undefined);
    return this._profiles;
  }

  /** The recipe catalog: recorded downloads keyed by product identity. */
  catalog() {
    if (!this._catalog) this._catalog = new RecipeCatalog(this.config.libraryPath || undefined);
    return this._catalog;
  }

  /** Start (or return) the recording proxy that puts ETS behind a capture file. */
  async startProxy(params = {}) {
    if (this.proxy?.running) return this.proxy.status();
    const upstream = params.upstream && typeof params.upstream === 'object'
      ? params.upstream
      : { host: params.upstreamHost ?? this.config.gateway?.split(':')[0], port: Number(params.upstreamPort ?? this.config.port ?? 3671) };
    if (!upstream.host) throw new Error('knx_proxy: pass upstream {host, port} - the real KNXnet/IP interface to forward to');
    this.proxy = new KnxProxy({
      listenPort: params.port ?? this.config.proxyPort ?? 3671,
      upstream,
      captureDir: params.captureDir || this.config.captureDir || undefined,
    });
    return this.proxy.start();
  }

  async stopProxy() {
    if (!this.proxy) return { ok: true, running: false };
    const status = await this.proxy.stop();
    this.proxy = null;
    this._catalog = null;
    this._profiles = null;
    this._tail = Promise.resolve();
    return status;
  }

  proxyStatus() {
    if (!this.proxy) return { ok: true, running: false };
    return this.proxy.status();
  }

  /** Connection parameters, with the configured gateway as the default target. */
  resolveGateway(params = {}) {
    if (params.gateway) return params.gateway;
    if (this.simulator && !this.config.gateway) return `127.0.0.1:${this.simulator.port}`;
    if (this.config.gateway) {
      return this.config.gateway.includes(':') ? this.config.gateway : `${this.config.gateway}:${this.config.port ?? 3671}`;
    }
    if (this.simulator) return `127.0.0.1:${this.simulator.port}`;
    throw new Error('no gateway: pass gateway, set the plugin config, or start the simulator');
  }

  async connect(params = {}) {
    const target = this.resolveGateway(params);
    const layerName = params.layer ?? this.layer;
    if (this.tunnel && this.gateway === `${target}|${layerName}`) {
      return this.describeConnection();
    }
    await this.close();
    if (layerName === 'routing') {
      // Multicast routing: no channel, no tunnel limit, group traffic only.
      this.tunnel = await knxip.Router.open({});
    } else {
      const [host, port] = target.includes(':') ? target.split(':') : [target, '3671'];
      this.tunnel = await knxip.Tunnel.open({
        host,
        port: Number(port) || 3671,
        layer: layerName === 'busmonitor' ? knxip.LAYER.BUSMON : knxip.LAYER.LINK,
      });
    }
    this.link = new DeviceLink(this.tunnel, {
      ackTimeoutMs: this.config.ackTimeoutMs ?? 1500,
      confirmTimeoutMs: this.config.confirmTimeoutMs ?? 400,
    });
    this.bus = new GroupBus(this.tunnel, { responseTimeoutMs: this.config.responseTimeoutMs ?? 2000 });
    this.gateway = `${target}|${layerName}`;
    this.layer = layerName;
    return this.describeConnection();
  }

  describeConnection() {
    return {
      connected: Boolean(this.tunnel),
      gateway: this.gateway,
      layer: this.layer,
      transport: this.layer === 'routing' ? 'routing' : 'tunnel',
      channel: this.tunnel?.channel ?? null,
      stats: this.tunnel?.stats ?? null,
    };
  }

  needLink() {
    if (!this.link) throw new Error('not connected: call knx_connect, or start the simulator with knx_simulator');
    return this.link;
  }

  needBus() {
    if (!this.bus) throw new Error('not connected: call knx_connect, or start the simulator with knx_simulator');
    return this.bus;
  }

  async close() {
    if (this.tunnel) {
      try { await this.tunnel.close(); } catch { /* ignore */ }
    }
    this.tunnel = null;
    this.link = null;
    this.bus = null;
    this.gateway = null;
  }

  async startSimulator(params = {}) {
    if (this.simulator) return this.simulatorInfo();
    const addresses = params.devices ?? this.config.simulatorDevices ?? [
      { ia: '1.1.1', name: 'sim-actor', descriptor: 0x07b0 },
      { ia: '1.1.2', name: 'sim-dimmer', descriptor: 0x0705 },
      { ia: '1.1.3', name: 'sim-shutter', descriptor: 0x0705 },
    ];
    const devices = addresses.map((entry) => new VirtualDevice(cemi.parseIA(entry.ia), {
      name: entry.name ?? 'sim-device',
      descriptor: entry.descriptor ?? 0x07b0,
    }));
    this.simulator = await new GatewaySim({ devices, port: params.port ?? 0 }).start();
    if (params.tables && Number.isInteger(params.tables.addressBase)) {
      const { attachTablesToAll } = await import('./simulator.js');
      await attachTablesToAll(this.simulator, params.tables);
    }
    if (!this.config.gateway) await this.connect({ gateway: `127.0.0.1:${this.simulator.port}` });
    return this.simulatorInfo();
  }

  simulatorInfo() {
    return {
      running: Boolean(this.simulator),
      port: this.simulator?.port ?? null,
      gateway: this.simulator ? `127.0.0.1:${this.simulator.port}` : null,
      devices: this.simulator ? [...this.simulator.devices.values()].map((device) => ({
        ia: cemi.formatIA(device.ia),
        name: device.name,
        descriptor: device.descriptor,
      })) : [],
      managementWrites: this.simulator
        ? [...this.simulator.devices.values()].reduce((sum, d) => sum + d.memoryWriteCalls, 0) : 0,
    };
  }

  /**
   * Stop the simulator and drop a tunnel that points at it; keeping a tunnel to a
   * gateway that no longer exists turns every later tool call into a timeout.
   */
  async stopSimulator() {
    const port = this.simulator?.port ?? null;
    this.simulator?.stop();
    this.simulator = null;
    let disconnected = false;
    if (port && this.gateway && this.gateway.includes(`:${port}|`)) {
      await this.close();
      disconnected = true;
    }
    return { running: false, disconnected };
  }

  record(tool, args, result) {
    this.audit.push({ tool, args, ok: result?.ok !== false, at: new Date().toISOString() });
    if (this.audit.length > 500) this.audit.splice(0, this.audit.length - 500);
  }
}
