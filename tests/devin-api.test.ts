import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_HOLDS, generateSampleRoutes } from "../lib/sampleGenerator";
import type { Brief, WallBoundary } from "../lib/schema";

const previous = {
  provider: process.env.AI_PROVIDER,
  key: process.env.DEVIN_API_KEY,
  org: process.env.DEVIN_ORG_ID,
};
const brief: Brief = {
  wallWidthM: 3.5, wallHeightM: 4, wallAngleDeg: 20, grade: "V4",
  style: "technical", requiredMove: "heel hook", climberHeightCm: 170, notes: "",
};
const boundary: WallBoundary = [
  { xPercent: 10, yPercent: 10 }, { xPercent: 90, yPercent: 10 },
  { xPercent: 90, yPercent: 90 }, { xPercent: 10, yPercent: 90 },
];
const image = "data:image/jpeg;base64,AA==";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
const post = (path: string, body: unknown) => new Request(`http://localhost${path}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

beforeEach(() => {
  process.env.AI_PROVIDER = "devin";
  process.env.DEVIN_API_KEY = "cog_test_secret";
  process.env.DEVIN_ORG_ID = "org-test";
  vi.unstubAllGlobals();
});
afterAll(() => {
  for (const [name, value] of Object.entries({ AI_PROVIDER: previous.provider, DEVIN_API_KEY: previous.key, DEVIN_ORG_ID: previous.org })) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  vi.unstubAllGlobals();
});

describe("Devin-backed APIs", () => {
  it("uploads the hold photo, starts a capped session, and reads structured inventory", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ url: "https://example.devin.ai/attachment" }))
      .mockResolvedValueOnce(json({ session_id: "devin-inventory1" }))
      .mockResolvedValueOnce(json({ status: "running", status_detail: "working" }))
      .mockResolvedValueOnce(json({ status: "running", status_detail: "finished", structured_output: { detectedHolds: SAMPLE_HOLDS.slice(0, 5) } }));
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("../app/api/analyze-holds/route");
    const started = await POST(post("/api/analyze-holds", { holdsImage: image }));
    expect(started.status).toBe(202);
    expect((await started.json()).sessionId).toBe("devin-inventory1");
    expect(fetchMock.mock.calls[0][0]).toContain("/attachments");
    expect(fetchMock.mock.calls[0][1].body).toBeInstanceOf(FormData);
    const createBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(createBody.max_acu_limit).toBe(2);
    expect(createBody.attachment_urls).toEqual(["https://example.devin.ai/attachment"]);
    const pending = await POST(post("/api/analyze-holds", { sessionId: "devin-inventory1" }));
    expect(pending.status).toBe(202);
    const complete = await POST(post("/api/analyze-holds", { sessionId: "devin-inventory1" }));
    expect(complete.status).toBe(200);
    expect((await complete.json()).detectedHolds).toHaveLength(5);
  });

  it("generates photo routes from a wall attachment without silent sample fallback", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ url: "https://example.devin.ai/wall" }))
      .mockResolvedValueOnce(json({ session_id: "devin-route1" }))
      .mockResolvedValueOnce(json({ status: "running", status_detail: "finished", structured_output: { candidates: generateSampleRoutes(brief).candidates } }));
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("../app/api/generate/route");
    const started = await POST(post("/api/generate", { brief, workflow: "photo", inventory: SAMPLE_HOLDS, wallImage: image, wallBoundary: boundary }));
    expect(started.status).toBe(202);
    const complete = await POST(post("/api/generate", { sessionId: "devin-route1", brief, workflow: "photo", inventory: SAMPLE_HOLDS }));
    expect(complete.status).toBe(200);
    const data = await complete.json();
    expect(data.mode).toBe("ai");
    expect(data.model).toBe("Devin");
    expect(data.candidates).toHaveLength(3);
  });

  it("reports authentication failure without echoing the secret", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({ detail: "cog_test_secret" }, 401)));
    const { POST } = await import("../app/api/generate/route");
    const response = await POST(post("/api/generate", { brief, workflow: "virtual", inventory: SAMPLE_HOLDS }));
    expect(response.status).toBe(502);
    const data = await response.json();
    expect(data.error).toMatch(/rejected the API key/);
    expect(JSON.stringify(data)).not.toContain("cog_test_secret");
    expect(data).not.toHaveProperty("candidates");
  });
});
