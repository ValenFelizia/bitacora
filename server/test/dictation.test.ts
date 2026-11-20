import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { WebSocket } from "ws";
import { transcribeWithCodex } from "../src/codex/transcribe";
import { DICTATION_FAILED, DICTATION_PATH, DICTATION_TOO_LARGE, MAX_DICTATION_BYTES, type DictationClip } from "../src/dictation";
import { serve } from "../src/server";
import { FakeEngine } from "./fake-engine";

const account = "test-workspace";
const claims = Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: account },
})).toString("base64url");
const bearer = (version: string) => `e30.${claims}.${version}`;
const fakeAudio = "fake clip";

async function setup(t: TestContext, statuses: number[]) {
  const directory = await mkdtemp(join(tmpdir(), "bitacora-dictation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const webRoot = join(directory, "web");
  await mkdir(webRoot);
  await writeFile(join(webRoot, "index.html"), "<title>Bitácora</title>");
  const received: {
    authorization?: string;
    accountId?: string | string[];
    name: string;
    type: string;
    audio: string;
  }[] = [];
  const upstream = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/backend-api/transcribe");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const form = await new Response(Buffer.concat(chunks), {
        headers: { "Content-Type": req.headers["content-type"] || "" },
      }).formData();
      const file = form.get("file");
      assert.ok(file instanceof File);
      assert.deepEqual([...form.keys()], ["file"]);
      received.push({
        authorization: req.headers.authorization,
        accountId: req.headers["chatgpt-account-id"],
        name: file.name,
        type: file.type,
        audio: await file.text(),
      });
      const status = statuses.shift() ?? 500;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status === 200 ? { text: " Córdoba " } : { error: "private upstream error" }));
    } catch (error) {
      t.diagnostic(String(error));
      res.writeHead(500).end();
    }
  });
  t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const mockFetch: typeof fetch = (input, init) => {
    assert.equal(input, "https://chatgpt.com/backend-api/transcribe");
    assert.equal(init?.redirect, "error");
    return fetch(`http://127.0.0.1:${address.port}/backend-api/transcribe`, init);
  };
  const refreshes: boolean[] = [];
  class DictationEngine extends FakeEngine {
    transcribe(clip: DictationClip, signal: AbortSignal) {
      return transcribeWithCodex(clip, signal, async (refreshToken) => {
        refreshes.push(refreshToken);
        return {
          authMethod: "chatgpt",
          authToken: bearer(refreshToken ? "new" : "old"),
          requiresOpenaiAuth: true,
        };
      }, mockFetch);
    }
  }

  const server = await serve(new DictationEngine(), join(directory, "data"), 0, undefined, undefined, {
    webRoot, kitSource: join(directory, "kit"),
  });
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.port}`;
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { origin });
  try {
    const [snapshot] = await once(socket, "message");
    const token: unknown = JSON.parse(String(snapshot)).state.fileToken;
    assert.equal(typeof token, "string");
    const url = origin + DICTATION_PATH;
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "audio/webm;codecs=opus" };
    const send = (body = fakeAudio, requestHeaders: Record<string, string> = headers) =>
      fetch(url, { method: "POST", headers: requestHeaders, body });
    return { send, url, headers, received, refreshes };
  } finally {
    socket.terminate();
    await once(socket, "close");
  }
}

test("dictation sends a multipart audio file and returns only the transcript", async (t) => {
  const { send, received, refreshes } = await setup(t, [200]);
  const response = await send();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { text: "Córdoba" });
  assert.deepEqual(refreshes, [false]);
  assert.deepEqual(received, [{
    authorization: `Bearer ${bearer("old")}`,
    accountId: account,
    name: "audio.webm",
    type: "audio/webm",
    audio: fakeAudio,
  }]);
});

test("dictation refreshes after a 401 and resends the same clip once", async (t) => {
  const { send, received, refreshes } = await setup(t, [401, 200]);
  const response = await send();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: "Córdoba" });
  assert.deepEqual(refreshes, [false, true]);
  assert.deepEqual(received.map(({ authorization, audio }) => [authorization, audio]), [
    [`Bearer ${bearer("old")}`, fakeAudio],
    [`Bearer ${bearer("new")}`, fakeAudio],
  ]);
});

test("dictation stops after a second 401", async (t) => {
  const { send, received, refreshes } = await setup(t, [401, 401, 200]);
  const response = await send();
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "Volvé a conectar tu cuenta de ChatGPT para dictar." });
  assert.deepEqual(refreshes, [false, true]);
  assert.equal(received.length, 2);
});

test("dictation hides upstream failure details", async (t) => {
  const { send, refreshes } = await setup(t, [500]);
  const response = await send();
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: DICTATION_FAILED });
  assert.deepEqual(refreshes, [false]);
});

test("dictation rejects oversized uploads with or without Content-Length", async (t) => {
  const { send, url, headers, received, refreshes } = await setup(t, []);
  const response = await send("x".repeat(MAX_DICTATION_BYTES + 1));
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: DICTATION_TOO_LARGE });
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const upload = request(url, { method: "POST", headers }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    upload.on("error", reject);
    upload.write(Buffer.alloc(MAX_DICTATION_BYTES));
    upload.end("x");
  });
  assert.equal(status, 413);
  assert.deepEqual(received, []);
  assert.deepEqual(refreshes, []);
});

test("dictation rejects a missing token and a foreign origin before reading audio", async (t) => {
  const { send, headers, received, refreshes } = await setup(t, []);
  const noToken = await send(fakeAudio, { "Content-Type": "audio/webm" });
  assert.equal(noToken.status, 403);
  const foreign = await send(fakeAudio, { ...headers, Origin: "https://example.org" });
  assert.equal(foreign.status, 403);
  assert.deepEqual(received, []);
  assert.deepEqual(refreshes, []);
});
