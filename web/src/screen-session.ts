/// <reference types="vite/client" />
import { DEV_SESSION_PATH, isScreenSecret } from "../../server/src/screen-session";

declare global {
  interface Window {
    readonly __BITACORA_SCREEN_SECRET__?: string;
  }
}

export async function screenSecret() {
  const injected = window.__BITACORA_SCREEN_SECRET__;
  if (isScreenSecret(injected)) return injected;
  if (!import.meta.env.DEV) return;
  try {
    const response = await fetch(DEV_SESSION_PATH, { method: "POST", redirect: "error" });
    if (!response.ok) return;
    const secret = await response.text();
    if (isScreenSecret(secret)) return secret;
  } catch {
    // The server may still be starting. The screen will retry.
  }
}
