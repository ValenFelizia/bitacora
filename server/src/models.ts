/**
 * Which model works on the agency's requests (DEC-014). The list comes from
 * the engine's catalogue for the account; Bitácora only picks a default,
 * leaves out the models the owner ruled out and says in plain words what each
 * one is good for.
 */

/** GPT-6.2 Sol: good and relatively cheap (Valentín, issue #57). */
export const DEFAULT_MODEL = "gpt-6.2-sol";
/** Effort every request asks for, whatever the model. */
export const WORK_EFFORT = "high";
/**
 * Effort of the automatic title. `thread/sample` cannot choose a model in
 * 0.168.0 (it reuses the work's cache, which belongs to the work's model), so
 * the cost is kept down with the lowest effort every listed model offers.
 */
export const TITLE_EFFORT = "low";

/** One entry of the engine's catalogue, already without hidden models. */
export type EngineModel = {
  id: string;
  displayName: string;
  efforts: string[];
  defaultEffort: string;
  isDefault: boolean;
};

/** What a request carries: the model and how much it thinks before answering. */
export type ModelSelection = { model: string; effort: string };

export type ModelChoice = {
  id: string;
  name: string;
  /** One line about what it is good for, without jargon. */
  description: string;
  recommended: boolean;
};

export type ModelState = {
  /** The model the next request uses. */
  current: ModelChoice;
  /** The effort in plain words, for the screen. */
  effortText: string;
  /** Empty while the account's catalogue is unknown, or when it has nothing allowed. */
  choices: ModelChoice[];
  /** True once the catalogue arrived, even empty: only a missing one can be asked again. */
  listed: boolean;
  /** Said when the chosen or the recommended model is not in the account. */
  notice?: string;
  /** True while the app is asking the engine for the catalogue. */
  listing?: boolean;
};

/** The owner ruled out every Astra model (issue #57). */
export function isAllowedModel(model: { id: string; displayName?: string }): boolean {
  return !/astra/i.test(model.id) && !/astra/i.test(model.displayName ?? "");
}

/** "GPT-6.2-Sol" or "gpt-6.2-sol" → "GPT-6.2 Sol". */
export function modelName(id: string, displayName?: string): string {
  const source = displayName?.trim() || id;
  return source
    .replace(/^gpt\b/i, "GPT")
    .replace(/(\d)-(?=[a-z])/gi, "$1 ")
    .replace(/ ([a-z])/g, (_, letter: string) => ` ${letter.toUpperCase()}`);
}

const KNOWN: Record<string, string> = {
  "gpt-6.2-sol": "Rápido y cuidadoso. Sirve para casi todo el trabajo de la agencia.",
  "gpt-6.1-terra": "Tiene buen ojo para fotos e imágenes.",
  "gpt-6.1-sol": "La versión anterior de Sol.",
  "gpt-6-sol": "Una versión más vieja de Sol.",
  "gpt-6-luna": "El más rápido y económico, para pedidos simples.",
  "gpt-5.6-sol": "Una versión más vieja de Sol.",
  "gpt-5.6-terra": "Una versión más vieja de Terra.",
  "gpt-5.6-luna": "Una versión más vieja de Luna, para pedidos simples.",
};

export function modelDescription(id: string): string {
  if (KNOWN[id]) return KNOWN[id];
  if (/sol/i.test(id)) return "Rápido y cuidadoso, para el trabajo de todos los días.";
  if (/terra/i.test(id)) return "Equilibrado, con buen ojo para imágenes.";
  if (/luna/i.test(id)) return "Rápido y económico, para pedidos simples.";
  return "Otro modelo disponible en tu cuenta.";
}

/** A catalogue that arrived with nothing allowed in it: empty, or only Astra. */
export const NO_MODELS = "Tu cuenta no tiene modelos disponibles para Bitácora.";

const EFFORT_TEXT: Record<string, string> = {
  low: "razonamiento bajo",
  medium: "razonamiento medio",
  high: "razonamiento alto",
  xhigh: "razonamiento muy alto",
  max: "razonamiento máximo",
};

function choice(id: string, displayName?: string): ModelChoice {
  return {
    id,
    name: modelName(id, displayName),
    description: modelDescription(id),
    recommended: id === DEFAULT_MODEL,
  };
}

/**
 * The model the next request uses and what the screen shows. `saved` is the
 * user's choice, if any; `catalogue` is undefined while the engine has not
 * answered. A choice that is not in the account falls back to the default,
 * and a default that is not there either falls back to the engine's own
 * default or the first one listed, saying so. A ruled-out choice is never
 * used, not even before the catalogue arrives.
 */
export function resolveModel(
  catalogue: EngineModel[] | undefined,
  saved?: string,
): { selection: ModelSelection; state: ModelState } {
  const wanted = saved && isAllowedModel({ id: saved }) ? saved : DEFAULT_MODEL;
  const allowed = (catalogue ?? []).filter(isAllowedModel);
  const choices = allowed.map((model) => choice(model.id, model.displayName));
  const pick = (model: EngineModel | undefined, notice?: string) => {
    const id = model?.id ?? wanted;
    const effort = !model || model.efforts.includes(WORK_EFFORT) ? WORK_EFFORT : model.defaultEffort;
    return {
      selection: { model: id, effort },
      state: {
        current: choice(id, model?.displayName),
        effortText: EFFORT_TEXT[effort] ?? `razonamiento ${effort}`,
        choices,
        listed: catalogue !== undefined,
        ...(notice ? { notice } : {}),
      },
    };
  };
  if (!catalogue) return pick(undefined);
  const found = allowed.find((model) => model.id === wanted);
  if (found) return pick(found);
  const fallback =
    allowed.find((model) => model.id === DEFAULT_MODEL) ??
    allowed.find((model) => model.isDefault) ??
    allowed[0];
  if (!fallback) return pick(undefined, NO_MODELS);
  return pick(
    fallback,
    `${modelName(wanted)} no está disponible en tu cuenta. Uso ${modelName(fallback.id, fallback.displayName)}.`,
  );
}
