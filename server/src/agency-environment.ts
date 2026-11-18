/**
 * Provider-independent curated environment policy for travel agencies (DEC-011).
 *
 * Bitácora shapes a workspace tailored for an agency instead of stripping the
 * engine down: AI images remain available when explicitly asked by the user
 * (never presented as real photos of a hotel or destination), the provider's
 * web search and goals stay on (a page the user pastes still enters through
 * `traer`, and every number still comes from a cited source), the agent can
 * ask the user questions with options, subagents and non-agency bundled skills
 * stay off, and external plugins/connectors use an allowlist that is empty
 * until issue #38 selects the agency shortlist.
 */
export type AgencyEnvironment = {
  /** Instructions added to every work thread in plain Rioplatense Spanish. */
  developerInstructions: string;
  /** Built-in AI image generation; used only on explicit user request. */
  aiImages: boolean;
  /**
   * Provider-hosted web search. `cached` is the provider's own default: results
   * from its index, without the agent fetching live pages.
   */
  webSearch: "disabled" | "cached" | "live";
  /** Multi-agent / subagent spawning; disabled to preserve the single-work UX. */
  subagents: boolean;
  /** Thread goals (`create_goal`, `get_goal`, `update_goal`). */
  goals: boolean;
  /**
   * Questions with options the agent asks the user and waits on
   * (`request_user_input`), outside the provider's planning mode too.
   */
  questions: boolean;
  /** Provider bundled skills unrelated to travel agencies (skill/plugin creators, review, docs). */
  bundledSkills: boolean;
  /**
   * Allowlisted skill names provided by Bitácora's kit. Empty because the kit
   * currently ships no skills; every other skill (user, admin, system, and
   * repo/ancestor) is disabled so host or external skills never leak in.
   */
  allowedSkills: readonly string[];
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
  "y nunca presentes una imagen con IA como si fuera una foto real de un hotel o un destino. " +
  "Si una pregunta de request_user_input vuelve sin respuestas ({\"answers\":{}}), la usuaria prefirió no responderla ahora: " +
  "no la repitas enseguida, seguí con lo que puedas y contale qué supusiste.";

export const AGENCY_ENVIRONMENT: AgencyEnvironment = {
  developerInstructions: AGENCY_DEVELOPER_INSTRUCTIONS,
  aiImages: true,
  webSearch: "cached",
  subagents: false,
  goals: true,
  questions: true,
  bundledSkills: false,
  allowedSkills: [],
  pluginSuggestions: false,
  allowedPlugins: [],
  allowedConnectors: [],
};

export function isAllowedSkill(
  skill: { name: string; scope: string },
  environment: AgencyEnvironment = AGENCY_ENVIRONMENT,
): boolean {
  return skill.scope === "repo" && environment.allowedSkills.includes(skill.name);
}
