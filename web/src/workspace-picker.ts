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

export function pickWorkspace(current: string): Promise<string | undefined> {
  if (import.meta.env.DEV) {
    return Promise.resolve(window.prompt("¿Dónde querés trabajar? Escribí la ubicación de la carpeta.", current)?.trim() || undefined);
  }

  const webview = window.chrome?.webview;
  if (!webview) return Promise.reject(new Error("Folder picker unavailable"));

  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const prefix = `bitacora:folder:${id}:`;
    function receive({ data }: MessageEvent<unknown>) {
      if (typeof data !== "string" || !data.startsWith(prefix)) return;
      webview?.removeEventListener("message", receive);
      resolve(data.slice(prefix.length) || undefined);
    }

    webview.addEventListener("message", receive);
    try {
      webview.postMessage(`bitacora:pick-folder:${id}`);
    } catch (error) {
      webview.removeEventListener("message", receive);
      reject(error);
    }
  });
}
