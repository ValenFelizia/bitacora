import React, { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ChevronLeft,
  ChevronRight,
  Copy,
  Ellipsis,
  Eye,
  FileText,
  FileX,
  Image as ImageIcon,
  LayoutGrid,
  X,
} from "lucide-react";
import type { FileRef, Work } from "../../server/src/contracts";
import {
  formatTime,
  groupDeliverableBatches,
  isOverview,
  type DeliverableGroup,
} from "./format";

const isDeliverableUnopened = (file: FileRef) => !file.reverted && !file.openedAt;

function fileUrl(file: FileRef) {
  return `/files?id=${encodeURIComponent(file.id)}`;
}

type FetchedFile = {
  blob?: Blob;
  url?: string;
  missing: boolean;
  loading: boolean;
  problem?: string;
};

function useFetchedFile(file: FileRef | undefined, token?: string, fileRevision?: number, sourceUrl?: string): FetchedFile {
  const [state, setState] = useState<FetchedFile>({
    missing: false,
    loading: !!file && !!token && !file.reverted,
  });

  useEffect(() => {
    if (!file) {
      setState({ missing: false, loading: false });
      return;
    }
    if (file.reverted) {
      setState({ missing: true, loading: false });
      return;
    }
    if (!token) {
      setState({ missing: false, loading: false });
      return;
    }
    setState({ missing: false, loading: true });
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void fetch(sourceUrl || fileUrl(file), { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          let problem: string | undefined;
          const text = await response.text();
          try {
            const body = JSON.parse(text) as { error?: unknown };
            if (typeof body.error === "string" && body.error) problem = body.error;
          } catch { /* a missing file has no message */ }
          if (!controller.signal.aborted) setState({ missing: !problem, loading: false, problem });
          return;
        }
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ blob, url: objectUrl, missing: false, loading: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ missing: true, loading: false });
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file?.id, file?.reverted, token, fileRevision, sourceUrl]);

  return state;
}

type Size = { width: number; height: number };

/** CSS size of an element, following the panel being dragged. */
function useSize(element: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState<Size>();
  useEffect(() => {
    const target = element.current;
    if (!target) return;
    const observer = new ResizeObserver(() => {
      const { width, height } = target.getBoundingClientRect();
      setSize((previous) => (previous?.width === width && previous.height === height ? previous : { width, height }));
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [element]);
  return size;
}

/** Device pixels per CSS pixel, updated when the window moves to a screen with another scale. */
function useDensity() {
  const [density, setDensity] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    // A resolution query matches only the current density, so it fires once
    // when the density changes and is asked again for the new one.
    let query: MediaQueryList | undefined;
    const watch = () => {
      query?.removeEventListener("change", changed);
      query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      query.addEventListener("change", changed);
    };
    const changed = () => {
      setDensity(window.devicePixelRatio || 1);
      watch();
    };
    watch();
    return () => query?.removeEventListener("change", changed);
  }, []);
  return density;
}

/** True once the element came near the screen; a gallery far below is left alone. */
function useNearScreen(element: React.RefObject<HTMLElement | null>) {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const target = element.current;
    if (!target || near) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: "200px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [element, near]);
  return near;
}

/** Decoding a 1080×1920 plate is heavy: a few at a time, the rest wait their turn. */
const DECODES_AT_ONCE = 2;
let decoding = 0;
const decodeQueue: (() => void)[] = [];
async function inTurn<T>(work: () => Promise<T>): Promise<T> {
  if (decoding >= DECODES_AT_ONCE) await new Promise<void>((resolve) => decodeQueue.push(resolve));
  decoding++;
  try {
    return await work();
  } finally {
    decoding--;
    decodeQueue.shift()?.();
  }
}

/**
 * An `<img>` that shows a copy of the image at the exact device size it is
 * shown at. A 1080×1920 plate squeezed into a thumbnail by the browser loses
 * its thin lines and small text; resized once with the high-quality filter it
 * stays sharp. The original shows until the copy is ready, and stays when it
 * is already small enough. A copy is released only once the next image is on
 * screen.
 */
function SharpImage({
  blob,
  url,
  alt,
  className,
  fit,
}: {
  blob?: Blob;
  url: string;
  alt: string;
  className: string;
  fit: "cover" | "contain";
}) {
  const element = useRef<HTMLImageElement>(null);
  const size = useSize(element);
  const density = useDensity();
  const near = useNearScreen(element);
  // The original's size, read when it loads: the copy is made from the file
  // in one step, so its crop is worked out before decoding.
  const [source, setSource] = useState<{ url: string } & Size>();
  const [copy, setCopy] = useState<{ url: string; link: string }>();
  const made = useRef<string[]>([]);

  useEffect(() => () => made.current.forEach((link) => URL.revokeObjectURL(link)), []);

  useEffect(() => {
    if (!blob || !near || !size || size.width < 1 || size.height < 1 || source?.url !== url) return;
    const scale =
      fit === "cover"
        ? Math.max(size.width / source.width, size.height / source.height)
        : Math.min(size.width / source.width, size.height / source.height);
    const cropWidth = fit === "cover" ? size.width / scale : source.width;
    const cropHeight = fit === "cover" ? size.height / scale : source.height;
    const width = Math.max(1, Math.round(cropWidth * scale * density));
    const height = Math.max(1, Math.round(cropHeight * scale * density));
    if (width >= cropWidth) {
      setCopy(undefined);
      return;
    }
    let cancelled = false;
    // Waits for the size to settle while the panel is being dragged.
    const timer = setTimeout(() => {
      void inTurn(async () => {
        if (cancelled) return;
        const options: ImageBitmapOptions = { resizeWidth: width, resizeHeight: height, resizeQuality: "high" };
        const resized =
          fit === "cover"
            ? await createImageBitmap(blob, (source.width - cropWidth) / 2, (source.height - cropHeight) / 2, cropWidth, cropHeight, options)
            : await createImageBitmap(blob, options);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d")!.drawImage(resized, 0, 0);
        resized.close();
        const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
        if (cancelled || !png) return;
        const link = URL.createObjectURL(png);
        made.current.push(link);
        setCopy({ url, link });
      }).catch(() => {
        // The original stays: blurrier, but it is the same image.
      });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [blob, url, near, size?.width, size?.height, density, fit, source]);

  // A copy of another version of the file is never shown.
  const shown = copy?.url === url ? copy.link : url;
  return (
    <img
      ref={element}
      src={shown}
      alt={alt}
      className={className}
      onLoad={(event) => {
        const image = event.currentTarget;
        if (image.getAttribute("src") === url)
          setSource((previous) =>
            previous?.url === url ? previous : { url, width: image.naturalWidth, height: image.naturalHeight },
          );
        // The image on screen no longer needs the copies made before it.
        for (const link of made.current) if (link !== shown) URL.revokeObjectURL(link);
        made.current = made.current.filter((link) => link === shown);
      }}
    />
  );
}

async function copyImageBlob(blob: Blob): Promise<boolean> {
  try {
    const png = (async () => {
      const bitmap = await createImageBitmap(blob);
      try {
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
        return await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob((b) => (b ? resolve(b) : reject()), "image/png"),
        );
      } finally {
        bitmap.close();
      }
    })();
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    return true;
  } catch {
    return false;
  }
}

function triggerDownload(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
}

async function downloadBatchFiles(
  files: FileRef[],
  token: string,
  onMarkOpened: (files: FileRef[]) => void,
  cachedPrimary?: { id: string; url?: string },
): Promise<{ message: string; allMissing: boolean }> {
  const active = files.filter((f) => !f.reverted);
  if (!active.length) return { message: "Ya no está disponible.", allMissing: true };
  if (active.length === 1 && cachedPrimary?.id === active[0].id && cachedPrimary.url) {
    triggerDownload(cachedPrimary.url, active[0].name);
    onMarkOpened([active[0]]);
    return { message: "Descargado.", allMissing: false };
  }
  const downloaded: FileRef[] = [];
  let missingCount = 0;
  for (const file of active) {
    try {
      const res = await fetch(fileUrl(file), { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        if (res.status === 404) missingCount++;
        continue;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      triggerDownload(url, file.name);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      downloaded.push(file);
    } catch {
      // Ignore individual failure
    }
  }
  if (downloaded.length > 0) onMarkOpened(downloaded);
  if (downloaded.length === active.length) {
    return {
      message: active.length === 1 ? "Descargado." : "Descargadas.",
      allMissing: false,
    };
  }
  if (downloaded.length > 0) {
    return {
      message: `Descargué ${downloaded.length} de ${active.length}.`,
      allMissing: false,
    };
  }
  if (missingCount === active.length) {
    return { message: "Ya no está disponible.", allMissing: true };
  }
  return {
    message: active.length === 1
      ? "No pude descargarlo."
      : "No pude descargarlas. Probá de a una.",
    allMissing: false,
  };
}

function UnopenedDot() {
  return (
    <span
      className="pointer-events-none absolute -top-1 -right-1 w-[10px] h-[10px] rounded-full bg-accent border-2 border-surface"
      aria-hidden="true"
    />
  );
}

function UnopenedDotInline() {
  return (
    <span
      className="w-1.5 h-1.5 rounded-full bg-accent shrink-0"
      aria-hidden="true"
    />
  );
}

const focusRing =
  "focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2";

const iconBtn =
  `w-[36px] h-[36px] max-[959px]:w-[40px] max-[959px]:h-[40px] shrink-0 inline-grid place-items-center rounded-[6px] text-muted hover:text-ink hover:bg-soft cursor-pointer disabled:opacity-40 disabled:cursor-default transition-colors duration-150 ${focusRing}`;

const downloadLink =
  "inline-flex items-center gap-[6px] min-w-0 text-left font-bold text-[13px] text-ink underline decoration-accent decoration-2 underline-offset-[5px] cursor-pointer hover:opacity-80 disabled:opacity-40 disabled:cursor-default transition-opacity duration-150 focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-3";

const batchDownloadBtn =
  `w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-[6px] bg-ink text-surface font-bold text-[14px] hover:opacity-90 disabled:bg-ink/40 disabled:cursor-default cursor-pointer transition-opacity duration-150 ${focusRing}`;

export function FileCard({
  file,
  token,
  result = false,
  fileRevision,
  onMarkOpened,
  onPreview,
}: {
  file: FileRef;
  token?: string;
  result?: boolean;
  fileRevision?: number;
  onMarkOpened?: (files: FileRef[]) => void;
  onPreview: (file: FileRef) => void;
}) {
  const fetched = useFetchedFile(file, token, fileRevision);
  const [notice, setNotice] = useState("");
  const image = file.mime.startsWith("image/");
  const unopened = result && !fetched.missing && isDeliverableUnopened(file);

  async function copy() {
    if (!fetched.blob) return;
    const ok = await copyImageBlob(fetched.blob);
    if (ok && result) onMarkOpened?.([file]);
    setNotice(ok ? "Copiada." : "No pude copiar. Probá descargarla.");
  }

  if (!result) {
    return (
      <figure className="min-w-0 rounded-[6px] border border-line bg-surface p-2.5 flex items-center gap-3">
        {image && !fetched.missing && fetched.url ? (
          <SharpImage
            className="w-12 h-12 shrink-0 rounded-[3px] object-cover border border-line bg-paper"
            blob={fetched.blob}
            url={fetched.url}
            alt={file.name}
            fit="cover"
          />
        ) : (
          <span className="w-12 h-12 shrink-0 rounded-[3px] border border-line bg-paper grid place-items-center text-muted">
            {fetched.missing ? <FileX size={18} strokeWidth={1.75} /> : <FileText size={18} strokeWidth={1.75} />}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <figcaption className="truncate text-[13px] font-bold text-ink">{file.name}</figcaption>
          <p role="status" className="text-[13px] text-muted">
            {fetched.missing
              ? "Ya no está disponible."
              : notice || (fetched.loading ? "Cargando…" : "Adjunto")}
          </p>
        </div>
        {!fetched.missing && fetched.url && (
          <div className="flex items-center gap-0.5 shrink-0">
            {!image && (
              <button
                className={iconBtn}
                type="button"
                onClick={() => onPreview(file)}
                title={`Abrir ${file.name}`}
                aria-label={`Abrir ${file.name}`}
              >
                <Eye size={18} strokeWidth={1.75} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className={iconBtn}
              title={`Descargar ${file.name}`}
              aria-label={`Descargar ${file.name}`}
              onClick={() => {
                if (!fetched.url) return;
                triggerDownload(fetched.url, file.name);
                onMarkOpened?.([file]);
                setNotice("Descargado.");
              }}
            >
              <ArrowDownToLine size={18} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        )}
      </figure>
    );
  }

  return (
    <figure className="min-w-0 rounded-[6px] border border-line bg-surface p-3.5 flex flex-col gap-2.5">
      {image && !fetched.missing && fetched.url && (
        <div className="relative">
          <button
            type="button"
            className="block w-full rounded-[3px] overflow-hidden border border-line bg-paper cursor-pointer focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
            onClick={() => onPreview(file)}
            title={`Ver ${file.name}`}
            aria-label={unopened ? `Ver ${file.name}, nueva` : `Ver ${file.name}`}
          >
            <SharpImage
              className="max-h-56 w-full object-contain"
              blob={fetched.blob}
              url={fetched.url}
              alt={file.name}
              fit="contain"
            />
          </button>
          {unopened && <UnopenedDot />}
        </div>
      )}
      {!image && !fetched.missing && fetched.url && (
        <div className="relative">
          <button
            type="button"
            onClick={() => onPreview(file)}
            aria-label={unopened ? `Abrir ${file.name}, nueva` : `Abrir ${file.name}`}
            className="w-full flex items-center justify-center gap-2 py-8 rounded-[3px] border border-line bg-paper text-muted hover:text-ink cursor-pointer transition-colors duration-150"
          >
            <FileText size={18} strokeWidth={1.75} aria-hidden="true" />
            <span className="text-[13px] font-bold">PDF</span>
          </button>
          {unopened && <UnopenedDot />}
        </div>
      )}
      <div>
        <figcaption className="font-display text-[17px] leading-snug text-ink break-words">
          {file.name}
        </figcaption>
        <p className="text-[13px] text-muted tabular-nums mt-0.5">
          {formatTime(file.createdAt)}
        </p>
      </div>
      {fetched.missing ? (
        <p role="status" className="text-[13px] text-muted flex items-center gap-2">
          <FileX size={18} strokeWidth={1.75} aria-hidden="true" />
          Ya no está disponible.
        </p>
      ) : (
        <div className="flex items-center justify-between border-t border-line pt-2.5">
          <button
            type="button"
            disabled={!fetched.url}
            className={downloadLink}
            onClick={() => {
              if (!fetched.url) return;
              triggerDownload(fetched.url, file.name);
              onMarkOpened?.([file]);
              setNotice("Descargado.");
            }}
          >
            <ArrowDownToLine size={18} strokeWidth={1.75} className="text-accent" aria-hidden="true" />
            Descargar
          </button>
          <div className="flex items-center gap-0.5">
            {image && (
              <>
                <button
                  type="button"
                  disabled={!fetched.blob}
                  className={iconBtn}
                  title="Ver"
                  aria-label={`Ver ${file.name}`}
                  onClick={() => onPreview(file)}
                >
                  <Eye size={18} strokeWidth={1.75} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  disabled={!fetched.blob}
                  className={iconBtn}
                  title="Copiar"
                  aria-label={`Copiar ${file.name}`}
                  onClick={() => void copy()}
                >
                  <Copy size={18} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </>
            )}
            {!image && fetched.url && (
              <button
                className={iconBtn}
                type="button"
                onClick={() => onPreview(file)}
                title="Abrir"
                aria-label={`Abrir ${file.name}`}
              >
                <Eye size={18} strokeWidth={1.75} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      )}
      {(notice || (!fetched.missing && fetched.loading)) && (
        <p role="status" className="text-[13px] text-muted">
          {notice || "Cargando…"}
        </p>
      )}
    </figure>
  );
}

function PlateThumbnail({
  file,
  token,
  fileRevision,
  compact,
  moreCount,
  unopened,
  fetched: given,
  onClick,
}: {
  file: FileRef;
  token?: string;
  fileRevision?: number;
  compact: boolean;
  moreCount?: number;
  unopened?: boolean;
  /** The file the group already downloaded, so it is not asked for twice. */
  fetched?: FetchedFile;
  onClick: () => void;
}) {
  const own = useFetchedFile(given ? undefined : file, token, fileRevision);
  const fetched = given ?? own;
  const label =
    moreCount && moreCount > 0
      ? `Ver ${moreCount} más`
      : `Ver ${file.name}`;
  const ariaLabel = unopened && !fetched.missing ? `${label}, nueva` : label;
  return (
    <div className={compact ? "relative" : "relative w-fit max-w-full mx-auto"}>
      <button
        type="button"
        onClick={onClick}
        title={label}
        aria-label={ariaLabel}
        className={`relative group block overflow-hidden rounded-[3px] border border-line bg-paper cursor-pointer focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2 ${
          compact ? "w-full aspect-[9/16]" : "w-fit max-w-full max-h-[280px]"
        }`}
      >
        {fetched.url && !fetched.missing ? (
          <SharpImage
            blob={fetched.blob}
            url={fetched.url}
            alt={file.name}
            className={compact ? "w-full h-full object-cover" : "block max-h-[280px] w-auto max-w-full object-contain"}
            fit={compact ? "cover" : "contain"}
          />
        ) : (
          <span className={`grid place-items-center text-muted ${compact ? "w-full h-full min-h-[72px]" : "w-[158px] h-[240px]"}`}>
            {fetched.missing ? (
              <FileX size={18} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <ImageIcon size={18} strokeWidth={1.75} aria-hidden="true" />
            )}
          </span>
        )}
        {moreCount && moreCount > 0 && (
          <span className="absolute inset-0 bg-ink/70 text-surface font-bold text-[15px] tabular-nums grid place-items-center">
            +{moreCount}
          </span>
        )}
      </button>
      {unopened && !fetched.missing && <UnopenedDot />}
    </div>
  );
}

function OlderDeliverableRow({
  file,
  token,
  fileRevision,
  onMarkOpened,
  onPreview,
}: {
  file: FileRef;
  token?: string;
  fileRevision?: number;
  onMarkOpened: (files: FileRef[]) => void;
  onPreview: (file: FileRef) => void;
}) {
  const fetched = useFetchedFile(file, token, fileRevision);
  const isImage = file.mime.startsWith("image/");
  const unopened = !fetched.missing && isDeliverableUnopened(file);

  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-[10px] items-center py-[10px] border-t border-line text-[14px]">
      <span className="text-muted">
        {fetched.missing ? (
          <FileX size={18} strokeWidth={1.75} aria-hidden="true" />
        ) : isImage ? (
          <ImageIcon size={18} strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <FileText size={18} strokeWidth={1.75} aria-hidden="true" />
        )}
      </span>
      <div className="min-w-0 flex items-center gap-1.5">
        {unopened && <UnopenedDotInline />}
        {fetched.missing ? (
          <span className="truncate text-muted" title="Ya no está disponible.">
            {file.name}
          </span>
        ) : (
          <button
            type="button"
            disabled={!fetched.url}
            onClick={() => onPreview(file)}
            aria-label={unopened ? `${file.name}, nueva` : file.name}
            className="truncate text-left text-ink hover:underline cursor-pointer focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
            title={file.name}
          >
            {file.name}
          </button>
        )}
      </div>
      <button
        type="button"
        disabled={!fetched.url || fetched.missing}
        title={`Descargar ${file.name}`}
        aria-label={`Descargar ${file.name}`}
        className={iconBtn}
        onClick={() => {
          if (fetched.url) {
            triggerDownload(fetched.url, file.name);
            onMarkOpened([file]);
          }
        }}
      >
        <ArrowDownToLine size={18} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  );
}

function BatchPdfRow({
  file,
  token,
  fileRevision,
  onMarkOpened,
  onPreview,
}: {
  file: FileRef;
  token?: string;
  fileRevision?: number;
  onMarkOpened: (files: FileRef[]) => void;
  onPreview: (file: FileRef) => void;
}) {
  const fetched = useFetchedFile(file, token, fileRevision);
  const unopened = !fetched.missing && isDeliverableUnopened(file);

  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-[10px] items-center pt-[10px] border-t border-line text-[14px]">
      <span className="text-muted">
        {fetched.missing ? (
          <FileX size={18} strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <FileText size={18} strokeWidth={1.75} aria-hidden="true" />
        )}
      </span>
      <div className="min-w-0 flex items-center gap-1.5">
        {unopened && <UnopenedDotInline />}
        {fetched.missing ? (
          <span className="truncate text-muted" title="Ya no está disponible.">
            {file.name}
          </span>
        ) : (
          <button
            type="button"
            disabled={!fetched.url}
            onClick={() => onPreview(file)}
            aria-label={unopened ? `${file.name}, nueva` : file.name}
            className="truncate text-left text-ink hover:underline cursor-pointer focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
            title={file.name}
          >
            {file.name}
          </button>
        )}
      </div>
      <button
        type="button"
        disabled={!fetched.url || fetched.missing}
        title={`Descargar ${file.name}`}
        aria-label={`Descargar ${file.name}`}
        className={iconBtn}
        onClick={() => {
          if (fetched.url) {
            triggerDownload(fetched.url, file.name);
            onMarkOpened([file]);
          }
        }}
      >
        <ArrowDownToLine size={18} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  );
}

function FeaturedDeliverable({
  group,
  workTitle,
  token,
  fileRevision,
  onMarkOpened,
  onPreview,
}: {
  group: DeliverableGroup;
  workTitle?: string;
  token?: string;
  fileRevision?: number;
  onMarkOpened: (files: FileRef[]) => void;
  onPreview: (file: FileRef, list: FileRef[]) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [missingAll, setMissingAll] = useState(false);
  const primaryFetched = useFetchedFile(group.primary, token, fileRevision);
  const isImage = group.primary.mime.startsWith("image/");
  const isMulti = group.plates.length >= 2;
  const availablePlates = group.plates.filter((p) => !p.reverted);
  const allReverted = isMulti
    ? availablePlates.length === 0
    : !!group.primary.reverted;
  const batchUnavailable =
    allReverted || missingAll || (!isMulti && primaryFetched.missing);
  const batchPdfs =
    group.plates.length > 0
      ? group.allFiles.filter((f) => f.mime === "application/pdf")
      : [];
  const menuFiles =
    group.plates.length > 0
      ? group.allFiles.filter((f) => f.mime !== "application/pdf")
      : group.allFiles;
  const showTitle = group.title && group.title !== workTitle;
  const downloadText =
    isMulti && availablePlates.length >= 2
      ? `Descargar las ${availablePlates.length}`
      : "Descargar";
  const featuredPlate = group.plates[0];
  const hasOverflow = group.plates.length > 7;
  const restPlates = hasOverflow ? group.plates.slice(1, 7) : group.plates.slice(1);
  const overflowCount = hasOverflow ? group.plates.length - 6 : 0;
  const primaryPdfUnopened = !primaryFetched.missing && isDeliverableUnopened(group.primary);

  useEffect(() => {
    setMissingAll(false);
  }, [group.id, fileRevision]);

  async function downloadAll() {
    if (!token) return;
    const filesToGet = isMulti ? group.plates : [group.primary];
    const result = await downloadBatchFiles(filesToGet, token, onMarkOpened, {
      id: group.primary.id,
      url: primaryFetched.url,
    });
    if (result.allMissing) setMissingAll(true);
    setNotice(result.message);
  }

  async function copyPrimary() {
    if (!primaryFetched.blob) return;
    const ok = await copyImageBlob(primaryFetched.blob);
    if (ok) onMarkOpened([group.primary]);
    setNotice(ok ? "Copiada." : "No pude copiar.");
  }

  return (
    <div className="rounded-[6px] border border-line bg-surface p-2.5 flex flex-col gap-[10px]">
      {featuredPlate ? (
        <PlateThumbnail
          key={`${featuredPlate.id}-${fileRevision ?? 0}`}
          file={featuredPlate}
          token={token}
          fileRevision={fileRevision}
          compact={false}
          unopened={isDeliverableUnopened(featuredPlate)}
          fetched={featuredPlate.id === group.primary.id ? primaryFetched : undefined}
          onClick={() => onPreview(featuredPlate, group.plates)}
        />
      ) : (
        <div className="relative">
          <button
            type="button"
            disabled={!primaryFetched.url}
            onClick={() => onPreview(group.primary, [group.primary])}
            aria-label={primaryPdfUnopened ? `Abrir ${group.primary.name}, nueva` : `Abrir ${group.primary.name}`}
            className="w-full flex flex-col items-center justify-center gap-2 py-8 rounded-[3px] border border-line bg-paper text-muted hover:text-ink cursor-pointer transition-colors duration-150"
          >
            <FileText size={18} strokeWidth={1.75} aria-hidden="true" />
            <span className="text-[13px] font-bold">PDF</span>
          </button>
          {primaryPdfUnopened && <UnopenedDot />}
        </div>
      )}

      {(showTitle || group.meta || !primaryFetched.missing) && (
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            {showTitle && (
              <div className="font-display text-[17px] leading-snug text-ink break-words">
                {group.title}
              </div>
            )}
            {group.meta && (
              <div className={`text-[13px] text-muted tabular-nums ${showTitle ? "mt-0.5" : ""}`}>
                {group.meta}
              </div>
            )}
          </div>
          <div className="flex items-center shrink-0">
            {!primaryFetched.missing && (
              isImage ? (
                <button
                  type="button"
                  className={iconBtn}
                  title="Ver"
                  aria-label="Ver pieza"
                  onClick={() => onPreview(group.primary, group.plates)}
                >
                  <Eye size={18} strokeWidth={1.75} aria-hidden="true" />
                </button>
              ) : (
                primaryFetched.url && (
                  <button
                    className={iconBtn}
                    type="button"
                    onClick={() => onPreview(group.primary, [group.primary])}
                    title="Abrir"
                    aria-label="Abrir PDF"
                  >
                    <Eye size={18} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                )
              )
            )}
            {!primaryFetched.missing && isImage && (
              <button
                type="button"
                disabled={!primaryFetched.blob}
                className={iconBtn}
                title="Copiar"
                aria-label="Copiar imagen"
                onClick={() => void copyPrimary()}
              >
                <Copy size={18} strokeWidth={1.75} aria-hidden="true" />
              </button>
            )}
            {menuFiles.length > 1 && (
              <button
                type="button"
                className={iconBtn}
                title="Más"
                aria-label="Más piezas del lote"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
              >
                <Ellipsis size={18} strokeWidth={1.75} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      )}

      {batchUnavailable ? (
        <p role="status" className="text-[13px] text-muted flex items-center gap-2 border-t border-line pt-[10px]">
          <FileX size={18} strokeWidth={1.75} aria-hidden="true" />
          Ya no está disponible.
        </p>
      ) : (
        <button
          type="button"
          disabled={!primaryFetched.url && !isMulti}
          className={batchDownloadBtn}
          onClick={() => void downloadAll()}
        >
          <ArrowDownToLine size={18} strokeWidth={1.75} aria-hidden="true" />
          <span>{downloadText}</span>
        </button>
      )}

      {restPlates.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {restPlates.map((plate, index) => {
            const hasMoreTile =
              overflowCount > 0 && index === restPlates.length - 1;
            const tileUnopened = hasMoreTile
              ? group.plates.slice(6).some(isDeliverableUnopened)
              : isDeliverableUnopened(plate);
            return (
              <PlateThumbnail
                key={`${plate.id}-${fileRevision ?? 0}`}
                file={plate}
                token={token}
                fileRevision={fileRevision}
                compact
                moreCount={hasMoreTile ? overflowCount : undefined}
                unopened={tileUnopened}
                onClick={() => onPreview(plate, group.plates)}
              />
            );
          })}
        </div>
      )}

      {batchPdfs.map((pdf) => (
        <BatchPdfRow
          key={`${pdf.id}-${fileRevision ?? 0}`}
          file={pdf}
          onMarkOpened={onMarkOpened}
          onPreview={(file) => onPreview(file, [file])}
          token={token}
          fileRevision={fileRevision}
        />
      ))}

      {menuOpen && menuFiles.length > 0 && (
        <div className="rounded-[6px] border border-line bg-paper p-2 flex flex-col gap-1">
          {menuFiles.map((f) => (
            <OlderDeliverableRow
              key={`${f.id}-${fileRevision ?? 0}`}
              file={f}
              token={token}
              fileRevision={fileRevision}
              onMarkOpened={onMarkOpened}
              onPreview={(target) =>
                onPreview(target, menuFiles.filter((x) => x.mime.startsWith("image/")))
              }
            />
          ))}
        </div>
      )}

      {notice && (
        <p role="status" className="text-[13px] text-muted">
          {notice}
        </p>
      )}
    </div>
  );
}

function OlderBatchGroup({
  group,
  workTitle,
  token,
  fileRevision,
  onMarkOpened,
  onPreview,
}: {
  group: DeliverableGroup;
  workTitle?: string;
  token?: string;
  fileRevision?: number;
  onMarkOpened: (files: FileRef[]) => void;
  onPreview: (file: FileRef, list: FileRef[]) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [missingAll, setMissingAll] = useState(false);
  const isMulti = group.plates.length >= 2;

  useEffect(() => {
    setMissingAll(false);
  }, [group.id, fileRevision]);

  if (!isMulti) {
    return (
      <div className="flex flex-col">
        {group.allFiles.map((file) => (
          <OlderDeliverableRow
            key={`${file.id}-${fileRevision ?? 0}`}
            file={file}
            token={token}
            fileRevision={fileRevision}
            onMarkOpened={onMarkOpened}
            onPreview={(target) =>
              onPreview(
                target,
                group.allFiles.filter((x) => x.mime.startsWith("image/")),
              )
            }
          />
        ))}
      </div>
    );
  }

  const hasOverflow = group.plates.length > 6;
  const visiblePlates = group.plates.slice(0, 6);
  const overflowCount = hasOverflow ? group.plates.length - 5 : 0;
  const batchPdfs = group.allFiles.filter((f) => f.mime === "application/pdf");
  const extraFiles = group.allFiles.filter(
    (f) => f.mime !== "application/pdf" && !group.plates.includes(f) && !isOverview(f),
  );
  // Only offer the ⋯ menu when it adds items not already shown above (overview sheets or overflow plates).
  const menuFiles = group.allFiles.filter(
    (f) =>
      f.mime !== "application/pdf" &&
      !extraFiles.includes(f) &&
      (isOverview(f) || !visiblePlates.includes(f) || (hasOverflow && f === visiblePlates[5])),
  );
  const showTitle = group.title && group.title !== workTitle;
  const availablePlates = group.plates.filter((p) => !p.reverted);
  const allReverted = availablePlates.length === 0 || missingAll;
  const downloadText =
    availablePlates.length >= 2 ? `Descargar las ${availablePlates.length}` : "Descargar";

  async function downloadAll() {
    if (!token) return;
    const result = await downloadBatchFiles(group.plates, token, onMarkOpened);
    if (result.allMissing) setMissingAll(true);
    setNotice(result.message);
  }

  return (
    <div className="border-t border-line pt-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          {showTitle && (
            <div className="truncate text-[14px] font-bold text-ink">{group.title}</div>
          )}
          {group.meta && (
            <div className="text-[13px] text-muted tabular-nums">{group.meta}</div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {allReverted ? (
            <span role="status" className="text-[13px] text-muted flex items-center gap-1.5">
              <FileX size={16} strokeWidth={1.75} aria-hidden="true" />
              Ya no está disponible.
            </span>
          ) : (
            <button
              type="button"
              className={downloadLink}
              onClick={() => void downloadAll()}
            >
              <ArrowDownToLine size={16} strokeWidth={1.75} className="text-accent shrink-0" aria-hidden="true" />
              <span>{downloadText}</span>
            </button>
          )}
          {menuFiles.length > 0 && (
            <button
              type="button"
              className={iconBtn}
              title="Más"
              aria-label="Más piezas del lote"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              <Ellipsis size={18} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {visiblePlates.map((plate, index) => {
          const hasMoreTile = overflowCount > 0 && index === visiblePlates.length - 1;
          const tileUnopened = hasMoreTile
            ? group.plates.slice(5).some(isDeliverableUnopened)
            : isDeliverableUnopened(plate);
          return (
            <PlateThumbnail
              key={`${plate.id}-${fileRevision ?? 0}`}
              file={plate}
              token={token}
              fileRevision={fileRevision}
              compact
              moreCount={hasMoreTile ? overflowCount : undefined}
              unopened={tileUnopened}
              onClick={() => onPreview(plate, group.plates)}
            />
          );
        })}
      </div>
      {extraFiles.map((file) => (
        <OlderDeliverableRow
          key={`${file.id}-${fileRevision ?? 0}`}
          file={file}
          token={token}
          fileRevision={fileRevision}
          onMarkOpened={onMarkOpened}
          onPreview={(target) =>
            onPreview(
              target,
              group.allFiles.filter((x) => x.mime.startsWith("image/")),
            )
          }
        />
      ))}
      {batchPdfs.map((pdf) => (
        <BatchPdfRow
          key={`${pdf.id}-${fileRevision ?? 0}`}
          file={pdf}
          token={token}
          fileRevision={fileRevision}
          onMarkOpened={onMarkOpened}
          onPreview={(file) => onPreview(file, [file])}
        />
      ))}
      {menuOpen && menuFiles.length > 0 && (
        <div className="rounded-[6px] border border-line bg-paper p-2 flex flex-col gap-1">
          {menuFiles.map((f) => (
            <OlderDeliverableRow
              key={`${f.id}-${fileRevision ?? 0}`}
              file={f}
              token={token}
              fileRevision={fileRevision}
              onMarkOpened={onMarkOpened}
              onPreview={(target) =>
                onPreview(
                  target,
                  group.allFiles.filter((x) => x.mime.startsWith("image/")),
                )
              }
            />
          ))}
        </div>
      )}
      {notice && (
        <p role="status" className="text-[13px] text-muted">
          {notice}
        </p>
      )}
    </div>
  );
}

export function DeliverablesPanel({
  work,
  focusedMessageId,
  token,
  fileRevision,
  onMarkOpened,
  hasGalleryResults,
  onOpenGallery,
  onPreview,
  heading,
  onCloseMobile,
  closeMobileRef,
}: {
  work?: Work;
  focusedMessageId?: string;
  token?: string;
  fileRevision?: number;
  onMarkOpened: (files: FileRef[]) => void;
  hasGalleryResults: boolean;
  onOpenGallery: () => void;
  onPreview: (file: FileRef, list: FileRef[]) => void;
  heading?: React.ReactNode;
  onCloseMobile?: () => void;
  closeMobileRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  const grouped = groupDeliverableBatches(work, focusedMessageId);

  return (
    <div className="flex flex-col gap-4 h-full overflow-y-auto">
      <div className="flex items-center justify-between gap-2">
        {heading ?? <h2 className="font-display text-[20px] font-normal text-ink">Para mandar</h2>}
        {onCloseMobile && (
          <button
            ref={closeMobileRef}
            type="button"
            onClick={onCloseMobile}
            className={`${iconBtn} min-[960px]:hidden`}
            title="Cerrar"
            aria-label="Cerrar panel"
          >
            <X size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
      </div>

      {!grouped.featured ? (
        <div className="flex flex-col items-start gap-3 py-4 text-muted">
          <p className="text-[14px] leading-relaxed">
            {work
              ? "Cuando arme las piezas, las vas a ver acá."
              : "Elegí un trabajo o empezá uno nuevo para ver las piezas acá."}
          </p>
          {hasGalleryResults && (
            <button
              type="button"
              onClick={onOpenGallery}
              className="inline-flex items-center gap-2 px-3 py-1.5 border border-ink rounded-[6px] text-ink font-bold text-[13px] hover:bg-soft cursor-pointer transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-ink focus-visible:outline-offset-2"
            >
              <LayoutGrid size={16} strokeWidth={1.75} aria-hidden="true" />
              Ver galería
            </button>
          )}
        </div>
      ) : (
        <>
          <FeaturedDeliverable
            key={grouped.featured.id}
            group={grouped.featured}
            workTitle={work?.title}
            token={token}
            fileRevision={fileRevision}
            onMarkOpened={onMarkOpened}
            onPreview={onPreview}
          />
          {grouped.olderGroups.map((group) => (
            <OlderBatchGroup
              key={group.id}
              group={group}
              workTitle={work?.title}
              token={token}
              fileRevision={fileRevision}
              onMarkOpened={onMarkOpened}
              onPreview={onPreview}
            />
          ))}
        </>
      )}
    </div>
  );
}

export function FilePreviewModal({
  file,
  list,
  token,
  fileRevision,
  onMarkOpened,
  onSelect,
  onClose,
  sourceUrl,
}: {
  file: FileRef;
  list: FileRef[];
  token?: string;
  fileRevision?: number;
  onMarkOpened?: (files: FileRef[]) => void;
  onSelect: (file: FileRef) => void;
  onClose: () => void;
  sourceUrl?: string;
}) {
  const fetched = useFetchedFile(file, token, fileRevision, sourceUrl);
  const [notice, setNotice] = useState("");
  const image = file.mime.startsWith("image/");
  const htmlPreview = sourceUrl && /\.html$/i.test(file.name);
  const drawn = useFetchedFile(htmlPreview ? file : undefined, token, fileRevision, htmlPreview ? sourceUrl + "&preview=1" : undefined);
  const pdf = fetched.blob?.type === "application/pdf";
  const plainText = fetched.blob?.type === "text/plain";
  const index = list.findIndex((f) => f.id === file.id);
  const previewProblem = drawn.problem || fetched.problem;

  useEffect(() => {
    setNotice("");
    onMarkOpened?.([file]);
  }, [file.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Close only the preview, not the drawer underneath it.
        e.stopPropagation();
        onClose();
      }
      if (e.key === "ArrowLeft" && index > 0) onSelect(list[index - 1]);
      if (e.key === "ArrowRight" && index >= 0 && index < list.length - 1) onSelect(list[index + 1]);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [index, list, onClose, onSelect]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={file.name}
      className="fixed inset-0 z-50 bg-ink/70 flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-surface border border-line rounded-[6px] max-w-[780px] w-full max-h-[90dvh] flex flex-col overflow-hidden">
        <header className="flex items-center justify-between gap-4 px-5 py-3.5 border-b border-line">
          <div className="min-w-0">
            <h3 className="font-display text-[17px] text-ink truncate">{file.name}</h3>
            {list.length > 1 && index >= 0 && (
              <p className="text-[13px] text-muted tabular-nums">
                {index + 1} de {list.length}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1">
            {list.length > 1 && (
              <>
                <button
                  type="button"
                  disabled={index <= 0}
                  onClick={() => onSelect(list[index - 1])}
                  className={iconBtn}
                  title="Anterior"
                  aria-label="Anterior"
                >
                  <ChevronLeft size={18} strokeWidth={1.75} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  disabled={index < 0 || index >= list.length - 1}
                  onClick={() => onSelect(list[index + 1])}
                  className={iconBtn}
                  title="Siguiente"
                  aria-label="Siguiente"
                >
                  <ChevronRight size={18} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={onClose}
              className={iconBtn}
              title="Cerrar"
              aria-label="Cerrar vista previa"
            >
              <X size={18} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
        </header>
        <div className="flex-1 min-h-0 overflow-auto p-5 bg-paper flex items-center justify-center">
          {fetched.url && (pdf || plainText) ? (
            <iframe
              src={fetched.url}
              title={file.name}
              sandbox={plainText ? "" : undefined}
              className="h-[68dvh] w-full border-0"
            />
          ) : (fetched.url && image) || drawn.url ? (
            <img
              src={drawn.url || fetched.url}
              alt={file.name}
              className="max-h-[65dvh] max-w-full rounded-[3px] object-contain"
            />
          ) : (
            <p className="text-[14px] text-muted">
              {fetched.missing && !previewProblem ? "Ya no está disponible."
                 : fetched.loading || drawn.loading ? "Cargando…"
                : previewProblem || "Descargalo para verlo."}
            </p>
          )}
        </div>
        <footer className="flex items-center justify-between gap-4 px-5 py-3 border-t border-line bg-surface">
          <div className="flex items-center gap-4">
            <button
              type="button"
              disabled={!fetched.url || fetched.missing}
              className={downloadLink}
              onClick={() => {
                if (fetched.url) {
                  triggerDownload(fetched.url, file.name);
                  onMarkOpened?.([file]);
                  setNotice("Descargado.");
                }
              }}
            >
              <ArrowDownToLine size={18} strokeWidth={1.75} className="text-accent" aria-hidden="true" />
              Descargar
            </button>
            {image && (
              <button
                type="button"
                disabled={!fetched.blob || fetched.missing}
                className="inline-flex items-center gap-1.5 text-[14px] text-ink hover:underline cursor-pointer disabled:opacity-40"
                onClick={async () => {
                  if (!fetched.blob) return;
                  const ok = await copyImageBlob(fetched.blob);
                  if (ok) onMarkOpened?.([file]);
                  setNotice(ok ? "Copiada." : "No pude copiar.");
                }}
              >
                <Copy size={18} strokeWidth={1.75} className="text-muted" aria-hidden="true" />
                Copiar
              </button>
            )}
          </div>
          {notice && <span role="status" className="text-[13px] text-muted">{notice}</span>}
        </footer>
      </div>
    </div>
  );
}
