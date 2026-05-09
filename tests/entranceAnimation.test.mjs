import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

test("hero title is split into animated words while preserving the original copy", () => {
  assert.match(app, /const heroTitleWords = \["Read", "the", "pulse", "before", "the", "track", "starts\."\];/);
  assert.match(app, /className="hero-title"/);
  assert.match(app, /className="hero-word"/);
  assert.match(app, /style=\{\{\s*"--word-index":\s*index\s*\} as CSSProperties\}/s);
});

test("entrance animation only layers temporary transforms over the existing final layout", () => {
  assert.match(css, /\.topbar\s*\{[^}]*justify-content:\s*space-between;/s);
  assert.match(css, /\.stage\s*\{[^}]*align-content:\s*center;[^}]*justify-items:\s*center;/s);
  assert.match(css, /\.copy\s*\{[^}]*text-align:\s*center;/s);
  assert.match(css, /\.hero-title\s*\{[^}]*animation:\s*titleFocusIn/s);
  assert.match(css, /\.topbar\s*\{[^}]*animation:\s*topbarCinematicIn/s);
  assert.match(css, /\.analyzer\s*\{[^}]*animation:\s*analyzerCinematicIn/s);
  assert.match(css, /@keyframes titleFocusIn\s*\{[\s\S]*100%\s*\{[^}]*transform:\s*translateY\(0\)\s+scale\(1\);/);
});
