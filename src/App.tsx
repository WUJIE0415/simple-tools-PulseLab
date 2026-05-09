import { ChangeEvent, DragEvent, KeyboardEvent, type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { guess } from "web-audio-beat-detector";
import { decideJudgeBpm, type BpmConfidence, type JudgeBpmCandidate, type ListeningDecision } from "./aggregateBpm";
import { analyzeAudioPreAnalysis, type BpmPreAnalysis } from "./audioPreAnalysis";
import { analyzeBpmWithEssentia, analyzeJudgeBpmWithEssentia } from "./essentiaBpmClient";
import { analyzeLoudness, type LoudnessResult } from "./loudness";

type AnalysisState = "idle" | "dragging" | "analyzing" | "success" | "error";
type AnalysisMode = "groove" | "listening" | "judge";
type BpmRatio = 0.5 | 1 | 2;
type KeyMode = "major" | "minor";

interface KeyResult {
  tonic: number;
  label: string;
  relativeLabel: string;
  relativeMode: KeyMode;
  mode: KeyMode;
  confidence: number;
  score: number;
}

interface BpmResult {
  bpm: number;
  tempo: number;
  offset: number;
  duration: number;
  sampleRate: number;
  analyzedDuration: number;
}

interface BpmCandidateRow {
  label: string;
  bpm: number;
  weight?: number;
}

interface AudioAnalysisResult extends BpmResult {
  key: KeyResult | null;
  loudness?: LoudnessResult | null;
  bpmConfidence?: BpmConfidence;
  bpmUnstable?: boolean;
  usedFallback?: boolean;
  alternativeBpm?: ListeningDecision["alternativeBpm"] | { half?: number; double?: number; related: number[] };
  bpmCandidates?: BpmCandidateRow[];
  bpmCandidateWeightsVisible?: boolean;
}

const MAX_ANALYSIS_SECONDS = 180;
const MAX_KEY_ANALYSIS_SECONDS = 90;
const JUDGE_SEGMENT_SECONDS = 30;
const TEMPO_SETTINGS = { minTempo: 80, maxTempo: 180 };
const STORAGE_MODE_KEY = "bpm-web-analysis-mode";
const BPM_FUSION_TOLERANCE = 2;
const BASS_FOCUS_LOW_HZ = 50;
const BASS_FOCUS_HIGH_HZ = 300;
const HIGH_MID_FOCUS_LOW_HZ = 300;
const HIGH_MID_FOCUS_HIGH_HZ = 5000;
const BASS_RMS_FLOOR = 0.003;
const BASS_RMS_RATIO_FLOOR = 0.06;
const LISTENING_LINES = [
  "Analyzing transient map...",
  "Checking tempo candidates...",
  "Verifying half/double BPM...",
  "Locking groove..."
];
const ERROR_LINES = [
  "SIGNAL OVERLOAD",
  "NO STABLE PULSE DETECTED",
  "TONAL CENTER UNSTABLE",
  "RHYTHMIC GRID COLLAPSED",
  "ANALYSIS CONFIDENCE LOW"
];
const heroTitleWords = ["Read", "the", "pulse", "before", "the", "track", "starts."];
const KEY_TONICS = [
  { sharp: "C", flat: "C" },
  { sharp: "C#", flat: "Db" },
  { sharp: "D", flat: "D" },
  { sharp: "D#", flat: "Eb" },
  { sharp: "E", flat: "E" },
  { sharp: "F", flat: "F" },
  { sharp: "F#", flat: "Gb" },
  { sharp: "G", flat: "G" },
  { sharp: "G#", flat: "Ab" },
  { sharp: "A", flat: "A" },
  { sharp: "A#", flat: "Bb" },
  { sharp: "B", flat: "B" }
] as const;
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function createAudioContext() {
  const AudioContextCtor =
    window.AudioContext ||
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  if (!AudioContextCtor) {
    throw new Error("Current browser cannot decode local audio.");
  }

  return new AudioContextCtor();
}

function createOfflineAudioContext(channelCount: number, length: number, sampleRate: number) {
  const OfflineAudioContextCtor =
    window.OfflineAudioContext ||
    (window as Window & { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;

  if (!OfflineAudioContextCtor) {
    throw new Error("Current browser cannot render bass-focused audio.");
  }

  return new OfflineAudioContextCtor(channelCount, length, sampleRate);
}

async function decodeAudioFile(file: File) {
  const audioContext = createAudioContext();

  try {
    const arrayBuffer = await file.arrayBuffer();
    return await audioContext.decodeAudioData(arrayBuffer);
  } finally {
    await audioContext.close().catch(() => undefined);
  }
}

async function analyzeBpm(audioBuffer: AudioBuffer, startSeconds = 0, durationSeconds?: number): Promise<BpmResult> {
  if (audioBuffer.duration < 4) {
    throw new Error("Audio is too short for stable BPM analysis.");
  }

  const safeStart = clamp(startSeconds, 0, Math.max(0, audioBuffer.duration - 4));
  const availableDuration = audioBuffer.duration - safeStart;
  const analyzedDuration = Math.min(durationSeconds ?? availableDuration, availableDuration, MAX_ANALYSIS_SECONDS);
  const result = await guess(audioBuffer, safeStart, analyzedDuration, TEMPO_SETTINGS);

  if (!Number.isFinite(result.bpm) || result.bpm <= 0) {
    throw new Error("No stable pulse detected.");
  }

  return {
    bpm: result.bpm,
    tempo: result.tempo,
    offset: result.offset,
    duration: audioBuffer.duration,
    sampleRate: audioBuffer.sampleRate,
    analyzedDuration
  };
}

function createMonoSlice(audioBuffer: AudioBuffer, maxSeconds: number, startSeconds = 0) {
  const startFrame = Math.floor(clamp(startSeconds, 0, audioBuffer.duration) * audioBuffer.sampleRate);
  const availableFrames = Math.max(0, audioBuffer.length - startFrame);
  const frameCount = Math.min(availableFrames, Math.floor(audioBuffer.sampleRate * maxSeconds));
  const channelCount = Math.min(audioBuffer.numberOfChannels, 2);
  const mono = new Float32Array(frameCount);

  for (let channel = 0; channel < channelCount; channel += 1) {
    const data = audioBuffer.getChannelData(channel);
    for (let index = 0; index < frameCount; index += 1) {
      mono[index] += data[startFrame + index] / channelCount;
    }
  }

  return mono;
}

function calculateRms(samples: Float32Array) {
  if (!samples.length) return 0;

  let energy = 0;
  for (let index = 0; index < samples.length; index += 1) {
    energy += samples[index] * samples[index];
  }

  return Math.sqrt(energy / samples.length);
}

function getAnalysisRms(audioBuffer: AudioBuffer) {
  return calculateRms(createMonoSlice(audioBuffer, MAX_ANALYSIS_SECONDS));
}

async function createBassFocusBuffer(audioBuffer: AudioBuffer) {
  return createBandFocusBuffer(audioBuffer, BASS_FOCUS_LOW_HZ, BASS_FOCUS_HIGH_HZ);
}

async function createHighMidFocusBuffer(audioBuffer: AudioBuffer) {
  return createBandFocusBuffer(audioBuffer, HIGH_MID_FOCUS_LOW_HZ, HIGH_MID_FOCUS_HIGH_HZ);
}

async function createBandFocusBuffer(audioBuffer: AudioBuffer, lowHz: number, highHz: number) {
  const offlineContext = createOfflineAudioContext(
    audioBuffer.numberOfChannels,
    audioBuffer.length,
    audioBuffer.sampleRate
  );
  const source = offlineContext.createBufferSource();
  const highPass = offlineContext.createBiquadFilter();
  const lowPass = offlineContext.createBiquadFilter();

  source.buffer = audioBuffer;
  highPass.type = "highpass";
  highPass.frequency.value = lowHz;
  highPass.Q.value = 0.707;
  lowPass.type = "lowpass";
  lowPass.frequency.value = highHz;
  lowPass.Q.value = 0.707;

  source.connect(highPass);
  highPass.connect(lowPass);
  lowPass.connect(offlineContext.destination);
  source.start(0);

  return offlineContext.startRendering();
}

function getWindowScore(audioBuffer: AudioBuffer, startSeconds: number, durationSeconds: number, mode: "energy" | "onset") {
  const sampleRate = audioBuffer.sampleRate;
  const startFrame = Math.floor(startSeconds * sampleRate);
  const frameCount = Math.max(0, Math.min(audioBuffer.length - startFrame, Math.floor(durationSeconds * sampleRate)));
  const channelCount = Math.min(audioBuffer.numberOfChannels, 2);
  let score = 0;
  let previous = 0;

  for (let index = 0; index < frameCount; index += Math.max(1, Math.floor(sampleRate / 200))) {
    let sample = 0;
    for (let channel = 0; channel < channelCount; channel += 1) {
      sample += audioBuffer.getChannelData(channel)[startFrame + index] / channelCount;
    }

    score += mode === "energy" ? sample * sample : Math.max(0, Math.abs(sample) - Math.abs(previous));
    previous = sample;
  }

  return score;
}

function findBestJudgeWindow(audioBuffer: AudioBuffer) {
  const durationSeconds = Math.min(JUDGE_SEGMENT_SECONDS, audioBuffer.duration);
  const maxStart = Math.max(0, audioBuffer.duration - durationSeconds);
  let bestStart = 0;
  let bestScore = -Infinity;

  for (let startSeconds = 0; startSeconds <= maxStart; startSeconds += 5) {
    const score =
      getWindowScore(audioBuffer, startSeconds, durationSeconds, "energy") +
      getWindowScore(audioBuffer, startSeconds, durationSeconds, "onset");
    if (score > bestScore) {
      bestScore = score;
      bestStart = startSeconds;
    }
  }

  return {
    startSeconds: bestStart,
    durationSeconds
  };
}

function hasValidBpm(result: BpmResult | null) {
  return Boolean(result && Number.isFinite(result.bpm) && result.bpm > 0);
}

function areBpmsClose(leftBpm: number, rightBpm: number) {
  return Math.abs(leftBpm - rightBpm) <= BPM_FUSION_TOLERANCE;
}

function hasTempoRelation(fullBpm: number, bassBpm: number) {
  return [fullBpm / 4, fullBpm / 2, fullBpm * 2, fullBpm * 4].some((candidate) =>
    areBpmsClose(bassBpm, candidate)
  );
}

function isBassFocusUsable(bassResult: BpmResult | null, originalRms: number, bassRms: number) {
  if (!hasValidBpm(bassResult)) return false;
  if (bassRms < BASS_RMS_FLOOR) return false;
  if (originalRms <= 0) return false;

  return bassRms / originalRms >= BASS_RMS_RATIO_FLOOR;
}

function fuseGrooveBpm(fullResult: BpmResult | null, bassResult: BpmResult | null, originalRms: number, bassRms: number) {
  const fullIsValid = hasValidBpm(fullResult);
  const bassIsUsable = isBassFocusUsable(bassResult, originalRms, bassRms);

  if (!fullIsValid && bassIsUsable && bassResult) {
    return {
      bpmResult: bassResult,
      confidence: "medium-high" as const,
      unstable: false
    };
  }

  if (!fullResult || !fullIsValid) {
    throw new Error("No stable pulse detected.");
  }

  if (!bassIsUsable || !bassResult) {
    return {
      bpmResult: fullResult,
      confidence: "medium" as const,
      unstable: false
    };
  }

  if (areBpmsClose(fullResult.bpm, bassResult.bpm)) {
    const bpm = (fullResult.bpm + bassResult.bpm) / 2;

    return {
      bpmResult: {
        ...fullResult,
        bpm,
        tempo: bpm,
        analyzedDuration: Math.max(fullResult.analyzedDuration, bassResult.analyzedDuration)
      },
      confidence: "high" as const,
      unstable: false
    };
  }

  if (hasTempoRelation(fullResult.bpm, bassResult.bpm)) {
    return {
      bpmResult: bassResult,
      confidence: "high" as const,
      unstable: false
    };
  }

  return {
    bpmResult: fullResult,
    confidence: "low" as const,
    unstable: true
  };
}

function goertzelPower(samples: Float32Array, start: number, frameSize: number, coefficient: number) {
  let previous = 0;
  let previous2 = 0;

  for (let index = 0; index < frameSize; index += 1) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (frameSize - 1));
    const next = samples[start + index] * window + coefficient * previous - previous2;
    previous2 = previous;
    previous = next;
  }

  return previous2 * previous2 + previous * previous - coefficient * previous * previous2;
}

function correlation(chroma: number[], profile: number[], tonic: number) {
  const chromaMean = chroma.reduce((sum, value) => sum + value, 0) / chroma.length;
  const profileMean = profile.reduce((sum, value) => sum + value, 0) / profile.length;
  let numerator = 0;
  let chromaEnergy = 0;
  let profileEnergy = 0;

  for (let index = 0; index < 12; index += 1) {
    const chromaValue = chroma[index] - chromaMean;
    const profileValue = profile[(index - tonic + 12) % 12] - profileMean;
    numerator += chromaValue * profileValue;
    chromaEnergy += chromaValue * chromaValue;
    profileEnergy += profileValue * profileValue;
  }

  if (!chromaEnergy || !profileEnergy) return -Infinity;
  return numerator / Math.sqrt(chromaEnergy * profileEnergy);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isPositiveFinite(value: number) {
  return Number.isFinite(value) && value > 0;
}

function formatSourceLabel(source: JudgeBpmCandidate["source"]) {
  const labels: Record<JudgeBpmCandidate["source"], string> = {
    groove_full: "Full",
    groove_middle: "Middle",
    groove_best_segment: "Best",
    groove_bass: "Bass",
    groove_high_mid: "High-mid",
    ejs_full: "Full",
    ejs_middle: "Middle",
    ejs_best_segment: "Best"
  };

  return labels[source];
}

function formatSegmentLabel(segment: string) {
  const labels: Record<string, string> = {
    full_track: "full",
    intro_30s: "intro",
    middle_30s: "middle",
    high_energy_30s: "energy",
    onset_dense_30s: "onset",
    outro_30s: "outro"
  };

  return labels[segment] ?? segment.replaceAll("_", " ");
}

function formatModelLabel(model?: string) {
  const labels: Record<string, string> = {
    rhythm2013_multifeature: "R2013 multi",
    rhythm2013_degara: "R2013 degara",
    percival: "Percival",
    web_audio_guess: "Web audio"
  };

  return model ? labels[model] ?? model.replaceAll("_", " ") : "Web audio";
}

function getGrooveCandidateRows(fullResult: BpmResult | null, bassResult: BpmResult | null) {
  return [
    fullResult && isPositiveFinite(fullResult.bpm)
      ? { label: "Full mix", bpm: fullResult.bpm }
      : null,
    bassResult && isPositiveFinite(bassResult.bpm)
      ? { label: "Bass focus", bpm: bassResult.bpm }
      : null
  ].filter((row): row is BpmCandidateRow => Boolean(row));
}

function getListeningCandidateRows(candidates: Array<{ bpm: number; model: string; segment: string }>) {
  return candidates
    .filter((candidate) => isPositiveFinite(candidate.bpm))
    .map((candidate) => ({
      label: `${formatModelLabel(candidate.model)} ${formatSegmentLabel(candidate.segment)}`,
      bpm: candidate.bpm
    }));
}

function getJudgeCandidateRows(decision: ReturnType<typeof decideJudgeBpm>) {
  return decision.candidates.map((candidate) => ({
    label: `${formatModelLabel(candidate.model)} ${formatSourceLabel(candidate.source)}`,
    bpm: candidate.bpm,
    weight: candidate.weight
  }));
}

function formatKeyLabel(tonic: number, mode: KeyMode, spelling: "sharp" | "flat") {
  const suffix = mode === "minor" ? "min" : "maj";
  return `${KEY_TONICS[tonic][spelling]}${suffix}`;
}

function buildKeyResult(tonic: number, mode: KeyMode, confidence: number, score: number): KeyResult {
  const relativeKey = getRelativeKey(tonic, mode);

  return {
    tonic,
    label: formatKeyLabel(tonic, mode, "sharp"),
    relativeLabel: formatKeyLabel(relativeKey.tonic, relativeKey.mode, "sharp"),
    relativeMode: relativeKey.mode,
    mode,
    confidence,
    score
  };
}

function getRelativeKey(tonic: number, mode: KeyMode) {
  if (mode === "major") {
    return {
      tonic: (tonic + 9) % 12,
      mode: "minor" as const
    };
  }

  return {
    tonic: (tonic + 3) % 12,
    mode: "major" as const
  };
}

function analyzeKey(audioBuffer: AudioBuffer, startSeconds = 0, maxSeconds = MAX_KEY_ANALYSIS_SECONDS): KeyResult | null {
  if (audioBuffer.duration < 4) return null;

  const samples = createMonoSlice(audioBuffer, maxSeconds, startSeconds);
  const frameSize = 4096;
  const hopSize = 4096;
  const minMidi = 36;
  const maxMidi = 83;
  const chroma = Array.from({ length: 12 }, () => 0);
  const bins = Array.from({ length: maxMidi - minMidi + 1 }, (_, index) => {
    const midi = minMidi + index;
    const frequency = 440 * 2 ** ((midi - 69) / 12);
    return {
      pitchClass: midi % 12,
      coefficient: 2 * Math.cos((2 * Math.PI * frequency) / audioBuffer.sampleRate)
    };
  });
  let usedFrames = 0;

  for (let start = 0; start + frameSize < samples.length; start += hopSize) {
    let frameEnergy = 0;
    for (let index = 0; index < frameSize; index += 1) {
      const sample = samples[start + index];
      frameEnergy += sample * sample;
    }

    const rms = Math.sqrt(frameEnergy / frameSize);
    if (rms < 0.008) continue;

    for (const bin of bins) {
      chroma[bin.pitchClass] += goertzelPower(samples, start, frameSize, bin.coefficient);
    }
    usedFrames += 1;
  }

  const totalEnergy = chroma.reduce((sum, value) => sum + value, 0);
  if (usedFrames < 4 || totalEnergy <= 0) return null;

  const normalizedChroma = chroma.map((value) => Math.log1p(value / totalEnergy));
  const candidates = Array.from({ length: 24 }, (_, index) => {
    const tonic = index % 12;
    const mode: KeyMode = index < 12 ? "major" : "minor";
    const profile = mode === "major" ? MAJOR_PROFILE : MINOR_PROFILE;
    return {
      tonic,
      mode,
      score: correlation(normalizedChroma, profile, tonic)
    };
  }).sort((a, b) => b.score - a.score);

  const best = candidates[0];
  const runnerUp = candidates[1];
  if (!best || best.score < 0.12) return null;

  const margin = runnerUp ? best.score - runnerUp.score : 0.2;
  const confidence = Math.round(clamp(0.54 + margin * 0.75, 0.54, 0.96) * 100);

  return buildKeyResult(best.tonic, best.mode, confidence, best.score);
}

async function collectGrooveJudgeCandidate(
  source: JudgeBpmCandidate["source"],
  audioBuffer: AudioBuffer,
  startSeconds = 0,
  durationSeconds?: number,
  weightMultiplier = 1
): Promise<JudgeBpmCandidate | null> {
  try {
    const result = await analyzeBpm(audioBuffer, startSeconds, durationSeconds);
    return {
      bpm: result.bpm,
      source,
      weight: weightMultiplier
    };
  } catch {
    return null;
  }
}

async function collectGrooveJudgeCandidates(audioBuffer: AudioBuffer, preAnalysis = analyzeAudioPreAnalysis(audioBuffer)) {
  const windowSeconds = Math.min(JUDGE_SEGMENT_SECONDS, audioBuffer.duration);
  const middleStart = Math.max(0, audioBuffer.duration / 2 - windowSeconds / 2);
  const bestWindow = preAnalysis.windows[0];
  const bestSegment = bestWindow
    ? { startSeconds: bestWindow.startSeconds, durationSeconds: bestWindow.durationSeconds }
    : findBestJudgeWindow(audioBuffer);
  const candidates: JudgeBpmCandidate[] = [];
  const primaryCandidates = await Promise.all([
    collectGrooveJudgeCandidate("groove_full", audioBuffer, 0, undefined, getGrooveRouteWeight(preAnalysis, "groove_full")),
    collectGrooveJudgeCandidate(
      "groove_middle",
      audioBuffer,
      middleStart,
      windowSeconds,
      getGrooveRouteWeight(preAnalysis, "groove_middle")
    ),
    collectGrooveJudgeCandidate(
      "groove_best_segment",
      audioBuffer,
      bestSegment.startSeconds,
      bestSegment.durationSeconds,
      getGrooveRouteWeight(preAnalysis, "groove_full") * (bestWindow?.weightMultiplier ?? 1)
    )
  ]);

  candidates.push(...primaryCandidates.filter((candidate): candidate is JudgeBpmCandidate => Boolean(candidate)));

  try {
    const bassFocusBuffer = await createBassFocusBuffer(audioBuffer);
    const bassRms = getAnalysisRms(bassFocusBuffer);
    const originalRms = getAnalysisRms(audioBuffer);
    const bassEnergyRatio = originalRms > 0 ? bassRms / originalRms : 0;
    const bassWeight =
      getGrooveRouteWeight(preAnalysis, "groove_bass") * (bassEnergyRatio >= BASS_RMS_RATIO_FLOOR ? 1 : 0.2);
    const bassCandidate = await collectGrooveJudgeCandidate("groove_bass", bassFocusBuffer, 0, undefined, bassWeight);
    if (bassCandidate) candidates.push(bassCandidate);
  } catch {
    // Judge can still work with the remaining sources.
  }

  try {
    const highMidFocusBuffer = await createHighMidFocusBuffer(audioBuffer);
    const highMidCandidate = await collectGrooveJudgeCandidate(
      "groove_high_mid",
      highMidFocusBuffer,
      0,
      undefined,
      getGrooveRouteWeight(preAnalysis, "groove_high_mid")
    );
    if (highMidCandidate) candidates.push(highMidCandidate);
  } catch {
    // Judge can still work with the remaining sources.
  }

  return candidates;
}

function getGrooveRouteWeight(preAnalysis: BpmPreAnalysis, source: "groove_full" | "groove_middle" | "groove_bass" | "groove_high_mid") {
  return preAnalysis.routes[source].weightMultiplier;
}

async function analyzeGroove(audioBuffer: AudioBuffer): Promise<AudioAnalysisResult> {
  const originalRms = getAnalysisRms(audioBuffer);
  let fullResult: BpmResult | null = null;
  let fullError: unknown = null;
  let bassResult: BpmResult | null = null;
  let bassRms = 0;

  try {
    fullResult = await analyzeBpm(audioBuffer);
  } catch (error) {
    fullError = error;
  }

  try {
    const bassFocusBuffer = await createBassFocusBuffer(audioBuffer);
    bassRms = getAnalysisRms(bassFocusBuffer);
    bassResult = await analyzeBpm(bassFocusBuffer);
  } catch {
    bassResult = null;
    bassRms = 0;
  }

  const fusedResult = (() => {
    try {
      return fuseGrooveBpm(fullResult, bassResult, originalRms, bassRms);
    } catch (error) {
      if (fullError instanceof Error) throw fullError;
      throw error;
    }
  })();
  let keyResult: KeyResult | null = null;

  try {
    keyResult = analyzeKey(audioBuffer);
  } catch {
    keyResult = null;
  }

  return {
    ...fusedResult.bpmResult,
    key: keyResult,
    bpmConfidence: fusedResult.confidence,
    bpmUnstable: fusedResult.unstable,
    bpmCandidates: getGrooveCandidateRows(fullResult, bassResult)
  };
}

async function analyzeJudge(audioBuffer: AudioBuffer): Promise<AudioAnalysisResult> {
  const preAnalysis = analyzeAudioPreAnalysis(audioBuffer);
  const grooveCandidatesPromise = collectGrooveJudgeCandidates(audioBuffer, preAnalysis);
  const ejsCandidatesPromise = analyzeJudgeBpmWithEssentia(audioBuffer, preAnalysis);
  const [grooveResult, ejsResult] = await Promise.allSettled([grooveCandidatesPromise, ejsCandidatesPromise]);
  const grooveCandidates = grooveResult.status === "fulfilled" ? grooveResult.value : [];
  let ejsCandidates: JudgeBpmCandidate[] = [];
  let ejsFailed = false;
  let ejsAnalyzedDuration = 0;

  if (grooveResult.status === "rejected") {
    console.error("Groove Judge BPM failed. Continuing with Essentia candidates.", grooveResult.reason);
  }

  if (ejsResult.status === "fulfilled") {
    ejsCandidates = ejsResult.value.candidates;
    ejsAnalyzedDuration = ejsResult.value.analyzedDuration;
  } else {
    console.error("Essentia Judge BPM failed. Continuing with Groove candidates.", ejsResult.reason);
    ejsFailed = true;
  }

  const decision = decideJudgeBpm([...grooveCandidates, ...ejsCandidates]);

  if (!decision.finalBpm) {
    throw new Error(ejsFailed ? "Auto BPM could not find a stable pulse from Groove candidates." : "Auto BPM returned no valid candidates.");
  }

  let keyResult: KeyResult | null = null;
  try {
    keyResult = analyzeKey(audioBuffer);
  } catch {
    keyResult = null;
  }

  return {
    bpm: decision.finalBpm,
    tempo: decision.finalBpm,
    offset: 0,
    duration: audioBuffer.duration,
    sampleRate: audioBuffer.sampleRate,
    analyzedDuration: Math.max(Math.min(audioBuffer.duration, MAX_ANALYSIS_SECONDS), ejsAnalyzedDuration),
    key: keyResult,
    bpmConfidence: ejsFailed && decision.confidence === "high" ? "low" : decision.confidence,
    usedFallback: ejsFailed,
    alternativeBpm: decision.alternativeBpm,
    bpmCandidates: getJudgeCandidateRows(decision),
    bpmCandidateWeightsVisible: false
  };
}

async function analyzeListening(audioBuffer: AudioBuffer): Promise<AudioAnalysisResult> {
  const bpmResult = await analyzeBpmWithEssentia(audioBuffer);
  let keyResult: KeyResult | null = null;

  try {
    keyResult = analyzeKey(audioBuffer);
  } catch {
    keyResult = null;
  }

  return {
    bpm: bpmResult.finalBpm,
    tempo: bpmResult.finalBpm,
    offset: 0,
    duration: audioBuffer.duration,
    sampleRate: audioBuffer.sampleRate,
    analyzedDuration: bpmResult.analyzedDuration,
    key: keyResult,
    bpmConfidence: bpmResult.confidence,
    alternativeBpm: bpmResult.alternativeBpm,
    bpmCandidates: getListeningCandidateRows(bpmResult.candidates)
  };
}

async function analyzeAudio(file: File, mode: AnalysisMode): Promise<AudioAnalysisResult> {
  const audioBuffer = await decodeAudioFile(file);
  const loudnessPromise = analyzeLoudness(audioBuffer).catch((error) => {
    console.error("Loudness analysis failed. Continuing with BPM result.", error);
    return null;
  });
  let analysisResult: AudioAnalysisResult;

  if (mode === "groove") {
    analysisResult = await analyzeGroove(audioBuffer);
  } else if (mode === "judge") {
    analysisResult = await analyzeJudge(audioBuffer);
  } else {
    try {
      analysisResult = await analyzeListening(audioBuffer);
    } catch (error) {
      console.error("Essentia Listening BPM failed. Falling back to Groove Mode analysis.", error);
      const grooveResult = await analyzeGroove(audioBuffer);
      analysisResult = { ...grooveResult, usedFallback: true };
    }
  }

  return {
    ...analysisResult,
    loudness: await loudnessPromise
  };
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainingSeconds}`;
}

function formatFileSize(size: number) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function getRandomErrorLine() {
  return ERROR_LINES[Math.floor(Math.random() * ERROR_LINES.length)];
}

function getRandomListeningLine() {
  return LISTENING_LINES[Math.floor(Math.random() * LISTENING_LINES.length)];
}

function getStoredAnalysisMode(): AnalysisMode {
  const storedMode = localStorage.getItem(STORAGE_MODE_KEY);
  if (storedMode === "judge") return "judge";
  if (storedMode === "listening" || storedMode === "thinking") return "listening";
  return "groove";
}

function getDisplayBpm(result: AudioAnalysisResult, ratio: BpmRatio) {
  if (ratio === 0.5) return result.alternativeBpm?.half ?? result.bpm / 2;
  if (ratio === 2) return result.alternativeBpm?.double ?? result.bpm * 2;
  return result.bpm;
}

function formatAudioLevel(value: number, unit: "LUFS" | "dBTP") {
  if (value === Number.NEGATIVE_INFINITY) return `-inf ${unit}`;
  if (!Number.isFinite(value)) return null;
  return `${value.toFixed(1)} ${unit}`;
}

export default function App() {
  const [state, setState] = useState<AnalysisState>("idle");
  const [analysisMode, setAnalysisModeState] = useState<AnalysisMode>(getStoredAnalysisMode);
  const [fileName, setFileName] = useState("");
  const [fileInfo, setFileInfo] = useState("");
  const [result, setResult] = useState<AudioAnalysisResult | null>(null);
  const [hoverRatio, setHoverRatio] = useState<BpmRatio>(1);
  const [bpmFlipped, setBpmFlipped] = useState(false);
  const [keyFlipped, setKeyFlipped] = useState(false);
  const [listeningLine, setListeningLine] = useState(LISTENING_LINES[0]);
  const [analysisNotice, setAnalysisNotice] = useState("");
  const [errorLine, setErrorLine] = useState(ERROR_LINES[0]);
  const [errorDetail, setErrorDetail] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [accentColor, setAccentColor] = useState(() => localStorage.getItem("bpm-web-accent") || "#616161");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const displayedBpm = result ? getDisplayBpm(result, hoverRatio) : null;
  const displayedBpmText = displayedBpm ? displayedBpm.toFixed(1) : "--";
  const beatInterval = displayedBpm ? `${(60 / displayedBpm).toFixed(3)}s` : "517ms";
  const relativeKeyLabel = result?.key?.relativeLabel ?? null;
  const bpmCandidateRows = result?.bpmCandidates ?? [];
  const showBpmCandidateWeights =
    Boolean(result?.bpmCandidateWeightsVisible) && bpmCandidateRows.some((row) => row.weight !== undefined);
  const loudnessValueText = result?.loudness
    ? formatAudioLevel(result.loudness.integratedLufs, "LUFS") ?? "--"
    : "--";
  const [loudnessNumberText, loudnessUnitText] = loudnessValueText.includes(" ")
    ? loudnessValueText.split(" ")
    : [loudnessValueText, ""];
  const truePeakText = result?.loudness
    ? formatAudioLevel(result.loudness.truePeakDbtp, "dBTP")
    : null;
  const truePeakValueText = truePeakText ?? "--";
  const [truePeakNumberText, truePeakUnitText] = truePeakValueText.includes(" ")
    ? truePeakValueText.split(" ")
    : [truePeakValueText, ""];
  const truePeakSubText = truePeakText
    ? "Peak ceiling"
    : state === "analyzing"
      ? "Measuring peak"
      : result
        ? "Peak unavailable"
        : "Peak pending";
  const loudnessSubText = result?.loudness
    ? "Integrated average"
    : state === "analyzing"
      ? "Measuring LUFS"
      : result
        ? "Loudness unavailable"
        : "Average pending";

  const statusText = useMemo(() => {
    if (state === "dragging") return "Dragging";
    if (state === "analyzing") {
      if (analysisMode === "listening") return "Listening";
      if (analysisMode === "judge") return "Judging";
      return "Grooving";
    }
    if (state === "success") return "Complete";
    if (state === "error") return "Error";
    return "Idle";
  }, [analysisMode, state]);

  useEffect(() => {
    if (state !== "analyzing" || analysisMode !== "listening") return undefined;

    setListeningLine(getRandomListeningLine());
    const intervalId = window.setInterval(() => {
      setListeningLine(getRandomListeningLine());
    }, 950);

    return () => window.clearInterval(intervalId);
  }, [analysisMode, state]);

  useEffect(() => {
    if (bpmFlipped) setHoverRatio(1);
  }, [bpmFlipped]);

  function setAnalysisMode(mode: AnalysisMode) {
    setAnalysisModeState(mode);
    localStorage.setItem(STORAGE_MODE_KEY, mode);
    setBpmFlipped(false);
    setKeyFlipped(false);
    setHoverRatio(1);
  }

  function toggleAnalysisMode() {
    setAnalysisMode(analysisMode === "groove" ? "listening" : "groove");
  }

  async function handleFile(file?: File) {
    if (!file) return;

    if (!file.type.startsWith("audio/")) {
      setState("error");
      setFileName(file.name);
      setFileInfo(formatFileSize(file.size));
      setResult(null);
      setHoverRatio(1);
      setBpmFlipped(false);
      setKeyFlipped(false);
      setAnalysisNotice("");
      setErrorLine(getRandomErrorLine());
      setErrorDetail("Unsupported audio file.");
      return;
    }

    setState("analyzing");
    setFileName(file.name);
    setFileInfo(formatFileSize(file.size));
    setResult(null);
    setHoverRatio(1);
    setBpmFlipped(false);
    setKeyFlipped(false);
    setListeningLine(getRandomListeningLine());
    setAnalysisNotice("");
    setErrorDetail("");

    try {
      const modeForRun = analysisMode;
      const audioResult = await analyzeAudio(file, modeForRun);
      setResult(audioResult);
      setAnalysisNotice(audioResult.usedFallback ? "Essentia BPM failed. Groove candidates retained." : "");
      setFileInfo(
        `${formatFileSize(file.size)} · ${formatDuration(audioResult.duration)} · ${Math.round(
          audioResult.sampleRate / 1000
        )} kHz`
      );
      setState("success");
    } catch (analysisError) {
      setResult(null);
      setErrorLine(getRandomErrorLine());
      setErrorDetail(analysisError instanceof Error ? analysisError.message : "BPM analysis failed.");
      setState("error");
    }
  }

  function setLightColor(color: string) {
    setAccentColor(color);
    localStorage.setItem("bpm-web-accent", color);
  }

  useEffect(() => {
    if (!paletteOpen) return undefined;
    function handleClick(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest(".palette-popover") && !target.closest(".palette-button")) {
        setPaletteOpen(false);
      }
    }
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [paletteOpen]);

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    void handleFile(event.target.files?.[0]);
    event.target.value = "";
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepth.current += 1;
    if (state !== "analyzing") setState("dragging");
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0 && state === "dragging") {
      setState(result ? "success" : "idle");
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepth.current = 0;
    void handleFile(event.dataTransfer.files?.[0]);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInputRef.current?.click();
    }
  }

  const dropTitle =
    state === "dragging"
      ? "Release to scan transient grid"
      : state === "analyzing"
        ? analysisMode === "listening"
          ? "listening / multi-sampling"
          : analysisMode === "judge"
            ? "auto / source judging"
            : "groove / bass fusion"
        : state === "error"
          ? ""
          : fileName || "Drop audio or click to browse";

  const dropMeta =
    state === "dragging"
      ? "File hover active"
      : state === "analyzing"
        ? analysisMode === "listening"
          ? listeningLine
          : analysisMode === "judge"
            ? "Collecting groove and EJS candidates."
            : "Fusing full mix and bass focus."
        : state === "success" && result
          ? analysisNotice || `${fileInfo} · analyzed ${formatDuration(result.analyzedDuration)}`
          : state === "error"
            ? errorDetail
            : "WAV, MP3, AIFF, FLAC. Local-only audio analysis.";

  return (
    <div
      className={`page body-state-${state}`}
      style={
        {
          "--beat": beatInterval,
          "--light-core": accentColor
        } as CSSProperties
      }
    >
      <div className="ambient" aria-hidden="true" />
      <div className="grid-noise" aria-hidden="true" />
      <button
        className="palette-button"
        type="button"
        aria-label="Color control"
        aria-expanded={paletteOpen}
        onClick={() => setPaletteOpen((open) => !open)}
      />
      <div className="palette-popover" data-open={paletteOpen} aria-label="Light color palette">
        {["#616161", "#7040ff", "#1a60d8", "#e0601a"].map((color) => (
          <button
            className="palette-swatch"
            key={color}
            type="button"
            aria-label={`Set light color ${color}`}
            data-active={accentColor.toLowerCase() === color}
            style={{ background: color }}
            onClick={() => setLightColor(color)}
          />
        ))}
        <input
          className="palette-picker"
          type="color"
          aria-label="Custom light color"
          value={accentColor}
          onChange={(event) => setLightColor(event.target.value)}
        />
      </div>
      <input
        ref={fileInputRef}
        className="file-input"
        type="file"
        accept="audio/*"
        onChange={handleInputChange}
      />

      <main className="app" aria-label="PulseLab local analyzer">
        <header className="topbar">
          <div className="brand" aria-label="PulseLab">
            <button
              className="mark mark-button"
              type="button"
              aria-label={`Switch analysis mode. Current mode is ${analysisMode}`}
              disabled={state === "analyzing"}
              onClick={toggleAnalysisMode}
            >
              PL
            </button>
            <span>
              <span className="wordmark">PulseLab</span>
              <span className="tagline">simple tools nothing more</span>
            </span>
          </div>
          <div className="topbar-actions">
            <div className="mode-switch" aria-label="Analysis mode">
              {(["groove", "listening"] as const).map((mode) => (
                <button
                  className="mode-button"
                  key={mode}
                  type="button"
                  disabled={state === "analyzing"}
                  data-active={analysisMode === mode}
                  onClick={() => setAnalysisMode(mode)}
                >
                  {mode === "groove" ? "Groove" : "Listening"}
                </button>
              ))}
            </div>
            <button
              className="mode-button auto-mode-button"
              type="button"
              disabled={state === "analyzing"}
              data-active={analysisMode === "judge"}
              onClick={() => setAnalysisMode("judge")}
            >
              Auto
            </button>
            <div className="status" aria-live="polite">
              <i />
              <span>{statusText}</span>
            </div>
          </div>
        </header>

        <section className="stage">
          <div className="copy">
            <span className="eyebrow">Audio analyzer</span>
            <h1 className="hero-title" aria-label="Read the pulse before the track starts.">
              {heroTitleWords.map((word, index) => (
                <span key={`${word}-${index}`}>
                  <span
                    className="hero-word"
                    aria-hidden="true"
                    style={{ "--word-index": index } as CSSProperties}
                  >
                    {word}
                  </span>
                  {index < heroTitleWords.length - 1 ? " " : null}
                </span>
              ))}
            </h1>
            <p className="deck">
              PulseLab is a local front-end tool for rhythm, key, true peak, and loudness inspection.
            </p>
          </div>

          <div
            className="analyzer"
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <div
              className="drop-core"
              role="button"
              tabIndex={0}
              aria-label="Drop audio file or click to analyze"
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={handleKeyDown}
            >
              <div className="drop-content">
                <div className="drop-title">{dropTitle}</div>
                <div className="drop-meta">{dropMeta}</div>
                {state === "analyzing" ? (
                  <div className="scanline" aria-hidden="true">
                    <span />
                  </div>
                ) : null}
                {state === "error" ? <div className="terminal">{errorLine}</div> : null}
              </div>
            </div>

            <div className="metrics">
              <article className="metric metric-bpm" data-ready={Boolean(result)} data-flipped={bpmFlipped}>
                <div
                  className="bpm-card-button"
                  role="button"
                  tabIndex={result ? 0 : -1}
                  aria-label={result ? "Flip BPM card" : "BPM result"}
                  aria-pressed={bpmFlipped}
                  onClick={() => result && setBpmFlipped((flipped) => !flipped)}
                  onKeyDown={(event) => {
                    if (!result) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setBpmFlipped((flipped) => !flipped);
                    }
                  }}
                >
                  <span className="bpm-flip-card">
                    <span className="bpm-face bpm-face-front">
                      <span className="metric-label">
                        <span>BPM</span>
                        {result ? <i className="beat-dot" aria-hidden="true" /> : null}
                      </span>
                      <span className="bpm-control">
                        <span className="bpm-side-zone bpm-side-zone-left" aria-hidden={!result || bpmFlipped}>
                          <button
                            className="bpm-bubble-button"
                            type="button"
                            aria-label="Preview half tempo"
                            disabled={!result || bpmFlipped}
                            data-active={hoverRatio === 0.5}
                            onClick={(event) => event.stopPropagation()}
                            onMouseEnter={() => !bpmFlipped && setHoverRatio(0.5)}
                            onMouseLeave={() => setHoverRatio(1)}
                            onFocus={() => !bpmFlipped && setHoverRatio(0.5)}
                            onBlur={() => setHoverRatio(1)}
                          >
                            <span className="bpm-bubble">1/2</span>
                          </button>
                        </span>
                        <span className="metric-value bpm-value" key={displayedBpmText}>
                          {displayedBpmText}
                        </span>
                        <span className="bpm-side-zone bpm-side-zone-right" aria-hidden={!result || bpmFlipped}>
                          <button
                            className="bpm-bubble-button"
                            type="button"
                            aria-label="Preview double tempo"
                            disabled={!result || bpmFlipped}
                            data-active={hoverRatio === 2}
                            onClick={(event) => event.stopPropagation()}
                            onMouseEnter={() => !bpmFlipped && setHoverRatio(2)}
                            onMouseLeave={() => setHoverRatio(1)}
                            onFocus={() => !bpmFlipped && setHoverRatio(2)}
                            onBlur={() => setHoverRatio(1)}
                          >
                            <span className="bpm-bubble">x2</span>
                          </button>
                        </span>
                      </span>
                      <span className="metric-sub">
                        {result
                          ? result.bpmUnstable && hoverRatio === 1
                            ? "Result may be unstable"
                            : result.bpmConfidence && hoverRatio === 1
                            ? `confidence: ${result.bpmConfidence}`
                            : hoverRatio === 1
                            ? `Detected ${result.tempo.toFixed(2)} BPM`
                            : `Adjusted from ${result.bpm.toFixed(1)} BPM`
                          : state === "analyzing"
                            ? "Pulse scan"
                            : "Awaiting pulse"}
                      </span>
                    </span>
                    <span className="bpm-face bpm-face-back">
                      <span className="bpm-candidate-head" data-has-weight={showBpmCandidateWeights}>
                        <span>Algorithm</span>
                        <span>BPM</span>
                        {showBpmCandidateWeights ? <span>Weight</span> : null}
                      </span>
                      <span className="bpm-candidate-list" data-has-weight={showBpmCandidateWeights}>
                        {bpmCandidateRows.length ? (
                          bpmCandidateRows.map((row, index) => (
                            <span className="bpm-candidate-row" key={`${row.label}-${row.bpm}-${index}`}>
                              <span className="bpm-candidate-name">{row.label}</span>
                              <span className="bpm-candidate-bpm">{row.bpm.toFixed(1)}</span>
                              {showBpmCandidateWeights ? (
                                <span className="bpm-candidate-weight">
                                  {row.weight !== undefined ? `+${row.weight.toFixed(2)}` : ""}
                                </span>
                              ) : null}
                            </span>
                          ))
                        ) : (
                          <span className="bpm-candidate-empty">No candidate output</span>
                        )}
                      </span>
                      <span className="metric-sub">
                        {bpmCandidateRows.length ? `${bpmCandidateRows.length} valid outputs` : "Candidate set pending"}
                      </span>
                    </span>
                  </span>
                  {result ? (
                    <span className="bpm-flip-icon" aria-hidden="true">
                      <svg viewBox="0 0 16 16">
                        <path d="M2 5h9a3 3 0 0 1 0 6H4" />
                        <path d="M4 3 2 5l2 2" />
                      </svg>
                    </span>
                  ) : null}
                </div>
              </article>
              <article
                className="metric metric-key"
                data-ready={Boolean(result?.key)}
                data-flipped={keyFlipped}
                data-warn={!result?.key}
              >
                <button
                  className="key-card-button"
                  type="button"
                  disabled={!relativeKeyLabel}
                  aria-label={relativeKeyLabel ? `Flip key card to show relative key ${relativeKeyLabel}` : "Key result"}
                  onClick={() => relativeKeyLabel && setKeyFlipped((flipped) => !flipped)}
                >
                  <span className="key-flip-card">
                    <span className="key-face key-face-front">
                      <span className="metric-label">
                        <span>Key</span>
                      </span>
                      <span className="metric-value">{result?.key?.label ?? "--"}</span>
                      <span className="metric-sub">
                        {result?.key
                          ? `${result.key.mode} · ${result.key.confidence}% confidence`
                          : state === "analyzing"
                            ? "Tonal scan"
                            : "Tonal center pending"}
                      </span>
                      {relativeKeyLabel ? (
                        <span className="key-flip-icon" aria-hidden="true">
                          <svg viewBox="0 0 16 16">
                            <path d="M2 5h9a3 3 0 0 1 0 6H4" />
                            <path d="M4 3 2 5l2 2" />
                          </svg>
                        </span>
                      ) : null}
                    </span>
                    <span className="key-face key-face-back">
                      <span className="metric-label">
                        <span>Relative</span>
                      </span>
                      <span className="metric-value">{relativeKeyLabel ?? "--"}</span>
                      <span className="metric-sub">
                        {result?.key
                          ? `${result.key.label} to ${result.key.relativeMode}`
                          : "Relative major / minor"}
                      </span>
                    </span>
                  </span>
                </button>
              </article>
              <article className="metric metric-true-peak">
                <div className="metric-label">
                  <span>True Peak</span>
                </div>
                <div className="metric-value true-peak-value">
                  {truePeakUnitText ? (
                    <>
                      <span className="true-peak-number">{truePeakNumberText}</span>
                      <span className="true-peak-unit">{truePeakUnitText}</span>
                    </>
                  ) : (
                    truePeakNumberText
                  )}
                </div>
                <div className="metric-sub">{truePeakSubText}</div>
              </article>
              <article className="metric metric-loudness" data-warn="true">
                <div className="metric-label">
                  <span>Loudness</span>
                </div>
                <div className="metric-value loudness-value">
                  {loudnessUnitText ? (
                    <>
                      <span className="loudness-number">{loudnessNumberText}</span>
                      <span className="loudness-unit">{loudnessUnitText}</span>
                    </>
                  ) : (
                    loudnessNumberText
                  )}
                </div>
                <div className="metric-sub">{loudnessSubText}</div>
              </article>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
