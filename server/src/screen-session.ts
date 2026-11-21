export const SCREEN_PROTOCOL = "bitacora";
export const DEV_SESSION_PATH = "/ws/dev-session";

export function isScreenSecret(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
}
