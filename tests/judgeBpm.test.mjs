import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const sourcePath = path.resolve("src", "aggregateBpm.ts");
const source = await readFile(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const outputDir = path.join(tmpdir(), "bpm-web-judge-tests");
const outputPath = path.join(outputDir, `aggregateBpm-${Date.now()}.mjs`);

await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, compiled, "utf8");

const { decideJudgeBpm, decideListeningBpm } = await import(`file://${outputPath.replaceAll("\\", "/")}`);

test("filters invalid BPM candidates", () => {
  const result = decideJudgeBpm([
    { bpm: Number.NaN, source: "groove_full" },
    { bpm: Infinity, source: "ejs_full" },
    { bpm: 0, source: "groove_middle" },
    { bpm: 49.9, source: "ejs_middle" },
    { bpm: 221, source: "groove_best_segment" },
    { bpm: 124, source: "groove_full" },
    { bpm: 124.3, source: "ejs_full" },
    { bpm: 124.1, source: "ejs_middle" }
  ]);

  assert.equal(result.validCount, 3);
  assert.equal(result.confidence, "high");
});

test("normalizes half and double candidates before averaging", () => {
  const result = decideJudgeBpm([
    { bpm: 90, source: "groove_full" },
    { bpm: 180.2, source: "ejs_full" },
    { bpm: 89.8, source: "groove_middle" },
    { bpm: 180.1, source: "ejs_best_segment" }
  ]);

  assert.ok(result.finalBpm > 89 && result.finalBpm < 91);
  assert.ok(result.clusters[0].normalizedBpms.every((bpm) => bpm > 89 && bpm < 91));
});

test("caps same-source vote pressure inside a cluster", () => {
  const repeatedSource = Array.from({ length: 6 }, (_, index) => ({
    bpm: 128 + index * 0.05,
    source: "groove_full"
  }));
  const result = decideJudgeBpm([
    ...repeatedSource,
    { bpm: 128.2, source: "ejs_full" },
    { bpm: 128.1, source: "ejs_middle" }
  ]);

  assert.equal(result.clusters[0].sources.includes("groove_full"), true);
  assert.ok(result.clusters[0].score < 12);
});

test("marks close leading clusters as ambiguous", () => {
  const result = decideJudgeBpm([
    { bpm: 100, source: "groove_full" },
    { bpm: 100.2, source: "ejs_full" },
    { bpm: 100.1, source: "groove_middle" },
    { bpm: 150, source: "groove_best_segment" },
    { bpm: 150.2, source: "ejs_middle" },
    { bpm: 150.1, source: "ejs_best_segment" }
  ]);

  assert.equal(result.confidence, "ambiguous");
});

test("marks low confidence when candidates or sources are too thin", () => {
  const tooFew = decideJudgeBpm([
    { bpm: 118, source: "groove_full" },
    { bpm: 118.1, source: "ejs_full" }
  ]);
  const oneSource = decideJudgeBpm([
    { bpm: 118, source: "groove_full" },
    { bpm: 118.1, source: "groove_full" },
    { bpm: 118.2, source: "groove_full" }
  ]);

  assert.equal(tooFew.confidence, "low");
  assert.equal(oneSource.confidence, "low");
});

test("exposes every valid auto candidate with raw BPM, model name, and source weight", () => {
  const result = decideJudgeBpm([
    { bpm: 128.234, source: "ejs_full", model: "rhythm2013_multifeature" },
    { bpm: 0, source: "ejs_full", model: "rhythm2013_degara" },
    { bpm: Number.NaN, source: "ejs_middle", model: "percival" },
    { bpm: 127.8, source: "ejs_best_segment", model: "percival" },
    { bpm: 128.1, source: "groove_best_segment", model: "web_audio_guess" }
  ]);

  assert.deepEqual(
    result.candidates.map(({ bpm, source, model, weight }) => ({ bpm, source, model, weight })),
    [
      { bpm: 128.23, source: "ejs_full", model: "rhythm2013_multifeature", weight: 1 },
      { bpm: 127.8, source: "ejs_best_segment", model: "percival", weight: 1.25 },
      { bpm: 128.1, source: "groove_best_segment", model: "web_audio_guess", weight: 1.2 }
    ]
  );
});

test("exposes every valid listening candidate with raw BPM and effective weight", () => {
  const result = decideListeningBpm([
    { bpm: 128.234, model: "rhythm2013_multifeature", segment: "full_track" },
    { bpm: 260, model: "percival", segment: "middle_30s" },
    { bpm: 0, model: "rhythm2013_degara", segment: "middle_30s" },
    { bpm: 64.1, model: "percival", segment: "onset_dense_30s", weight: 0.6 }
  ]);

  assert.deepEqual(
    result.candidates.map(({ bpm, model, segment, weight }) => ({ bpm, model, segment, weight })),
    [
      { bpm: 128.23, model: "rhythm2013_multifeature", segment: "full_track", weight: 1.2 },
      { bpm: 260, model: "percival", segment: "middle_30s", weight: 0.45 },
      { bpm: 64.1, model: "percival", segment: "onset_dense_30s", weight: 0.6 }
    ]
  );
});

test("uses dynamic judge weights to demote misleading sources", () => {
  const result = decideJudgeBpm([
    { bpm: 173, source: "groove_bass", weight: 0.05 },
    { bpm: 173.2, source: "groove_high_mid", weight: 0.1 },
    { bpm: 173.1, source: "groove_best_segment", weight: 0.1 },
    { bpm: 130, source: "ejs_best_segment", model: "rhythm2013_degara", weight: 3.5 }
  ]);

  assert.ok(result.finalBpm > 129 && result.finalBpm < 131);
  assert.equal(result.clusters[0].canonicalBpm, 130);
});
