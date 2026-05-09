import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const sourcePath = path.resolve("src", "audioPreAnalysis.ts");
const source = await readFile(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const outputDir = path.join(tmpdir(), "bpm-web-preanalysis-tests");
const outputPath = path.join(outputDir, `audioPreAnalysis-${Date.now()}.mjs`);

await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, compiled, "utf8");

const { classifyAlgorithmRoutes, rankAnalysisWindows } = await import(`file://${outputPath.replaceAll("\\", "/")}`);

test("downgrades bass evidence when low band does not agree with the full mix", () => {
  const routes = classifyAlgorithmRoutes({
    sampleRate: 44100,
    onsetRegularity: 0.84,
    tempoStability: 0.8,
    bassEnergyRatio: 0.72,
    lowBandRegularity: 0.9,
    midHighRegularity: 0.77,
    crossBandAgreement: 0.18
  });

  assert.equal(routes.rhythm2013_multifeature.role, "primary");
  assert.equal(routes.groove_bass.role, "suspect");
  assert.ok(routes.groove_bass.weightMultiplier < 0.5);
});

test("can promote degara when transient regularity is clear even if it has no confidence value", () => {
  const routes = classifyAlgorithmRoutes({
    sampleRate: 44100,
    onsetRegularity: 0.91,
    tempoStability: 0.86,
    bassEnergyRatio: 0.2,
    lowBandRegularity: 0.25,
    midHighRegularity: 0.82,
    crossBandAgreement: 0.62
  });

  assert.equal(routes.rhythm2013_degara.role, "primary");
  assert.ok(routes.rhythm2013_degara.weightMultiplier > routes.percival.weightMultiplier);
});

test("prefers rhythmically stable windows over merely loud windows", () => {
  const windows = rankAnalysisWindows([
    {
      label: "loud_break",
      startSeconds: 30,
      durationSeconds: 30,
      energyScore: 1,
      onsetScore: 1,
      onsetRegularity: 0.2,
      tempoStability: 0.25,
      crossBandAgreement: 0.2
    },
    {
      label: "steady_middle",
      startSeconds: 60,
      durationSeconds: 30,
      energyScore: 0.42,
      onsetScore: 0.5,
      onsetRegularity: 0.86,
      tempoStability: 0.82,
      crossBandAgreement: 0.72
    }
  ]);

  assert.equal(windows[0].label, "steady_middle");
  assert.equal(windows[0].role, "primary");
});
