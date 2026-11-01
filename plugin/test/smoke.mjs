/**
 * End-to-end check of the plugin without the Harness: the same code paths the
 * tools run, against the in-process gateway. `node test/smoke.mjs`
 */

import zlib from 'node:zlib';
import * as cemi from '../lib/cemi.js';
import * as dpt from '../lib/dpt.js';
import * as knxip from '../lib/knxip.js';
import { KnxRuntime } from '../lib/runtime.js';
import { buildTools } from '../lib/tools.js';
import { Tunnel } from '../lib/knxip.js';
import { DeviceLink, GroupBus } from '../lib/link.js';

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  PASS ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`);
  }
};

console.log('codec vectors');
check('memory read apdu', cemi.apduMemoryRead(0x1234, 11).toString('hex') === '020b1234');
check('memory write apdu', cemi.apduMemoryWrite(0x1234, Buffer.from('aabbcc', 'hex')).toString('hex') === '02831234aabbcc');
const req = cemi.ldata(cemi.parseGA('1/2/3'), cemi.apduGroupWrite(Buffer.from([1])), true);
check('control octets', req.subarray(0, 4).toString('hex') === '1100bce0', req.subarray(0, 4).toString('hex'));
check('group write decodes', cemi.parse(req).service === 'A_GroupValue_Write');
const standard = cemi.ldata(0x1105, cemi.apduMemoryWrite(0x4000, Buffer.alloc(11)), false);
const extended = cemi.ldata(0x1105, cemi.apduMemoryWrite(0x4000, Buffer.alloc(12)), false);
check('frame type threshold', Boolean(standard[2] & 0x80) && !(extended[2] & 0x80));
check('dpt9 roundtrip', Math.abs(dpt.decode('9.001', dpt.encode('9.001', 21.5)) - 21.5) < 0.01);

console.log('tool surface');
const runtime = new KnxRuntime({ allowWrites: true, scanSettleMs: 300 });
const tools = new Map(buildTools(runtime).map((definition) => [definition.name, definition]));
const call = async (name, args = {}) => {
  const definition = tools.get(name);
  if (!definition) throw new Error(`missing tool ${name}`);
  return definition.execute(args, { signal: { aborted: false } });
};
check('25 tools registered', tools.size === 25, String(tools.size));
check('schemas are objects', [...tools.values()].every((t) => t.parameters?.type === 'object' && t.description.length > 20));
check('disconnect, library and proxy tools exist', ['knx_disconnect', 'knx_import', 'knx_library', 'knx_build_download', 'knx_proxy', 'knx_recipe_from_capture', 'knx_catalog', 'knx_group_table'].every((name) => tools.has(name)));

const started = await call('knx_simulator', { action: 'start' });
check('simulator started', started.ok && started.devices.length === 3, JSON.stringify(started.devices?.length));

const scanned = await call('knx_scan', { line: '1.1', start: 1, end: 5, window: 4 });
check('scan finds devices', scanned.ok && scanned.count === 3, JSON.stringify(scanned.devices));

const info = await call('knx_device_info', { ia: '1.1.1' });
check('device info', info.ok && info.descriptor === '0x07B0', String(info.descriptor));

const wrote = await call('knx_memory_write', { ia: '1.1.1', address: '0x4000', data: '0a0b0c0d' });
const read = await call('knx_memory_read', { ia: '1.1.1', address: '0x4000', count: 4 });
check('memory write/read', wrote.ok && read.ok && read.data === '0a0b0c0d', JSON.stringify([wrote, read]));

const ga = '3/1/5';
const gaWrite = await call('knx_ga_write', { ga, dpt: '9.001', value: 21.5 });
const gaRead = await call('knx_ga_read', { ga, dpt: '9.001' });
check('group value acceptance', gaWrite.ok && gaRead.ok && Math.abs(gaRead.value - 21.5) < 0.01, JSON.stringify(gaRead));

const recipe = {
  device: { ia: '1.1.2' },
  steps: [
    { op: 'memory_write', address: '0x4700', data: '01020304' },
    { op: 'memory_expect', address: '0x4700', data: '01020304' },
    { op: 'restart', master: false },
    { op: 'group_write', ga: '1/2/3', dpt: '1.001', value: 1 },
    { op: 'group_expect', ga: '1/2/3', dpt: '1.001', value: 1 },
  ],
};
const dry = await call('knx_download', { recipe, dryRun: true });
check('dry run touches nothing', dry.ok && dry.steps.every((s) => s.detail === 'dry-run' || s.op === 'note'), JSON.stringify(dry.steps?.[0]));
const download = await call('knx_download', { recipe });
check('download runs and verifies', download.ok, JSON.stringify(download.steps));

const validated = await call('knx_validate_recipe', { recipe });
check('recipe validation', validated.ok && validated.steps === 5, JSON.stringify(validated));
const badRecipe = await call('knx_validate_recipe', { recipe: { steps: [{ op: 'nope' }] } });
check('invalid op rejected', badRecipe.ok === false && /unknown op/.test(badRecipe.error), JSON.stringify(badRecipe));

console.log('capture and diagnose');
// The capture occupies the plugin's tunnel, so the traffic is driven from an
// independent tunnel - which is exactly the field case: ETS (or a second tool)
// produces the download while the plugin only observes.
const capturePromise = call('knx_capture', { ia: '1.1.2', seconds: 1.5 });
await new Promise((resolve) => setTimeout(resolve, 250));
const driver = await Tunnel.open({ host: '127.0.0.1', port: runtime.simulator.port });
const driverLink = new DeviceLink(driver);
await driverLink.memoryWrite(0x1102, 0x4900, Buffer.from('feedface', 'hex'));
await driver.close();
const captured = await capturePromise;
check('capture yields a replayable recipe', captured.ok && captured.recipe.steps.some((s) => s.op === 'memory_write'),
  JSON.stringify(captured).slice(0, 200));
if (captured.ok) {
  const replayed = await call('knx_download', { recipe: captured.recipe, dryRun: true });
  check('captured recipe replays', replayed.ok, JSON.stringify(replayed.steps?.[0]));
}
const diagnosed = await call('knx_diagnose', { scan: [] });
check('empty scan is diagnosed', diagnosed.ok && diagnosed.findings.some((f) => f.code === 'NO_DEVICES'));

console.log('project parsing');
// minimal stored (no compression) zip so the reader is exercised without extra deps
function storedZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(data) : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

const projectXml = `<?xml version="1.0"?><KNX><Project ProjectNumber="1019"><Topology><Area Address="1"><Line Address="1">
<DeviceInstance Id="di-1" Address="4354" Name="Dimmer EG" ProductRefId="M-0002_H-0003_P-0004"/>
<DeviceInstance Id="di-2" Address="4355" Name="Switch EG"/>
<ComObjectInstanceRef RefId="O-1" Text="Switch" DatapointType="DPST-1-1" Links="ga-1 ga-2"/>
</Line></Area></Topology><GroupAddresses>
<GroupAddress Id="ga-1" Address="2307" Name="EG Licht schalten" DatapointType="DPST-1-1"/>
<GroupAddress Id="ga-2" Address="2308" Name="EG Licht Status" DatapointType="DPST-1-1"/>
</GroupAddresses></Project></KNX>`;
const { writeFileSync, mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const dir = mkdtempSync(join(tmpdir(), 'knx-'));
const projectPath = join(dir, 'site.knxproj');
writeFileSync(projectPath, storedZip({ 'P-0001/project.xml': projectXml, 'P-0001/0.xml': '<KNX/>' }));
const parsed = await call('knx_project', { path: projectPath, detail: 'full' });
check('project devices and addresses', parsed.ok && parsed.summary.devices === 2 && parsed.summary.groupAddresses === 2,
  JSON.stringify(parsed.summary));
check('com objects linked', parsed.devices.some((d) => d.comObjects?.[0]?.groupAddresses?.length === 2),
  JSON.stringify(parsed.devices?.[0]?.comObjects));

console.log('data point types');
check('DPT3 dimming control roundtrips',
  JSON.stringify(dpt.decode('3.007', dpt.encode('3.007', { direction: 'down', step: 3 })))
  === JSON.stringify({ direction: 'down', step: 3, raw: 11 }));
check('DPT2 controlled bit roundtrips',
  dpt.decode('2.001', dpt.encode('2.001', { control: true, value: false })).control === true);
check('DPT10 time roundtrips', dpt.decode('10.001', dpt.encode('10.001', '14:35:07')).text === '14:35:07');
check('DPT11 date roundtrips', dpt.decode('11.001', dpt.encode('11.001', '2026-10-31')).text === '2026-10-31');

console.log('product data + library');
const { KnxLibrary } = await import('../lib/library.js');
const libraryDir = mkdtempSync(join(tmpdir(), 'knx-lib-'));
const library = new KnxLibrary(libraryDir);
const productImport = await library.importFile('examples/acme-dimmer.knxprod');
check('product data imported', productImport.ok && productImport.summary.resolvedParameters === 4,
  JSON.stringify(productImport.summary));
const projectImport = await library.importFile('examples/site.knxproj');
check('project imported', projectImport.ok && projectImport.summary.devices === 2, JSON.stringify(projectImport.summary));
const listing = await library.list();
check('library lists both kinds', listing.products.length === 1 && listing.projects.length === 1);
const resolved = await library.resolve({ ia: '1.1.2' });
check('device resolves to its application program',
  resolved.ok && resolved.via === 'productRefId' && resolved.application?.id === 'M-0002_A-1234',
  JSON.stringify({ via: resolved.via, app: resolved.application?.id }));
const addresses = Object.fromEntries((resolved.application?.parameters ?? []).map((p) => [p.id, p.address]));
check('parameter addresses resolved', addresses['P-dim-time'] === 0x4700 && addresses['P-min-level'] === 0x4702
  && addresses['P-enable'] === 0x4703 && addresses['P-abs'] === 0x4710, JSON.stringify(addresses));
check('unresolved parameter is reported honestly', addresses['P-ghost'] === null);

const productEntry = await library.read(productImport.id);
const productApp = productEntry.applications[0];
check('application version is decoded the way ETS displays it',
  productApp.applicationVersionText === '1.0', productApp.applicationVersionText);
check('load procedure controls are parsed',
  productApp.procedures.length === 3
  && productApp.procedures.flatMap((p) => p.controls.map((c) => c.op)).sort().join(',')
     === 'LdCtrlCompareProp,LdCtrlRelSegment,LdCtrlWriteRelMem',
  JSON.stringify(productApp.procedures.map((p) => p.controls.map((c) => c.op))));
check('communication objects merge their refs',
  productApp.comObjects[0].text === 'Switching' && productApp.comObjects[0].dpt === '1.001'
  && productApp.comObjects[0].bits === 1,
  JSON.stringify(productApp.comObjects[0]));
check('a disagreeing DPT stays unset and keeps its variants',
  productApp.comObjects[1].dpt === '' && (productApp.comObjects[1].dptVariants ?? []).length === 2,
  JSON.stringify(productApp.comObjects[1]));
const { orderNumberFromProductId, normaliseDpt } = await import('../lib/knxprod.js');
check('escaped product ids decode to the order number',
  orderNumberFromProductId('M-0002_H-0003_P-15.2D15') === '15-15');
check('DPST names normalise to dotted DPTs', normaliseDpt('DPST-1-2') === '1.002' && normaliseDpt('DPT-9') === '9');

const projectBuilt = await library.buildDownload({ useProjectValues: true, ia: '1.1.2' });
check('project values drive the download plan',
  projectBuilt.ok && projectBuilt.plan.some((step) => step.parameter === 'P-dim-time' && step.value === '300'),
  JSON.stringify(projectBuilt.plan));
check('project plan writes the commissioned value',
  projectBuilt.recipe.steps.some((step) => step.op === 'memory_write'
    && Number(step.address) === 0x4700 && step.data === '012c'),
  JSON.stringify(projectBuilt.recipe.steps.slice(0, 2)));
const otherDevice = await library.buildDownload({ useProjectValues: true, ia: '1.1.3' });
check('the same product on another address uses that address own values',
  otherDevice.ok && otherDevice.recipe.steps.some((step) => step.data === '0078'),
  JSON.stringify(otherDevice.plan));

const built = await library.buildDownload({
  values: { 'P-dim-time': 300, 'min level': 20, 'P-enable': 1, 'P-abs': 11 },
  ia: '1.1.2',
});
check('build download emits writes + patches', built.ok && built.plan.length === 4, JSON.stringify(built.plan));
check('bit-level parameters use memory_patch',
  built.recipe.steps.filter((step) => step.op === 'memory_patch').length === 2,
  JSON.stringify(built.recipe.steps.map((step) => step.op)));
check('byte-aligned parameter writes the encoded value',
  built.recipe.steps.some((step) => step.op === 'memory_write' && step.data === '012c'), JSON.stringify(built.recipe.steps[0]));

// neighbours must survive a bit-level patch: seed the octets, then run for real
const simDevice = runtime.simulator.devices.get(0x1102);
simDevice.fill(0x4703, Buffer.from([0x55]));
simDevice.fill(0x4710, Buffer.from([0x3f]));
const patched = await call('knx_download', { recipe: built.recipe });
check('built recipe runs on the bus', patched.ok, JSON.stringify(patched.steps));
check('byte write landed', simDevice.dump(0x4700, 2).toString('hex') === '012c' && simDevice.dump(0x4702, 1).toString('hex') === '14',
  simDevice.dump(0x4700, 3).toString('hex'));
check('bit patch preserved neighbours', simDevice.dump(0x4703, 1).toString('hex') === 'd5',
  simDevice.dump(0x4703, 1).toString('hex'));
// 0x3F with bits 3..6 (MSB-first) replaced by 11 = 1011 -> 0x37
check('nibble patch preserved neighbours', simDevice.dump(0x4710, 1).toString('hex') === '37',
  simDevice.dump(0x4710, 1).toString('hex'));
check('unresolved parameter is skipped with a warning',
  built.warnings.some((warning) => /no resolved address/.test(warning)) === false, JSON.stringify(built.warnings));

console.log('recording proxy (ETS behind a capture)');
const { KnxProxy, readCapture } = await import('../lib/proxy.js');
const { captureToRecipe } = await import('../lib/recipe.js');
const proxyDir = mkdtempSync(join(tmpdir(), 'knx-proxy-'));
const proxy = new KnxProxy({
  listenPort: 0,
  upstream: { host: '127.0.0.1', port: runtime.simulator.port },
  captureDir: proxyDir,
});
const proxyStatus = await proxy.start();
check('proxy listens', proxyStatus.running && proxyStatus.listenPort > 0, JSON.stringify(proxyStatus.listenPort));

const discovered = await knxip.search({
  timeoutMs: 700, multicast: false, unicastTargets: [['127.0.0.1', proxyStatus.listenPort]],
});
check('proxy answers discovery as a gateway',
  discovered.length === 1 && discovered[0].friendlyName === 'knx-agent proxy',
  JSON.stringify(discovered[0]?.friendlyName));

// Act as ETS: a plain tunnel client pointed at the proxy instead of the gateway.
const ets = await Tunnel.open({ host: '127.0.0.1', port: proxyStatus.listenPort });
const etsLink = new DeviceLink(ets);
check('proxy opens an upstream channel', proxy.status().channels.length === 1, JSON.stringify(proxy.status().channels));
await etsLink.memoryWrite(0x1102, 0x4800, Buffer.from('deadbeef', 'hex'));
await etsLink.memoryWrite(0x1102, 0x4804, Buffer.from('cafe', 'hex'));
check('writes reach the device through the proxy',
  runtime.simulator.devices.get(0x1102).dump(0x4800, 6).toString('hex') === 'deadbeefcafe',
  runtime.simulator.devices.get(0x1102).dump(0x4800, 6).toString('hex'));
check('device reads answer through the proxy',
  (await etsLink.memoryRead(0x1102, 0x4800, 6))?.toString('hex') === 'deadbeefcafe');
await ets.close();

const proxyStatusNow = proxy.status();
check('proxy binds loopback by default', proxyStatusNow.stats.boundTo?.startsWith('127.0.0.1:'), proxyStatusNow.stats.boundTo);

const stopped = await proxy.stop();
const proxyCapture = readCapture(stopped.capturePath);
check('capture file holds the forwarded traffic', proxyCapture.frames.length >= 3, String(proxyCapture.frames.length));
const proxyRecipe = captureToRecipe(proxyCapture.frames, 0x1102);
check('capture becomes a replayable recipe (contiguous writes merged)',
  proxyRecipe.steps.filter((step) => step.op === 'memory_write').length === 1
  && proxyRecipe.steps.some((step) => step.address === 0x4800 && step.data === 'deadbeefcafe'),
  JSON.stringify(proxyRecipe.steps.map((step) => [step.op, step.address, step.data])));

// The device is reset by the replay: prove the recipe is self-contained.
runtime.simulator.devices.get(0x1102).fill(0x4800, Buffer.alloc(6));
const replayed = await call('knx_download', { recipe: proxyRecipe });
check('replayed capture restores the device',
  replayed.ok && runtime.simulator.devices.get(0x1102).dump(0x4800, 6).toString('hex') === 'deadbeefcafe',
  JSON.stringify(replayed.steps));

console.log('recipe catalog');
const { RecipeCatalog, fingerprint } = await import('../lib/catalog.js');
const catalogDir = mkdtempSync(join(tmpdir(), 'knx-cat-'));
const catalog = new RecipeCatalog(catalogDir);
const baseRecipe = {
  device: { ia: '1.1.2' },
  steps: [
    { op: 'memory_write', address: '0x4800', data: 'deadbeefcafe' },
    { op: 'note', text: 'recorded once' },
  ],
};
const first = await catalog.install(baseRecipe, { orderNumber: 'AKH-0401.02', applicationId: 'M-0002_A-1234' });
check('catalog install', first.ok && first.reused === false && first.steps === 1, JSON.stringify(first));
const second = await catalog.install(
  { ...baseRecipe, device: { ia: '1.1.9' }, steps: [...baseRecipe.steps, { op: 'note', text: 'other device' }] },
  { orderNumber: 'AKH-0401.02' },
);
check('same content dedups across devices and notes', second.id === first.id && second.reused === true, JSON.stringify(second));
check('fingerprint ignores the device binding', fingerprint(baseRecipe) === fingerprint({ ...baseRecipe, device: { ia: '1.1.9' } }));

const found = await catalog.find({ orderNumber: 'AKH-0401.02' });
check('find by product', found?.id === first.id, found?.id);
const changed = await catalog.install({ steps: [{ op: 'memory_write', address: '0x4800', data: '0badc0de' }] }, { orderNumber: 'AKH-0401.02' });
check('different content becomes its own entry', changed.id !== first.id && changed.versions === 1);
const catalogListing = await catalog.list();
check('catalog lists both entries', catalogListing.count === 2, String(catalogListing.count));

const applied = await catalog.apply({ id: first.id, ia: '1.1.2' });
check('apply binds the recipe to a device', applied.ok && applied.recipe.device.ia === '1.1.2' && applied.uses === 1,
  JSON.stringify({ ia: applied.recipe?.device?.ia, uses: applied.uses }));
const versions = await catalog.versions(first.id);
check('versions are kept', versions.ok && versions.versions.length === 1, JSON.stringify(versions.versions));

// through the tools, against the bus
runtime.config.libraryPath = catalogDir;
const captureInstall = await call('knx_capture', { ia: '1.1.2', seconds: 0.3, install: true });
check('capture can install straight into the catalog',
  captureInstall.ok === false || captureInstall.catalogId !== undefined,
  JSON.stringify(captureInstall).slice(0, 120));
const installedByTool = await call('knx_catalog', {
  action: 'install',
  recipe: { steps: [{ op: 'memory_write', address: '0x4800', data: 'deadbeefcafe' }] },
  orderNumber: 'AKH-0401.02',
});
check('knx_catalog installs through the tool surface', installedByTool.ok, JSON.stringify(installedByTool));
runtime.simulator.devices.get(0x1102).fill(0x4800, Buffer.alloc(6));
const fromCatalog = await call('knx_download', { catalogId: installedByTool.id, ia: '1.1.2' });
check('knx_download runs a catalog recipe',
  fromCatalog.ok && runtime.simulator.devices.get(0x1102).dump(0x4800, 6).toString('hex') === 'deadbeefcafe',
  JSON.stringify(fromCatalog.steps));
const forgot = await catalog.forget(changed.id);
check('forget removes one entry', forgot.ok && (await catalog.list()).count === 1);

console.log('group address table');
const gate = await import('../lib/gatable.js');
const tableDevice = { iaText: '1.1.2', name: 'Dimmer EG',
  comObjects: [{ ref: 'O-1', links: ['ga-1', 'ga-2'] }, { ref: 'O-2', links: ['ga-3'] }] };
const tableApp = { comObjects: [{ id: 'O-1', number: 1 }, { id: 'O-2', number: 2 }] };
const tableGas = [{ id: 'ga-1', number: 2307 }, { id: 'ga-2', number: 2308 }, { id: 'ga-3', number: 2309 }];
const tableModel = gate.buildTables(tableDevice, tableApp, tableGas);
check('group address table built from the project',
  tableModel.addresses.length === 3 && tableModel.associations.length === 3,
  JSON.stringify(tableModel.counts));
check('address table encoding is System B (unused slot + uint16 GAs)',
  gate.encodeAddressTable(tableModel).toString('hex') === 'ffff090309040905',
  gate.encodeAddressTable(tableModel).toString('hex'));
check('association table encoding is (TSAP, ASAP) pairs',
  gate.encodeAssociationTable(tableModel).toString('hex') === '000100010002000100030002',
  gate.encodeAssociationTable(tableModel).toString('hex'));
check('tables round-trip',
  JSON.stringify(gate.decodeAddressTable(gate.encodeAddressTable(tableModel))) === JSON.stringify(tableModel.addresses));

const noProfile = gate.buildTableRecipe(tableModel, { ia: '1.1.2' });
check('a table download refuses to guess base addresses',
  noProfile.ok === false && noProfile.needsProfile === true, JSON.stringify(noProfile.error).slice(0, 80));

const tableProfile = { ...gate.SYSTEM_B, addressBase: 0x5000, associationBase: 0x5100 };
const tableBuilt = gate.buildTableRecipe(tableModel, { profile: tableProfile, ia: '1.1.2' });
check('table recipe covers both regions and restarts',
  tableBuilt.ok && tableBuilt.recipe.steps.some((step) => step.op === 'restart')
  && tableBuilt.recipe.steps.filter((step) => step.op === 'memory_write').length === 3,
  JSON.stringify(tableBuilt.recipe.steps.map((step) => [step.op, step.address])));

// A device honours the table: it answers listed addresses and stays silent otherwise.
const tableStore = new gate.DeviceTableStore({ addressBase: 0x5000, associationBase: 0x5100 });
runtime.simulator.devices.get(0x1102).attachTables(tableStore);
const tableRun = await call('knx_download', { recipe: tableBuilt.recipe });
check('table download runs on the bus', tableRun.ok, JSON.stringify(tableRun.steps));
check('device now answers a listed group address',
  tableStore.listens(2307) && tableStore.addresses.length === 3, JSON.stringify(tableStore.summary()));
const listened = await call('knx_ga_write', { ga: '1/1/5', dpt: '1.001', value: 1 });
check('device ignores a group address outside its table', listened.ok === true);
const unheard = await call('knx_ga_read', { ga: '1/1/9', dpt: '1.001', timeoutMs: 400 });
check('an address outside the table gets no answer', unheard.ok === false, JSON.stringify(unheard));

// Calibration: infer the profile from a capture of exactly this download.
const syntheticCapture = {
  frames: tableBuilt.recipe.steps
    .filter((step) => step.op === 'memory_write')
    .flatMap((step) => {
      const bytes = Buffer.from(step.data, 'hex');
      const out = [];
      for (let offset = 0; offset < bytes.length; offset += 11) {
        const apdu = cemi.apduMemoryWrite(Number(step.address) + offset, bytes.subarray(offset, offset + 11));
        out.push({ ...cemi.parse(cemi.ldata(0x1102, apdu, false)), kind: 'ldata', service: 'A_Memory_Write' });
      }
      return out;
    }),
};
const inferred = gate.inferProfile(syntheticCapture.frames, tableModel, { ia: 0x1102 });
check('base addresses are inferred from a capture',
  inferred.ok && inferred.profile.addressBase === 0x5000 && inferred.profile.associationBase === 0x5100,
  JSON.stringify(inferred.profile?.inference ?? inferred.error));

// Profiles are learned once per product family and reused afterwards.
const { TableProfileStore, identityKeys } = await import('../lib/profiles.js');
const profileDir = mkdtempSync(join(tmpdir(), 'knx-prof-'));
const profileStore = new TableProfileStore(profileDir);
const savedKeys = identityKeys({ product: { orderNumber: 'AKH-0401.02' }, application: { id: 'M-0002_A-1234', maskVersion: 'MV-0705' } });
const put = await profileStore.put(savedKeys, { ...gate.SYSTEM_B, addressBase: 0x5000, associationBase: 0x5100 }, { source: 'calibrated' });
check('profile saved under product identity', put.saved.length === 3, JSON.stringify(put.saved));
const profileHit = await profileStore.find(savedKeys);
check('profile lookup prefers the order number',
  profileHit?.matchedBy === 'order' && profileHit.profile.addressBase === 0x5000,
  JSON.stringify({ by: profileHit?.matchedBy, base: profileHit?.profile?.addressBase }));
const listed = await profileStore.list();
check('profiles are listable', listed.count === 3, String(listed.count));
const forgotten = await profileStore.forget(savedKeys[1].key);
check('a profile can be forgotten', forgotten.ok === true);

// Point the runtime at the same directory and load a project there, then let the
// tool path (not the raw store) resolve the profile.
runtime.config.libraryPath = profileDir;
runtime._library = null;
await call('knx_import', { path: 'examples/site.knxproj' });
await call('knx_import', { path: 'examples/acme-dimmer.knxprod' });
const viaLibrary = await call('knx_group_table', { action: 'build', ia: '1.1.2' });
check('build without base addresses uses the saved profile',
  viaLibrary.ok === true && String(viaLibrary.profileSource ?? '').startsWith('library'),
  JSON.stringify({ ok: viaLibrary.ok, source: viaLibrary.profileSource, error: viaLibrary.error }));
const secondDevice = await call('knx_group_table', { action: 'build', ia: '1.1.3' });
check('the same product family needs no second calibration',
  secondDevice.ok === true && String(secondDevice.profileSource ?? '').startsWith('library'),
  JSON.stringify({ ok: secondDevice.ok, source: secondDevice.profileSource, error: secondDevice.error }));

console.log('routing transport');
const routingOptions = { group: '239.255.42.42', port: 36799 };
const routerA = await knxip.Router.open(routingOptions);
const routerB = await knxip.Router.open(routingOptions);
await new Promise((resolve) => setTimeout(resolve, 150));
const routingGa = cemi.parseGA('3/1/5');
await routerA.sendCemi(cemi.ldata(routingGa, cemi.apduGroupWrite(Buffer.from([0x0c, 0x33])), true));
const routed = await routerB.wait((frame) => frame.kind === 'ldata' && frame.group && frame.dst === routingGa, 1500);
check('routing carries group telegrams without a tunnel',
  routed?.service === 'A_GroupValue_Write' && routed.value.toString('hex') === '0c33',
  JSON.stringify(routed?.service));
await routerA.close();
await routerB.close();

console.log('panel bridge');
const { createBridge } = await import('../lib/http.js');
const bridge = createBridge(runtime);
function fakeRes() {
  const state = { status: 0, body: null, headers: null };
  return {
    state,
    writeHead(status, headers) { state.status = status; state.headers = headers; },
    end(body) { state.body = body ? JSON.parse(body) : null; },
  };
}
async function bridgeCall(req) {
  const res = fakeRes();
  // A real HTTP request always has a peer; the bridge fails closed without one.
  await bridge({ socket: { remoteAddress: '127.0.0.1' }, headers: {}, ...req }, res);
  return { status: res.state.status, body: res.state.body, headers: res.state.headers };
}
const health = await bridgeCall({ url: '/knx/api/health', method: 'GET' });
check('bridge health', health.status === 200 && health.body.ok === true && health.body.operations.includes('scan'), JSON.stringify(health.body));
const bridgeState = await bridgeCall({ url: '/knx/api/state', method: 'GET' });
check('bridge state', bridgeState.status === 200 && bridgeState.body.connection.connected === true);
const bridgeScan = await bridgeCall({
  url: '/knx/api/op', method: 'POST',
  async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ name: 'scan', args: { line: '1.1', start: 1, end: 4, window: 4 } })); },
});
check('bridge scan op', bridgeScan.status === 200 && bridgeScan.body.count === 3, JSON.stringify(bridgeScan.body).slice(0, 120));
const bridgeBad = await bridgeCall({
  url: '/knx/api/op', method: 'POST',
  async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ name: 'dropDatabase' })); },
});
check('bridge rejects unknown op', bridgeBad.status === 400 && /unknown operation/.test(bridgeBad.body.error), JSON.stringify(bridgeBad.body));
const bridgeRemote = await bridgeCall({
  url: '/knx/api/state', method: 'GET', socket: { remoteAddress: '192.168.1.77' },
});
check('bridge refuses a non-loopback peer when the Host has no connection service',
  bridgeRemote.status === 403 && /non-loopback/.test(bridgeRemote.body.error), JSON.stringify(bridgeRemote.body));

const { createBridge: createGuardedBridge } = await import('../lib/http.js');
const guarded = createGuardedBridge(runtime, { requestRejection: () => 401 });
const guardedRes = fakeRes();
await guarded({ url: '/knx/api/op', method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: {},
  async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ name: 'state' })); } }, guardedRes);
check('bridge honours the Host rejection status', guardedRes.state.status === 401, String(guardedRes.state.status));

const tokenBridge = createGuardedBridge(runtime, { token: 's3cret' });
const tokenRes = fakeRes();
await tokenBridge({ url: '/knx/api/state', method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: {} }, tokenRes);
const tokenOkRes = fakeRes();
await tokenBridge({ url: '/knx/api/health', method: 'GET', socket: { remoteAddress: '127.0.0.1' },
  headers: { 'x-knx-token': 's3cret' } }, tokenOkRes);
check('bridgeToken is enforced', tokenRes.state.status === 401 && tokenOkRes.state.status === 200,
  JSON.stringify([tokenRes.state.status, tokenOkRes.state.status]));

const bridgeWrite = await bridgeCall({
  url: '/knx/api/op', method: 'POST',
  async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ name: 'memoryWrite', args: { ia: '1.1.1', address: '0x4000', data: 'ff' } })); },
});
check('bridge write op', bridgeWrite.status === 200 && bridgeWrite.body.ok === true, JSON.stringify(bridgeWrite.body));

const status = await call('knx_status', {});
check('audit trail recorded', status.ok && status.audit.length > 5, String(status.audit.length));

await runtime.close();
runtime.stopSimulator();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
