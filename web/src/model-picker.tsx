import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { ModelState } from "../../server/src/contracts";

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2";

/**
 * Shows which model works on the requests and lets the user pick another one.
 * The choice is the same for every work and applies from the next request.
 */
export function ModelPicker({
  model,
  disabled,
  onChoose,
}: {
  model: ModelState;
  disabled: boolean;
  onChoose: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const items = () => [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];

  function close(restoreFocus: boolean) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    const current = items().find((item) => item.getAttribute("aria-checked") === "true");
    (current ?? items()[0])?.focus();
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) close(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  function onMenuKey(event: React.KeyboardEvent) {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    const move = (to: number) => {
      event.preventDefault();
      list[(to + list.length) % list.length]?.focus();
    };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(list.length - 1);
    else if (event.key === "Escape") {
      // Closes the menu only, not a drawer or a preview underneath.
      event.stopPropagation();
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") close(false);
  }

  const choices = model.choices.length ? model.choices : [model.current];
  return (
    <div className="min-w-0">
      <button
        ref={trigger}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Modelo: ${model.current.name}, ${model.effortText}. Cambiar modelo`}
        title="Cambiar el modelo"
        onClick={() => setOpen((value) => !value)}
        className={`inline-flex max-w-full items-center gap-1 h-[36px] max-[959px]:h-[40px] px-2 rounded-[6px] text-[13px] text-ink hover:bg-soft cursor-pointer disabled:opacity-40 disabled:cursor-default transition-colors duration-150 ${focusRing}`}
      >
        <span className="truncate font-bold">{model.current.name}</span>
        <ChevronDown size={16} strokeWidth={1.75} className="text-muted shrink-0" aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label="Elegir modelo"
          onKeyDown={onMenuKey}
          className="absolute bottom-full left-0 right-0 mb-2 z-20 min-[640px]:right-auto min-[640px]:w-[380px] max-h-[60dvh] overflow-y-auto rounded-[6px] border border-line bg-surface p-1"
        >
          <p className="px-3 pt-2 pb-1.5 text-[13px] text-muted">Con qué modelo trabajo</p>
          {choices.map((choice) => {
            const selected = choice.id === model.current.id;
            return (
              <button
                key={choice.id}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  if (!selected) onChoose(choice.id);
                  close(true);
                }}
                className={`w-full grid grid-cols-[18px_minmax(0,1fr)] gap-2.5 items-start px-3 py-2 rounded-[6px] text-left cursor-pointer hover:bg-soft transition-colors duration-150 ${focusRing}`}
              >
                <span className="mt-[3px] text-ink">
                  {selected && <Check size={18} strokeWidth={1.75} aria-hidden="true" />}
                </span>
                <span className="min-w-0 flex flex-col">
                  <span className="text-[15px] text-ink">
                    <span className="font-bold">{choice.name}</span>
                    {choice.recommended && <span className="text-[13px] text-muted"> · Recomendado</span>}
                  </span>
                  <span className="text-[13px] text-muted leading-snug">{choice.description}</span>
                </span>
              </button>
            );
          })}
          <p className="mt-1 border-t border-line px-3 pt-2 pb-1.5 text-[13px] text-muted leading-snug">
            {model.choices.length
              ? `Trabaja con ${model.effortText}: cuanto más alto, más piensa antes de responder. El cambio vale para todos tus trabajos desde el próximo pedido.`
              : "Todavía no tengo la lista de modelos de tu cuenta. Probá de nuevo en un momento."}
          </p>
        </div>
      )}
    </div>
  );
}
