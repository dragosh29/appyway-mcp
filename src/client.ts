// Minimal AppyWay API client used by the MCP tools.
// Docs: https://docs.appyway.com (getting-started guide: API-KEY header, {success, result} envelope,
// error shapes). Specs: the Explorer, Traffic Data and Reference OpenAPI 3.0.1 documents published
// through Stoplight (see README).
import { redactContacts } from "./format.js";

export class AppyWayError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "AppyWayError";
  }
}

/** The three API sections; each has its own base path under /v1. */
export type Section = "explorer" | "traffic-data" | "reference";
export const SECTION_NAMES: Record<Section, string> = { explorer: "Explorer", "traffic-data": "Traffic Data", reference: "Reference" };

// A 429 means the request was not processed, so it is safe to repeat for any method. A 502/503/504
// from a gateway does not prove the upstream did not process the request, so those are only retried
// for GET. Every POST this server makes is a documented read-only query, but the rule is kept strict:
// a POST is never repeated after a gateway error, and the error message says it is safe to call again.
const RETRY_ANY_METHOD = new Set([429]);
const RETRY_GET_ONLY = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 3;
// Longest single wait honoured from Retry-After. The MCP SDK's default request timeout is 60 s
// (DEFAULT_REQUEST_TIMEOUT_MSEC), so the whole retry budget (at most two waits) must stay well
// under that; a longer Retry-After makes the call give up at once with the wait time in the message.
export const MAX_RETRY_AFTER_S = 10;

// Getting-started guide: "api.appyway.com/<version>/<section_name>/<endpoint_name>"; the specs'
// servers are https://api.appyway.com/v1/explorer, /v1/traffic-data and /v1/reference.
export const DEFAULT_BASE_URL = "https://api.appyway.com/v1";
// Getting-started guide, "Authentication": "Header name: API-KEY".
export const API_KEY_HEADER = "API-KEY";

export class AppyWayClient {
  private readonly baseUrl: string;
  // AppyWay documents a 429 ("Too many requests") on every operation but no limit and no Retry-After
  // behaviour. Space requests at about four per second so a tool call that fans out stays polite.
  private nextSlot = 0;
  private readonly minIntervalMs = 250;

  constructor(private readonly apiKey: string, baseUrl = DEFAULT_BASE_URL) {
    let u: URL;
    try {
      u = new URL(baseUrl);
    } catch {
      throw new AppyWayError("APPYWAY_BASE_URL is not a valid URL.");
    }
    if (u.username || u.password) throw new AppyWayError("APPYWAY_BASE_URL must not contain a username or password; the key goes in APPYWAY_API_KEY.");
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  /** POST a documented query and return its `result`. `body` undefined sends no body (the endpoints without a requestBody). */
  post<T = any>(section: Section, path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", section, path, body);
  }

  /** GET /ping on a section. The Explorer and Traffic Data pings document no body, so any 2xx counts. */
  async ping(section: Section): Promise<{ status: number; result?: string }> {
    const { status, json, text } = await this.send("GET", section, "/ping");
    const result = json && typeof json === "object" && typeof json.result === "string" ? json.result : text && !json ? text.slice(0, 40) : undefined;
    return { status, result: redactContacts(result, false) };
  }

  async request<T = any>(method: string, section: Section, path: string, body?: unknown): Promise<T> {
    const { status, json, text } = await this.send(method, section, path, body);
    const where = `${method} /${section}${path}`;
    // Every documented 2xx body is the JSON envelope {success, result}. A 200 with HTML (a proxy, a
    // captive portal, a login page) must not be mistaken for an empty result.
    if (!json || typeof json !== "object") {
      throw new AppyWayError(
        `AppyWay returned ${status} for ${where} but the body was not JSON (starts with: ${JSON.stringify(redactContacts(text.slice(0, 60), false) ?? "")}). Check APPYWAY_BASE_URL and whether a proxy or login page is in the way.`,
        status,
      );
    }
    if (json.success === false) {
      // Same redaction as the error path in send(): AppyWay's messages are free text.
      const detail = redactContacts(describeError(json), false);
      throw new AppyWayError(`AppyWay answered ${where} with success: false.${detail ? " " + detail : ""}`, status);
    }
    return json.result as T;
  }

  private async send(method: string, section: Section, path: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
    const url = `${this.baseUrl}/${section}${path}`;
    const where = `${method} /${section}${path}`;
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            [API_KEY_HEADER]: this.apiKey,
            Accept: "application/json",
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        throw new AppyWayError(`Could not reach AppyWay at ${this.baseUrl}/${section}: ${(err as Error).message}`);
      }

      const retryable = RETRY_ANY_METHOD.has(res.status) || (method === "GET" && RETRY_GET_ONLY.has(res.status));
      if (retryable && attempt < MAX_ATTEMPTS - 1) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_S) {
          throw new AppyWayError(`AppyWay asked to wait ${Math.ceil(retryAfter)} seconds before retrying ${where} (HTTP ${res.status}). Try again after that.`, res.status);
        }
        // A missing or unparsable header falls back to 2 s then 4 s; a Retry-After of 0 (or a date already
        // passed) means retry now, subject to the throttle.
        const delay = retryAfter !== undefined ? retryAfter * 1000 : 2000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      const text = await res.text();
      const json = text ? safeJson(text) : undefined;
      if (res.ok) return { status: res.status, json, text };

      // AppyWay's messages are free text; anything that looks like a contact detail is redacted before
      // it is passed on. Only a JSON message is used: a gateway's HTML page is never quoted.
      const detail = redactContacts(describeError(json), false);
      const tail = detail ? " " + detail : "";
      if (res.status === 401) {
        // Getting-started guide, "Unauthorized / Access Denied - HTTP 401": the example is an errors[]
        // entry on property "authority" saying "No permissions to authority '{GUID}'". That is a valid
        // key used outside its entitlement, which needs a different fix from a wrong key.
        if (mentionsAuthorityPermission(json)) {
          throw new AppyWayError(
            `AppyWay refused ${where} (401): the API key is not entitled to this authority.${tail} An AppyWay key only covers the authorities it has been granted; list_authorities (without a location) shows the ones this key can use. To add an authority, ask AppyWay (apisupport@appyway.com).`,
            401,
          );
        }
        throw new AppyWayError(
          `AppyWay rejected the API key (401) for ${where}. Check APPYWAY_API_KEY: it is sent in the ${API_KEY_HEADER} header, and keys are issued by AppyWay (apisupport@appyway.com).${tail}`,
          401,
        );
      }
      if (res.status === 403) {
        throw new AppyWayError(
          `AppyWay refused ${where} (403 Forbidden). The key may not be enabled for the ${SECTION_NAMES[section]} API or for this endpoint; the ping tool shows which API sections the key can reach.${tail}`,
          403,
        );
      }
      if (res.status === 404) throw new AppyWayError(`Not found: ${where}. Check the ID.${tail}`, 404);
      if (res.status === 429) throw new AppyWayError("AppyWay rate limit reached (AppyWay does not document the limit). Wait a minute and try again.", 429);
      if (res.status === 400) throw new AppyWayError(`AppyWay refused the query ${where} (400).${tail}`, 400);
      if (RETRY_GET_ONLY.has(res.status)) {
        if (method !== "GET") {
          throw new AppyWayError(
            `AppyWay returned ${res.status} for ${where}. This server does not repeat a POST after a gateway error, but this call is a read-only query, so it is safe to call the tool again.${tail}`,
            res.status,
          );
        }
        throw new AppyWayError(`AppyWay returned ${res.status} for ${where} ${MAX_ATTEMPTS} times in a row. The service may be unavailable; try again in a few minutes.${tail}`, res.status);
      }
      throw new AppyWayError(`AppyWay returned ${res.status} for ${where}.${tail}`, res.status);
    }
  }
}

/**
 * Retry-After in seconds, from either form allowed by RFC 9110 (delay-seconds or an HTTP-date).
 * A fractional number is accepted as seconds too. Anything else that is not an HTTP-date (which always
 * names a month, so contains letters) gives undefined, so the caller's fallback applies; without that
 * check Date.parse("1.5") would be read as a date in 2001 and the retry would happen at once.
 */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const h = header.trim();
  if (/^\d+(\.\d+)?$/.test(h)) return Number(h);
  if (!/[A-Za-z]/.test(h)) return undefined;
  const at = Date.parse(h);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, (at - now) / 1000);
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function mentionsAuthorityPermission(json: any): boolean {
  const errs = Array.isArray(json?.errors) ? json.errors : [];
  return errs.some((e: any) => (typeof e?.message === "string" && /no permissions? to authority/i.test(e.message)) || e?.property === "authority");
}

// Getting-started guide and the specs' BadRequestResponse / NotFoundResponse: {success, message,
// errors: [{property, code, message}]}.
function describeError(json: any): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const parts: string[] = [];
  if (typeof json.message === "string" && json.message.trim()) parts.push(json.message.trim());
  if (Array.isArray(json.errors)) {
    for (const e of json.errors.slice(0, 10)) {
      if (!e || typeof e !== "object") continue;
      const bits = [e.property ? `${e.property}:` : "", typeof e.message === "string" ? e.message : "", e.code ? `(${e.code})` : ""].filter(Boolean).join(" ");
      if (bits) parts.push(bits);
    }
  }
  return parts.length ? parts.join(" ") : undefined;
}
