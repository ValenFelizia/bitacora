declare global {
  interface Window {
    chrome?: {
      webview?: {
        postMessage(message: string): void;
        addEventListener(event: "message", listener: (message: MessageEvent<unknown>) => void): void;
        removeEventListener(event: "message", listener: (message: MessageEvent<unknown>) => void): void;
      };
    };
  }
}

/** A picker failure with the text the person sees. */
export class FolderPickerProblem extends Error {}

const PICK_TIMEOUT_MS = 180_000;
let abandonPrevious: (() => void) | undefined;

/**
 * Asks the desktop shell for a folder. The buttons must come back even when
 * the reply never arrives, so the wait is bounded; a folder chosen after that
 * still reaches `late`, because the window may simply have stayed open.
 */
export function pickWorkspace(current: string, late?: (path: string) => void): Promise<string | undefined> {
  if (import.meta.env.DEV) {
    return Promise.resolve(window.prompt("¿Dónde querés trabajar? Escribí la ubicación de la carpeta.", current)?.trim() || undefined);
  }

  const webview = window.chrome?.webview;
  if (!webview) return Promise.reject(new Error("Folder picker unavailable"));
  abandonPrevious?.();

  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const prefix = `bitacora:folder:${id}:`;
    let settled = false;
    const timer = window.setTimeout(() => settle(() => reject(new FolderPickerProblem(
      "La ventana para elegir la carpeta no respondió. Si sigue abierta, elegí la carpeta ahí. Si no, probá de nuevo.",
    ))), PICK_TIMEOUT_MS);
    const pageHidden = () => {
      stop();
      settle(() => reject(new Error("Folder picker page closed")));
    };
    function stop() {
      window.clearTimeout(timer);
      window.removeEventListener("pagehide", pageHidden);
      webview?.removeEventListener("message", receive);
      if (abandonPrevious === stop) abandonPrevious = undefined;
    }
    function settle(finish: () => void) {
      window.clearTimeout(timer);
      if (settled) return;
      settled = true;
      finish();
    }
    function receive({ data }: MessageEvent<unknown>) {
      if (typeof data !== "string" || !data.startsWith(prefix)) return;
      stop();
      const result = data.slice(prefix.length);
      const path = result.startsWith("ok:") && result.length > 3 ? result.slice(3) : undefined;
      if (settled) {
        if (path) late?.(path);
      } else if (path) settle(() => resolve(path));
      else if (result === "cancel") settle(() => resolve(undefined));
      // The shell could not turn the folder into a name the app can use.
      else settle(() => reject(new FolderPickerProblem("No pude usar esa carpeta. Cambiale el nombre o elegí otra.")));
    }

    abandonPrevious = stop;
    try {
      window.addEventListener("pagehide", pageHidden);
      webview.addEventListener("message", receive);
      webview.postMessage(`bitacora:pick-folder:${id}`);
    } catch (error) {
      stop();
      settle(() => reject(error));
    }
  });
}
