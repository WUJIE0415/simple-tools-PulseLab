import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

test("metric cards use fixed internal rows for aligned labels, values, and subtitles", () => {
  assert.match(css, /--metric-label-row:\s*16px;/);
  assert.match(css, /--metric-value-row:\s*56px;/);
  assert.match(css, /--metric-sub-row:\s*32px;/);
  assert.match(css, /grid-template-rows:\s*var\(--metric-label-row\)\s+var\(--metric-value-row\)\s+var\(--metric-sub-row\);/);
  assert.match(css, /\.key-face\s*\{[^}]*grid-template-rows:\s*inherit;/s);
});

test("loudness value renders unit separately so LUFS can be smaller without changing row height", () => {
  assert.match(app, /<span className="loudness-number">/);
  assert.match(app, /<span className="loudness-unit">/);
  assert.match(css, /\.loudness-unit,\s*\.true-peak-unit\s*\{[^}]*font-size:\s*13px;/s);
});

test("true peak replaces the old time signature metric card", () => {
  assert.doesNotMatch(app, /Time Signature/);
  assert.match(app, /<span>True Peak<\/span>/);
  assert.match(app, /truePeakNumberText/);
  assert.match(app, /<span className="true-peak-number">/);
  assert.match(app, /<span className="true-peak-unit">/);
});

test("palette button is a locked half-size circle", () => {
  assert.match(css, /\.palette-button\s*\{[^}]*width:\s*30px;[^}]*aspect-ratio:\s*1\s*\/\s*1;/s);
});

test("BPM card uses the same whole-card flip affordance as the key card", () => {
  assert.match(app, /const \[bpmFlipped, setBpmFlipped\]/);
  assert.match(app, /className="bpm-card-button"/);
  assert.match(app, /onClick=\{\(\) => result && setBpmFlipped\(\(flipped\) => !flipped\)\}/);
  assert.match(app, /className="bpm-flip-icon"/);
  assert.match(css, /\.metric-bpm\[data-flipped="true"\] \.bpm-flip-card\s*\{[^}]*rotateY\(180deg\)/s);
});

test("BPM back can show compact candidate rows with optional fixed weight column", () => {
  assert.match(app, /bpmCandidateRows/);
  assert.match(app, /bpm-candidate-list/);
  assert.match(app, /bpm-candidate-weight/);
  assert.match(css, /\.bpm-candidate-list\s*\{[^}]*overflow-y:\s*auto;/s);
  assert.match(css, /\.bpm-candidate-list\s*::-webkit-scrollbar\s*\{[^}]*display:\s*none;/s);
});
