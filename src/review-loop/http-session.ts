type Code = "config" | "scope" | "credential" | "closed" | "busy" | "request_limit" | "timeout" | "aborted"
  | "read_failed" | "unauthorized" | "forbidden" | "not_found" | "rate_limited" | "server_error" | "http_status"
  | "graphql" | "http_response" | "content_type" | "content_length" | "response_bytes" | "session_bytes" | "json";
/** Content-free transport receipt. Never includes a response body, URL or thrown port error. */
export class ReviewHttpError extends Error {
  constructor(readonly code: Code, readonly status?: number, readonly retryAfterSeconds?: number) {
    super(`review_http:${code}`);
    this.name = "ReviewHttpError";
  }
}
interface Limits { responseBytes: number; sessionBytes: number; requests: number; timeoutMs: number }
export interface ReviewHttpDependencies {
  /** Trusted native fetch implementation; no implicit network default or model-supplied function. */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Tool-owned issuer. Identity, actual permission scope and expiry are NOT proved by this adapter. */
  credential: (signal: AbortSignal) => Promise<string>;
  limits?: Partial<Limits>;
}
const ORIGIN = "https://api.github.com";
const CEILINGS: Limits = { responseBytes: 8 * 1024 * 1024, sessionBytes: 64 * 1024 * 1024, requests: 40, timeoutMs: 30_000 };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
export function validReviewBranch(value: string): boolean {
  return value.length > 0 && value.length <= 255 && !/[\x00-\x20\x7f~^:?*\[\\]/.test(value)
    && !value.includes("..") && !value.includes("@{") && value !== "@"
    && value.split("/").every(part => !!part && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"));
}
function statusError(response: Response): ReviewHttpError {
  const status = response.status;
  const raw = response.headers.get("Retry-After");
  const retry = raw && /^\d{1,10}$/.test(raw) ? Math.min(3600, Number(raw)) : undefined;
  const limited = status === 429 || (status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || retry !== undefined));
  return new ReviewHttpError(limited ? "rate_limited" : status === 401 ? "unauthorized" : status === 403 ? "forbidden"
    : status === 404 ? "not_found" : status >= 500 ? "server_error" : "http_status", status, retry);
}

interface PreparedRequest { path: string; method: "GET" | "POST"; body?: string }
interface SessionConfig<Input> {
  requests: number;
  prepare: (input: Input) => PreparedRequest | undefined;
  accept?: (value: unknown) => boolean;
}
/** Internal native transport engine; only scoped factories prepare requests. No issuer or tool registration. */
export function createReviewHttpSession<Input>(deps: ReviewHttpDependencies, config: SessionConfig<Input>):
  (input: Input, signal: AbortSignal) => Promise<unknown> {
  if (!object(deps) || typeof deps.fetch !== "function" || typeof deps.credential !== "function"
    || (deps.limits !== undefined && !object(deps.limits))) throw new ReviewHttpError("config");
  const ceilings = { ...CEILINGS, requests: config.requests };
  const limits = { ...ceilings, ...deps.limits };
  for (const key of Object.keys(limits)) {
    if (!Object.hasOwn(CEILINGS, key) || !positive(limits[key as keyof Limits]) || limits[key as keyof Limits] > ceilings[key as keyof Limits]) {
      throw new ReviewHttpError("config");
    }
  }
  let closed = false, requests = 0, total = 0, started: number | undefined, active: AbortController | undefined;
  function refuse(code: Code): never { closed = true; throw new ReviewHttpError(code); }
  return async (input, callerSignal) => {
    if (closed) throw new ReviewHttpError("closed");
    if (active) { active.abort(); refuse("busy"); }
    let request: PreparedRequest | undefined;
    try { request = config.prepare(input); } catch { refuse("scope"); }
    if (!request) refuse("scope");
    if (!(callerSignal instanceof AbortSignal)) refuse("config");
    if (callerSignal.aborted) refuse("aborted");
    if (++requests > limits.requests) refuse("request_limit");
    started ??= performance.now();
    const remaining = limits.timeoutMs - (performance.now() - started);
    if (remaining <= 0) refuse("timeout");
    const controller = new AbortController(); active = controller;
    let abortCode: "timeout" | "aborted" = "aborted";
    const abort = () => controller.abort();
    const timer = setTimeout(() => { abortCode = "timeout"; controller.abort(); }, remaining);
    callerSignal.addEventListener("abort", abort, { once: true });
    let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    function checkDeadline(): void {
      if (!controller.signal.aborted && performance.now() - started! >= limits.timeoutMs) {
        abortCode = "timeout"; controller.abort();
      }
      if (controller.signal.aborted) throw new ReviewHttpError(abortCode);
    }
    async function bounded<T>(operation: () => Promise<T>): Promise<T> {
      let interrupted: (() => void) | undefined;
      const cancelled = new Promise<never>((_, reject) => {
        interrupted = () => reject(new ReviewHttpError(abortCode));
        controller.signal.addEventListener("abort", interrupted, { once: true });
      });
      try {
        checkDeadline();
        const value = await Promise.race([operation(), cancelled]);
        checkDeadline();
        return value;
      } catch {
        // Even a port throwing a forged ReviewHttpError cannot inject a body/token into our errors.
        throw new ReviewHttpError(controller.signal.aborted ? abortCode : "read_failed");
      } finally { if (interrupted) controller.signal.removeEventListener("abort", interrupted); }
    }
    try {
      const credential = await bounded(() => deps.credential(controller.signal));
      if (typeof credential !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(credential)) throw new ReviewHttpError("credential");
      const url = ORIGIN + request.path;
      response = await bounded(() => deps.fetch(url, {
        method: request.method, ...(request.body === undefined ? {} : { body: request.body }), redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
        signal: controller.signal,
        headers: { ...(request.method === "POST" ? { "Content-Type": "application/json" } : {}), Authorization: `Bearer ${credential}`, Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "anima-review-collector" },
      }));
      if (!(response instanceof Response) || response.redirected || (response.url && response.url !== url)) throw new ReviewHttpError("http_response");
      if (response.status !== 200) throw statusError(response);
      if (!/^(?:application\/json|application\/vnd.github\+json)(?:\s*;.*)?$/i.test(response.headers.get("Content-Type") ?? "")) {
        throw new ReviewHttpError("content_type");
      }
      const declared = response.headers.get("Content-Length");
      if (declared !== null) {
        if (!/^\d{1,16}$/.test(declared) || !Number.isSafeInteger(Number(declared))) throw new ReviewHttpError("content_length");
        if (Number(declared) > limits.responseBytes) throw new ReviewHttpError("response_bytes");
        if (total + Number(declared) > limits.sessionBytes) throw new ReviewHttpError("session_bytes");
      }
      if (!response.body) throw new ReviewHttpError("json");
      reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const next = await bounded(() => reader!.read());
        if (next.done) break;
        size += next.value.byteLength; total += next.value.byteLength;
        if (size > limits.responseBytes) throw new ReviewHttpError("response_bytes");
        if (total > limits.sessionBytes) throw new ReviewHttpError("session_bytes");
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (!value || typeof value !== "object") throw new Error();
      } catch { throw new ReviewHttpError("json"); }
      if (config.accept && !config.accept(value)) throw new ReviewHttpError("graphql");
      checkDeadline();
      return value;
    } catch (error) {
      closed = true;
      throw error instanceof ReviewHttpError ? error : new ReviewHttpError("read_failed");
    } finally {
      clearTimeout(timer); callerSignal.removeEventListener("abort", abort); controller.abort();
      // Cancellation is best effort and never an unbounded await or a quiescence claim.
      try { void (reader ? reader.cancel() : response?.body?.cancel())?.catch(() => {}); } catch {}
      try { reader?.releaseLock(); } catch {}
      if (active === controller) active = undefined;
    }
  };
}
