import { FolderOpen } from "lucide-react";

export function WorkspaceControl({ path, disabled, changing, problem, onChoose }: {
  path: string;
  disabled: boolean;
  changing: boolean;
  problem?: string;
  onChoose: () => void;
}) {
  return (
    <div className="min-w-0">
      <button
        type="button"
        disabled={disabled}
        onClick={onChoose}
        title={path}
        className="flex w-full items-center gap-2 rounded-[6px] border border-line bg-surface px-2.5 py-2 text-left text-ink hover:bg-soft focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2 enabled:cursor-pointer disabled:opacity-60"
      >
        <FolderOpen size={18} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
        <span className="min-w-0">
          <span className="block text-[14px] font-bold">Carpeta de trabajo</span>
          <span className="block truncate text-[13px] text-muted" dir="ltr">{path}</span>
        </span>
      </button>
      {changing && <p className="mt-1 text-[13px] text-muted" role="status">Cambiando de carpeta…</p>}
      {problem && <p className="mt-1 text-[13px] text-danger" role="alert">{problem}</p>}
    </div>
  );
}
