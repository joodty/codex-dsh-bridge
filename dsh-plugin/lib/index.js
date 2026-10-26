import z from "@deepseek-ai/schemastery";
import { publishConnection } from "./local-connection.js";
import {
  DEFAULT_BASE_URL,
  normalizeBridgeConfig,
  writeBridgeConfigAtomic,
} from "./config.js";
import {
  createSettingsRouteHandler,
  SETTINGS_ROUTE_PATH,
} from "./settings-route.js";

export const SETTINGS_NAMESPACE = "codex-dsh-bridge";
export const BridgeSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  baseUrl: z.string().default(DEFAULT_BASE_URL),
});

// rc3 derives settings from each plugin's Config and reloads it on edits.
export const Config = BridgeSettingsSchema;
export const inject = ["settings", "webServer", "connection"];

export function apply(ctx, config) {
  const value = normalizeBridgeConfig(config ?? {});
  ctx.effect(async () => {
    await writeBridgeConfigAtomic({ ...value, baseUrl: ctx.webServer.getOrigin() });
    return value.enabled ? publishConnection(ctx) : undefined;
  }, "codex-dsh-bridge: publish authenticated local desktop connection");
  const handleSettings = createSettingsRouteHandler(ctx.settings);
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: SETTINGS_ROUTE_PATH,
    handler: (request, response) => {
      const admission = ctx.connection.admit(request);
      if ("rejection" in admission || admission.peer.principal.kind !== "owner") {
        response.writeHead(admission.rejection ?? 403);
        response.end("unauthorized");
        return;
      }
      return handleSettings(request, response);
    },
  }), "codex-dsh-bridge: authenticated settings route");
}
