/**
 * The local KNX library: imported product data and projects, and the link between them.
 *
 * Why a library and not "parse the file every time": a commissioning job keeps the
 * product data (what each parameter's address is) next to the project (which device
 * uses which product at which individual address). Resolving that pair is what turns
 * "I want dimming time = 300" into a memory write at a verified address.
 *
 * Everything is plain JSON on disk, in a directory the operator can inspect, diff
 * and archive. Nothing here talks to a bus.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { readZip, parseProject } from './project.js';
import { encodeBits, parseProductData } from './knxprod.js';

export { encodeBits } from './knxprod.js';
import { validate as validateRecipe } from './recipe.js';

export const LIBRARY_VERSION = 1;

function slug(text) {
  return String(text ?? '')
    .replace(/\.[^.]+$/, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'entry';
}

function digest(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12);
}

export class KnxLibrary {
  constructor(directory) {
    this.dir = directory ?? path.join(os.homedir(), '.dsh', 'knx-library');
    this.indexPath = path.join(this.dir, 'index.json');
  }

  async ensure() {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.mkdir(path.join(this.dir, 'entries'), { recursive: true });
  }

  async readIndex() {
    try {
      const raw = await fs.readFile(this.indexPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.entries) return parsed;
    } catch { /* missing or unreadable: start empty */ }
    return { version: LIBRARY_VERSION, entries: {} };
  }

  async writeIndex(index) {
    await this.ensure();
    await fs.writeFile(this.indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
    return index;
  }

  entryPath(id) {
    return path.join(this.dir, 'entries', `${id.replace(/[^\w.-]+/g, '_')}.json`);
  }

  /** Import a .knxprod or .knxproj file; re-importing the same bytes is idempotent. */
  async importFile(filePath, options = {}) {
    const buffer = await fs.readFile(filePath);
    const hash = digest(buffer);
    const lower = filePath.toLowerCase();
    let entry;
    if (lower.endsWith('.knxprod')) {
      entry = parseProductData(buffer, { name: slug(path.basename(filePath)) });
      entry.kind = 'knxprod';
    } else if (lower.endsWith('.knxproj')) {
      const project = parseProject(buffer, { name: slug(path.basename(filePath)) });
      entry = {
        kind: 'knxproj',
        name: project.name,
        summary: project.summary,
        devices: project.devices.map((device) => ({
          id: device.id,
          ia: device.ia ?? null,
          iaText: device.iaText ?? '',
          name: device.name,
          comment: device.comment ?? '',
          productRef: device.productRef ?? '',
          applicationRef: device.applicationRef ?? '',
          parameterValues: device.parameterValues ?? {},
          comObjects: device.comObjects ?? [],
        })),
        groupAddresses: project.groupAddresses,
      };
    } else {
      throw new Error(`unsupported file ${path.basename(filePath)}: expected .knxprod or .knxproj`);
    }

    const id = `${entry.kind}:${slug(entry.name)}:${hash}`;
    entry.id = id;
    entry.source = path.resolve(filePath);
    entry.importedAt = new Date().toISOString();
    entry.size = buffer.length;

    await this.ensure();
    await fs.writeFile(this.entryPath(id), `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
    const index = await this.readIndex();
    index.entries[id] = {
      id,
      kind: entry.kind,
      name: entry.name,
      source: entry.source,
      importedAt: entry.importedAt,
      size: entry.size,
      summary: entry.summary,
    };
    await this.writeIndex(index);
    return { ok: true, id, kind: entry.kind, name: entry.name, summary: entry.summary, source: entry.source };
  }

  async list() {
    const index = await this.readIndex();
    const entries = Object.values(index.entries).sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1));
    return {
      directory: this.dir,
      count: entries.length,
      products: entries.filter((entry) => entry.kind === 'knxprod'),
      projects: entries.filter((entry) => entry.kind === 'knxproj'),
    };
  }

  async read(id) {
    const raw = await fs.readFile(this.entryPath(id), 'utf8');
    return JSON.parse(raw);
  }

  async show(id, { detail = 'summary' } = {}) {
    const entry = await this.read(id);
    if (detail === 'full') return { ok: true, entry };
    if (entry.kind === 'knxprod') {
      return {
        ok: true,
        entry: {
          ...entry,
          applications: entry.applications.map((application) => ({
            id: application.id,
            name: application.name,
            maskVersion: application.maskVersion,
            memory: application.memory,
            segments: application.segments.length,
            parameters: application.parameters.slice(0, 80),
            comObjects: application.comObjects.length,
          })),
        },
      };
    }
    return { ok: true, entry };
  }

  async forget(id) {
    const index = await this.readIndex();
    if (!index.entries[id]) return { ok: false, error: `no library entry ${id}` };
    delete index.entries[id];
    await this.writeIndex(index);
    try { await fs.unlink(this.entryPath(id)); } catch { /* file already gone */ }
    return { ok: true, removed: id };
  }

  /**
   * Resolve a project device to its product, application program and memory map.
   * Accepts either an explicit ia or the first device of a single imported project.
   */
  async resolve({ projectId = null, ia = null } = {}) {
    const index = await this.readIndex();
    const projects = Object.values(index.entries).filter((entry) => entry.kind === 'knxproj');
    const products = Object.values(index.entries).filter((entry) => entry.kind === 'knxprod');
    // Default to the most recently imported project: a field engineer expects the
    // project they just imported to be the one used, and the answer says which one
    // was chosen instead of failing when several are present.
    const newest = [...projects].sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1))[0] ?? null;
    const projectEntry = projectId
      ? projects.find((entry) => entry.id === projectId)
      : newest;
    if (!projectEntry) {
      return {
        ok: false,
        error: projectId
          ? `no imported project ${projectId}`
          : 'import a project first (knx_import with a .knxproj)',
        projects,
      };
    }
    const project = await this.read(projectEntry.id);
    const device = ia
      ? project.devices.find((candidate) => candidate.iaText === ia)
      : project.devices.find((candidate) => candidate.ia !== null);
    if (!device) {
      return { ok: false, error: `no device ${ia ?? '(first addressable device)'} in ${projectEntry.name}` };
    }

    // The project references product data through two id chains: the product
    // instance ("M-0002_H-0003_P-0004") and the hardware-2-program
    // ("M-0002_H-0003_HP-0004"). Either one identifies the application program.
    let matched = null;
    let application = null;
    let via = null;
    for (const candidate of products) {
      const entry = await this.read(candidate.id);
      const product = entry.products.find((item) => item.id && item.id === device.productRef);
      if (product) {
        matched = { entry: candidate, product };
        via = 'productRefId';
        const program = (entry.hardware2Programs ?? []).find((item) => item.id === device.applicationRef);
        const appId = program?.applicationProgramIds?.[0] ?? product.applicationProgramIds?.[0];
        application = entry.applications.find((item) => item.id === appId) ?? entry.applications[0] ?? null;
        break;
      }
      const program = (entry.hardware2Programs ?? []).find((item) => item.id === device.applicationRef);
      if (program) {
        matched = { entry: candidate, product: null };
        via = 'hardware2ProgramRefId';
        application = entry.applications.find((item) => item.id === program.applicationProgramIds[0]) ?? null;
        break;
      }
    }

    return {
      ok: true,
      via,
      project: {
        id: projectEntry.id,
        name: projectEntry.name,
        importedAt: projectEntry.importedAt,
        selection: projectId ? 'explicit' : 'newest',
        importedProjects: projects.length,
      },
      device,
      product: matched?.product ?? null,
      productEntry: matched?.entry ?? null,
      application,
      groupAddresses: project.groupAddresses,
    };
  }

  /**
   * Build a download recipe for parameter overrides.
   *
   * Parameters that do not fill a whole octet go through `memory_patch`, which
   * reads the octets, changes the bits and writes them back: writing a whole block
   * with zeros would clobber every neighbouring parameter.
   */
  async buildDownload({
    applicationId, values = {}, ia, chunk = 11, restart = false,
    useProjectValues = false, projectId = null,
  } = {}) {
    let resolvedDevice = null;
    if (useProjectValues) {
      // Take the values the project was commissioned with, mapped from the
      // project's ParameterInstanceRef ids to the product's parameter ids.
      const resolved = await this.resolve({ projectId, ia });
      if (!resolved.ok) return resolved;
      resolvedDevice = resolved.device;
      const app = resolved.application;
      if (!app) return { ok: false, error: 'device resolves to a product without an application program' };
      const refToParameter = new Map((app.parameterRefs ?? []).map((ref) => [ref.id, ref.refId]));
      const merged = { ...values };
      for (const [refId, raw] of Object.entries(resolvedDevice.parameterValues ?? {})) {
        const parameterId = refToParameter.get(refId) ?? refId;
        if (merged[parameterId] === undefined) merged[parameterId] = raw;
      }
      values = merged;
      if (applicationId === undefined || applicationId === null) applicationId = app.id;
    }
    const entry = await this.findApplication(applicationId);
    if (!entry) return { ok: false, error: `no application program ${applicationId ?? '(none imported)'}` };
    const { application, entryId } = entry;

    const steps = [];
    const plan = [];
    const warnings = [];
    for (const [key, rawValue] of Object.entries(values)) {
      const wanted = String(key).trim().toLowerCase();
      const parameter = application.parameters.find((item) => item.id === key)
        ?? application.parameters.find((item) => String(item.name).trim().toLowerCase() === wanted);
      if (!parameter) {
        warnings.push(`unknown parameter ${JSON.stringify(key)}`);
        continue;
      }
      if (parameter.address === null || parameter.address === undefined) {
        warnings.push(`parameter ${parameter.id || parameter.name} has no resolved address (${parameter.unresolved ?? 'unknown'})`);
        continue;
      }
      const bits = parameter.bits ?? 8;
      const { buffer } = encodeBits(rawValue, bits, parameter.bitOffset ?? 0);
      if (parameter.bitOffset === 0 && bits % 8 === 0 && buffer.length * 8 === bits) {
        for (let offset = 0; offset < buffer.length; offset += chunk) {
          steps.push({
            op: 'memory_write',
            address: `0x${(parameter.address + offset).toString(16)}`,
            data: buffer.subarray(offset, offset + chunk).toString('hex'),
          });
        }
      } else {
        steps.push({
          op: 'memory_patch',
          address: `0x${parameter.address.toString(16)}`,
          count: buffer.length,
          bitOffset: parameter.bitOffset ?? 0,
          bits,
          value: rawValue,
        });
      }
      plan.push({
        parameter: parameter.id || parameter.name,
        name: parameter.name,
        address: `0x${parameter.address.toString(16)}`,
        bits,
        bitOffset: parameter.bitOffset ?? 0,
        value: rawValue,
        bytes: buffer.toString('hex'),
      });
    }

    if (!steps.length) {
      return { ok: false, error: 'nothing to write: no parameter resolved', warnings, application: application.id };
    }
    if (restart) steps.push({ op: 'restart', master: false });
    steps.push({
      op: 'note',
      text: `rebuilt from ${entryId} for ${application.name || application.id} (${plan.length} parameter(s)); verify with the read-back steps`,
    });

    const recipe = validateRecipe({
      schema: 'knxagent.download/1',
      device: { ia: ia ?? null },
      options: { chunk },
      source: `library:${entryId}`,
      steps,
    });
    return {
      ok: true,
      application: { id: application.id, name: application.name, maskVersion: application.maskVersion },
      device: resolvedDevice
        ? { ia: resolvedDevice.iaText, name: resolvedDevice.name, source: 'project' }
        : null,
      projectValues: resolvedDevice ? Object.keys(resolvedDevice.parameterValues ?? {}).length : 0,
      plan,
      warnings,
      recipe,
    };
  }

  async findApplication(applicationId) {
    const index = await this.readIndex();
    for (const summary of Object.values(index.entries)) {
      if (summary.kind !== 'knxprod') continue;
      const entry = await this.read(summary.id);
      const application = applicationId
        ? entry.applications.find((item) => item.id === applicationId)
        : entry.applications[0];
      if (application) return { application, entryId: summary.id };
    }
    return null;
  }
}
