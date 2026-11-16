/**
 * Provider-independent curated environment policy for travel agencies (DEC-011).
 *
 * Bitácora shapes a workspace tailored for an agency instead of stripping the
 * engine down: AI images remain available when explicitly asked by the user
 * (never presented as real photos of a hotel or destination), web intake uses
 * `traer` rather than provider web search, subagents and non-agency bundled
 * skills stay off, and external plugins/connectors use an allowlist that is
 * empty until issue #38 selects the agency shortlist.
 */
export type AgencyEnvironment = {
  /** Instructions added to every work thread in plain Rioplatense Spanish. */
  developerInstructions: string;
  /** Built-in AI image generation; used only on explicit user request. */
  aiImages: boolean;
  /** Provider-hosted web search; disabled because external pages enter via `traer`. */
  webSearch: "disabled";
  /** Multi-agent / subagent spawning; disabled to preserve the single-work UX. */
  subagents: boolean;
  /** Provider bundled skills unrelated to travel agencies (skill/plugin creators, review, docs). */
  bundledSkills: boolean;
  /** Automatic install prompts for provider plugins/connectors. */
  pluginSuggestions: boolean;
  /**
   * Allowlisted plugin IDs enabled for agencies. Empty for now so no full
   * catalogue is downloaded at startup; issue #38 will populate a shortlist.
   */
  allowedPlugins: readonly string[];
  /**
   * Allowlisted connector/app IDs enabled for agencies. Empty for now; issue
   * #38 will populate a shortlist without redesigning this contract.
   */
  allowedConnectors: readonly string[];
};

export const AGENCY_DEVELOPER_INSTRUCTIONS =
  "Respondé en castellano rioplatense, simple y sin términos técnicos. " +
  "Trabajá en la carpeta actual. " +
  "Usá imágenes generadas con IA solo si la usuaria te lo pide explícitamente, " +
  "y nunca presentes una imagen con IA como si fuera una foto real de un hotel o un destino.";

export const AGENCY_ENVIRONMENT: AgencyEnvironment = {
  developerInstructions: AGENCY_DEVELOPER_INSTRUCTIONS,
  aiImages: true,
  webSearch: "disabled",
  subagents: false,
  bundledSkills: false,
  pluginSuggestions: false,
  allowedPlugins: [],
  allowedConnectors: [],
};
