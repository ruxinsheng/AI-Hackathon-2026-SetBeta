// Server-side Devin Sessions API adapter. A Devin key is not an OpenAI model key.
import { INVENTORY_JSON_SCHEMA, PHOTO_ROUTE_JSON_SCHEMA, ROUTE_JSON_SCHEMA } from "./jsonSchema";
import { INVENTORY_SYSTEM_PROMPT, PHOTO_ROUTE_SYSTEM_PROMPT, VIRTUAL_SYSTEM_PROMPT, buildPhotoRouteUserPrompt, buildVirtualUserPrompt } from "./prompt";
import type { Brief, DetectedHold, WallBoundary } from "./schema";

const BASE_URL = "https://api.devin.ai/v3/organizations";
const SESSION_ID = /^devin-[A-Za-z0-9_-]+$/;

export class DevinRequestError extends Error {
  constructor(public readonly reason: "configuration" | "authentication" | "permission" | "quota" | "request" | "session") {
    super(reason);
    this.name = "DevinRequestError";
  }
}

const FAILURE_TEXT: Record<DevinRequestError["reason"], string> = {
  configuration: "Set DEVIN_API_KEY (a cog_ key) and DEVIN_ORG_ID in .env.local, then restart the server.",
  authentication: "Devin rejected the API key (401). Check DEVIN_API_KEY and restart the server.",
  permission: "The Devin key lacks access (403). Grant UseDevinSessions for this organization.",
  quota: "Devin rate-limited the request (429). Wait briefly and retry.",
  request: "The Devin request failed. Check the organization ID, connection, and server logs for the HTTP status.",
  session: "The Devin session stopped without a completed result. Check your Devin dashboard and credit limit.",
};

export function devinFailure(error: unknown) {
  const reason = error instanceof DevinRequestError ? error.reason : "request";
  return { error: FAILURE_TEXT[reason], category: "api_request" as const };
}

export function devinAvailable(): boolean {
  const key = process.env.DEVIN_API_KEY?.trim();
  const org = process.env.DEVIN_ORG_ID?.trim();
  return Boolean(key?.startsWith("cog_") && key !== "cog_your_key_here" &&
    org !== "org-your_org_id_here" && /^org-[A-Za-z0-9_-]+$/.test(org ?? ""));
}

function config() {
  const key = process.env.DEVIN_API_KEY?.trim();
  const org = process.env.DEVIN_ORG_ID?.trim();
  if (!devinAvailable() || !key || !org) throw new DevinRequestError("configuration");
  return { key, url: `${BASE_URL}/${org}` };
}

async function devinFetch(path: string, init: RequestInit): Promise<unknown> {
  const { key, url } = config();
  let response: Response;
  try {
    response = await fetch(`${url}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${key}`, ...init.headers },
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
  } catch { throw new DevinRequestError("request"); }
  if (!response.ok) {
    if (response.status === 401) throw new DevinRequestError("authentication");
    if (response.status === 403) throw new DevinRequestError("permission");
    if (response.status === 429) throw new DevinRequestError("quota");
    throw new DevinRequestError("request");
  }
  try { return await response.json(); }
  catch { throw new DevinRequestError("request"); }
}

async function uploadImage(dataUrl: string, name: string): Promise<string> {
  const match = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new DevinRequestError("request");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > 11_250_000) throw new DevinRequestError("request");
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: match[1] }), name);
  const value = await devinFetch("/attachments", { method: "POST", body: form }) as { url?: unknown };
  if (typeof value?.url !== "string" || !value.url.startsWith("https://")) throw new DevinRequestError("request");
  return value.url;
}

function acuLimit(): number {
  const value = Number(process.env.DEVIN_MAX_ACU ?? "2");
  return Number.isInteger(value) && value >= 1 && value <= 20 ? value : 2;
}

async function createSession(prompt: string, schema: Record<string, unknown>, image?: { data: string; name: string }): Promise<string> {
  const attachment_urls = image ? [await uploadImage(image.data, image.name)] : [];
  const value = await devinFetch("/sessions", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      attachment_urls,
      structured_output_required: true,
      structured_output_schema: schema,
      max_acu_limit: acuLimit(),
      resumable: false,
      title: "SetBeta route-setting concept",
      tags: ["setbeta"],
    }),
  }) as { session_id?: unknown };
  if (typeof value?.session_id !== "string" || !SESSION_ID.test(value.session_id)) throw new DevinRequestError("request");
  return value.session_id;
}

export async function startInventorySession(image: string): Promise<string> {
  return createSession(
    `${INVENTORY_SYSTEM_PROMPT}\nInspect the attached loose-holds photo. Return the detectedHolds object using the requested structured output schema. Do not change any code or create a PR.`,
    INVENTORY_JSON_SCHEMA,
    { data: image, name: "setbeta-holds.jpg" },
  );
}

export async function startPhotoRouteSession(brief: Brief, image: string, inventory: DetectedHold[], boundary: WallBoundary): Promise<string> {
  return createSession(
    `${PHOTO_ROUTE_SYSTEM_PROMPT}\n${buildPhotoRouteUserPrompt(brief, inventory, boundary)}\nInspect the attached wall photo. Return only the candidates object using the requested structured output schema. Do not change any code or create a PR.`,
    PHOTO_ROUTE_JSON_SCHEMA,
    { data: image, name: "setbeta-wall.jpg" },
  );
}

export async function startVirtualRouteSession(brief: Brief, inventory: DetectedHold[]): Promise<string> {
  return createSession(
    `${VIRTUAL_SYSTEM_PROMPT}\n${buildVirtualUserPrompt(brief, inventory)}\nReturn detectedHolds and candidates using the requested structured output schema. Do not change any code or create a PR.`,
    ROUTE_JSON_SCHEMA,
  );
}

export async function getSessionOutput(sessionId: string): Promise<{ state: "pending" } | { state: "complete"; output: unknown }> {
  if (!SESSION_ID.test(sessionId)) throw new DevinRequestError("request");
  const value = await devinFetch(`/sessions/${encodeURIComponent(sessionId)}`, { method: "GET" }) as {
    status?: unknown; status_detail?: unknown; structured_output?: unknown;
  };
  if (value.status === "error" || value.status_detail === "waiting_for_user" || value.status_detail === "waiting_for_approval" ||
      (value.status === "suspended" && value.status_detail !== "finished")) throw new DevinRequestError("session");
  if (value.status_detail === "finished" || value.status === "exit") {
    if (!value.structured_output || typeof value.structured_output !== "object") throw new DevinRequestError("session");
    return { state: "complete", output: value.structured_output };
  }
  return { state: "pending" };
}
