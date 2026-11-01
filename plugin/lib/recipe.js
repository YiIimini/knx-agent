/**
 * Download recipes: record what ETS sends once, replay it on macOS afterwards.
 *
 * The protocol is public; the *content* of a download (the application image and
 * the parameter block composed from the manufacturer product database) is not.
 * So a full download is captured once from ETS and stored as a declarative
 * recipe; the runtime only ever executes recipes, which keeps one code path for
 * captured and hand-written downloads, and makes every step auditable.
 */

import * as cemi from './cemi.js';
import * as dpt from './dpt.js';
import { encodeBits, fieldMask } from './knxprod.js';

export const SCHEMA = 'knxagent.download/1';
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

const OPS = new Set([
  'ia_write', 'memory_write', 'memory_write_ext', 'memory_read', 'memory_expect',
  'property_write', 'property_read', 'restart', 'group_write', 'group_expect',
  'memory_patch', 'wait', 'scan', 'note',
]);

export class RecipeError extends Error {}

export function validate(recipe) {
  if (!recipe || typeof recipe !== 'object') throw new RecipeError('recipe must be an object');
  const steps = recipe.steps;
  if (!Array.isArray(steps) || steps.length === 0) throw new RecipeError("recipe needs a non-empty 'steps' array");
  steps.forEach((step, index) => {
    if (!step || typeof step !== 'object') throw new RecipeError(`step ${index} is not an object`);
    if (typeof step.op !== 'string') throw new RecipeError(`step ${index} has no 'op'`);
    if (!OPS.has(step.op)) throw new RecipeError(`step ${index}: unknown op '${step.op}'`);
  });
  return { ...recipe, schema: recipe.schema ?? SCHEMA, options: recipe.options ?? {} };
}

export function resolve(value, context) {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER, (_, key) => {
      if (!(key in context)) throw new RecipeError(`unknown placeholder {{${key}}}`);
      return String(context[key]);
    });
  }
  if (Array.isArray(value)) return value.map((item) => resolve(item, context));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, context)]));
  }
  return value;
}

export function toInt(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number') return Math.trunc(value);
  return Number(String(value).trim());
}

export function toBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  const text = String(value ?? '').replace(/[\s:]/g, '').replace(/^0x/i, '');
  if (text.length % 2) throw new RecipeError(`hex payload must have an even number of digits: ${value}`);
  return Buffer.from(text, 'hex');
}

/** Turn the captured download traffic of one device into a recipe. */
export function captureToRecipe(frames, ia) {
  const steps = [];
  for (const item of frames) {
    const frame = item?.kind === 'busmon' ? item.frame : item;
    if (!frame || frame.kind !== 'ldata') continue;
    if (frame.group) continue; // group traffic is not part of the download itself
    if (frame.dst !== ia && frame.service !== 'A_IndividualAddress_Write') continue;
    switch (frame.service) {
      case 'A_Memory_Write':
        steps.push({ op: 'memory_write', address: frame.address, data: (frame.value ?? Buffer.alloc(0)).toString('hex') });
        break;
      case 'A_MemoryExtended_Write':
        steps.push({ op: 'memory_write_ext', address: frame.address, data: (frame.value ?? Buffer.alloc(0)).toString('hex') });
        break;
      case 'A_IndividualAddress_Write':
        steps.push({ op: 'ia_write', ia: cemi.formatIA(frame.address) });
        break;
      case 'A_Restart':
        steps.push({ op: 'restart', master: Boolean(frame.masterReset) });
        break;
      default:
        break;
    }
  }
  const merged = mergeWrites(steps);
  if (!merged.length) throw new RecipeError(`no download traffic for ${cemi.formatIA(ia)} found in the capture`);
  merged.push({ op: 'note', text: `captured from ETS for ${cemi.formatIA(ia)}` });
  return validate({
    schema: SCHEMA,
    device: { ia: cemi.formatIA(ia) },
    options: {},
    source: 'capture',
    steps: merged,
  });
}

/** Splice contiguous memory writes into single blocks. */
export function mergeWrites(steps) {
  const out = [];
  let pending = null;
  for (const step of steps) {
    if (step.op !== 'memory_write' && step.op !== 'memory_write_ext') {
      if (pending) out.push(pending);
      pending = null;
      out.push(step);
      continue;
    }
    const data = Buffer.from(step.data, 'hex');
    if (pending && step.address === pending.address + Buffer.from(pending.data, 'hex').length) {
      pending.data = Buffer.concat([Buffer.from(pending.data, 'hex'), data]).toString('hex');
    } else {
      if (pending) out.push(pending);
      pending = { op: step.op, address: step.address, data: data.toString('hex') };
    }
  }
  if (pending) out.push(pending);
  return out;
}

/** Executes a recipe against one device, one step at a time, stopping on failure. */
export class DownloadRunner {
  constructor(link, bus, { interStepDelayMs = 10 } = {}) {
    this.link = link;
    this.bus = bus;
    this.interStepDelayMs = interStepDelayMs;
  }

  async run(recipe, { context = null, dryRun = false } = {}) {
    const plan = validate(recipe);
    const vars = { ...(plan.device ?? {}), ...(context ?? {}) };
    if (!vars.ia) throw new RecipeError('recipe has no device.ia');
    const ia = cemi.parseIA(vars.ia);
    const started = Date.now();
    const steps = [];
    for (const [index, rawStep] of plan.steps.entries()) {
      const step = resolve(rawStep, vars);
      const began = Date.now();
      const entry = { index, op: step.op };
      try {
        const outcome = await this.execute(ia, step, dryRun);
        entry.ok = outcome.ok;
        entry.detail = outcome.detail;
      } catch (error) {
        entry.ok = false;
        entry.detail = `${error.name}: ${error.message}`;
      }
      entry.ms = Date.now() - began;
      steps.push(entry);
      if (!entry.ok) {
        return { ok: false, device: cemi.formatIA(ia), failedStep: index, steps, seconds: (Date.now() - started) / 1000 };
      }
      if (!dryRun && this.interStepDelayMs) await new Promise((r) => setTimeout(r, this.interStepDelayMs));
    }
    return { ok: true, device: cemi.formatIA(ia), steps, seconds: (Date.now() - started) / 1000 };
  }

  async execute(ia, step, dryRun) {
    switch (step.op) {
      case 'note':
        return { ok: true, detail: step.text ?? '' };
      case 'wait':
        if (!dryRun) await new Promise((r) => setTimeout(r, Number(step.seconds ?? 1) * 1000));
        return { ok: true, detail: 'waited' };
      default:
        break;
    }
    if (dryRun) return { ok: true, detail: 'dry-run' };

    switch (step.op) {
      case 'ia_write': {
        const target = cemi.parseIA(step.ia);
        return { ok: await this.link.assignIA(target), detail: `-> ${cemi.formatIA(target)}` };
      }
      case 'memory_write': {
        const data = toBytes(step.data);
        const ok = await this.link.memoryWrite(ia, toInt(step.address), data);
        return { ok, detail: `${data.length} octets @0x${toInt(step.address).toString(16).toUpperCase()}` };
      }
      case 'memory_write_ext': {
        const data = toBytes(step.data);
        const ok = await this.link.memoryWriteExt(ia, toInt(step.address), data);
        return { ok, detail: `${data.length} octets @0x${toInt(step.address).toString(16).toUpperCase()}` };
      }
      case 'memory_read': {
        const value = await this.link.memoryRead(ia, toInt(step.address), toInt(step.count, 1));
        return { ok: value !== null, detail: value ? value.toString('hex') : 'no answer' };
      }
      case 'memory_expect': {
        const expected = toBytes(step.data);
        const value = await this.link.memoryRead(ia, toInt(step.address), expected.length);
        return { ok: Boolean(value && value.equals(expected)), detail: `got ${value ? value.toString('hex') : 'None'}` };
      }
      case 'property_write': {
        const ok = await this.link.propertyWrite(ia, toInt(step.object, 1), toInt(step.property), toBytes(step.data));
        return { ok, detail: `property ${step.property}` };
      }
      case 'property_read': {
        const value = await this.link.propertyRead(ia, toInt(step.object, 1), toInt(step.property));
        return { ok: value !== null, detail: value ? value.toString('hex') : 'no answer' };
      }
      case 'memory_patch': {
        // A parameter that does not fill whole octets must not be written as a
        // block: read the octets, change only its bits, write them back.
        const address = toInt(step.address);
        const bitOffset = toInt(step.bitOffset, 0);
        const bits = toInt(step.bits, 8);
        const { buffer } = encodeBits(step.value, bits, bitOffset);
        const mask = fieldMask(bits, bitOffset);
        const current = await this.link.memoryRead(ia, address, buffer.length);
        if (!current) return { ok: false, detail: 'read-modify-write: read failed' };
        const patched = Buffer.alloc(buffer.length);
        for (let index = 0; index < buffer.length; index += 1) {
          patched[index] = (current[index] & ~mask[index]) | (buffer[index] & mask[index]);
        }
        const ok = await this.link.memoryWrite(ia, address, patched);
        return {
          ok,
          detail: `${current.toString('hex')} -> ${patched.toString('hex')} (bits ${bits}@${bitOffset})`,
        };
      }
      case 'restart': {
        const ok = await this.link.restart(ia, { master: Boolean(step.master) });
        return { ok, detail: step.master ? 'master reset' : 'application start' };
      }
      case 'group_write': {
        const ga = cemi.parseGA(step.ga);
        const value = step.data !== undefined ? toBytes(step.data) : dpt.encode(step.dpt ?? '1.001', step.value);
        return { ok: await this.bus.write(ga, value), detail: `${step.ga} = ${value.toString('hex')}` };
      }
      case 'group_expect': {
        const ga = cemi.parseGA(step.ga);
        const expected = step.data !== undefined ? toBytes(step.data) : dpt.encode(step.dpt ?? '1.001', step.value);
        const deadline = Date.now() + Number(step.timeout ?? 3) * 1000;
        let last = null;
        while (Date.now() < deadline) {
          const response = await this.bus.read(ga, { timeoutMs: Math.max(200, deadline - Date.now()) });
          if (!response) break;
          last = response.value ?? Buffer.alloc(0);
          if (last.equals(expected)) return { ok: true, detail: `confirmed ${last.toString('hex')}` };
        }
        return { ok: false, detail: `expected ${expected.toString('hex')}, got ${last ? last.toString('hex') : 'no answer'}` };
      }
      case 'scan': {
        const found = await this.link.scan(step.line ?? '1.1', {});
        return { ok: true, detail: `${found.length} devices` };
      }
      default:
        throw new RecipeError(`unhandled op '${step.op}'`);
    }
  }
}
