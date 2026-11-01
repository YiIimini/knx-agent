/**
 * Group table profiles, keyed by product identity.
 *
 * A profile answers the one question the protocol does not: *where* in this
 * device's memory are the group address table and the association table, and how
 * wide are their slots. It is device-family knowledge, learned once from a
 * recorded ETS "download group addresses" pass, then reused for every device of
 * the same product - which is what makes "move a point, rewrite the table" a one
 * command operation instead of a recording session.
 *
 * Lookup order is order number -> application program id -> mask version, most
 * specific first: two products can share a mask but not a table address.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { SYSTEM_B } from './gatable.js';

export const PROFILE_STORE_VERSION = 1;

function normaliseKey(value) {
  return String(value ?? '').trim();
}

/** Ordered lookup keys for a resolved device, most specific first. */
export function identityKeys({ product, application } = {}) {
  const keys = [];
  if (product?.orderNumber) keys.push({ kind: 'order', key: `order:${normaliseKey(product.orderNumber)}` });
  if (application?.id) keys.push({ kind: 'application', key: `application:${normaliseKey(application.id)}` });
  if (application?.maskVersion) keys.push({ kind: 'mask', key: `mask:${normaliseKey(application.maskVersion)}` });
  return keys;
}

export class TableProfileStore {
  constructor(directory) {
    this.dir = (directory && String(directory).trim()) || path.join(os.homedir(), '.dsh', 'knx-library');
    this.file = path.join(this.dir, 'grouptable-profiles.json');
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (parsed && parsed.profiles) return parsed;
    } catch { /* missing: start empty */ }
    return { version: PROFILE_STORE_VERSION, profiles: {} };
  }

  async save(store) {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.file, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    return store;
  }

  async put(keys, profile, meta = {}) {
    const store = await this.load();
    const now = new Date().toISOString();
    const saved = [];
    for (const { kind, key } of keys) {
      const existing = store.profiles[key] ?? { key, createdAt: now, uses: 0 };
      store.profiles[key] = {
        ...existing,
        key,
        kind,
        profile: { ...profile },
        source: meta.source ?? existing.source ?? 'calibrated',
        device: meta.device ?? existing.device ?? null,
        updatedAt: now,
      };
      saved.push(key);
    }
    await this.save(store);
    return { saved, file: this.file };
  }

  /** First profile that matches this device, most specific key first. */
  async find(keys) {
    const store = await this.load();
    for (const { kind, key } of keys) {
      const entry = store.profiles[key];
      if (entry) return { ...entry, matchedBy: kind };
    }
    return null;
  }

  async touch(key) {
    try {
      const store = await this.load();
      if (!store.profiles[key]) return;
      store.profiles[key].uses = (store.profiles[key].uses ?? 0) + 1;
      store.profiles[key].lastUsedAt = new Date().toISOString();
      await this.save(store);
    } catch { /* usage accounting never fails a commissioning run */ }
  }

  async list() {
    const store = await this.load();
    const entries = Object.values(store.profiles).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return { file: this.file, count: entries.length, entries };
  }

  async forget(key) {
    const store = await this.load();
    if (!store.profiles[key]) return { ok: false, error: `no profile ${key}` };
    delete store.profiles[key];
    await this.save(store);
    return { ok: true, removed: key };
  }
}

/** Merge a stored profile over the built-in default, keeping unknown fields. */
export function withProfile(stored, overrides = {}) {
  return {
    ...SYSTEM_B,
    ...(stored?.profile ?? {}),
    ...(overrides ?? {}),
  };
}
