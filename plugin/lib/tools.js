/**
 * The model-facing tool surface.
 *
 * Design rule: the model fills JSON arguments, never telegram bytes. A wrong tool
 * choice or a wrong address is recoverable; a hand-assembled frame is not.
 *
 * Every tool is a thin, declarative binding onto `lib/ops.js`, which the panel's
 * HTTP bridge calls too: one implementation, two callers, identical results.
 */

import * as opsModule from './ops.js';

const { ops, BUS_OPS } = opsModule;

const textResult = (value) => [{
  type: 'text',
  text: typeof value === 'string' ? value : `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``,
}];

const iaSchema = { type: 'string', description: 'Individual address, e.g. "1.1.10".' };
const addressSchema = { type: 'string', description: 'Device memory address, decimal or 0x-prefixed hex, e.g. "0x4700".' };
const object = (properties, required = []) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required.length ? { required } : {}),
});

/**
 * Tool table: name -> { description, parameters, op, required }.
 * `op` names the operation in `lib/ops.js`; arguments pass through unchanged.
 */
const TABLE = [
  ['knx_search', 'Discover KNXnet/IP gateways on the local network by multicast and/or a unicast target list. Returns name, individual address, serial and supported service families.', object({
    timeoutMs: { type: 'number', description: 'Collection window per target (default 3000).' },
    multicast: { type: 'boolean', description: 'Search 224.0.23.12 (default true).' },
    targets: { type: 'array', items: { type: 'string' }, description: 'Extra gateways as "ip" or "ip:port".' },
  }), 'search'],

  ['knx_connect', 'Open (or reuse) a KNXnet/IP tunnelling connection. layer="busmonitor" opens a bus monitor tunnel, which is what sees individual-addressed download traffic.', object({
    gateway: { type: 'string', description: 'Gateway as "ip" or "ip:port". Defaults to the plugin config or the running simulator.' },
    layer: { type: 'string', enum: ['link', 'busmonitor', 'routing'], description: 'Tunnel layer (default link); "routing" uses multicast 224.0.23.12 and needs no tunnel.' },
  }), 'connect'],

  ['knx_disconnect', 'Close the current tunnelling connection and release its channel on the gateway.', object({}), 'disconnect'],

  ['knx_status', 'Current connection, transport counters, read-only policy, simulator state and the recent tool audit trail.', object({}), 'state'],

  ['knx_scan', 'Scan one line for devices with pipelined device descriptor reads. Reports individual address and mask/descriptor per responder.', object({
    line: { type: 'string', description: 'Area.line to scan, e.g. "1.1" (default "1.1").' },
    start: { type: 'integer', description: 'First device number (default 0).' },
    end: { type: 'integer', description: 'Device number limit, exclusive (default 256).' },
    window: { type: 'integer', description: 'Frames in flight per batch (default 48).' },
  }), 'scan'],

  ['knx_device_info', 'Identity of one device: mask/descriptor, individual address, and optionally the serial number (only answered by a device in programming mode).', object({
    ia: iaSchema,
    serial: { type: 'boolean', description: 'Also read the serial number (default false).' },
  }, ['ia']), 'deviceInfo'],

  ['knx_memory_read', 'Read device memory (management access), returned as hex. Chunked automatically to the service limit.', object({
    ia: iaSchema, address: addressSchema, count: { type: 'integer', description: 'Octets to read.' },
  }, ['ia', 'address', 'count']), 'memoryRead'],

  ['knx_memory_write', 'Write device memory from hex. This is the primitive a download is made of; verify with knx_memory_read afterwards.', object({
    ia: iaSchema, address: addressSchema, data: { type: 'string', description: 'Hex payload, e.g. "0a00ff10".' },
  }, ['ia', 'address', 'data']), 'memoryWrite'],

  ['knx_property_read', 'Read an interface object property (identity, tables, application id). object index and property id follow the device profile.', object({
    ia: iaSchema,
    object: { type: 'integer', description: 'Interface object index (default 1).' },
    property: { type: 'integer', description: 'Property id, e.g. 51 for PID_ORDER_INFO.' },
    count: { type: 'integer', description: 'Element count (default 1).' },
    start: { type: 'integer', description: 'Start index (default 1).' },
  }, ['ia', 'property']), 'propertyRead'],

  ['knx_ga_read', 'Group value read decoded through a data point type, e.g. dpt "9.001" for temperature or "1.001" for a switch.', object({
    ga: { type: 'string', description: 'Group address, e.g. "3/1/5".' },
    dpt: { type: 'string', description: 'Data point type (default "1.001").' },
    timeoutMs: { type: 'number', description: 'Response window (default 2000).' },
  }, ['ga']), 'gaRead'],

  ['knx_ga_write', 'Group value write decoded through a data point type. Use it for acceptance tests and actuator checks.', object({
    ga: { type: 'string', description: 'Group address, e.g. "3/1/5".' },
    dpt: { type: 'string', description: 'Data point type (default "1.001").' },
    value: { description: 'Value in that data point type: boolean, number or hex string.' },
  }, ['ga', 'value']), 'gaWrite'],

  ['knx_monitor', 'Collect bus traffic for N seconds. On a bus monitor tunnel this includes the individual-addressed management traffic of a download.', object({
    seconds: { type: 'number', description: 'Observation window (default 5).' },
    groupOnly: { type: 'boolean', description: 'Only group-addressed frames (default false).' },
  }), 'monitor'],

  ['knx_download', 'Execute a download recipe against one device. dryRun validates the plan without touching the device; a failed step stops the run and reports where it stopped.', object({
    recipe: { type: 'object', description: 'Inline recipe object (schema knxagent.download/1).' },
    recipePath: { type: 'string', description: 'Path to a recipe JSON file (absolute or relative to the workspace).' },
    ia: { type: 'string', description: 'Override the recipe device individual address.' },
    catalogId: { type: 'string', description: 'Run a recipe from the catalog instead of an inline one.' },
    dryRun: { type: 'boolean', description: 'Validate only (default false).' },
  }), 'download'],

  ['knx_capture', 'Record the download traffic of one device and turn it into a reusable recipe. Needs a bus monitor tunnel; the result can be saved and replayed by knx_download.', object({
    ia: iaSchema,
    seconds: { type: 'number', description: 'Recording window (default 60).' },
    savePath: { type: 'string', description: 'Optional path to write the recipe JSON to.' },
    install: { type: 'boolean', description: 'Also store the recipe in the catalog, keyed by the product resolved from the project (default false).' },
  }, ['ia']), 'capture'],

  ['knx_validate_recipe', 'Validate a recipe without a device: step ops, placeholders, and whether the plan is complete enough to run.', object({
    recipe: { type: 'object', description: 'Inline recipe object.' },
    recipePath: { type: 'string', description: 'Path to a recipe JSON file.' },
  }), 'validateRecipe'],

  ['knx_project', 'Read an ETS project (.knxproj) or manufacturer product database (.knxprod): devices with their individual addresses, group addresses, communication object links and the parameter memory layout.', object({
    path: { type: 'string', description: 'Path to the archive.' },
    detail: { type: 'string', enum: ['summary', 'full'], description: 'summary (default) or full device and group address lists.' },
  }, ['path']), 'project'],

  ['knx_import', 'Import a manufacturer product database (.knxprod) or an ETS project (.knxproj) into the local library. Product data supplies the parameter memory layout; the project supplies which device runs which product at which individual address.', object({
    path: { type: 'string', description: 'Path to the .knxprod or .knxproj file.' },
  }, ['path']), 'import'],

  ['knx_library', 'Work with the imported library: list entries, show one entry (product parameters with their resolved addresses, or a project device list), resolve a project device to its product and memory map, or forget an entry.', object({
    action: { type: 'string', enum: ['list', 'show', 'resolve', 'forget'], description: 'Operation (default list).' },
    id: { type: 'string', description: 'Entry id for show/forget.' },
    projectId: { type: 'string', description: 'Project entry id for resolve (defaults to the only imported project).' },
    ia: { type: 'string', description: 'Device individual address for resolve.' },
    detail: { type: 'string', enum: ['summary', 'full'], description: 'show detail (default summary).' },
  }), 'library'],

  ['knx_build_download', 'Build a download recipe from a product\'s parameter memory layout. Either give parameter ids or names with values, or set useProjectValues to take the values the imported project was commissioned with (the project is mapped through its ParameterInstanceRef ids). Byte-aligned parameters become memory writes, bit-level ones a read-modify-write patch. Review the plan, then run it with knx_download.', object({
    applicationId: { type: 'string', description: 'Application program id (defaults to the product of the device/project).' },
    values: { type: 'object', description: 'Parameter id or name -> value, e.g. {"P-dim-time": 300}.' },
    ia: { type: 'string', description: 'Device individual address the recipe targets.' },
    useProjectValues: { type: 'boolean', description: 'Take the parameter values recorded in the imported project (default false).' },
    projectId: { type: 'string', description: 'Project entry id to read values from (defaults to the only imported project).' },
    restart: { type: 'boolean', description: 'Append an application restart step (default false).' },
  }), 'buildDownload'],

  ['knx_proxy', 'Run the KNXnet/IP recording proxy: ETS (in a VM) connects to this port instead of the real interface, every telegram is forwarded unchanged and written to a JSONL capture. Point ETS at listenPort, let it do one download, then turn the capture into a recipe with knx_recipe_from_capture. action=captures lists recorded files.', object({
    action: { type: 'string', enum: ['start', 'stop', 'status', 'captures'], description: 'Operation (default status).' },
    port: { type: 'integer', description: 'UDP port ETS will reach (default 3671).' },
    upstream: {
      type: 'object',
      description: 'The real KNXnet/IP interface to forward to: {host, port}.',
      additionalProperties: false,
      properties: { host: { type: 'string' }, port: { type: 'integer' } },
    },
    upstreamHost: { type: 'string', description: 'Shorthand for upstream.host.' },
    upstreamPort: { type: 'integer', description: 'Shorthand for upstream.port.' },
    captureDir: { type: 'string', description: 'Directory for capture files (default ~/.dsh/knx-library/captures).' },
  }), 'proxy'],

  ['knx_recipe_from_capture', 'Turn a proxy capture (or bus monitor capture) into a replayable download recipe for one device. Reads the traffic ETS sent to that device and produces the same recipe knx_capture would, offline and after the fact.', object({
    capturePath: { type: 'string', description: 'Path to the .jsonl capture.' },
    ia: { type: 'string', description: 'Device individual address recorded in the capture.' },
    savePath: { type: 'string', description: 'Optional path to write the recipe JSON to.' },
    direction: { type: 'string', enum: ['from-client', 'to-client'], description: 'Which direction to read (default from-client: what ETS sent to the bus).' },
    install: { type: 'boolean', description: 'Also store the recipe in the catalog (default false).' },
    orderNumber: { type: 'string', description: 'Product order number for the catalog entry.' },
  }, ['capturePath', 'ia']), 'recipeFromCapture'],

  ['knx_catalog', 'The recorded-recipe catalog: install a recipe under its product identity, list/find entries, apply one to a device (returns a ready recipe), inspect its versions, or forget it. A recipe is keyed by a fingerprint of its telegram content with the device address and notes removed, so two devices of one product dedup to a single entry while a different parameter set becomes its own version - the second commissioning is a lookup, not a recording.', object({
    action: { type: 'string', enum: ['list', 'install', 'find', 'apply', 'versions', 'forget'], description: 'Operation (default list).' },
    recipeId: { type: 'string', description: 'Catalog entry id for apply/versions/forget.' },
    recipe: { type: 'object', description: 'Inline recipe to install.' },
    recipePath: { type: 'string', description: 'Recipe file to install.' },
    orderNumber: { type: 'string', description: 'Product order number, e.g. "AKH-0401.02".' },
    applicationId: { type: 'string', description: 'Application program id, e.g. "M-0002_A-1234".' },
    maskVersion: { type: 'string', description: 'Mask version of the application program.' },
    deviceName: { type: 'string', description: 'Human label for the product, e.g. "Dimmer EG".' },
    ia: { type: 'string', description: 'Device individual address: target for apply, product lookup hint for install.' },
    version: { type: 'string', description: 'Fingerprint prefix of a stored version to apply.' },
    product: { type: 'string', description: 'list filter over order number, application id or name.' },
  }), 'catalog'],

  ['knx_group_table', 'Build the group address table and association table a device needs to answer telegrams at all, and turn them into a download recipe. action=plan shows the tables and says whether base addresses are known; action=build returns the recipe (needs addressBase/associationBase); action=infer calibrates those base addresses from a recorded ETS "download group addresses" pass. The tables are the part of a device configuration that changes when points move.', object({
    action: { type: 'string', enum: ['plan', 'build', 'infer', 'profiles'], description: 'Operation (default plan).' },
    save: { type: 'boolean', description: 'infer: store the calibrated profile for this product family (default true).' },
    forget: { type: 'string', description: 'profiles: remove this saved profile key.' },
    ia: { type: 'string', description: 'Device individual address.' },
    projectId: { type: 'string', description: 'Project entry id (defaults to the newest imported project).' },
    addressBase: { type: 'integer', description: 'Memory address of the group address table.' },
    associationBase: { type: 'integer', description: 'Memory address of the association table.' },
    profile: { type: 'object', description: 'Profile overrides (entrySize, unusedEntry, leadingUnused, padByte).' },
    capturePath: { type: 'string', description: 'Capture to calibrate from (action=infer).' },
  }), 'groupTable'],

  ['knx_accept', 'Run one acceptance pass: scan the line, compare it with the imported project device by device (present? mask on the bus matches the project?), list addresses that are on the bus but not in the project, and attach findings plus a Markdown handover report. Read-only - it never writes to a device.', object({
    line: { type: 'string', description: 'Area.line to check, e.g. "1.1" (default "1.1").' },
    projectId: { type: 'string', description: 'Project entry id (defaults to the newest imported project).' },
    savePath: { type: 'string', description: 'Optional path to write the Markdown report to.' },
  }), 'accept'],

  ['knx_diagnose', 'Diagnose observed evidence: a scan result, captured frames, or failed recipe steps. Returns findings with the next probe, never a guess.', object({
    scan: { type: 'array', items: { type: 'object' }, description: 'Devices from knx_scan.' },
    frames: { type: 'array', items: { type: 'object' }, description: 'Frames from knx_monitor.' },
    failedSteps: { type: 'array', items: { type: 'object' }, description: 'Steps from a failed knx_download report.' },
  }), 'diagnose'],

  ['knx_simulator', 'Start or stop an in-process KNXnet/IP gateway with virtual devices, so a commissioning plan can be rehearsed without hardware. The tools then work against it unchanged.', object({
    action: { type: 'string', enum: ['start', 'stop', 'status'], description: 'What to do (default status).' },
    devices: {
      type: 'array',
      description: 'Optional device list: [{ia, name, descriptor}].',
      items: object({ ia: { type: 'string' }, name: { type: 'string' }, descriptor: { type: 'integer' } }, ['ia']),
    },
  }), 'simulator'],
];

function defineTool(runtime, name, description, parameters, opName) {
  const required = parameters.required ?? [];
  return {
    name,
    description,
    parameters,
    output: { schema: { type: 'object' }, render: (_args, value) => textResult(value) },
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {};
      for (const key of required) {
        if (input[key] === undefined || input[key] === null || input[key] === '') {
          throw new Error(`${name}: missing required argument '${key}'`);
        }
      }
      if (exec?.signal?.aborted) throw new Error(`${name}: cancelled`);
      try {
        const run = () => ops[opName](runtime, input);
        const value = BUS_OPS.has(opName) ? await runtime.serialize(run) : await run();
        runtime.record(name, input, value ?? {});
        return value;
      } catch (error) {
        runtime.record(name, input, { ok: false, error: error.message });
        throw error;
      }
    },
    presentCall: (args) => ({ card: 'generic', title: name, rawInput: args }),
  };
}

export function buildTools(runtime) {
  return TABLE.map(([name, description, parameters, opName]) =>
    defineTool(runtime, name, description, parameters, opName));
}

/** Names only, for the HTTP bridge's allow-list and for docs. */
export const TOOL_NAMES = TABLE.map(([name]) => name);

/** Operation names reachable from the panel, re-exported for convenience. */
export { OP_NAMES } from './ops.js';
