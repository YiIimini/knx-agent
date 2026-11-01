/**
 * Acceptance: compare what the project says with what is actually on the bus.
 *
 * This is the "walk the site before you touch it" step: it reads, never writes, so
 * it is safe to run on a live installation and safe to run as often as you like.
 * The output is a table plus a Markdown report that can be attached to a handover.
 */

import * as cemi from './cemi.js';
import { diagnose } from './diagnose.js';

/** 'MV-0705' -> 0x0705; anything unparsable stays null rather than guessing. */
export function maskToDescriptor(mask) {
  const match = /^MV-?([0-9A-Fa-f]{4})$/.exec(String(mask ?? '').trim());
  return match ? Number.parseInt(match[1], 16) : null;
}

function hex(value) {
  return value === null || value === undefined ? null : `0x${value.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Newest imported project, or the one asked for. */
async function pickProject(library, projectId) {
  const { projects } = await library.list();
  if (projectId) {
    const found = projects.find((entry) => entry.id === projectId);
    return found ? library.read(found.id) : null;
  }
  const newest = [...projects].sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1))[0];
  return newest ? library.read(newest.id) : null;
}

/**
 * Run one acceptance pass.
 * @param options.library - KnxLibrary with at least one imported project.
 * @param options.link - DeviceLink on a live tunnel.
 * @param options.projectId - project entry id (defaults to the newest import).
 * @param options.line - area.line to scan, e.g. "1.1" (default "1.1").
 */
export async function runAcceptance({ library, link, projectId = null, line = '1.1', scanWindow = 48, settleMs = 600 }) {
  const project = await pickProject(library, projectId);
  if (!project) {
    return { ok: false, error: 'no imported project: run knx_import with a .knxproj first' };
  }

  const scanned = await link.scan(line, { start: 0, end: 256, window: scanWindow, settleMs });
  const present = new Map(scanned.map((device) => [device.ia, device]));
  const inProject = (project.devices ?? []).filter((device) => device.iaText.startsWith(`${line}.`));

  const rows = [];
  for (const device of inProject) {
    const ia = device.iaText;
    const observed = present.get(device.ia) ?? null;
    let expectedMask = null;
    let expectedMaskHex = null;
    try {
      const resolved = await library.resolve({ projectId: project.id, ia });
      if (resolved.ok && resolved.application?.maskVersion) {
        expectedMask = maskToDescriptor(resolved.application.maskVersion);
        expectedMaskHex = resolved.application.maskVersion;
      }
    } catch { /* a device without product data is reported, not fatal */ }

    const observedMask = observed?.descriptor ?? null;
    const links = (device.comObjects ?? []).reduce((sum, object) => sum + (object.groupAddresses?.length ?? 0), 0);
    let status = 'ok';
    if (!observed) status = 'missing';
    else if (expectedMask !== null && observedMask !== null && expectedMask !== observedMask) status = 'mask-mismatch';
    else if (observedMask === null) status = 'no-descriptor';

    rows.push({
      ia,
      name: device.name ?? '',
      status,
      present: Boolean(observed),
      observedMask: hex(observedMask),
      expectedMask: expectedMaskHex,
      groupAddressLinks: links,
      communicationObjects: (device.comObjects ?? []).length,
    });
  }

  const expectedIas = new Set(inProject.map((device) => device.iaText));
  const unexpected = scanned
    .filter((device) => !expectedIas.has(device.iaText))
    .map((device) => ({ ia: device.iaText, mask: hex(device.descriptor), name: 'not in project' }));

  const summary = {
    line,
    project: { id: project.id, name: project.name },
    expected: rows.length,
    present: rows.filter((row) => row.present).length,
    missing: rows.filter((row) => row.status === 'missing').length,
    maskMismatch: rows.filter((row) => row.status === 'mask-mismatch').length,
    noDescriptor: rows.filter((row) => row.status === 'no-descriptor').length,
    unexpected: unexpected.length,
  };

  const findings = diagnose({
    scan: scanned,
    frames: null,
    failedSteps: rows
      .filter((row) => row.status !== 'ok')
      .map((row) => ({ op: `device ${row.ia}`, detail: row.status === 'mask-mismatch'
        ? 'the mask on the bus does not match the project; wrong product or wrong device'
        : row.status })),
    transport: null,
  });

  return {
    ok: true,
    summary,
    devices: rows,
    unexpected,
    findings,
    report: markdown(project, summary, rows, unexpected, findings),
  };
}

function markdown(project, summary, rows, unexpected, findings) {
  const lines = [];
  lines.push(`# KNX acceptance — ${project.name || project.id}`);
  lines.push('');
  lines.push(`- line: \`${summary.line}\``);
  lines.push(`- expected ${summary.expected} · present ${summary.present} · missing ${summary.missing} · mask mismatch ${summary.maskMismatch} · unexpected ${summary.unexpected}`);
  lines.push('');
  lines.push('| IA | name | status | mask on bus | mask in project | GA links |');
  lines.push('|---|---|---|---|---|---|');
  for (const row of rows) {
    lines.push(`| \`${row.ia}\` | ${row.name} | ${row.status} | ${row.observedMask ?? '—'} | ${row.expectedMask ?? '—'} | ${row.groupAddressLinks} |`);
  }
  if (unexpected.length) {
    lines.push('');
    lines.push('**On the bus but not in the project:**');
    for (const device of unexpected) lines.push(`- \`${device.ia}\` (${device.mask ?? 'no descriptor'})`);
  }
  if (findings?.length) {
    lines.push('');
    lines.push('## Findings');
    for (const finding of findings) {
      lines.push(`- **${finding.code}** (${finding.severity}): ${finding.evidence}`);
      lines.push(`  - next: ${finding.next}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}
