import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { AlertCircle, ArrowLeft, ArrowRight, Check } from "lucide-react";
import { MAX_NAME, MAX_OTHER, WELCOME_USES, type WelcomeUseId } from "../../server/src/welcome";

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2";
const buttonBordered = `inline-flex items-center justify-center gap-2 px-3 py-2 rounded-[6px] border border-ink bg-surface text-ink font-bold text-[14px] hover:bg-soft cursor-pointer disabled:opacity-40 disabled:cursor-default transition-colors duration-150 ${focusRing}`;
const buttonQuiet = `inline-flex items-center justify-center gap-2 px-3 py-2 rounded-[6px] border border-line bg-surface text-ink text-[14px] hover:bg-soft cursor-pointer disabled:opacity-40 disabled:cursor-default transition-colors duration-150 ${focusRing}`;
const backLink = `inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink cursor-pointer disabled:opacity-40 disabled:cursor-default transition-colors duration-150 ${focusRing}`;
const row =
  "flex items-start gap-3 px-2 py-2.5 cursor-pointer hover:bg-soft transition-colors duration-150";
const checkbox = `mt-[3px] w-4 h-4 shrink-0 accent-[#1d2838] cursor-pointer ${focusRing}`;

const STEPS = [
  {
    header: "Antes de empezar",
    question: "¿Cómo se llama tu agencia?",
    hint: "Es el nombre con el que voy a hablar de tu agencia.",
  },
  {
    header: "Antes de empezar",
    question: "¿Cómo te llamás?",
    hint: "Es el nombre con el que te voy a hablar.",
  },
  {
    header: "Antes de empezar",
    question: "¿Para qué vas a usar Bitácora?",
    hint: "Marcá todo lo que te sirva. Con eso empiezo por lo que más necesitás.",
  },
] as const;

export type WelcomeAnswer = {
  agency: string;
  person: string;
  uses: WelcomeUseId[];
  other?: string;
};

/**
 * The first-run questions (issue #67): one per screen, no agent involved, so
 * they cost neither cupo nor time. They can be skipped, and going back keeps
 * what was already written.
 */
export function Welcome({
  problem,
  onSave,
  onSkip,
}: {
  /** What the server said when it could not save, in plain words. */
  problem?: string;
  onSave: (answers: WelcomeAnswer) => void;
  onSkip: () => void;
}) {
  const base = useId();
  const titleId = `${base}-title`;
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [agency, setAgency] = useState("");
  const [person, setPerson] = useState("");
  const [uses, setUses] = useState<WelcomeUseId[]>([]);
  const [other, setOther] = useState("");
  const [writing, setWriting] = useState(false);
  const [missing, setMissing] = useState<"agency" | "person" | undefined>();
  const [sending, setSending] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // A new question takes the focus; the last one has no field, so it takes it
    // on its title, like a question the agent asks.
    if (step === 2) heading.current?.focus();
    else field.current?.focus();
  }, [step]);

  // A refused save must leave the buttons usable again.
  useEffect(() => {
    if (problem) setSending(false);
  }, [problem]);

  const current = STEPS[step];

  function submit(event: FormEvent) {
    event.preventDefault();
    if (sending) return;
    if (step === 0 && !agency.trim()) {
      setMissing("agency");
      field.current?.focus();
      return;
    }
    if (step === 1 && !person.trim()) {
      setMissing("person");
      field.current?.focus();
      return;
    }
    setMissing(undefined);
    if (step < 2) {
      setStep((value) => (value + 1) as 0 | 1 | 2);
      return;
    }
    setSending(true);
    const written = writing ? other.trim() : "";
    onSave({ agency: agency.trim(), person: person.trim(), uses, ...(written ? { other: written } : {}) });
  }

  function toggle(id: WelcomeUseId) {
    setUses((current) =>
      current.includes(id) ? current.filter((use) => use !== id) : [...current, id],
    );
  }

  function skip() {
    setSending(true);
    onSkip();
  }

  const fieldError =
    missing === "agency"
      ? "Escribí el nombre de tu agencia para seguir."
      : missing === "person"
        ? "Escribí tu nombre para seguir."
        : undefined;

  return (
    <main className="min-h-dvh bg-paper text-ink">
      <div className="mx-auto flex min-h-dvh w-full max-w-[560px] flex-col px-6 pb-10 pt-6">
        <header className="mb-12 flex items-baseline justify-between gap-4">
          <div className="font-display text-[25px] leading-none text-ink">
            Bitácora
            <em className="not-italic text-accent" aria-hidden="true">
              .
            </em>
          </div>
          <span className="text-[13px] tabular-nums text-muted">
            {step + 1} de {STEPS.length}
          </span>
        </header>

        <form onSubmit={submit} noValidate className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <span className="text-[13px] text-muted">{current.header}</span>
            <h1
              id={titleId}
              ref={heading}
              tabIndex={-1}
              className="font-display text-[25px] font-normal leading-tight text-ink outline-none"
            >
              {current.question}
            </h1>
            <p className="text-[15px] leading-relaxed text-muted">{current.hint}</p>
          </div>

          {step === 0 && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${base}-agency`} className="sr-only">
                El nombre de tu agencia
              </label>
              <input
                id={`${base}-agency`}
                ref={field}
                type="text"
                autoComplete="organization"
                maxLength={MAX_NAME}
                value={agency}
                aria-invalid={missing === "agency" || undefined}
                aria-describedby={missing === "agency" ? `${base}-missing` : undefined}
                onChange={(event) => {
                  setAgency(event.target.value);
                  setMissing(undefined);
                }}
                className={`w-full rounded-[6px] border bg-surface px-3 py-2.5 text-[17px] text-ink placeholder:text-muted ${missing === "agency" ? "border-danger" : "border-line"} ${focusRing}`}
                placeholder="Tu agencia"
              />
            </div>
          )}

          {step === 1 && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${base}-person`} className="sr-only">
                Tu nombre
              </label>
              <input
                id={`${base}-person`}
                ref={field}
                type="text"
                autoComplete="given-name"
                maxLength={MAX_NAME}
                value={person}
                aria-invalid={missing === "person" || undefined}
                aria-describedby={missing === "person" ? `${base}-missing` : undefined}
                onChange={(event) => {
                  setPerson(event.target.value);
                  setMissing(undefined);
                }}
                className={`w-full rounded-[6px] border bg-surface px-3 py-2.5 text-[17px] text-ink placeholder:text-muted ${missing === "person" ? "border-danger" : "border-line"} ${focusRing}`}
                placeholder="Tu nombre"
              />
            </div>
          )}

          {step === 2 && (
            <fieldset className="flex min-w-0 flex-col gap-2" aria-labelledby={titleId}>
              <legend className="sr-only">{current.question}</legend>
              <div className="flex flex-col divide-y divide-line border-y border-line">
                {WELCOME_USES.map((use) => (
                  <label key={use.id} className={row}>
                    <input
                      type="checkbox"
                      className={checkbox}
                      checked={uses.includes(use.id)}
                      onChange={() => toggle(use.id)}
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="text-[15px] font-bold text-ink">{use.label}</span>
                      <span className="text-[13px] text-muted">{use.description}</span>
                    </span>
                  </label>
                ))}
                <div className="flex flex-col">
                  <label className={row}>
                    <input
                      type="checkbox"
                      className={checkbox}
                      checked={writing}
                      onChange={() => {
                        // Unticking «Otra» throws away what was written there.
                        if (writing) setOther("");
                        setWriting((value) => !value);
                      }}
                    />
                    <span className="text-[15px] font-bold text-ink">Otra</span>
                  </label>
                  {writing && (
                    <div className="px-2 pb-2.5 pl-9">
                      <label htmlFor={`${base}-other`} className="sr-only">
                        Otra cosa para la que vas a usar Bitácora
                      </label>
                      <input
                        id={`${base}-other`}
                        type="text"
                        autoFocus
                        autoComplete="off"
                        maxLength={MAX_OTHER}
                        value={other}
                        onChange={(event) => setOther(event.target.value)}
                        placeholder="Escribilo acá…"
                        className={`w-full rounded-[6px] border border-line bg-paper px-3 py-2 text-[15px] text-ink placeholder:text-muted ${focusRing}`}
                      />
                    </div>
                  )}
                </div>
              </div>
            </fieldset>
          )}

          {fieldError && (
            <p id={`${base}-missing`} role="alert" className="flex items-center gap-2 text-[13px] text-danger">
              <AlertCircle size={16} strokeWidth={1.75} aria-hidden="true" />
              {fieldError}
            </p>
          )}

          {problem && (
            <p role="alert" className="flex items-start gap-2 text-[13px] text-danger">
              <AlertCircle size={16} strokeWidth={1.75} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{problem}</span>
            </p>
          )}

          <div className="flex items-center justify-between gap-3">
            {step > 0 ? (
              <button type="button" className={backLink} disabled={sending} onClick={() => setStep((value) => (value - 1) as 0 | 1 | 2)}>
                <ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" />
                Atrás
              </button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={buttonQuiet}
                disabled={sending}
                onClick={skip}
                title="Saltear las preguntas"
                aria-label="Saltear las preguntas de la bienvenida"
              >
                Saltear
              </button>
              <button type="submit" className={buttonBordered} disabled={sending}>
                {step === 2 ? (
                  <>
                    <Check size={18} strokeWidth={1.75} aria-hidden="true" />
                    {sending ? "Guardando…" : "Listo"}
                  </>
                ) : (
                  <>
                    Seguir
                    <ArrowRight size={18} strokeWidth={1.75} aria-hidden="true" />
                  </>
                )}
              </button>
            </div>
          </div>
          <span role="status" className="sr-only">
            {sending ? "Guardando tus respuestas." : ""}
          </span>
        </form>
      </div>
    </main>
  );
}
