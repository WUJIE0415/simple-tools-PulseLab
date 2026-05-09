import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const essentiaClient = readFileSync(new URL("../src/essentiaBpmClient.ts", import.meta.url), "utf8");

test("auto mode starts groove and Essentia candidate analysis before awaiting either result", () => {
  const analyzeJudgeMatch = app.match(/async function analyzeJudge\(audioBuffer: AudioBuffer\): Promise<AudioAnalysisResult> \{(?<body>[\s\S]*?)\n\}/);
  assert.ok(analyzeJudgeMatch?.groups?.body, "analyzeJudge function should exist");

  const body = analyzeJudgeMatch.groups.body;
  const grooveStart = body.indexOf("const grooveCandidatesPromise = collectGrooveJudgeCandidates(audioBuffer, preAnalysis);");
  const essentiaStart = body.indexOf("const ejsCandidatesPromise = analyzeJudgeBpmWithEssentia(audioBuffer, preAnalysis);");
  const firstAwait = body.indexOf("await");

  assert.notEqual(grooveStart, -1, "Auto should start Groove candidate collection as a promise");
  assert.notEqual(essentiaStart, -1, "Auto should start Essentia candidate collection as a promise");
  assert.ok(grooveStart < firstAwait, "Groove candidate collection should start before the first await");
  assert.ok(essentiaStart < firstAwait, "Essentia candidate collection should start before the first await");
  assert.match(body, /Promise\.allSettled\(\s*\[\s*grooveCandidatesPromise,\s*ejsCandidatesPromise\s*\]\s*\)/);
  assert.doesNotMatch(body, /const\s+grooveCandidates\s*=\s*await\s+collectGrooveJudgeCandidates/);
});

test("auto mode reuses one preanalysis profile for Groove and Essentia judge routes", () => {
  const analyzeJudgeMatch = app.match(/async function analyzeJudge\(audioBuffer: AudioBuffer\): Promise<AudioAnalysisResult> \{(?<body>[\s\S]*?)\n\}/);
  assert.ok(analyzeJudgeMatch?.groups?.body, "analyzeJudge function should exist");

  const body = analyzeJudgeMatch.groups.body;

  assert.match(body, /const\s+preAnalysis\s*=\s*analyzeAudioPreAnalysis\(audioBuffer\);/);
  assert.match(body, /collectGrooveJudgeCandidates\(audioBuffer,\s*preAnalysis\)/);
  assert.match(body, /analyzeJudgeBpmWithEssentia\(audioBuffer,\s*preAnalysis\)/);
  assert.match(
    essentiaClient,
    /export function analyzeJudgeBpmWithEssentia\(audioBuffer: AudioBuffer,\s*preAnalysis = analyzeAudioPreAnalysis\(audioBuffer\)\)/
  );
});
