import { NextResponse } from "next/server";
import { aiAvailable, analyzeHoldsWithOpenAI, configuredModel } from "../../../lib/openai";
import { DevinRequestError, devinAvailable, devinFailure, getSessionOutput, startInventorySession } from "../../../lib/devin";
import { InventoryAnalysisSchema, PhotoWorkflowError, normalizeDetectedInventory, photoFailurePayload } from "../../../lib/photoWorkflow";
import { AnalyzeHoldsRequestSchema } from "../../../lib/schema";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function fail(category: PhotoWorkflowError["category"], status: number) {
  // The category is fixed vocabulary. Never log the key, the request body, or API errors.
  console.error(`[setbeta] photo inventory failed: ${category}`);
  return NextResponse.json(photoFailurePayload(category), { status });
}

export async function POST(req: Request) {
  let body: unknown;
  try { body = await req.json(); }
  catch { return fail("image_processing", 400); }
  if (process.env.AI_PROVIDER === "devin") {
    if (!devinAvailable()) return NextResponse.json(devinFailure(new DevinRequestError("configuration")), { status: 503 });
    const polling = z.object({ sessionId: z.string().regex(/^devin-[A-Za-z0-9_-]+$/) }).safeParse(body);
    try {
      if (polling.success) {
        const result = await getSessionOutput(polling.data.sessionId);
        if (result.state === "pending") return NextResponse.json({ pending: true, sessionId: polling.data.sessionId }, { status: 202 });
        const parsed = InventoryAnalysisSchema.safeParse(result.output);
        if (!parsed.success) return fail("response_schema", 502);
        return NextResponse.json({ detectedHolds: normalizeDetectedInventory(parsed.data.detectedHolds), model: "Devin" });
      }
      const parsed = AnalyzeHoldsRequestSchema.safeParse(body);
      if (!parsed.success) return fail("image_processing", 400);
      const sessionId = await startInventorySession(parsed.data.holdsImage!);
      return NextResponse.json({ pending: true, sessionId }, { status: 202 });
    } catch (error) { return NextResponse.json(devinFailure(error), { status: 502 }); }
  }
  const parsed = AnalyzeHoldsRequestSchema.safeParse(body);
  if (!parsed.success) return fail("image_processing", 400);
  if (!aiAvailable()) return fail("api_request", 503);
  try {
    const detectedHolds = await analyzeHoldsWithOpenAI(parsed.data.holdsImage!);
    return NextResponse.json({ detectedHolds, model: configuredModel() });
  } catch (error) {
    const category = error instanceof PhotoWorkflowError ? error.category : "api_request";
    return fail(category, 502);
  }
}
