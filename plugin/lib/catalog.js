/**
 * The recipe catalog: one recorded download, reused forever.
 *
 * Recording is the expensive step (a Windows VM, ETS, a product database, an
 * engineer clicking Download). It must not be repeated per device or per site.
 * So every recipe is stored under a fingerprint of its *content* - the telegram
 * sequence with the target individual address and the free-text notes removed -
 * keyed by the product it belongs to. The second commissioning of the same
 * product is then a lookup, not a recording.
 *
 * Two rules keep this honest:
 * - the fingerprint covers content only, so two devices of the same type dedup to
 *   one entry while a changed parameter set produces a new one;
 * - versions are kept, never overwritten, so a recipe that worked on site last
 *   year can be reproduced after someone "improves" it.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { toBytes, validate as validateRecipe } from './recipe.js';

export const CATALOG_VERSION = 1;

function slug(text) {
  return String(text ?? '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'recipe';
}

function numberish(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return value;
  const text = String(value).trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : text.toLowerCase();
}

/**
 * Canonicalise a recipe for fingerprinting: drop the device binding, the notes and
 * any formatting difference, keep everything that changes what goes on the bus.
 */
export function canonicalise(recipe) {
  const steps = (recipe?.steps ?? [])
    .filter((step) => step && step.op && step.op !== 'note')
    .map((step) => {
      const out = { op: step.op };
      if (step.address !== undefined) out.address = numberish(step.address);
      if (step.data !== undefined) {
        try {
          out.data = toBytes(step.data).toString('hex');
        } catch {
          out.data = String(step.data).toLowerCase();
        }
      }
      for (const key of ['count', 'bitOffset', 'bits', 'value', 'ga', 'dpt', 'master',
        'object', 'property', 'seconds', 'line', 'timeout']) {
        if (step[key] !== undefined) out[key] = step[key];
      }
      return out;
    });
  return { steps, options: recipe?.options ?? {} };
}

export function fingerprint(recipe) {
  const canonical = canonicalise(recipe);
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

export class RecipeCatalog {
  constructor(directory) {
    this.dir = (directory && String(directory).trim()) || path.join(os.homedir(), '.dsh', 'knx-library');
    this.indexPath = path.join(this.dir, 'catalog.json');
    this.recipeDir = path.join(this.dir, 'recipes');
  }

  async ensure() {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.mkdir(this.recipeDir, { recursive: true });
  }

  async readIndex() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.indexPath, 'utf8'));
      if (parsed && parsed.entries) return parsed;
    } catch { /* missing: start empty */ }
    return { version: CATALOG_VERSION, entries: {} };
  }

  async writeIndex(index) {
    await this.ensure();
    await fs.writeFile(this.indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  }

  recipePath(id) {
    return path.join(this.recipeDir, `${slug(id)}.json`);
  }

  /**
   * Store a recipe. Same fingerprint under the same product = same entry (uses
   * bump, version recorded); a different fingerprint is a new version of the same
   * product, or a separate entry when the product is unknown.
   */
  async install(recipe, meta = {}) {
    const plan = validateRecipe(recipe);
    const print = fingerprint(plan);
    const product = meta.orderNumber || meta.applicationId || meta.deviceName || 'manual';
    const id = `recipe:${slug(product)}:${print.slice(0, 10)}`;
    await this.ensure();
    const index = await this.readIndex();
    const now = new Date().toISOString();
    // The index holds summaries only; the full entry (with its version history)
    // lives in its own file, so a second install must read that file back.
    let existing = null;
    if (index.entries[id]) {
      try { existing = await this.read(id); } catch { existing = null; }
    }

    const entry = existing ?? {
      id,
      orderNumber: meta.orderNumber ?? null,
      applicationId: meta.applicationId ?? null,
      maskVersion: meta.maskVersion ?? null,
      deviceName: meta.deviceName ?? null,
      fingerprint: print,
      createdAt: now,
      uses: 0,
      versions: [],
    };
    if (meta.orderNumber) entry.orderNumber = meta.orderNumber;
    if (meta.applicationId) entry.applicationId = meta.applicationId;
    if (meta.maskVersion) entry.maskVersion = meta.maskVersion;
    if (meta.deviceName) entry.deviceName = meta.deviceName;
    entry.fingerprint = print;
    entry.updatedAt = now;
    entry.source = meta.source ?? plan.source ?? 'manual';
    entry.options = plan.options ?? {};
    entry.steps = plan.steps;
    entry.versions = [
      ...(entry.versions ?? []).filter((version) => version.fingerprint !== print),
      { fingerprint: print, savedAt: now, source: entry.source, steps: plan.steps },
    ].slice(-10);

    await fs.writeFile(this.recipePath(id), `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
    index.entries[id] = {
      id,
      orderNumber: entry.orderNumber,
      applicationId: entry.applicationId,
      maskVersion: entry.maskVersion,
      deviceName: entry.deviceName,
      fingerprint: print,
      steps: entry.steps.filter((step) => step.op !== 'note').length,
      versions: entry.versions.length,
      uses: entry.uses,
      source: entry.source,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
    await this.writeIndex(index);
    return {
      ok: true,
      id,
      fingerprint: print,
      reused: Boolean(existing),
      versions: entry.versions.length,
      steps: index.entries[id].steps,
      product: entry.orderNumber ?? entry.applicationId ?? null,
    };
  }

  async list({ product = null } = {}) {
    const index = await this.readIndex();
    let entries = Object.values(index.entries);
    if (product) {
      const wanted = String(product).toLowerCase();
      entries = entries.filter((entry) =>
        [entry.orderNumber, entry.applicationId, entry.deviceName, entry.id]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(wanted)));
    }
    entries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return { directory: this.dir, count: entries.length, entries };
  }

  /** Find by explicit id, or by product/application identity. */
  async find({ id = null, orderNumber = null, applicationId = null } = {}) {
    const index = await this.readIndex();
    if (id) return index.entries[id] ? this.read(id) : null;
    const candidates = Object.values(index.entries).filter((entry) => {
      if (orderNumber && entry.orderNumber === orderNumber) return true;
      if (applicationId && entry.applicationId === applicationId) return true;
      return false;
    });
    if (!candidates.length) return null;
    candidates.sort((a, b) => (b.uses ?? 0) - (a.uses ?? 0) || (a.updatedAt < b.updatedAt ? 1 : -1));
    return this.read(candidates[0].id);
  }

  async read(id) {
    const entry = JSON.parse(await fs.readFile(this.recipePath(id), 'utf8'));
    return entry;
  }

  /** Materialise a recipe bound to a device, and remember that it was used. */
  async apply({ id = null, orderNumber = null, applicationId = null, ia = null, version = null } = {}) {
    const entry = await this.find({ id, orderNumber, applicationId });
    if (!entry) {
      return { ok: false, error: `no catalog entry for ${id ?? orderNumber ?? applicationId ?? '(nothing given)'}` };
    }
    const chosen = version
      ? entry.versions.find((item) => item.fingerprint.startsWith(version)) ?? null
      : null;
    const steps = chosen ? chosen.steps : entry.steps;
    const recipe = validateRecipe({
      schema: 'knxagent.download/1',
      device: { ia: ia ?? null, name: entry.deviceName ?? null, order: entry.orderNumber ?? null },
      options: entry.options ?? {},
      source: `catalog:${entry.id}`,
      steps,
    });
    await this.recordUse(entry.id);
    return {
      ok: true,
      id: entry.id,
      fingerprint: chosen?.fingerprint ?? entry.fingerprint,
      versions: entry.versions.map((item) => ({ fingerprint: item.fingerprint, savedAt: item.savedAt })),
      uses: (entry.uses ?? 0) + 1,
      recipe,
    };
  }

  async recordUse(id) {
    try {
      const entry = await this.read(id);
      entry.uses = (entry.uses ?? 0) + 1;
      entry.lastUsedAt = new Date().toISOString();
      await fs.writeFile(this.recipePath(id), `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
      const index = await this.readIndex();
      if (index.entries[id]) {
        index.entries[id].uses = entry.uses;
        index.entries[id].lastUsedAt = entry.lastUsedAt;
        await this.writeIndex(index);
      }
    } catch { /* usage accounting must never fail a commissioning run */ }
  }

  async forget(id) {
    const index = await this.readIndex();
    if (!index.entries[id]) return { ok: false, error: `no catalog entry ${id}` };
    delete index.entries[id];
    await this.writeIndex(index);
    try { await fs.unlink(this.recipePath(id)); } catch { /* already gone */ }
    return { ok: true, removed: id };
  }

  async versions(id) {
    const entry = await this.find({ id });
    if (!entry) return { ok: false, error: `no catalog entry ${id}` };
    return {
      ok: true,
      id: entry.id,
      current: entry.fingerprint,
      versions: entry.versions.map((item) => ({
        fingerprint: item.fingerprint,
        savedAt: item.savedAt,
        source: item.source,
        steps: item.steps.filter((step) => step.op !== 'note').length,
      })),
    };
  }
}
