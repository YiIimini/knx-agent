/**
 * knx-agent — KNX wired-system commissioning tools for the Harness.
 *
 * Two halves, one runtime:
 *   - the tool registry (`lib/tools.js`), for the agent;
 *   - an HTTP bridge (`lib/http.js`) on the Web GUI's own origin, for the panel.
 * Both call `lib/ops.js`, so the UI cannot drift from what the model can do.
 *
 * Everything is dependency free: `node:dgram` and `node:zlib` are the only
 * external touch points, so the same build runs wherever the Harness runs -
 * macOS included, without ETS or a Windows guest.
 */

import { KnxRuntime } from './lib/runtime.js';
import { buildTools } from './lib/tools.js';
import { createBridge } from './lib/http.js';

/** Cordis plugin name. */
export const name = 'knx-agent';

/** The tool registry is the only hard service dependency. */
export const inject = ['tools'];

/**
 * Register the tool surface, and the panel's HTTP bridge when this composition
 * serves a Web GUI.
 * @param ctx - Cordis context that owns the registrations.
 * @param config - Row config: gateway, port, layer, timeouts, allowWrites, simulator defaults.
 */
export function apply(ctx, config = {}) {
  const runtime = new KnxRuntime(config ?? {});

  ctx.effect(() => {
    const definitions = buildTools(runtime);
    const disposers = [];
    const failures = [];
    for (const definition of definitions) {
      try {
        disposers.push(ctx.tools.register(definition));
      } catch (error) {
        // One bad definition must not take the whole surface down, but a surface
        // that registered nothing is a real failure and has to be reported.
        failures.push(`${definition.name}: ${error.message}`);
      }
    }
    if (!disposers.length) throw new Error(`knx-agent registered no tools: ${failures.join('; ')}`);
    return () => {
      for (const dispose of disposers) {
        try { dispose(); } catch { /* already gone */ }
      }
    };
  });

  // Optional: a composition without a Web GUI keeps the tools and stays inert here.
  const webServer = ctx.get('webServer');
  const connection = ctx.get('connection');
  if (webServer) {
    ctx.effect(() => {
      const dispose = webServer.register({
        kind: 'prefix',
        path: '/knx',
        handler: createBridge(runtime, {
          // The bridge writes to a bus, so it goes through the Host's own
          // Host/Origin and browser-credential check like every other Web route.
          requestRejection: connection
            ? (request) => connection.requestRejection(request)
            : null,
          token: runtime.config.bridgeToken ?? '',
        }),
      });
      return () => {
        try { dispose(); } catch { /* already gone */ }
      };
    });
  }

  ctx.effect(() => () => {
    void runtime.close();
  });
}
