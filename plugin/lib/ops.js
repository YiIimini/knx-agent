/**
 * Application operations, one implementation with two callers.
 *
 * The agent tools (`lib/tools.js`) and the panel's HTTP bridge (`lib/http.js`)
 * both go through this module, so a commissioning action has exactly one
 * behaviour, one set of failure reasons and one audit record - the UI cannot
 * drift from what the model can do.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as cemi from './cemi.js';
import * as dpt from './dpt.js';
import * as knxip from './knxip.js';
import { captureToRecipe, DownloadRunner, validate as validateRecipe } from './recipe.js';
import { parseProject, parseProductDatabase } from './project.js';
import { diagnose } from './diagnose.js';
import { readCapture } from './proxy.js';
import { SYSTEM_B, buildTableRecipe, buildTables, inferProfile } from './gatable.js';
import { identityKeys, withProfile } from './profiles.js';
import { runAcceptance } from './accept.js';
import { calibrateEncoding, checkableParameters, describeCalibration } from './calibrate.js';

export class PolicyError extends Error {}

function assertWritable(runtime, operation) {
  if (runtime.config.allowWrites === false) {
    throw new PolicyError(`${operation} is disabled: this profile sets allowWrites=false (read-only commissioning mode)`);
  }
}

async function session(runtime, params = {}) {
  if (!runtime.link) await runtime.connect(params);
  return runtime;
}

export const ops = {
  async state(runtime) {
    return {
      ok: true,
      connection: runtime.describeConnection(),
      simulator: runtime.simulatorInfo(),
      config: {
        gateway: runtime.config.gateway ?? '',
        layer: runtime.config.layer ?? 'link',
        allowWrites: runtime.config.allowWrites !== false,
      },
      audit: runtime.audit.slice(-30),
    };
  },

  async connect(runtime, params = {}) {
    const info = await runtime.connect(params);
    return { ok: true, ...info };
  },

  async disconnect(runtime) {
    await runtime.close();
    return { ok: true, connected: false };
  },

  async search(_runtime, params = {}) {
    const gateways = await knxip.search({
      timeoutMs: params.timeoutMs ?? 3000,
      multicast: params.multicast ?? true,
      unicastTargets: params.targets ?? [],
    });
    return { ok: true, count: gateways.length, gateways };
  },

  async scan(runtime, params = {}) {
    const rt = await session(runtime, params);
    const line = params.line ?? '1.1';
    const devices = await rt.needLink().scan(line, {
      start: params.start ?? 0,
      end: params.end ?? 256,
      window: params.window ?? 48,
      settleMs: runtime.config.scanSettleMs ?? 600,
    });
    return { ok: true, line, count: devices.length, devices };
  },

  async deviceInfo(runtime, params = {}) {
    const rt = await session(runtime, params);
    const ia = cemi.parseIA(params.ia);
    const descriptor = await rt.needLink().descriptorRead(ia);
    return {
      ok: descriptor !== null,
      ia: params.ia,
      descriptor: descriptor === null ? null : `0x${descriptor.toString(16).toUpperCase().padStart(4, '0')}`,
      serial: params.serial ? await rt.needLink().serialNumber() : undefined,
    };
  },

  async memoryRead(runtime, params = {}) {
    const rt = await session(runtime, params);
    const value = await rt.needLink().memoryRead(cemi.parseIA(params.ia), Number(params.address), Number(params.count));
    if (!value) return { ok: false, ia: params.ia, error: 'no answer from device' };
    return { ok: true, ia: params.ia, address: params.address, count: value.length, data: value.toString('hex') };
  },

  async memoryWrite(runtime, params = {}) {
    assertWritable(runtime, 'knx_memory_write');
    const rt = await session(runtime, params);
    const data = Buffer.from(String(params.data).replace(/^0x/i, '').replace(/\s/g, ''), 'hex');
    const ok = await rt.needLink().memoryWrite(cemi.parseIA(params.ia), Number(params.address), data);
    return { ok, ia: params.ia, address: params.address, octets: data.length };
  },

  async propertyRead(runtime, params = {}) {
    const rt = await session(runtime, params);
    const value = await rt.needLink().propertyRead(cemi.parseIA(params.ia), params.object ?? 1,
      Number(params.property), { count: params.count ?? 1, startIndex: params.start ?? 1 });
    if (!value) return { ok: false, ia: params.ia, error: 'no answer' };
    return { ok: true, ia: params.ia, property: params.property, data: value.toString('hex') };
  },

  async gaRead(runtime, params = {}) {
    const rt = await session(runtime, params);
    const response = await rt.needBus().read(cemi.parseGA(params.ga), { timeoutMs: params.timeoutMs ?? 2000 });
    if (!response) return { ok: false, ga: params.ga, error: 'no response' };
    const raw = response.value ?? Buffer.alloc(0);
    const dptId = params.dpt ?? '1.001';
    return { ok: true, ga: params.ga, dpt: dptId, value: dpt.decode(dptId, raw), raw: raw.toString('hex'), source: response.srcIA };
  },

  async gaWrite(runtime, params = {}) {
    assertWritable(runtime, 'knx_ga_write');
    const rt = await session(runtime, params);
    const dptId = params.dpt ?? '1.001';
    const raw = dpt.encode(dptId, params.value);
    const ok = await rt.needBus().write(cemi.parseGA(params.ga), raw);
    return { ok, ga: params.ga, dpt: dptId, raw: raw.toString('hex') };
  },

  async monitor(runtime, params = {}) {
    const rt = await session(runtime, params);
    const seconds = params.seconds ?? 5;
    const frames = await rt.needBus().listen(seconds, params.groupOnly ? (frame) => frame.group : null);
    return {
      ok: true,
      seconds,
      count: frames.length,
      frames: frames.map((frame) => ({
        src: frame.srcIA,
        dst: frame.dstText,
        group: frame.group,
        service: frame.service,
        value: frame.value ? Buffer.from(frame.value).toString('hex') : '',
        conError: frame.conError,
        hopCount: frame.hopCount,
      })),
    };
  },

  async download(runtime, params = {}) {
    assertWritable(runtime, 'knx_download');
    let recipe = params.recipe;
    if (!recipe && params.catalogId) {
      const applied = await runtime.catalog().apply({ id: params.catalogId, ia: params.ia ?? null });
      if (!applied.ok) throw new Error(applied.error);
      recipe = applied.recipe;
    }
    if (!recipe && params.recipePath) recipe = JSON.parse(await fs.readFile(params.recipePath, 'utf8'));
    if (!recipe) throw new Error('knx_download: pass recipe, recipePath or catalogId');
    const rt = await session(runtime, params);
    const runner = new DownloadRunner(rt.needLink(), rt.needBus(), { interStepDelayMs: 5 });
    return runner.run(recipe, { context: params.ia ? { ia: params.ia } : null, dryRun: Boolean(params.dryRun) });
  },

  async validateRecipe(_runtime, params = {}) {
    const recipe = params.recipe ?? JSON.parse(await fs.readFile(params.recipePath, 'utf8'));
    try {
      const plan = validateRecipe(recipe);
      return {
        ok: true,
        schema: plan.schema,
        device: plan.device ?? null,
        ops: plan.steps.reduce((acc, step) => {
          acc[step.op] = (acc[step.op] ?? 0) + 1;
          return acc;
        }, {}),
        steps: plan.steps.length,
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  },

  async capture(runtime, params = {}) {
    assertWritable(runtime, 'knx_capture');
    const rt = await session(runtime, params);
    const previous = rt.layer;
    if (rt.layer !== 'busmonitor') await rt.connect({ layer: 'busmonitor' });
    let frames;
    try {
      frames = await rt.needBus().listen(params.seconds ?? 60);
    } finally {
      if (previous !== 'busmonitor') await rt.connect({ layer: previous });
    }
    try {
      const recipe = captureToRecipe(frames, cemi.parseIA(params.ia));
      if (params.savePath) await fs.writeFile(params.savePath, JSON.stringify(recipe, null, 2), 'utf8');
      return { ok: true, steps: recipe.steps.length, frames: frames.length, saved: params.savePath ?? null, recipe };
    } catch (error) {
      return {
        ok: false,
        frames: frames.length,
        error: error.message,
        hint: 'start the capture first, then trigger the download (or have ETS run it) inside the window',
      };
    }
  },

  async project(_runtime, params = {}) {
    const buffer = await fs.readFile(params.path);
    if (String(params.path).toLowerCase().endsWith('.knxprod')) {
      const database = parseProductDatabase(buffer);
      return { ok: true, kind: 'knxprod', summary: database.summary, applications: database.applications };
    }
    const parsed = parseProject(buffer, { name: params.path });
    if (params.detail === 'full') return { ok: true, kind: 'knxproj', ...parsed };
    return {
      ok: true,
      kind: 'knxproj',
      summary: parsed.summary,
      devices: parsed.devices.slice(0, 50).map((device) => ({
        ia: device.iaText, name: device.name, order: device.productRef, comObjects: device.comObjects.length,
      })),
      groupAddresses: parsed.groupAddresses.slice(0, 50).map((ga) => ({
        ga: `${(ga.number >> 11) & 0x1f}/${(ga.number >> 8) & 0x07}/${ga.number & 0xff}`,
        name: ga.name, dpt: ga.dpt,
      })),
    };
  },

  async import(runtime, params = {}) {
    if (!params.path) throw new Error('knx_import: pass path to a .knxprod or .knxproj');
    const library = runtime.library();
    const result = await library.importFile(params.path);
    return { ok: true, ...result };
  },

  async library(runtime, params = {}) {
    const library = runtime.library();
    switch (params.action ?? 'list') {
      case 'list':
        return { ok: true, ...(await library.list()) };
      case 'show': {
        if (!params.id) return { ok: false, error: "knx_library action 'show' needs id" };
        return library.show(params.id, { detail: params.detail ?? 'summary' });
      }
      case 'resolve': {
        const resolved = await library.resolve({ projectId: params.projectId ?? null, ia: params.ia ?? null });
        if (!resolved.ok) return resolved;
        return {
          ok: true,
          via: resolved.via,
          project: resolved.project,
          device: resolved.device,
          product: resolved.product,
          application: resolved.application
            ? {
              id: resolved.application.id,
              name: resolved.application.name,
              maskVersion: resolved.application.maskVersion,
              memory: resolved.application.memory,
              parameters: resolved.application.parameters.map((parameter) => ({
                id: parameter.id,
                name: parameter.name,
                address: parameter.address === null ? null : `0x${parameter.address.toString(16)}`,
                bitOffset: parameter.bitOffset,
                bits: parameter.bits,
                unresolved: parameter.unresolved ?? null,
              })),
              comObjects: resolved.application.comObjects,
            }
            : null,
          productEntry: resolved.productEntry,
        };
      }
      case 'forget': {
        if (!params.id) return { ok: false, error: "knx_library action 'forget' needs id" };
        return library.forget(params.id);
      }
      default:
        return { ok: false, error: `unknown action ${JSON.stringify(params.action)}; use list | show | resolve | forget` };
    }
  },

  async buildDownload(runtime, params = {}) {
    const library = runtime.library();
    let encoding = params.encoding ?? null;
    if (!encoding) {
      // A calibrated bit/octet order is device-family knowledge: apply it when the
      // device resolves to a product we have calibrated before.
      try {
        const resolved = await library.resolve({ projectId: params.projectId ?? null, ia: params.ia ?? null });
        if (resolved.ok) {
          const stored = await runtime.profiles().findEncoding(identityKeys({
            product: resolved.product, application: resolved.application,
          }));
          if (stored) encoding = stored.encoding;
        }
      } catch { /* calibration is optional */ }
    }
    return library.buildDownload({
      applicationId: params.applicationId ?? null,
      values: params.values ?? {},
      ia: params.ia ?? null,
      restart: params.restart ?? false,
      useProjectValues: Boolean(params.useProjectValues),
      projectId: params.projectId ?? null,
      encoding,
    });
  },

  async proxy(runtime, params = {}) {
    switch (params.action ?? 'status') {
      case 'start': {
        assertWritable(runtime, 'knx_proxy');
        const status = await runtime.startProxy(params);
        return { ...status, hint: 'point ETS at this port; every telegram is written to capturePath' };
      }
      case 'stop':
        return runtime.stopProxy();
      case 'captures': {
        const directory = runtime.config.captureDir
          || path.join(os.homedir(), '.dsh', 'knx-library', 'captures');
        const files = await fs.readdir(directory).catch(() => []);
        const captures = [];
        for (const name of files.filter((entry) => entry.endsWith('.jsonl')).sort().reverse().slice(0, 40)) {
          const full = path.join(directory, name);
          const stat = await fs.stat(full).catch(() => null);
          captures.push({ path: full, name, size: stat?.size ?? 0, modified: stat?.mtime?.toISOString() ?? null });
        }
        return { ok: true, directory, captures };
      }
      default:
        return runtime.proxyStatus();
    }
  },

  async recipeFromCapture(runtime, params = {}) {
    if (!params.capturePath) throw new Error('knx_recipe_from_capture: pass capturePath');
    if (!params.ia) throw new Error('knx_recipe_from_capture: pass ia');
    const capture = readCapture(params.capturePath, { direction: params.direction ?? 'from-client' });
    try {
      const recipe = captureToRecipe(capture.frames, cemi.parseIA(params.ia));
      if (params.savePath) await fs.writeFile(params.savePath, `${JSON.stringify(recipe, null, 2)}\n`, 'utf8');
      const installed = params.install ? await this._installRecipe(runtime, recipe, params) : null;
      return {
        ok: true,
        frames: capture.frames.length,
        connects: capture.events.length,
        steps: recipe.steps.length,
        saved: params.savePath ?? null,
        catalogId: installed?.id ?? null,
        recipe,
      };
    } catch (error) {
      return { ok: false, frames: capture.frames.length, error: error.message };
    }
  },

  /** Store a freshly recorded recipe under the product it belongs to. */
  async _installRecipe(runtime, recipe, params = {}) {
    const meta = {
      orderNumber: params.orderNumber ?? null,
      applicationId: params.applicationId ?? null,
      deviceName: params.deviceName ?? null,
      source: params.source ?? 'capture',
    };
    if (!meta.orderNumber && !meta.applicationId) {
      try {
        const resolved = await runtime.library().resolve({ ia: params.ia ?? null });
        if (resolved.ok) {
          meta.orderNumber = resolved.product?.orderNumber ?? null;
          meta.applicationId = resolved.application?.id ?? null;
          meta.maskVersion = resolved.application?.maskVersion ?? null;
          meta.deviceName = resolved.device?.name ?? null;
        }
      } catch { /* enrichment is optional */ }
    }
    const installed = await runtime.catalog().install(recipe, meta);
    return { id: installed.id, reused: installed.reused };
  },

  async catalog(runtime, params = {}) {
    const catalog = runtime.catalog();
    switch (params.action ?? 'list') {
      case 'list':
        return { ok: true, ...(await catalog.list({ product: params.product ?? null })) };
      case 'install': {
        let recipe = params.recipe;
        if (!recipe && params.recipePath) recipe = JSON.parse(await fs.readFile(params.recipePath, 'utf8'));
        if (!recipe) throw new Error('knx_catalog install: pass recipe or recipePath');
        const meta = {
          orderNumber: params.orderNumber ?? null,
          applicationId: params.applicationId ?? null,
          maskVersion: params.maskVersion ?? null,
          deviceName: params.deviceName ?? null,
          source: params.source ?? 'install',
        };
        // Without an explicit product, resolve it from the imported project so the
        // entry lands under the product the field engineer will search for.
        if (!meta.orderNumber && !meta.applicationId) {
          try {
            const resolved = await runtime.library().resolve({ ia: params.ia ?? null });
            if (resolved.ok) {
              meta.orderNumber = resolved.product?.orderNumber ?? meta.orderNumber;
              meta.applicationId = resolved.application?.id ?? meta.applicationId;
              meta.maskVersion = resolved.application?.maskVersion ?? meta.maskVersion;
              meta.deviceName = resolved.device?.name ?? meta.deviceName;
            }
          } catch { /* enrichment is optional */ }
        }
        return catalog.install(recipe, meta);
      }
      case 'find': {
        const entry = await catalog.find({
          id: params.recipeId ?? null,
          orderNumber: params.orderNumber ?? null,
          applicationId: params.applicationId ?? null,
        });
        return entry ? { ok: true, entry } : { ok: false, error: 'no matching catalog entry' };
      }
      case 'apply':
        return catalog.apply({
          id: params.recipeId ?? null,
          orderNumber: params.orderNumber ?? null,
          applicationId: params.applicationId ?? null,
          ia: params.ia ?? null,
          version: params.version ?? null,
        });
      case 'versions':
        return catalog.versions(params.recipeId);
      case 'forget':
        return catalog.forget(params.recipeId);
      default:
        return { ok: false, error: `unknown action ${JSON.stringify(params.action)}; use list | install | find | apply | versions | forget` };
    }
  },

  async groupTable(runtime, params = {}) {
    const library = runtime.library();
    const profiles = runtime.profiles();
    const action = params.action ?? 'plan';

    if (action === 'profiles') {
      const listed = await profiles.list();
      if (!params.forget) return { ok: true, ...listed };
      return profiles.forget(params.forget);
    }

    const resolved = await library.resolve({ projectId: params.projectId ?? null, ia: params.ia ?? null });
    if (!resolved.ok) return resolved;
    const model = buildTables(resolved.device, resolved.application, resolved.groupAddresses);
    const keys = identityKeys({ product: resolved.product, application: resolved.application });

    if (action === 'infer') {
      if (!params.capturePath) throw new Error("knx_group_table action 'infer' needs capturePath");
      const capture = readCapture(params.capturePath);
      const inferred = inferProfile(capture.frames, model, { ia: cemi.parseIA(params.ia ?? resolved.device.iaText) });
      if (!inferred.ok) return { ...inferred, model, capture: params.capturePath };
      let persisted = null;
      if (params.save !== false && keys.length) {
        persisted = await profiles.put(keys, inferred.profile, {
          source: 'calibrated',
          device: { ia: resolved.device.iaText, name: resolved.device.name ?? null },
        });
      }
      return {
        ...inferred,
        model,
        capture: params.capturePath,
        saved: persisted ? persisted.saved : null,
        keys,
      };
    }

    // Explicit values win; otherwise fall back to the profile learned for this
    // product family, so the second device of a type needs no calibration.
    const stored = keys.length ? await profiles.find(keys) : null;
    const profile = withProfile(
      Number.isInteger(Number(params.addressBase)) || Number.isInteger(Number(params.associationBase)) ? null : stored,
      {
        ...(params.profile && typeof params.profile === 'object' ? params.profile : {}),
        ...(params.addressBase !== undefined ? { addressBase: Number(params.addressBase) } : {}),
        ...(params.associationBase !== undefined ? { associationBase: Number(params.associationBase) } : {}),
      },
    );
    const hasBases = Number.isInteger(profile.addressBase) && Number.isInteger(profile.associationBase);

    if (action === 'plan') {
      return {
        ok: true,
        model,
        profile: {
          addressBase: profile.addressBase ?? null,
          associationBase: profile.associationBase ?? null,
          leadingUnused: profile.leadingUnused,
          source: hasBases ? (stored && !params.addressBase ? `library:${stored.matchedBy}` : 'explicit') : 'none',
        },
        needsProfile: !hasBases,
        ...(hasBases ? {} : { hint: 'base addresses are device/firmware specific: calibrate once with action "infer" on a recorded ETS group-address download (add save:true to reuse it per product)' }),
      };
    }
    if (action === 'build') {
      const built = buildTableRecipe(model, { profile, ia: params.ia ?? resolved.device.iaText });
      if (built.ok && stored && !params.addressBase) await profiles.touch(stored.key);
      return {
        ...built,
        model: built.model ?? model,
        profileSource: built.ok ? (stored && !params.addressBase ? `library:${stored.matchedBy}` : 'explicit') : 'none',
      };
    }
    return { ok: false, error: `unknown action ${JSON.stringify(action)}; use plan | build | infer | profiles` };
  },

  async accept(runtime, params = {}) {
    const rt = await session(runtime, params);
    const report = await runAcceptance({
      library: runtime.library(),
      link: rt.needLink(),
      bus: rt.needBus(),
      projectId: params.projectId ?? null,
      line: params.line ?? '1.1',
      settleMs: runtime.config.scanSettleMs ?? 600,
      readValues: Boolean(params.readValues),
      expect: params.expect ?? null,
      valueTimeoutMs: params.valueTimeoutMs ?? 800,
    });
    if (report.ok && params.savePath) {
      await fs.writeFile(params.savePath, report.report, 'utf8');
      report.saved = params.savePath;
    }
    return report;
  },

  async calibrate(runtime, params = {}) {
    const iface = await session(runtime, params);
    const library = runtime.library();
    const resolved = await library.resolve({ projectId: params.projectId ?? null, ia: params.ia ?? null });
    if (!resolved.ok) return resolved;
    if (!resolved.application) return { ok: false, error: 'device resolves to a product without an application program' };
    const parameters = checkableParameters(resolved.application, resolved.device.parameterValues ?? {});
    const ia = cemi.parseIA(params.ia ?? resolved.device.iaText);
    const link = iface.needLink();
    const result = await calibrateEncoding({
      parameters,
      read: (address, count) => link.memoryRead(ia, address, count),
    });
    if (!result.ok) return result;
    let saved = null;
    if (params.save !== false) {
      saved = await runtime.profiles().putEncoding(identityKeys({
        product: resolved.product, application: resolved.application,
      }), result.encoding, { source: 'calibrated', device: { ia: resolved.device.iaText } });
    }
    return {
      ...result,
      device: { ia: resolved.device.iaText, name: resolved.device.name ?? null },
      summary: describeCalibration(result),
      saved: saved ? saved.saved : null,
    };
  },

  async diagnose(runtime, params = {}) {
    const findings = diagnose({
      scan: params.scan ?? null,
      frames: params.frames ?? null,
      failedSteps: params.failedSteps ?? null,
      transport: runtime.tunnel?.stats ?? null,
    });
    return { ok: true, findings, transport: runtime.tunnel?.stats ?? null };
  },

  async simulator(runtime, params = {}) {
    switch (params.action ?? 'status') {
      case 'start': {
        assertWritable(runtime, 'knx_simulator');
        const info = await runtime.startSimulator(params);
        return { ok: true, ...info };
      }
      case 'stop':
        return { ok: true, ...(await runtime.stopSimulator()) };
      default:
        return { ok: true, ...runtime.simulatorInfo() };
    }
  },
};

/**
 * Operations that occupy the single tunnel (or the bus monitor layer) and must run
 * one at a time. Everything else - library, catalog, project parsing, diagnostics,
 * status - is pure in-memory work and stays responsive while a capture runs.
 */
export const BUS_OPS = new Set([
  'connect', 'disconnect', 'scan', 'deviceInfo', 'memoryRead', 'memoryWrite',
  'propertyRead', 'gaRead', 'gaWrite', 'monitor', 'download', 'capture',
  'simulator', 'proxy', 'recipeFromCapture', 'accept', 'calibrate',
]);

/** Every operation the panel bridge may call, derived from this module. */
export const OP_NAMES = Object.keys(ops);
