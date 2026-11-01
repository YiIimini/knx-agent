/**
 * First-contact calibration: find out how a device really stores parameters.
 *
 * Two conventions are not settled by any public document and both appear in the
 * field: bit 0 as the MSB or as the LSB of the first octet, and big- or
 * little-endian order for multi-octet fields. A wrong choice writes a plausible
 * number into the wrong bits - the device accepts it and behaves inexplicably.
 *
 * The trick is that a *commissioned* device already holds the right bytes: read
 * the parameter block, encode the same project values under every variant, and
 * the variant that reproduces the bytes is the one this device uses. That is an
 * observation, not a guess, and it is cheap: two reads per candidate block.
 */

import * as cemi from './cemi.js';
import { DEFAULT_ENCODING, encodeBits } from './knxprod.js';

export const CANDIDATES = [
  { bitOrder: 'msb', byteOrder: 'be' },
  { bitOrder: 'lsb', byteOrder: 'be' },
  { bitOrder: 'msb', byteOrder: 'le' },
  { bitOrder: 'lsb', byteOrder: 'le' },
];

const name = (encoding) => `${encoding.bitOrder}/${encoding.byteOrder}`;

/**
 * Pick the parameters that can be checked: they need an address, a width, and a
 * value recorded in the project.
 */
export function checkableParameters(application, projectValues) {
  const refToParameter = new Map((application?.parameterRefs ?? []).map((ref) => [ref.id, ref.refId]));
  const byId = new Map((application?.parameters ?? []).map((parameter) => [parameter.id, parameter]));
  const out = [];
  for (const [refId, raw] of Object.entries(projectValues ?? {})) {
    const parameter = byId.get(refToParameter.get(refId) ?? refId) ?? byId.get(refId);
    if (!parameter || parameter.address === null || parameter.address === undefined) continue;
    if (!Number.isFinite(Number(raw))) continue;
    out.push({ ...parameter, value: Number(raw), raw });
  }
  return out;
}

/**
 * Compare every encoding variant against the bytes the device actually holds.
 * @param read - async (address, count) => Buffer|null
 */
export async function calibrateEncoding({ parameters, read, encoding = DEFAULT_ENCODING }) {
  const usable = parameters.filter((parameter) => Number.isFinite(parameter.address));
  if (!usable.length) {
    return { ok: false, error: 'no parameter with an address and a project value to compare against' };
  }

  // One read per contiguous run keeps it to a couple of round trips.
  const runs = [];
  for (const parameter of [...usable].sort((a, b) => a.address - b.address)) {
    const width = Math.ceil(((parameter.bits ?? 8) + (parameter.bitOffset ?? 0)) / 8);
    const last = runs[runs.length - 1];
    const start = parameter.address;
    if (last && start <= last.end + 1) last.end = Math.max(last.end, start + width - 1);
    else runs.push({ start, end: start + width - 1 });
  }

  const device = new Map();
  for (const run of runs) {
    const count = run.end - run.start + 1;
    const bytes = await read(run.start, count);
    if (!bytes) {
      return { ok: false, error: `device did not answer a read at 0x${run.start.toString(16)}` };
    }
    for (let index = 0; index < count; index += 1) device.set(run.start + index, bytes[index]);
  }
  if (!device.size) return { ok: false, error: 'nothing was read from the device' };

  const results = CANDIDATES.map((candidate) => {
    let match = 0;
    let mismatch = 0;
    const detail = [];
    for (const parameter of usable) {
      const width = Math.ceil(((parameter.bits ?? 8) + (parameter.bitOffset ?? 0)) / 8);
      const { buffer } = encodeBits(parameter.value, parameter.bits ?? 8, parameter.bitOffset ?? 0, candidate);
      let same = 0;
      for (let index = 0; index < width; index += 1) {
        const observed = device.get(parameter.address + index);
        if (observed === undefined) continue;
        if (observed === buffer[index]) same += 1;
        else mismatch += 1;
      }
      match += same;
      detail.push({ parameter: parameter.id || parameter.name, address: `0x${parameter.address.toString(16)}`, bytes: buffer.toString('hex'), matchedOctets: same, width });
    }
    return {
      encoding: candidate,
      name: name(candidate),
      matchedOctets: match,
      mismatchedOctets: mismatch,
      totalOctets: match + mismatch,
      detail,
    };
  }).sort((a, b) => (b.matchedOctets - a.matchedOctets) || (a.mismatchedOctets - b.mismatchedOctets));

  const best = results[0];
  const second = results[1] ?? null;
  const decisive = best.matchedOctets > 0 && (!second || best.mismatchedOctets < second.mismatchedOctets);
  return {
    ok: true,
    encoding: best.encoding,
    name: best.name,
    confidence: decisive ? 'decisive' : 'ambiguous',
    candidates: results.map((result) => ({
      name: result.name,
      matchedOctets: result.matchedOctets,
      mismatchedOctets: result.mismatchedOctets,
      totalOctets: result.totalOctets,
    })),
    checked: usable.length,
    detail: best.detail,
    assumed: name(encoding),
    ...(decisive ? {} : { note: 'every variant scored the same: the compared parameters are all zero or the project values do not reach the device. Compare a parameter with a distinctive value.' }),
  };
}

/** Human summary for a tool result. */
export function describeCalibration(result) {
  if (!result?.ok) return result?.error ?? 'calibration failed';
  return `device uses ${result.name} (${result.confidence}); ${result.checked} parameter(s) compared over ${result.candidates[0].totalOctets} octet(s)`;
}

export { cemi };
