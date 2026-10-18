# SetBeta — virtual-wall co-setter demo

SetBeta proposes **three conceptual bouldering routes** for human setter review. The main demo is a virtual wall with configurable dimensions and an existing structured 15-hold sample inventory. Photos are optional. Every concept needs professional installation, inspection, and human forerunning; estimated grades are hypotheses.

## Run

Requires Node.js 18.18 or newer.

```bash
npm install
npm test
npm run build
npm run dev
```

Open http://localhost:3000. Choose **Virtual wall**, set dimensions and a brief, then select **Generate routes**. The virtual mode needs no photos. Choose **Photos (optional)** to upload an empty wall and loose-hold inventory photo. Analyze the hold photo, correct the numbered markers, continue, then tap the wall's top-left, top-right, bottom-right, and bottom-left corners before generating.

For Devin-backed AI, set `AI_PROVIDER=devin`, `DEVIN_API_KEY` (a `cog_` key with `UseDevinSessions` permission), and `DEVIN_ORG_ID` (an `org-` ID) in `.env.local`, then restart. `DEVIN_MAX_ACU` caps each session (default 2). SetBeta uploads a photo to Devin as a session attachment, requests validated structured output, and polls for completion. A virtual request starts a text-only session. The app never sends your Devin key to the browser. The status pill reports configuration only, not a successful API call. Devin sessions can take minutes and consume ACUs; this is a prototype, and photo interpretation has **not** been verified with a live Devin key.

Alternatively, set `AI_PROVIDER=openai` and `OPENAI_API_KEY` for the original direct model path. `OPENAI_MODEL` defaults to `gpt-4.1` and must support the Responses API and Structured Outputs. A Devin key cannot be used as `OPENAI_API_KEY`.

In virtual mode, **Force sample mode** skips AI. The original OpenAI path falls back to deterministic sample concepts when its AI call fails or returns incomplete output. The Devin path returns explicit errors after a session starts; it does not silently turn a failed Devin session into a sample route. With no configured key, virtual mode still shows sample concepts. In photo mode, failures stay visible. Development mode identifies image processing, API request, response schema, or route validation failures; the error never includes the key or image data. **View sample concepts** is an explicit choice and its result says it was not generated from the photos. The sample generator uses hand-authored heuristics; its placements, beta, and grade ranges are illustrative.

## What the AI generates

In virtual mode, the browser sends the wall width, height, angle, route brief, and the structured sample inventory to `/api/generate`. The server sends only that text to the selected provider and asks for three route concepts. AI proposes new wall coordinates, hold choices, rotations, beta, crux, and tentative grade ranges. The sample inventory labels, types, sizes, and illustration positions are supplied data, **not AI detections**. Inventory positions locate labels in the inventory illustration; they are not wall placements.

In photo mode, the first API call sends only the loose-hold photo and returns numbered centers, grip type and size guesses, and confidence. The user can add, move, remove, and correct markers. The second call sends the wall photo, confirmed hold inventory, selected wall corners, dimensions, and route brief. The route model returns three candidates using wall-local coordinates; the UI maps those onto the selected quadrilateral in the photo. A human must confirm every physical hold match and placement before setting. The wall photo should show an unobstructed climbable area; the boundary only establishes coordinates and does not measure depth or structural features.

Every response passes deterministic validation: only inventory hold IDs, one use of each physical hold per route, coordinate bounds, 5–9 placements, start and finish, beta references, reach warnings, and removal of safety claims. The virtual wall drawing and sample hold art are illustrations. Nothing in ClimbDB trains the route generator or grades its output.

## ClimbDB: descriptive comparison only

We inspected [`climbing_data.csv`](https://github.com/NehaRajganesh/ClimbDB/blob/main/climbing_data.csv) directly. Its 97 rows record attempts with grades V1–V5, four limb movement counts, total moves, climbing time, outcome, and completion. It has **no hold coordinates or move-by-move sequence**, so it cannot teach SetBeta hold placement or intended beta. Counts, times, and completion are observed during or after an attempt and are never used as inputs to a pre-climb success predictor.

The independent, standard-library importer reads a **local copy** of that CSV and prints grade-level descriptive aggregates with sample sizes:

```bash
python3 scripts/import_climbdb.py /path/to/climbing_data.csv
```

The currently inspected CSV gives these descriptive comparisons. Means include both completed and incomplete attempts, so grade groups are not controlled comparisons:

| Grade | Attempts (n) | Mean hand moves | Mean leg moves | Mean total moves | Mean time (s) | Completed (n) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| V1 | 27 | 8.3 | 7.4 | 15.8 | 22.6 | 22 |
| V2 | 26 | 7.6 | 5.7 | 13.3 | 19.1 | 16 |
| V3 | 12 | 9.3 | 8.8 | 18.1 | 31.6 | 9 |
| V4 | 20 | 9.9 | 9.6 | 19.5 | 35.0 | 13 |
| V5 | 12 | 9.5 | 7.5 | 17.0 | 35.0 | 4 |

The importer validates required columns, time format, outcomes, nonnegative counts, and consistency between limb counts and total moves. It does not import names, video links, or attempt rows into the app. The CSV and videos are **not bundled** in this project; confirm reuse terms before redistribution. The repository's `dt_pandas.py` references `grade_climbing_data.csv` and `grade_merge_demographics.csv`, which are absent from the repository, so it is not a dependency.

## Layout

- `components/SetBetaApp.tsx`, `components/PhotoEditors.tsx`: virtual and staged photo UI
- `app/api/analyze-holds/route.ts`: hold-only photo analysis
- `app/api/generate/route.ts`: route generation, photo failure reporting, virtual fallback, validation
- `lib/openai.ts`, `lib/prompt.ts`, `lib/jsonSchema.ts`: server-side AI paths
- `lib/devin.ts`: Devin session/attachment adapter with structured output and ACU cap
- `lib/sampleGenerator.ts`: structured inventory and deterministic sample routes
- `lib/validator.ts`: deterministic checks and warnings
- `scripts/import_climbdb.py`: local descriptive CSV importer
- `tests/`: validator and mocked virtual API flow tests
