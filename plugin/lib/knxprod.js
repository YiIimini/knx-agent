/**
 * Manufacturer product data (.knxprod): the thing that makes a download possible.
 *
 * ETS compiles a device's application image and parameter block from this file.
 * Reading it gives us the two halves an agent needs: the *memory layout* (which
 * absolute address holds which parameter, in bits) and the *communication object
 * table* (which object number answers which group address). Without the layout a
 * parameter write is a guess; with it, a parameter change is a verified memory
 * write.
 *
 * Parsing notes, stated because they decide correctness:
 * - the archives carry no stable schema across ETS 4/5/6 and vendors, so this is
 *   a tolerant reader, not a validator: anything it cannot resolve keeps an
 *   explicit `unresolved` reason instead of a plausible-looking address;
 * - numbers are read with `numberBase`: `0x…` is always hex, all-digits is
 *   decimal, anything else hex. ETS exports are inconsistent here, and a wrong
 *   base produces a wrong address, so the generated recipe always carries a
 *   `memory_expect` verification step that turns a misread map into an observable
 *   failure instead of a silent device corruption.
 */

import { readZip } from './project.js';

const HEX = /^0x[0-9a-f]+$/i;
const DIGITS = /^[0-9]+$/;
const HEXLIKE = /^[0-9a-f]+$/i;

export function toNumber(value, base = 'auto') {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return value;
  const text = String(value).trim();
  if (!text) return null;
  if (base === 'hex' || HEX.test(text)) return Number.parseInt(text.replace(/^0x/i, ''), 16);
  if (DIGITS.test(text)) return Number.parseInt(text, 10);
  if (HEXLIKE.test(text)) return Number.parseInt(text, 16);
  return null;
}

/** Minimal tag scanner: enough structure for nested Parameter/Memory and segments. */
export function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  const pattern = /<(\/?)([\w.:-]+)((?:\s+[\w.:-]+\s*=\s*"[^"]*")*)\s*(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g;
  let match;
  const truncated = text.length > 32 * 1024 * 1024 ? text.slice(0, 32 * 1024 * 1024) : text;
  while ((match = pattern.exec(truncated)) !== null) {
    const [, closing, rawName, rawAttrs, selfClosing] = match;
    if (rawName === undefined) continue; // comment or processing instruction
    const name = rawName.includes(':') ? rawName.split(':').pop() : rawName;
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs = {};
    for (const attribute of rawAttrs.matchAll(/([\w.:-]+)\s*=\s*"([^"]*)"/g)) {
      attrs[attribute[1].includes(':') ? attribute[1].split(':').pop() : attribute[1]] = attribute[2];
    }
    const node = { name, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

function findAll(node, name, out = []) {
  for (const child of node.children) {
    if (child.name === name) out.push(child);
    findAll(child, name, out);
  }
  return out;
}

function first(node, name) {
  return node.children.find((child) => child.name === name) ?? null;
}

function descendants(node, predicate, out = []) {
  for (const child of node.children) {
    if (predicate(child)) out.push(child);
    descendants(child, predicate, out);
  }
  return out;
}

/** Extract every zip entry as text; XML only, and never throws on one bad member. */
export async function readArchiveXml(buffer, readZip) {
  const entries = readZip(buffer);
  const warnings = [];
  const files = [];
  for (const entry of entries) {
    if (!entry.name.toLowerCase().endsWith('.xml')) continue;
    files.push({ name: entry.name, text: entry.data.toString('utf8') });
  }
  if (!files.length) warnings.push('archive contains no XML part');
  return { files, warnings };
}

function parseSegments(application, base) {
  const segments = [];
  const staticNode = first(application, 'Static');
  const source = staticNode ?? application;
  for (const child of source.children) {
    if (!/Segment$/i.test(child.name)) continue;
    const address = toNumber(child.attrs.Address, base);
    const size = toNumber(child.attrs.Size, base);
    segments.push({
      kind: child.name,
      id: child.attrs.Id ?? '',
      address,
      size,
      name: child.attrs.Name ?? '',
      raw: { address: child.attrs.Address, size: child.attrs.Size },
    });
  }
  return segments;
}

/**
 * Resolve one `<Memory>` element of a Parameter into an absolute octet address.
 * @returns {{address: number|null, bitOffset: number, resolvedBy: string, reason?: string}}
 */
function resolveMemory(memory, parameter, segments, base) {
  const attrs = memory?.attrs ?? {};
  const absolute = toNumber(attrs.Address, base);
  if (absolute !== null && absolute !== undefined) {
    return { address: absolute, bitOffset: toNumber(attrs.BitOffset, base) ?? 0, resolvedBy: 'memory.address' };
  }
  const segmentRef = attrs.CodeSegment ?? attrs.Segment ?? attrs.Id ?? null;
  const offsetBits = toNumber(attrs.Offset, base);
  if (offsetBits !== null && offsetBits !== undefined) {
    let segment = null;
    if (segmentRef) segment = segments.find((entry) => entry.id === segmentRef) ?? null;
    if (!segment) segment = segments.find((entry) => entry.kind === 'ParameterSegment' && entry.address !== null) ?? null;
    if (!segment) segment = segments.find((entry) => entry.address !== null) ?? null;
    if (segment) {
      return {
        address: segment.address + Math.floor(offsetBits / 8),
        bitOffset: offsetBits % 8,
        resolvedBy: `segment:${segment.kind}${segment.id ? `#${segment.id}` : ''}`,
      };
    }
    return { address: null, bitOffset: 0, resolvedBy: 'unresolved', reason: `no segment for Offset ${offsetBits}` };
  }
  const parameterOffset = toNumber(parameter?.attrs?.Offset, base);
  if (parameterOffset !== null && parameterOffset !== undefined) {
    const parameterAddress = toNumber(parameter?.attrs?.Address, base);
    if (parameterAddress !== null && parameterAddress !== undefined) {
      return { address: parameterAddress, bitOffset: parameterOffset % 8, resolvedBy: 'parameter.address' };
    }
  }
  return { address: null, bitOffset: 0, resolvedBy: 'unresolved', reason: 'no Memory address or segment offset' };
}

/** 'DPST-1-2' -> '1.002'; 'DPT-1' -> '1'; anything else stays verbatim. */
export function normaliseDpt(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  const dpst = /^DPST-(\d+)-(\d+)$/.exec(text);
  if (dpst) return `${Number(dpst[1])}.${String(dpst[2]).padStart(3, '0')}`;
  const dpt = /^DPT-(\d+)$/.exec(text);
  if (dpt) return String(Number(dpt[1]));
  return text;
}

/** Decode an escaped product id back to its order number: '.2D' -> '-'. */
export function orderNumberFromProductId(productId) {
  const text = String(productId ?? '');
  if (!text) return null;
  const segment = text.split('_').find((part) => part.startsWith('P-')) ?? '';
  if (!segment) return null;
  const decoded = segment.replace(/^P-/, '').replace(/\.([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  return decoded || null;
}

function parseParameterTypes(application, base) {
  const types = new Map();
  for (const node of findAll(application, 'ParameterType')) {
    const id = node.attrs.Id ?? '';
    if (!id) continue;
    const typed = node.children.find((child) => /^Type/.test(child.name)) ?? null;
    const size = toNumber(typed?.attrs?.Size ?? node.attrs.Size, base);
    types.set(id, { size, kind: typed?.name ?? '' });
  }
  return types;
}

function parseParameters(application, segments, base, types = new Map()) {
  const parameters = [];
  const warnings = [];
  const parameterNodes = descendants(application, (node) => node.name === 'Parameter');
  for (const node of parameterNodes) {
    const memory = first(node, 'Memory');
    const resolved = resolveMemory(memory, node, segments, base);
    const typeSize = types.get(node.attrs.ParameterType ?? '')?.size ?? null;
    const bits = toNumber(memory?.attrs?.Size ?? node.attrs.Size ?? node.attrs.BitSize, base) ?? typeSize;
    const entry = {
      id: node.attrs.Id ?? '',
      name: node.attrs.Name ?? node.attrs.Text ?? '',
      type: node.attrs.ParameterType ?? node.attrs.Type ?? '',
      text: node.attrs.Text ?? '',
      bits: bits ?? null,
      address: resolved.address,
      bitOffset: resolved.bitOffset,
      resolvedBy: resolved.resolvedBy,
    };
    if (entry.address === null) {
      entry.unresolved = resolved.reason ?? 'unknown';
      warnings.push(`parameter ${entry.id || entry.name}: ${entry.unresolved}`);
    }
    parameters.push(entry);
  }
  return { parameters, warnings };
}

function decodeApplicationVersion(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  // ETS shows the raw byte as highNibble.lowNibble in decimal: 1 -> 0.1, 16 -> 1.0
  return `${Math.floor(value / 16)}.${value % 16}`;
}

function parseLoadProcedures(application) {
  // A product database may carry its own load procedure, which ETS merges into the
  // knx_master default procedure at each LdCtrlMerge MergeId. The control
  // elements tell us the shape of a download (segments, relative memory writes,
  // property comparisons) - not the image bytes, which live in the product store.
  const out = [];
  const container = first(application, 'LoadProcedures');
  const source = container ?? application;
  for (const node of source.children) {
    if (node.name !== 'LoadProcedure') continue;
    const controls = node.children
      .filter((child) => /^LdCtrl/.test(child.name))
      .map((child) => ({ op: child.name, attrs: { ...child.attrs } }));
    out.push({ mergeId: node.attrs.MergeId ?? '', controls });
  }
  return out;
}

function parseApplication(node, base, manufacturerId, schemaVersion = '') {
  const segments = parseSegments(node, base);
  const types = parseParameterTypes(node, base);
  const { parameters, warnings } = parseParameters(node, segments, base, types);
  const refs = descendants(node, (child) => child.name === 'ParameterRef')
    .filter((child) => child.attrs.RefId)
    .map((child) => ({ id: child.attrs.Id ?? '', refId: child.attrs.RefId, name: child.attrs.Text ?? '' }));
  const refsByTarget = new Map();
  for (const ref of descendants(node, (child) => child.name === 'ComObjectRef')) {
    const target = ref.attrs.RefId ?? '';
    if (!target) continue;
    if (!refsByTarget.has(target)) refsByTarget.set(target, []);
    refsByTarget.get(target).push(ref.attrs);
  }
  const comObjects = descendants(node, (child) => child.name === 'ComObject').map((child) => {
    const base = { ...child.attrs };
    const refs = refsByTarget.get(base.Id ?? '') ?? [];
    // Refs are parameter-dependent variants: fill what the base left empty, and
    // take a DPT only when every ref that declares one agrees - a disagreement
    // stays unset instead of becoming a guess.
    for (const field of ['Text', 'Name', 'FunctionText', 'ObjectSize',
      'ReadFlag', 'WriteFlag', 'CommunicationFlag', 'TransmitFlag', 'UpdateFlag']) {
      if (!base[field]) {
        const values = refs.map((ref) => ref[field]).filter(Boolean);
        if (values.length) base[field] = values[0];
      }
    }
    // A DPT is only taken when every declaring ref agrees: refs are
    // parameter-dependent variants, so a disagreement means "depends on the
    // configuration" and must not be collapsed into the first value seen.
    const variants = new Set(refs.map((ref) => ref.DatapointType).filter(Boolean));
    if (!base.DatapointType && variants.size === 1) base.DatapointType = [...variants][0];
    const size = String(base.ObjectSize ?? '');
    const bits = /(\d+)\s*bit/i.test(size) ? Number(/(\d+)\s*bit/i.exec(size)[1])
      : /(\d+)\s*byte/i.test(size) ? Number(/(\d+)\s*byte/i.exec(size)[1]) * 8
        : null;
    return {
      id: base.Id ?? '',
      number: toNumber(base.Number, 'decimal'),
      name: base.Name ?? '',
      functionText: base.FunctionText ?? '',
      text: base.Text ?? '',
      objectSize: size,
      bits,
      dpt: normaliseDpt(base.DatapointType ?? ''),
      dptVariants: variants.size > 1 ? [...variants].map(normaliseDpt) : undefined,
      flags: ['ReadFlag', 'WriteFlag', 'CommunicationFlag', 'TransmitFlag', 'UpdateFlag']
        .filter((flag) => (base[flag] ?? '').toLowerCase() === 'enabled')
        .map((flag) => flag.replace('Flag', '').toLowerCase()),
    };
  });
  const addresses = parameters.filter((parameter) => parameter.address !== null);
  return {
    id: node.attrs.Id ?? '',
    manufacturer: manufacturerId,
    name: node.attrs.Name ?? '',
    maskVersion: node.attrs.MaskVersion ?? '',
    applicationNumber: node.attrs.ApplicationNumber ?? '',
    applicationVersion: node.attrs.ApplicationVersion ?? '',
    applicationVersionText: decodeApplicationVersion(node.attrs.ApplicationVersion),
    loadProcedure: node.attrs.LoadProcedure ?? node.attrs.Procedure ?? '',
    schemaVersion,
    procedures: parseLoadProcedures(node),
    segments,
    parameterTypes: [...types.entries()].map(([id, type]) => ({ id, size: type.size, kind: type.kind })),
    parameters,
    parameterRefs: refs,
    comObjects,
    memory: {
      min: addresses.length ? Math.min(...addresses.map((p) => p.address)) : null,
      max: addresses.length
        ? Math.max(...addresses.map((p) => p.address + Math.max(1, Math.ceil((p.bits ?? 8) / 8)) - 1))
        : null,
      resolved: addresses.length,
      unresolved: parameters.length - addresses.length,
    },
    warnings,
  };
}

/**
 * Parse a .knxprod archive (or a bare product XML) into a library entry.
 * @param buffer - archive bytes.
 * @param options - {base} number base policy, {name} entry name.
 */
export function parseProductData(buffer, options = {}) {
  const base = options.base ?? 'auto';
  const files = options.files ?? archiveFiles(buffer);
  const products = [];
  const hardware = [];
  const applications = [];
  const warnings = [];
  let manufacturer = { id: '', name: '' };
  const globalPrograms = [];

  for (const file of files) {
    const root = parseXml(file.text);
    const schema = /xmlns="[^"]*?\/project\/(\d+)"/.exec(file.text);
    const schemaVersion = schema ? schema[1] : '';
    const manufacturerNodes = findAll(root, 'Manufacturer');
    for (const node of manufacturerNodes) {
      if (node.attrs.Name) manufacturer = { id: node.attrs.RefId ?? node.attrs.Id ?? '', name: node.attrs.Name };
    }
    for (const node of findAll(root, 'ApplicationProgram')) {
      const application = parseApplication(node, base, manufacturer.id, schemaVersion);
      if (application.id || application.name) {
        applications.push(application);
        warnings.push(...application.warnings.map((warning) => `${application.id}: ${warning}`));
      }
    }
    for (const node of findAll(root, 'Product')) {
      products.push({
        id: node.attrs.Id ?? '',
        orderNumber: node.attrs.OrderNumber ?? '',
        text: node.attrs.Text ?? node.attrs.Name ?? '',
        hardwareId: node.attrs.HardwareRefId ?? '',
      });
    }
    for (const node of findAll(root, 'Hardware2Program')) {
      globalPrograms.push({
        id: node.attrs.Id ?? '',
        mediumTypes: node.attrs.MediumTypes ?? '',
        applicationProgramIds: descendants(node, (ref) => ref.name === 'ApplicationProgramRef')
          .map((ref) => ref.attrs.RefId)
          .filter(Boolean),
      });
    }
    for (const node of findAll(root, 'Hardware').filter((entry) => entry.attrs.Id)) {
      const programRefs = descendants(node, (child) => child.name === 'Hardware2Program')
        .flatMap((child) => descendants(child, (ref) => ref.name === 'ApplicationProgramRef'))
        .map((ref) => ref.attrs.RefId)
        .filter(Boolean);
      const productRefs = descendants(node, (child) => child.name === 'Product')
        .map((product) => ({
          id: product.attrs.Id ?? '',
          orderNumber: product.attrs.OrderNumber ?? '',
          text: product.attrs.Text ?? product.attrs.Name ?? '',
        }));
      const hardware2Programs = descendants(node, (child) => child.name === 'Hardware2Program').map((child) => ({
        id: child.attrs.Id ?? '',
        mediumTypes: child.attrs.MediumTypes ?? '',
        applicationProgramIds: descendants(child, (ref) => ref.name === 'ApplicationProgramRef')
          .map((ref) => ref.attrs.RefId)
          .filter(Boolean),
      }));
      hardware.push({
        id: node.attrs.Id,
        name: node.attrs.Name ?? '',
        productRefs,
        hardware2Programs,
        applicationProgramIds: [...new Set(programRefs)],
      });
    }
  }

  // A Hardware2Program belongs to the hardware whose id prefixes it.
  for (const program of globalPrograms) {
    if (hardware.some((entry) => (entry.hardware2Programs ?? []).some((item) => item.id === program.id))) continue;
    const owner = hardware.find((entry) => program.id.startsWith(`${entry.id}_`))
      ?? hardware.find((entry) => entry.applicationProgramIds.some((id) => program.applicationProgramIds.includes(id)));
    if (owner) {
      owner.hardware2Programs = [...(owner.hardware2Programs ?? []), program];
      owner.applicationProgramIds = [...new Set([...owner.applicationProgramIds, ...program.applicationProgramIds])];
    }
  }

  // Products declared outside <Hardware> keep their own record; resolve the
  // hardware that owns them when the export nests it the other way round.
  for (const product of products) {
    if (!product.hardwareId) {
      const owner = hardware.find((entry) => entry.productRefs.some((ref) => ref.id === product.id));
      if (owner) product.hardwareId = owner.id;
    }
    const owner = hardware.find((entry) => entry.id === product.hardwareId);
    product.applicationProgramIds = owner ? owner.applicationProgramIds : [];
  }

  return {
    kind: 'knxprod',
    name: options.name ?? 'product-data',
    manufacturer,
    applications,
    hardware,
    hardware2Programs: [...hardware.flatMap((entry) => entry.hardware2Programs ?? []),
      ...globalPrograms.filter((program) => !hardware.some((entry) => (entry.hardware2Programs ?? []).some((item) => item.id === program.id)))],
    products,
    summary: {
      manufacturer: manufacturer.name,
      products: products.length,
      hardware: hardware.length,
      applications: applications.length,
      parameters: applications.reduce((sum, app) => sum + app.parameters.length, 0),
      resolvedParameters: applications.reduce((sum, app) => sum + app.memory.resolved, 0),
      warnings: warnings.slice(0, 50),
    },
  };
}

/** Normalise an archive into text files with the shared ZIP reader. */
function archiveFiles(buffer, reader = readZip) {
  return reader(buffer)
    .filter((entry) => entry.name.toLowerCase().endsWith('.xml'))
    .map((entry) => ({ name: entry.name, text: entry.data.toString('utf8') }));
}

/** Look up a product (order number or id) and the application program it runs. */
export function resolveProduct(entry, { orderNumber = null, productId = null, applicationId = null } = {}) {
  const product = entry.products.find((candidate) =>
    (orderNumber && candidate.orderNumber === orderNumber)
    || (productId && candidate.id === productId)
    || (applicationId && candidate.applicationProgramIds?.includes(applicationId))) ?? null;
  const applicationIds = applicationId
    ? [applicationId]
    : (product?.applicationProgramIds ?? []);
  const application = entry.applications.find((candidate) => applicationIds.includes(candidate.id))
    ?? entry.applications[0]
    ?? null;
  return { product, application };
}


/**
 * Pack a parameter value into octets for a `bits`-wide field at `bitOffset`.
 * Bit 0 is the MSB of the first octet, which is the memory layout convention a
 * device reads back; `bits` of 1..32 are supported.
 */
export const DEFAULT_ENCODING = { bitOrder: 'msb', byteOrder: 'be' };

/**
 * Pack a parameter value into octets.
 *
 * `encoding` names the two conventions a vendor may have chosen, both of which
 * have been seen in the field: bit 0 as the MSB of the first octet (default, the
 * usual KNX memory layout) or as the LSB, and big- or little-endian octet order
 * for multi-octet fields. `knx_calibrate` determines which one a device actually
 * uses by comparing the bytes it holds with every variant.
 */
export function encodeBits(value, bits, bitOffset = 0, encoding = DEFAULT_ENCODING) {
  const width = Math.max(1, bits ?? 8);
  const octets = Math.ceil((bitOffset + width) / 8);
  const littleEndian = encoding?.byteOrder === 'le';
  const lsbFirst = encoding?.bitOrder === 'lsb';
  const buffer = Buffer.alloc(octets);
  let number = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value);
  if (!Number.isFinite(number)) throw new Error(`value ${JSON.stringify(value)} is not numeric`);
  if (number < 0) number = 2 ** width + number;
  const mask = width >= 32 ? 0xffffffff : 2 ** width - 1;
  number &= mask;
  const bitString = number.toString(2).padStart(width, '0');
  for (let index = 0; index < width; index += 1) {
    if (bitString[index] !== '1') continue;
    const absolute = bitOffset + index;
    const octet = Math.floor(absolute / 8);
    const bitInOctet = lsbFirst ? absolute % 8 : 7 - (absolute % 8);
    buffer[littleEndian ? octets - 1 - octet : octet] |= 1 << bitInOctet;
  }
  return { buffer };
}

/** Bit mask covering exactly the field, used for read-modify-write patches. */
export function fieldMask(bits, bitOffset = 0, encoding = DEFAULT_ENCODING) {
  const width = Math.max(1, bits ?? 8);
  return encodeBits(width >= 32 ? 0xffffffff : 2 ** width - 1, width, bitOffset, encoding).buffer;
}
