import type { GetAuthStatusResponse } from "./generated/GetAuthStatusResponse";
import { DICTATION_FAILED, DictationError, type DictationClip } from "../dictation";

const TRANSCRIBE_URL = "https://chatgpt.com/backend-api/transcribe";
const MAX_RESPONSE_BYTES = 64 * 1024;

type ReadAuth = (refreshToken: boolean) => Promise<GetAuthStatusResponse>;

function chatgptHeaders(auth: GetAuthStatusResponse) {
  if (auth.authMethod !== "chatgpt" || !auth.authToken) {
    throw new DictationError(409, "Volvé a conectar tu cuenta de ChatGPT para dictar.");
  }
  const headers = new Headers({
    Authorization: `Bearer ${auth.authToken}`,
    "User-Agent": "Bitacora",
  });
  // Use the account claim only as a routing hint. ChatGPT validates the bearer.
  const payload = auth.authToken.split(".")[1];
  if (payload) {
    let claims: unknown;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      return headers;
    }
    if (claims && typeof claims === "object" && "https://api.openai.com/auth" in claims) {
      const account = claims["https://api.openai.com/auth"];
      if (account && typeof account === "object") {
        if ("chatgpt_account_id" in account && typeof account.chatgpt_account_id === "string" &&
            /^[a-zA-Z0-9_-]+$/.test(account.chatgpt_account_id)) {
          headers.set("ChatGPT-Account-Id", account.chatgpt_account_id);
        }
        if ("chatgpt_account_is_fedramp" in account && account.chatgpt_account_is_fedramp === true) {
          headers.set("X-OpenAI-Fedramp", "true");
        }
      }
    }
  }
  return headers;
}

async function readTranscript(response: Response) {
  if (!response.body) throw new Error("Missing transcript");
  let size = 0;
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Transcript too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  if (!value || typeof value !== "object" || !("text" in value) || typeof value.text !== "string") {
    throw new Error("Invalid transcript");
  }
  const transcript = value.text.trim();
  if (!transcript) throw new DictationError(422, "No escuché palabras claras. Probá de nuevo.");
  return transcript;
}

export async function transcribeWithCodex(
  clip: DictationClip,
  signal: AbortSignal,
  readAuth: ReadAuth,
  request = fetch,
): Promise<string> {
  const audio = new FormData();
  audio.set("file", new Blob([clip.bytes], { type: clip.mime }), `audio.${clip.extension}`);
  const submit = (headers: Headers) => request(TRANSCRIBE_URL, {
    method: "POST",
    headers,
    body: audio,
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });

  const headers = chatgptHeaders(await readAuth(false));
  signal.throwIfAborted();
  let response = await submit(headers);
  if (response.status === 401) {
    await response.body?.cancel();
    signal.throwIfAborted();
    const renewed = chatgptHeaders(await readAuth(true));
    signal.throwIfAborted();
    const account = headers.get("ChatGPT-Account-Id");
    const renewedAccount = renewed.get("ChatGPT-Account-Id");
    // A renewed token without an account id cannot prove it is the same account.
    if (account && renewedAccount !== account) {
      throw new DictationError(409, "Cambió tu cuenta de ChatGPT. Volvé a dictar.");
    }
    response = await submit(renewed);
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 401) {
      throw new DictationError(409, "Volvé a conectar tu cuenta de ChatGPT para dictar.");
    }
    throw new DictationError(502, DICTATION_FAILED);
  }
  return readTranscript(response);
}
