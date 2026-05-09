import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import wav from "node-wav";
import ts from "typescript";

const sourcePath = path.resolve("src", "audioPreAnalysis.ts");
const source = await readFile(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const outputDir = path.join(tmpdir(), "bpm-web-fixture-preanalysis-tests");
const outputPath = path.join(outputDir, `audioPreAnalysis-${Date.now()}.mjs`);

await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, compiled, "utf8");

const { analyzeAudioPreAnalysis } = await import(`file://${outputPath.replaceAll("\\", "/")}`);

class TestAudioBuffer {
  constructor(decoded) {
    this.sampleRate = decoded.sampleRate;
    this.numberOfChannels = decoded.channelData.length;
    this.length = decoded.channelData[0].length;
    this.duration = this.length / this.sampleRate;
    this.channels = decoded.channelData;
  }

  getChannelData(index) {
    return this.channels[index];
  }
}

async function decodeFixture(filePath) {
  const wavPath = path.join(outputDir, `${path.basename(filePath)}-${Date.now()}.wav`);
  execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", filePath, "-ac", "2", "-ar", "44100", wavPath]);
  return new TestAudioBuffer(wav.decode(await readFile(wavPath)));
}

const fixtureCases = [
  {
    name: "piano bass 138 bpm",
    path: path.resolve("1", "audio", "(piano,bass) 138bpm @wujie.mp3")
  },
  {
    name: "piano guitar 139 bpm",
    path: path.resolve("1", "audio", "(piano,guitar) 139bpm gmaj.mp3")
  }
].filter((fixture) => existsSync(fixture.path));

for (const fixture of fixtureCases) {
  test(`keeps EJS eligible for ${fixture.name}`, async () => {
    const result = analyzeAudioPreAnalysis(await decodeFixture(fixture.path));

    assert.notEqual(result.routes.rhythm2013_multifeature.role, "disabled");
    assert.notEqual(result.routes.rhythm2013_degara.role, "disabled");
    assert.ok(result.routes.ejs_best_segment.weightMultiplier >= 1);
    assert.notEqual(result.windows[0].role, "disabled");
    assert.notEqual(result.routes.groove_bass.role, "primary");
  });
}
