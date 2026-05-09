import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

test("listening mode connects key analysis data to the key card result", () => {
  const analyzeListeningMatch = app.match(/async function analyzeListening\(audioBuffer: AudioBuffer\): Promise<AudioAnalysisResult> \{(?<body>[\s\S]*?)\n\}/);
  assert.ok(analyzeListeningMatch?.groups?.body, "analyzeListening function should exist");

  const body = analyzeListeningMatch.groups.body;
  assert.match(body, /keyResult\s*=\s*analyzeKey\(audioBuffer\)/);
  assert.match(body, /key:\s*keyResult/);
  assert.doesNotMatch(body, /key:\s*null/);
});
