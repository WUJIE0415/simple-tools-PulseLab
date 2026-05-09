import type { JudgeBpmCandidate, JudgeBpmSource, ListeningCandidate, ListeningDecision } from "./aggregateBpm";
import { analyzeAudioPreAnalysis, type BpmPreAnalysis, type RankedAnalysisWindow } from "./audioPreAnalysis";

interface WorkerSegment {
  label: string;
  samples: Float32Array;
  weightMultiplier?: number;
}

interface PendingRequest {
  resolve: (result: EssentiaBpmResult) => void;
  reject: (error: Error) => void;
}

export interface EssentiaBpmResult {
  bpm: number;
  finalBpm: number;
  confidence: ListeningDecision["confidence"];
  alternativeBpm: ListeningDecision["alternativeBpm"];
  validCount: number;
  analyzedDuration: number;
  candidates: ListeningCandidate[];
}

export interface EssentiaJudgeBpmResult {
  analyzedDuration: number;
  candidates: JudgeBpmCandidate[];
}

const MIN_SEGMENT_SECONDS = 4;
const TARGET_SEGMENT_SECONDS = 30;
const MAX_EJS_FULL_SECONDS = 180;
const WINDOW_SCAN_STEP_SECONDS = 5;

let requestId = 0;
let worker: Worker | null = null;
const pendingRequests = new Map<number, PendingRequest>();

function getWorker() {
  if (worker) return worker;

  worker = new Worker(new URL("./essentia-worker.js", import.meta.url), { type: "module" });

  worker.onmessage = (event: MessageEvent) => {
    const { id, type, payload, error } = event.data || {};
    const pending = pendingRequests.get(id);
    if (!pending) return;

    pendingRequests.delete(id);

    if (type === "bpm-result") {
      pending.resolve(payload);
    } else {
      pending.reject(new Error(error?.message || "Essentia BPM worker failed."));
    }
  };

  worker.onerror = (event) => {
    const error = new Error(event.message || "Essentia worker runtime error.");
    for (const pending of pendingRequests.values()) {
      pending.reject(error);
    }
    pendingRequests.clear();
    worker?.terminate();
    worker = null;
  };

  return worker;
}

function createMonoSegment(audioBuffer: AudioBuffer, startSeconds: number, durationSeconds: number): WorkerSegment {
  const sampleRate = audioBuffer.sampleRate;
  const startFrame = Math.floor(startSeconds * sampleRate);
  const frameCount = Math.max(0, Math.min(audioBuffer.length - startFrame, Math.floor(durationSeconds * sampleRate)));
  const channelCount = Math.min(audioBuffer.numberOfChannels, 2);

  if (channelCount === 1) {
    const channelData = audioBuffer.getChannelData(0);
    return {
      label: "",
      samples: channelData.slice(startFrame, startFrame + frameCount)
    };
  }

  const mono = new Float32Array(frameCount);
  const left = audioBuffer.getChannelData(0);
  const right = audioBuffer.getChannelData(1);

  for (let index = 0; index < frameCount; index += 1) {
    mono[index] = (left[startFrame + index] + right[startFrame + index]) / 2;
  }

  return {
    label: "",
    samples: mono
  };
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

function findBestWindow(audioBuffer: AudioBuffer, mode: "energy" | "onset") {
  const durationSeconds = Math.min(TARGET_SEGMENT_SECONDS, audioBuffer.duration);
  const maxStart = Math.max(0, audioBuffer.duration - durationSeconds);
  let bestStart = 0;
  let bestScore = -Infinity;

  for (let startSeconds = 0; startSeconds <= maxStart; startSeconds += WINDOW_SCAN_STEP_SECONDS) {
    const score = getWindowScore(audioBuffer, startSeconds, durationSeconds, mode);
    if (score > bestScore) {
      bestScore = score;
      bestStart = startSeconds;
    }
  }

  return {
    startSeconds: bestStart,
    durationSeconds,
    score: bestScore
  };
}

function createSegmentFromWindow(audioBuffer: AudioBuffer, window: RankedAnalysisWindow, label = window.label) {
  return {
    ...createMonoSegment(audioBuffer, window.startSeconds, window.durationSeconds),
    label,
    durationSeconds: window.durationSeconds,
    weightMultiplier: window.weightMultiplier
  };
}

function createListeningSegments(audioBuffer: AudioBuffer, preAnalysis: BpmPreAnalysis) {
  const plannedWindows = preAnalysis.windows.filter((window) => window.role !== "disabled").slice(0, 5);

  if (plannedWindows.length > 0) {
    return plannedWindows
      .map((window) => createSegmentFromWindow(audioBuffer, window))
      .filter((segment) => segment.durationSeconds >= MIN_SEGMENT_SECONDS);
  }

  const windowSeconds = Math.min(TARGET_SEGMENT_SECONDS, audioBuffer.duration);
  const middleStart = Math.max(0, audioBuffer.duration / 2 - windowSeconds / 2);
  const highEnergy = findBestWindow(audioBuffer, "energy");
  const onsetDense = findBestWindow(audioBuffer, "onset");
  const windows = [
    { label: "intro_30s", startSeconds: 0, durationSeconds: windowSeconds },
    { label: "middle_30s", startSeconds: middleStart, durationSeconds: windowSeconds },
    { label: "high_energy_30s", ...highEnergy },
    { label: "onset_dense_30s", ...onsetDense },
    { label: "outro_30s", startSeconds: Math.max(0, audioBuffer.duration - windowSeconds), durationSeconds: windowSeconds }
  ];

  const segments = windows.map((segment) => {
    return {
      ...createMonoSegment(audioBuffer, segment.startSeconds, segment.durationSeconds),
      label: segment.label,
      durationSeconds: segment.durationSeconds
    };
  }).filter((segment) => segment.durationSeconds >= MIN_SEGMENT_SECONDS);

  if (segments.length > 0) return segments;

  return [
    {
      ...createMonoSegment(audioBuffer, 0, audioBuffer.duration),
      label: "full_track",
      durationSeconds: audioBuffer.duration,
      weightMultiplier: 1
    }
  ];
}

type EjsJudgeSource = "ejs_full" | "ejs_middle" | "ejs_best_segment";

function createJudgeEssentiaSegments(audioBuffer: AudioBuffer, preAnalysis: BpmPreAnalysis) {
  const fullSeconds = Math.min(MAX_EJS_FULL_SECONDS, audioBuffer.duration);
  const windowSeconds = Math.min(TARGET_SEGMENT_SECONDS, audioBuffer.duration);
  const middleStart = Math.max(0, audioBuffer.duration / 2 - windowSeconds / 2);
  const middleWindow = preAnalysis.windows.find((window) => window.label === "middle_30s");
  const bestWindow = preAnalysis.windows[0];
  const windows: Array<{ label: EjsJudgeSource; startSeconds: number; durationSeconds: number }> = [
    { label: "ejs_full", startSeconds: 0, durationSeconds: fullSeconds },
    {
      label: "ejs_middle",
      startSeconds: middleWindow?.startSeconds ?? middleStart,
      durationSeconds: middleWindow?.durationSeconds ?? windowSeconds
    },
    {
      label: "ejs_best_segment",
      startSeconds: bestWindow?.startSeconds ?? findBestWindow(audioBuffer, "onset").startSeconds,
      durationSeconds: bestWindow?.durationSeconds ?? windowSeconds
    }
  ];

  return windows
    .map((segment) => {
      const segmentRoute = preAnalysis.routes[segment.label];
      const matchingWindow =
        segment.label === "ejs_best_segment"
          ? bestWindow
          : segment.label === "ejs_middle"
            ? middleWindow
            : undefined;

      return {
        ...createMonoSegment(audioBuffer, segment.startSeconds, segment.durationSeconds),
        label: segment.label,
        durationSeconds: segment.durationSeconds,
        weightMultiplier: (segmentRoute?.weightMultiplier ?? 1) * (matchingWindow?.weightMultiplier ?? 1)
      };
    })
    .filter((segment) => segment.durationSeconds >= MIN_SEGMENT_SECONDS);
}

function getModelWeightMultipliers(preAnalysis: BpmPreAnalysis) {
  return {
    rhythm2013_multifeature: preAnalysis.routes.rhythm2013_multifeature.weightMultiplier,
    rhythm2013_degara: preAnalysis.routes.rhythm2013_degara.weightMultiplier,
    percival: preAnalysis.routes.percival.weightMultiplier
  };
}

export function analyzeBpmWithEssentia(audioBuffer: AudioBuffer) {
  const id = ++requestId;
  const preAnalysis = analyzeAudioPreAnalysis(audioBuffer);
  const segments = createListeningSegments(audioBuffer, preAnalysis);
  const analyzedDuration = segments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
  const transferables = segments.map((segment) => segment.samples.buffer);

  return new Promise<EssentiaBpmResult>((resolve, reject) => {
    pendingRequests.set(id, {
      resolve: (result) => resolve({ ...result, analyzedDuration }),
      reject
    });

    try {
      getWorker().postMessage(
        {
          id,
          type: "analyze-bpm",
          payload: {
            sampleRate: audioBuffer.sampleRate,
            modelWeightMultipliers: getModelWeightMultipliers(preAnalysis),
            segments: segments.map(({ label, samples, weightMultiplier }) => ({ label, samples, weightMultiplier }))
          }
        },
        transferables
      );
    } catch (error) {
      pendingRequests.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function analyzeJudgeBpmWithEssentia(audioBuffer: AudioBuffer, preAnalysis = analyzeAudioPreAnalysis(audioBuffer)) {
  const id = ++requestId;
  const segments = createJudgeEssentiaSegments(audioBuffer, preAnalysis);
  const analyzedDuration = segments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
  const transferables = segments.map((segment) => segment.samples.buffer);

  return new Promise<EssentiaJudgeBpmResult>((resolve, reject) => {
    pendingRequests.set(id, {
      resolve: (result) =>
        resolve({
          analyzedDuration,
          candidates: result.candidates
            .map((candidate): JudgeBpmCandidate | null => {
              if (!segments.some((segment) => segment.label === candidate.segment)) return null;
              return {
                bpm: candidate.bpm,
                source: candidate.segment as JudgeBpmSource,
                model: candidate.model,
                weight: candidate.weight
              };
            })
            .filter((candidate): candidate is JudgeBpmCandidate => Boolean(candidate))
        }),
      reject
    });

    try {
      getWorker().postMessage(
        {
          id,
          type: "analyze-bpm",
          payload: {
            decision: "candidates-only",
            sampleRate: audioBuffer.sampleRate,
            modelWeightMultipliers: getModelWeightMultipliers(preAnalysis),
            segments: segments.map(({ label, samples, weightMultiplier }) => ({ label, samples, weightMultiplier }))
          }
        },
        transferables
      );
    } catch (error) {
      pendingRequests.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
