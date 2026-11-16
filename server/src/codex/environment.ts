import {
  AGENCY_ENVIRONMENT,
  type AgencyEnvironment,
} from "../agency-environment";

const c = (setting: string) => ["-c", setting];

function tomlString(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Curated environment value cannot be empty");
  return JSON.stringify(trimmed);
}

/**
 * Codex `config/overrides.rs` splits `-c` key paths on `.` without unquoting,
 * so quoted keys become literal quotes in the table key name. Emit bare key
 * segments and reject characters that would misparse or split a key path.
 */
function codexKeySegment(id: string): string {
  if (!id || id !== id.trim() || /[.=]/.test(id) || /\s/.test(id) || /["']/.test(id)) {
    throw new Error(`Invalid curated environment identifier: ${JSON.stringify(id)}`);
  }
  return id;
}

/**
 * Translates {@link AgencyEnvironment} into `-c` command-line overrides for
 * `codex` (both `codex app-server` and CLI subcommands), without writing to the
 * user's or app's `config.toml`.
 *
 * Allowlist mechanism in Codex 0.168.0:
 * - Per-item enablement exists (`plugins._default.enabled=false` plus
 *   `plugins.<id>.enabled=true`, and `apps._default.enabled=false` plus
 *   `apps.<id>.enabled=true`), so non-empty allowlists work directly when
 *   issue #38 populates them.
 * - However, Codex 0.168.0 has no `-c` download allowlist for the curated
 *   plugin catalogue: whenever `features.plugins=true` and `remote_plugin=false`,
 *   startup sync clones the entire `openai/plugins` repository (`~58-81 MB`),
 *   and `features.apps=true` registers `codex_apps`. While the allowlists are
 *   empty, keeping `features.plugins=false`, `features.apps=false`, and
 *   `include_apps_instructions=false` prevents that download and registration.
 */
export function codexEnvironmentArgs(
  environment: AgencyEnvironment = AGENCY_ENVIRONMENT,
): string[] {
  const args: string[] = [];

  // `image_gen.imagegen` depends on `features.image_generation` (plus auth and
  // multimodal model capabilities) and does not depend on the `imagegen` skill.
  args.push(...c(`features.image_generation=${environment.aiImages}`));
  args.push(...c(`web_search=${tomlString(environment.webSearch)}`));
  args.push(
    ...c(`features.multi_agent=${environment.subagents}`),
    ...c(`features.multi_agent_v2=${environment.subagents}`),
    ...c(`agents.enabled=${environment.subagents}`),
  );
  args.push(...c(`skills.bundled.enabled=${environment.bundledSkills}`));
  args.push(...c(`features.tool_suggest=${environment.pluginSuggestions}`));

  args.push(
    ...c(`features.plugins=${environment.allowedPlugins.length > 0}`),
    ...c("features.remote_plugin=false"),
    ...c("features.plugin_discovery_prefetch=false"),
    ...c("features.plugin_sharing=false"),
    ...c("plugins._default.enabled=false"),
  );
  for (const id of environment.allowedPlugins) {
    args.push(...c(`plugins.${codexKeySegment(id)}.enabled=true`));
  }

  const hasConnectors = environment.allowedConnectors.length > 0;
  args.push(
    ...c(`features.apps=${hasConnectors}`),
    ...c(`include_apps_instructions=${hasConnectors}`),
    ...c("apps._default.enabled=false"),
  );
  for (const id of environment.allowedConnectors) {
    args.push(...c(`apps.${codexKeySegment(id)}.enabled=true`));
  }

  return args;
}
