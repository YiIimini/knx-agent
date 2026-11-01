/**
 * Diagnostic rule book.
 *
 * A commissioning agent is only useful if it can say *why* something failed.
 * Every rule takes observed evidence (scan output, captured frames, failed
 * recipe steps, transport counters) and returns a finding with the next probe -
 * never a guess dressed up as a conclusion.
 */

export function diagnose({ scan = null, frames = null, failedSteps = null, transport = null } = {}) {
  const findings = [];

  if (transport) {
    if ((transport.ackTimeouts ?? 0) > 0) {
      findings.push({
        code: 'GATEWAY_NO_ACK',
        severity: 'high',
        evidence: `gateway did not acknowledge ${transport.ackTimeouts} tunnelling request(s)`,
        next: 'check the KNXnet/IP interface, its IP route and whether the tunnel limit (usually 4, often held by ETS) is exhausted; retry over routing.',
      });
    }
    if ((transport.rxErrors ?? 0) > 0) {
      findings.push({
        code: 'MALFORMED_INBOUND',
        severity: 'medium',
        evidence: `${transport.rxErrors} unparsable inbound frame(s)`,
        next: 'capture raw frames and compare with the cEMI layout; the interface may use a frame variant this build does not decode.',
      });
    }
  }

  if (Array.isArray(scan)) {
    if (!scan.length) {
      findings.push({
        code: 'NO_DEVICES',
        severity: 'high',
        evidence: 'line scan found no device answers',
        next: 'verify 29 V bus power, termination and that the interface is on the same line; then retry with a larger settle window.',
      });
    }
    const seen = new Map();
    for (const device of scan) {
      const key = device.ia ?? device.iaText;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    for (const [key, count] of seen) {
      if (count > 1) {
        findings.push({
          code: 'DUPLICATE_INDIVIDUAL_ADDRESS',
          severity: 'high',
          evidence: `individual address ${key} answered ${count} times`,
          next: 'read the serial number of each device in programming mode and re-assign one; duplicate addresses make downloads fail silently.',
        });
      }
    }
    for (const device of scan) {
      if (device.descriptor === null || device.descriptor === undefined) {
        findings.push({
          code: 'NO_DESCRIPTOR',
          severity: 'medium',
          evidence: `${device.iaText ?? device.ia} answered but returned no device descriptor`,
          next: 'device is likely in an error or half-downloaded state: read its serial number, then re-run its download from the start.',
        });
      }
    }
  }

  for (const step of failedSteps ?? []) {
    const detail = String(step.detail ?? '');
    if (/timeout|no answer/i.test(detail)) {
      findings.push({
        code: 'STEP_TIMEOUT',
        severity: 'high',
        evidence: `step ${step.op} timed out`,
        next: 'power cycle the device, then read back the memory block to see how far the download got before retrying.',
      });
    }
    if (/negative confirmation/i.test(detail)) {
      findings.push({
        code: 'NEGATIVE_CONFIRMATION',
        severity: 'high',
        evidence: `the link layer refused step ${step.op}`,
        next: 'bus level problem (collision, frame too long, no free address): check the interface error counters and bus termination.',
      });
    }
  }

  for (const frame of frames ?? []) {
    if (frame.conError) {
      findings.push({
        code: 'TRANSMISSION_ERROR',
        severity: 'medium',
        evidence: `L_Data.con with the error bit for ${frame.dstText}`,
        next: 'repeat the measurement with a bus monitor; one error is normal, a pattern points at cabling or a missing choke.',
      });
    }
    if (frame.hopCount === 0) {
      findings.push({
        code: 'HOP_COUNT_EXHAUSTED',
        severity: 'medium',
        evidence: 'a frame reached the bus with hop count 0',
        next: 'a coupler or repeater is dropping the frame; check the topology (three couplers maximum) or the interface hop count setting.',
      });
    }
  }

  if (!findings.length) {
    findings.push({
      code: 'NO_FINDING',
      severity: 'info',
      evidence: 'no rule matched the supplied observations',
      next: 'supply scan output, captured frames or failed recipe steps.',
    });
  }
  return findings;
}
