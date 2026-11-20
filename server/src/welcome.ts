/**
 * The welcome questions (issue #67). They run once, before connecting the
 * account, without the agent: they ask what the interview would ask anyway, so
 * no cupo or time is spent on it. The answers are kept in plain text inside the
 * agency folder, where the agent reads them (DEC-015).
 *
 * Nothing here touches disk: the screen imports this module too, and the half
 * that reads and writes `perfil.md` lives in `welcome-profile.ts`.
 */
export const PROFILE_FILE = "perfil.md";

/** Longest agency or person name the welcome accepts. */
export const MAX_NAME = 80;
/** Longest answer to «Otra». */
export const MAX_OTHER = 300;

export type WelcomeUseId = "imagenes" | "presupuestos" | "orden" | "consultas";

/**
 * What the agency may use Bitácora for. The labels are the ones the screen
 * shows; they are also what `perfil.md` writes, so a person can read it.
 */
export const WELCOME_USES: readonly { id: WelcomeUseId; label: string; description: string }[] = [
  { id: "imagenes", label: "Imágenes para vender", description: "Placas para WhatsApp, historias y publicaciones." },
  { id: "presupuestos", label: "Presupuestos y cotizaciones", description: "Propuestas con precios para tus clientes." },
  { id: "orden", label: "Ordenar mi trabajo", description: "Archivos, clientes y pendientes." },
  { id: "consultas", label: "Responder consultas", description: "Mensajes para clientes." },
];

export type WelcomeAnswers = {
  agency: string;
  person: string;
  uses: WelcomeUseId[];
  other?: string;
};

/** What `perfil.md` says, as far as Bitácora reads it back. */
export type WelcomeProfile = {
  agency?: string;
  person?: string;
  uses: WelcomeUseId[];
};

/** A welcome answer that cannot be used, with the words the screen shows. */
export class WelcomeProblem extends Error {}

const single = (value: unknown) =>
  typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";

/**
 * Normalizes and checks what the screen sent. Empty names are refused: the
 * whole welcome can be skipped instead, and a profile without them tells the
 * agent nothing. A use that is not in the catalogue is dropped instead of
 * failing the save: the cost of ignoring it is only a suggestion.
 */
export function welcomeAnswers(input: unknown): WelcomeAnswers {
  const value = input as Partial<WelcomeAnswers> | null;
  if (!value || typeof value !== "object") throw new WelcomeProblem("No pude leer las respuestas. Probá de nuevo.");
  const agency = single(value.agency);
  const person = single(value.person);
  if (!agency) throw new WelcomeProblem("Faltó el nombre de tu agencia. Escribilo o salteá la bienvenida.");
  if (!person) throw new WelcomeProblem("Faltó tu nombre. Escribilo o salteá la bienvenida.");
  if (agency.length > MAX_NAME) throw new WelcomeProblem(`El nombre de la agencia puede tener hasta ${MAX_NAME} letras.`);
  if (person.length > MAX_NAME) throw new WelcomeProblem(`Tu nombre puede tener hasta ${MAX_NAME} letras.`);
  if (value.uses !== undefined && !Array.isArray(value.uses)) throw new WelcomeProblem("No pude leer los usos que marcaste. Probá de nuevo.");
  const uses = WELCOME_USES
    .filter((use) => (Array.isArray(value.uses) ? value.uses : []).includes(use.id))
    .map((use) => use.id);
  const other = single(value.other);
  if (other.length > MAX_OTHER) throw new WelcomeProblem(`Lo que escribiste en «Otra» puede tener hasta ${MAX_OTHER} letras.`);
  return { agency, person, uses, ...(other ? { other } : {}) };
}

/** The plain-text profile the agency keeps and can edit. */
export function profileMarkdown(answers: WelcomeAnswers): string {
  const labels = answers.uses.map((id) => WELCOME_USES.find((use) => use.id === id)?.label).filter(Boolean);
  return [
    "# Perfil de la agencia",
    "",
    "Bitácora preguntó esto la primera vez que se abrió. Se puede cambiar pidiéndomelo.",
    "",
    `- **Agencia:** ${answers.agency}`,
    `- **Nombre:** ${answers.person}`,
    ...(labels.length ? [`- **Usos:** ${labels.join(", ")}`] : []),
    ...(answers.other ? [`- **Otra:** ${answers.other}`] : []),
    "",
  ].join("\n");
}

const FIELD = /^\s*[-*]\s*\*\*(Agencia|Nombre|Usos|Otra):\*\*\s*(.*?)\s*$/i;

/**
 * Reads back what the welcome needs to know: the marked uses pick the
 * suggested routes. Anything unrecognized is ignored, so a profile rewritten
 * by the agent or by hand never breaks the screen.
 */
export function parseProfile(text: string): WelcomeProfile {
  const profile: WelcomeProfile = { uses: [] };
  for (const line of text.split(/\r?\n/)) {
    const field = FIELD.exec(line);
    if (!field) continue;
    const key = field[1].toLowerCase();
    const value = field[2];
    if (key === "agencia") profile.agency = value || undefined;
    else if (key === "nombre") profile.person = value || undefined;
    else if (key === "usos")
      for (const part of value.split(/[,;]/)) {
        const use = WELCOME_USES.find((candidate) =>
          [candidate.label, candidate.id].some((known) => known.toLowerCase() === part.trim().toLowerCase()),
        );
        if (use && !profile.uses.includes(use.id)) profile.uses.push(use.id);
      }
  }
  return profile;
}

/** The three suggestions the empty screen shows when nothing was marked. */
export const DEFAULT_ROUTES = [
  "Armame una propuesta con este link",
  "Armame una cotización rápida",
  "Revisá este PDF",
] as const;

const ROUTE_BY_USE: Record<WelcomeUseId, string> = {
  imagenes: "Armame placas para historias con este link",
  presupuestos: "Armame una cotización con este link",
  orden: "Ordename los archivos y pendientes de la agencia",
  consultas: "Escribime una respuesta para un cliente",
};

/**
 * Exactly three «Rumbos sugeridos», the marked uses first so the empty screen
 * starts where the agency said it needs help; with no uses they are the three
 * of always.
 */
export function suggestedRoutes(uses: readonly string[] | undefined): string[] {
  const picked = WELCOME_USES
    .filter((use) => uses?.includes(use.id))
    .map((use) => ROUTE_BY_USE[use.id]);
  return [...new Set([...picked, ...DEFAULT_ROUTES])].slice(0, 3);
}
