export const DICTATION_PATH = "/dictation";
export const MAX_DICTATION_MS = 60_000;
export const MAX_DICTATION_BYTES = 2 * 1024 * 1024;
export const DICTATION_TOO_LARGE = "La grabación pesa demasiado. Probá con un dictado más corto.";
export const DICTATION_FAILED = "No pude pasar el audio a texto. Probá de nuevo en un momento.";

export type DictationClip = {
  bytes: Uint8Array<ArrayBuffer>;
  mime: string;
  extension: string;
};

export class DictationError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
