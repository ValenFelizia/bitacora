import React, { useEffect, useId, useRef, useState } from "react";
import { AlertCircle, Check, MessageCircleQuestion } from "lucide-react";
import type { PendingQuestion } from "../../server/src/contracts";
import { MAX_ANSWER, optionLabel } from "../../server/src/questions";

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2";
const buttonBordered = `inline-flex items-center justify-center gap-2 px-3 py-2 rounded-[6px] border border-ink bg-surface text-ink font-bold text-[14px] hover:bg-soft cursor-pointer disabled:opacity-40 disabled:cursor-default transition-colors duration-150 ${focusRing}`;
const buttonQuiet = `inline-flex items-center justify-center gap-2 px-3 py-2 rounded-[6px] border border-line bg-surface text-ink text-[14px] hover:bg-soft cursor-pointer disabled:opacity-40 disabled:cursor-default transition-colors duration-150 ${focusRing}`;
const row =
  "flex items-start gap-3 px-2 py-2.5 cursor-pointer hover:bg-soft transition-colors duration-150";
const radio = `mt-[5px] w-4 h-4 shrink-0 accent-[#1d2838] cursor-pointer ${focusRing}`;

/** «Otra» is chosen; kept apart from the labels so no option can collide with it. */
type Choice = { option: string } | { other: true };

function isTextField(element: Element | null) {
  return (
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement && element.type !== "radio") ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}

/**
 * A question the agent asked, shown as a card in the conversation. Each
 * question offers its options plus «Otra» when it accepts a written answer.
 * Once it can no longer be answered it stays as a closed card that says why.
 */
export function QuestionCard({
  question,
  disabled,
  sending,
  onAnswer,
  onSkip,
}: {
  question: PendingQuestion;
  disabled: boolean;
  sending: boolean;
  onAnswer: (answers: Record<string, string>) => void;
  /** «Ahora no»: the agent goes on without an answer. */
  onSkip: () => void;
}) {
  const baseId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [written, setWritten] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState<string>();
  const open = !question.closed;
  const wasOpen = useRef(open);

  useEffect(() => {
    const closing = wasOpen.current && !open;
    wasOpen.current = open;
    const active = document.activeElement;
    // A new question takes the focus, and a card that closes keeps it on its
    // title so it does not fall to the page, unless the user is typing
    // somewhere else.
    if (open || closing) {
      if (sectionRef.current?.contains(active) || !isTextField(active)) headingRef.current?.focus();
    }
  }, [question.id, open]);

  function answerFor(id: string) {
    const choice = choices[id];
    if (!choice) return undefined;
    if ("option" in choice) return choice.option;
    return written[id]?.trim() || undefined;
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (disabled || sending) return;
    const unanswered = question.questions.find((q) => !answerFor(q.id));
    if (unanswered) {
      setMissing(unanswered.id);
      const choice = choices[unanswered.id];
      const target = choice && "other" in choice
        ? document.getElementById(`${baseId}-${unanswered.id}-written`)
        : document.querySelector<HTMLInputElement>(`input[name="${baseId}-${unanswered.id}"]`);
      target?.focus();
      return;
    }
    setMissing(undefined);
    onAnswer(Object.fromEntries(question.questions.map((q) => [q.id, answerFor(q.id)!])));
  }

  return (
    <section
      ref={sectionRef}
      aria-labelledby={`${baseId}-title`}
      className={`w-full rounded-[6px] border border-line border-l-2 bg-surface px-4 py-3.5 flex flex-col gap-3.5 ${
        open ? "border-l-accent" : ""
      }`}
    >
      <h2
        id={`${baseId}-title`}
        ref={headingRef}
        tabIndex={-1}
        className="flex items-center gap-2 text-[13px] font-bold text-muted outline-none"
      >
        <MessageCircleQuestion
          size={18}
          strokeWidth={1.75}
          className={open ? "text-accent" : "text-muted"}
          aria-hidden="true"
        />
        {open
          ? question.questions.length > 1
            ? "Te hago unas preguntas"
            : "Te hago una pregunta"
          : "Pregunta sin responder"}
      </h2>

      {open ? (
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          {question.questions.map((q) => {
            const name = `${baseId}-${q.id}`;
            const choice = choices[q.id];
            const writing = !!choice && "other" in choice;
            const errorId = `${name}-missing`;
            return (
              <fieldset
                key={q.id}
                className="flex flex-col gap-2 min-w-0"
                aria-describedby={missing === q.id ? errorId : undefined}
              >
                <legend className="flex flex-col gap-0.5 mb-2">
                  {q.header && q.header !== q.text && (
                    <span className="text-[13px] text-muted">{q.header}</span>
                  )}
                  <span className="text-[17px] font-bold leading-snug text-ink">{q.text}</span>
                </legend>
                <div className="flex flex-col divide-y divide-line border-y border-line">
                  {q.options.map((option) => {
                    const { text, recommended } = optionLabel(option.label);
                    return (
                      <label key={option.label} className={row}>
                        <input
                          type="radio"
                          name={name}
                          className={radio}
                          checked={!!choice && "option" in choice && choice.option === option.label}
                          onChange={() => {
                            setChoices((current) => ({ ...current, [q.id]: { option: option.label } }));
                            setMissing(undefined);
                          }}
                        />
                        <span className="flex flex-col min-w-0">
                          <span className="text-[15px] font-bold text-ink [overflow-wrap:anywhere]">
                            {text}
                            {recommended && (
                              <span className="ml-2 text-[13px] font-normal text-muted">Recomendada</span>
                            )}
                          </span>
                          {option.description && (
                            <span className="text-[13px] text-muted [overflow-wrap:anywhere]">
                              {option.description}
                            </span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                  {q.other && (
                    <div className="flex flex-col">
                      <label className={row}>
                        <input
                          type="radio"
                          name={name}
                          className={radio}
                          checked={writing}
                          onChange={() => {
                            setChoices((current) => ({ ...current, [q.id]: { other: true } }));
                            setMissing(undefined);
                          }}
                        />
                        <span className="text-[15px] font-bold text-ink">
                          {q.options.length ? "Otra" : "Tu respuesta"}
                        </span>
                      </label>
                      {writing && (
                        <div className="px-2 pb-2.5 pl-9">
                          <label className="sr-only" htmlFor={`${name}-written`}>
                            Tu respuesta a: {q.text}
                          </label>
                          <input
                            id={`${name}-written`}
                            type={q.secret ? "password" : "text"}
                            autoFocus
                            onFocus={(e) =>
                              e.currentTarget.form
                                ?.querySelector("button[type=submit]")
                                ?.scrollIntoView({ block: "nearest" })
                            }
                            autoComplete="off"
                            maxLength={MAX_ANSWER}
                            value={written[q.id] || ""}
                            placeholder="Escribí tu respuesta…"
                            onChange={(e) => {
                              const value = e.target.value;
                              setWritten((current) => ({ ...current, [q.id]: value }));
                              setMissing(undefined);
                            }}
                            className={`w-full rounded-[6px] border border-line bg-paper px-3 py-2 text-[15px] text-ink placeholder:text-muted focus:outline-none focus:border-ink`}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
                {missing === q.id && (
                  <p id={errorId} role="alert" className="flex items-center gap-2 text-[13px] text-danger">
                    <AlertCircle size={16} strokeWidth={1.75} aria-hidden="true" />
                    {writing ? "Escribí tu respuesta para seguir." : "Elegí una opción para seguir."}
                  </p>
                )}
              </fieldset>
            );
          })}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              className={buttonQuiet}
              disabled={disabled || sending}
              onClick={() => {
                if (!disabled && !sending) onSkip();
              }}
            >
              Ahora no
            </button>
            <button type="submit" className={buttonBordered} disabled={disabled || sending}>
              <Check size={18} strokeWidth={1.75} aria-hidden="true" />
              {sending ? "Enviando…" : "Responder"}
            </button>
          </div>
        </form>
      ) : (
        <ul className="flex flex-col gap-1">
          {question.questions.map((q) => (
            <li key={q.id} className="text-[15px] text-muted [overflow-wrap:anywhere]">
              {q.text}
            </li>
          ))}
        </ul>
      )}
      {/* Mounted with the card, so a reader announces the notice when it closes. */}
      <p role="status" className={question.closed ? "flex items-start gap-2 text-[14px] text-ink" : "sr-only"}>
        {question.closed && (
          <>
            <AlertCircle
              size={18}
              strokeWidth={1.75}
              className="text-muted shrink-0 mt-0.5"
              aria-hidden="true"
            />
            <span>{question.closed}</span>
          </>
        )}
      </p>
    </section>
  );
}
