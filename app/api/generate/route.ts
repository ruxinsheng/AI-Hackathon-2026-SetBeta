import { NextResponse } from "next/server";
import { aiAvailable, configuredModel, generatePhotoRoutesWithOpenAI, generateVirtualWithOpenAI } from "../../../lib/openai";
import { DevinRequestError, devinAvailable, devinFailure, getSessionOutput, startPhotoRouteSession, startVirtualRouteSession } from "../../../lib/devin";
import { generateSampleRoutes, SAMPLE_HOLDS } from "../../../lib/sampleGenerator";
import { BriefSchema, CandidateSchema, DetectedHoldSchema, GenerateRequestSchema, RouteResponseSchema, type GenerateResponse, type RouteResponse } from "../../../lib/schema";
import { validateRouteResponse } from "../../../lib/validator";
import { PhotoWorkflowError, isValidWallBoundary, photoFailurePayload, type PhotoFailureCategory } from "../../../lib/photoWorkflow";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Lets the UI show whether AI mode is configured. Never returns the key. */
export async function GET() {
  if (process.env.AI_PROVIDER === "devin") return NextResponse.json({ aiAvailable: devinAvailable(), model: devinAvailable() ? "Devin" : null });
  return NextResponse.json({ aiAvailable: aiAvailable(), model: aiAvailable() ? configuredModel() : null });
}

const DevinPollSchema = z.object({
  sessionId: z.string().regex(/^devin-[A-Za-z0-9_-]+$/),
  brief: BriefSchema,
  workflow: z.enum(["virtual", "photo"]),
  inventory: z.array(DetectedHoldSchema).min(5).max(100),
});

async function pollDevin(body: unknown) {
  const parsed = DevinPollSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid Devin result request." }, { status: 400 });
  const { sessionId, brief, workflow, inventory } = parsed.data;
  try {
    const result = await getSessionOutput(sessionId);
    if (result.state === "pending") return NextResponse.json({ pending: true, sessionId }, { status: 202 });
    const raw = workflow === "photo"
      ? CandidateSchema.array().safeParse((result.output as { candidates?: unknown } | null)?.candidates)
      : RouteResponseSchema.safeParse(result.output);
    if (!raw.success) return NextResponse.json(photoFailurePayload("response_schema"), { status: 502 });
    const routeResponse: RouteResponse = workflow === "photo"
      ? { detectedHolds: inventory, candidates: raw.data as RouteResponse["candidates"] }
      : { ...(raw.data as RouteResponse), detectedHolds: inventory };
    const validated = validateRouteResponse(routeResponse, brief);
    if (validated.candidates.length !== 3 || validated.candidates.some((c) => c.validation.status === "invalid")) {
      return NextResponse.json(photoFailurePayload("route_validation"), { status: 422 });
    }
    return NextResponse.json({
      mode: "ai", model: "Devin", detectedHolds: inventory, candidates: validated.candidates,
      notices: ["Devin proposed these concepts in an agent session. Human installation and forerunning are required.", ...validated.notices],
    } satisfies GenerateResponse);
  } catch (error) { return NextResponse.json(devinFailure(error), { status: 502 }); }
}

export async function POST(req: Request) {
  const photoFail = (category: PhotoFailureCategory, status: number) => {
    console.error(`[setbeta] photo generation failed: ${category}`);
    return NextResponse.json(photoFailurePayload(category), { status });
  };
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
  }

  if (process.env.AI_PROVIDER === "devin" && typeof body === "object" && body !== null && "sessionId" in body) return pollDevin(body);

  const parsed = GenerateRequestSchema.safeParse(body);
  if (!parsed.success) {
    if (typeof body === "object" && body !== null && "workflow" in body && body.workflow === "photo") {
      const imageIssue = parsed.error.issues.some((issue) => issue.path[0] === "wallImage" || issue.path[0] === "holdsImage");
      return photoFail(imageIssue ? "image_processing" : "route_validation", 400);
    }
    const message = parsed.error.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; ");
    return NextResponse.json({ error: `Invalid request — ${message}` }, { status: 400 });
  }

  const { brief, workflow, inventory, wallImage, wallBoundary, forceSample } = parsed.data;
  if (process.env.AI_PROVIDER === "devin") {
    if (forceSample || !devinAvailable()) {
      if (workflow === "photo" && !forceSample) return NextResponse.json(devinFailure(new DevinRequestError("configuration")), { status: 503 });
      const validated = validateRouteResponse(generateSampleRoutes(brief), brief);
      return NextResponse.json({ mode: "sample", model: null, detectedHolds: validated.detectedHolds,
        candidates: validated.candidates, notices: [forceSample ? "Sample concepts were explicitly requested. No Devin session was started." : "Devin is not configured; showing deterministic sample concepts."] } satisfies GenerateResponse);
    }
    if (workflow === "photo" && (!wallImage || !inventory || !wallBoundary || !isValidWallBoundary(wallBoundary))) {
      return photoFail(!wallImage ? "image_processing" : "route_validation", 400);
    }
    try {
      const sessionId = workflow === "photo"
        ? await startPhotoRouteSession(brief, wallImage!, inventory!, wallBoundary!)
        : await startVirtualRouteSession(brief, inventory ?? SAMPLE_HOLDS);
      return NextResponse.json({ pending: true, sessionId }, { status: 202 });
    } catch (error) { return NextResponse.json(devinFailure(error), { status: 502 }); }
  }
  if (workflow === "photo") {
    if (forceSample) {
      const validated = validateRouteResponse(generateSampleRoutes(brief), brief);
      return NextResponse.json({ mode: "sample", model: null, detectedHolds: validated.detectedHolds,
        candidates: validated.candidates, notices: ["Sample concepts were requested explicitly. They use the sample wall and holds, not your photos."] });
    }
    if (!wallImage) return photoFail("image_processing", 400);
    if (!inventory || new Set(inventory.map((h) => h.id)).size !== inventory.length ||
        !wallBoundary || !isValidWallBoundary(wallBoundary)) return photoFail("route_validation", 400);
    if (!aiAvailable()) return photoFail("api_request", 503);
    try {
      const raw = await generatePhotoRoutesWithOpenAI(brief, wallImage, inventory, wallBoundary);
      const validated = validateRouteResponse(raw, brief);
      if (validated.candidates.length !== 3 || validated.candidates.some((c) => c.validation.status === "invalid")) {
        return photoFail("route_validation", 422);
      }
      return NextResponse.json({ mode: "ai", model: configuredModel(), detectedHolds: inventory,
        candidates: validated.candidates, notices: validated.notices } satisfies GenerateResponse);
    } catch (error) {
      return photoFail(error instanceof PhotoWorkflowError ? error.category : "route_validation", 502);
    }
  }
  if (workflow === "virtual" && inventory && new Set(inventory.map((h) => h.id)).size !== inventory.length) {
    return NextResponse.json({ error: "Inventory hold IDs must be unique." }, { status: 400 });
  }
  const notices: string[] = [];
  let raw: RouteResponse | null = null;
  let mode: GenerateResponse["mode"] = "sample";

  if (forceSample) {
    notices.push("Sample mode forced — no AI call was made.");
  } else if (!aiAvailable()) {
    notices.push("No OPENAI_API_KEY configured — using the deterministic sample engine.");
  } else {
    try {
      raw = await generateVirtualWithOpenAI(brief, inventory ?? SAMPLE_HOLDS);
      mode = "ai";
    } catch (err) {
      // Keep external API errors out of responses and logs; they may contain request details.
      console.error("[setbeta] AI generation failed; using sample fallback.");
      notices.push("AI generation failed. Showing deterministic sample concepts instead.");
    }
  }

  if (!raw) raw = generateSampleRoutes(brief);

  let validated = validateRouteResponse(raw, brief);
  if (mode === "ai" && (validated.candidates.length !== 3 || validated.candidates.some((c) => c.validation.status === "invalid"))) {
    notices.push("AI returned incomplete route concepts. Showing deterministic sample concepts instead.");
    mode = "sample";
    validated = validateRouteResponse(generateSampleRoutes(brief), brief);
  }
  if (mode === "ai") {
    notices.unshift("AI generated wall placements and beta from virtual dimensions and structured sample holds; grade estimates require human review.");
  }
  const payload: GenerateResponse = {
    mode,
    model: mode === "ai" ? configuredModel() : null,
    detectedHolds: validated.detectedHolds,
    candidates: validated.candidates,
    notices: [...notices, ...validated.notices],
  };
  return NextResponse.json(payload);
}
