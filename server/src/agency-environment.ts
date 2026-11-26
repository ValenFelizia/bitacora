import { join, resolve } from "node:path";

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
   * Skill names the kit ships. The name alone does not allow a skill: it also
   * has to be `repo` scope and live at `<agency>/.agents/skills/<name>/SKILL.md`
   * in the agency's copy of the kit, so the same name in the user folder or in
   * a folder the agent wrote by hand inside `.agents/skills` stays off.
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
  "Si en estas instrucciones vienen los datos que la usuaria contó al abrir Bitácora " +
  "(su agencia, su nombre y para qué la va a usar), usalos para hablarle y no vuelvas " +
  "a preguntar lo que ya está; si no vienen, preguntale el nombre de la agencia y cómo " +
  "firma antes de armar la marca. " +
  "Si lo que dice la usuaria en la conversación no coincide con estos datos, vale lo " +
  "que diga ella; si te pide cambiarlos, actualizá `perfil.md`. " +
  "Usá imágenes generadas con IA solo si la usuaria te lo pide explícitamente, " +
  "y nunca presentes una imagen con IA como si fuera una foto real de un hotel o un destino. " +
  "Para armar la agencia, seguí `.agents/skills/entrevista/SKILL.md`. " +
  "Antes de crear cualquier pieza, cotización o documento, llamá a listar_plantillas para ese pedido. " +
  "Si hay una que sirve, llamá a leer_plantilla, usala como formato y decilo en una línea. " +
  "Si hay varias que podrían servir, preguntá cuál con request_user_input antes de crear. Si no hay, seguí como siempre. " +
  "Si la consulta falla, decilo y no tomes la falla como una lista vacía. " +
  "Si te pide guardar un adjunto o archivo como plantilla, usá sumar_plantilla; si te pide cambiarla, usá actualizar_plantilla. " +
  "Para convertir una cotización PDF: mirá el original con mirar_pdf, armá un HTML editable con data-piece, " +
  "quitá los datos del cliente y prepará campos reutilizables. Dibujalo con dibujar a las medidas del PDF, " +
  "compará todas las páginas con el original usando mirar_pdf para el PDF y la vista de las imágenes dibujadas. " +
  "Ajustá y volvé a dibujar si difiere la estructura, tipografía, colores o ubicación de los bloques. " +
  "Guardá el HTML como archivo principal y el PDF original como referencia, junto a los recursos locales que necesite el HTML. " +
  "El PDF de referencia es de trabajo interno. Nunca reutilices sus datos del cliente ni lo adjuntes a una cotización nueva. " +
  "Usá las herramientas para cambiar las plantillas, sin editar el índice directamente. " +
  "Antes de un pedido ambiguo o grande, seguí `.agents/skills/entender-el-pedido/SKILL.md`. " +
  "Si una pregunta de request_user_input vuelve sin respuestas ({\"answers\":{}}), la usuaria prefirió no responderla ahora: " +
  "no la repitas enseguida, seguí con lo que puedas y contale qué supusiste.";

/**
 * Skills the kit ships, one folder each under `<agency>/.agents/skills/`.
 * Verified against `kit/turismo/.agents/skills` by the tests: adding a skill to
 * the kit without listing it here leaves it off, and a name listed here that
 * the kit does not ship turns nothing on.
 */
export const KIT_SKILLS = ["entender-el-pedido", "entrevista"] as const;

export const AGENCY_ENVIRONMENT: AgencyEnvironment = {
  developerInstructions: AGENCY_DEVELOPER_INSTRUCTIONS,
  aiImages: true,
  webSearch: "cached",
  subagents: false,
  goals: true,
  questions: true,
  bundledSkills: false,
  allowedSkills: KIT_SKILLS,
  pluginSuggestions: false,
  allowedPlugins: [],
  allowedConnectors: [],
};

/** Folder the agency's copy of the kit keeps its skills in. */
export function kitSkillsRoot(workspace: string): string {
  return join(workspace, ".agents", "skills");
}

/**
 * Windows reports the same file with either separator and any case; the engine
 * has to compare what the app-server listed against the path Bitácora wrote.
 */
export function skillPathKey(path: string): string {
  return resolve(path).replace(/\\/g, "/").replace(/\/{2,}/g, "/").toLowerCase();
}

/**
 * True only for a skill the kit ships, listed as `repo` scope, whose file is
 * exactly `<agency>/.agents/skills/<name>/SKILL.md`. Codex `0.168.0` looks for
 * project skills in the working folder's `.agents/skills`; a skill of any other
 * scope, a copy with the same name in another folder, and a folder the agent
 * wrote by hand are refused because the path is not the one Bitácora copied.
 */
export function isAllowedSkill(
  skill: { name: string; scope: string; path?: string | null },
  workspace: string,
  environment: AgencyEnvironment = AGENCY_ENVIRONMENT,
): boolean {
  if (skill.scope !== "repo") return false;
  if (!environment.allowedSkills.includes(skill.name)) return false;
  if (typeof skill.path !== "string" || !skill.path) return false;
  const expected = join(kitSkillsRoot(workspace), skill.name, "SKILL.md");
  return skillPathKey(skill.path) === skillPathKey(expected);
}
