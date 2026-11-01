/**
 * The panel's HTTP bridge.
 *
 * A static installed bundle has no client→host RPC channel, so the Client half
 * talks to the Host half over one same-origin route. It exposes exactly the
 * operations the agent tools expose (`lib/ops.js`), which keeps the UI and the
 * model on one implementation with one set of failure reasons.
 *
 * AUTHORISATION - this route performs bus writes, so it is not open:
 *   - when the Host composition has a `connection` service, every request is run
 *     through its Host/Origin and browser-credential check, exactly like the rest
 *     of the Web surface;
 *   - otherwise (a composition with a plain web server) only loopback peers are
 *     accepted, because a LAN-reachable KNX bridge would be an unauthenticated
 *     write path to the bus;
 *   - `bridgeToken`, when configured, is an additional shared secret required in
 *     `x-knx-token` for every request.
 */

import { ops, OP_NAMES, BUS_OPS, PolicyError } from './ops.js';

const MAX_BODY = 256 * 1024;

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error(`request body larger than ${MAX_BODY} bytes`);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function isLoopbackPeer(address) {
  if (!address) return false;
  const text = String(address);
  return text === '::1'
    || text.startsWith('127.')
    || text.startsWith('::ffff:127.')
    || text === '::ffff:7f00:1';
}

const ALLOWED = new Set(OP_NAMES);

/**
 * Build the request handler for the `/knx` prefix route.
 * @param runtime - the plugin's single KnxRuntime.
 * @param options - {requestRejection, token}: Host admission hook and optional shared secret.
 * @returns an async (req, res) handler.
 */
export function createBridge(runtime, options = {}) {
  const { requestRejection = null, token = '' } = options;

  function authorize(req) {
    const remote = req.socket?.remoteAddress;
    if (token) {
      const header = req.headers?.['x-knx-token'];
      const given = Array.isArray(header) ? header[0] : header;
      if (given !== token) return { status: 401, reason: 'missing or wrong x-knx-token' };
    }
    if (typeof requestRejection === 'function') {
      try {
        const rejection = requestRejection({ headers: req.headers ?? {} });
        if (rejection === 401 || rejection === 403) {
          return { status: rejection, reason: 'rejected by the Host connection policy' };
        }
      } catch (error) {
        return { status: 403, reason: `admission failed: ${error.message}` };
      }
      return null;
    }
    if (!isLoopbackPeer(remote)) {
      return { status: 403, reason: `non-loopback peer ${remote} needs the Host connection service or a bridgeToken` };
    }
    return null;
  }

  return async function handleKnxRequest(req, res) {
    const denied = authorize(req);
    if (denied) {
      send(res, denied.status, { ok: false, error: denied.reason, bridge: 'knx' });
      return;
    }

    let path;
    try {
      path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      send(res, 400, { ok: false, error: 'malformed request URL' });
      return;
    }

    if (!path.startsWith('/knx/api')) {
      send(res, 404, { ok: false, error: `no route ${path}` });
      return;
    }

    try {
      if (path === '/knx/api/state' && req.method === 'GET') {
        send(res, 200, await ops.state(runtime));
        return;
      }
      if (path === '/knx/api/health' && req.method === 'GET') {
        send(res, 200, {
          ok: true,
          bridge: 'knx',
          authorizedBy: typeof requestRejection === 'function' ? 'connection' : 'loopback',
          tokenRequired: Boolean(token),
          operations: [...ALLOWED].sort(),
        });
        return;
      }
      if (path === '/knx/api/op') {
        if (req.method !== 'POST') {
          send(res, 405, { ok: false, error: 'use POST for /knx/api/op' });
          return;
        }
        const body = await readJson(req);
        const name = String(body.name ?? '');
        if (!ALLOWED.has(name)) {
          send(res, 400, { ok: false, error: `unknown operation ${JSON.stringify(name)}`, operations: [...ALLOWED].sort() });
          return;
        }
        const args = body.args && typeof body.args === 'object' ? body.args : {};
        const started = Date.now();
        // One bus, one tunnel: panel calls and tool calls are serialised so a
        // capture cannot swap the tunnel layer under a running download.
        const run = () => ops[name](runtime, args);
        const result = BUS_OPS.has(name) ? await runtime.serialize(run) : await run();
        runtime.record(`panel:${name}`, args, result ?? {});
        send(res, 200, { ...result, ms: Date.now() - started });
        return;
      }
      send(res, 404, { ok: false, error: `no route ${req.method} ${path}` });
    } catch (error) {
      const status = error instanceof PolicyError ? 403 : 400;
      send(res, status, { ok: false, error: error.message ?? String(error), policy: status === 403 });
    }
  };
}
