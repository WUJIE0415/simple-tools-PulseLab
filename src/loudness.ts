import { LoudnessWorkletNode, type LoudnessMeasurements } from "loudness-worklet";

export interface LoudnessResult {
  integratedLufs: number;
  truePeakDbtp: number;
}

function createLoudnessOfflineContext(channelCount: number, length: number, sampleRate: number) {
  const OfflineAudioContextCtor =
    window.OfflineAudioContext ||
    (window as Window & { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;

  if (!OfflineAudioContextCtor) {
    throw new Error("Current browser cannot measure loudness.");
  }

  return new OfflineAudioContextCtor(channelCount, length, sampleRate);
}

function readFinalMeasurement(measurements?: LoudnessMeasurements[]) {
  const measurement = measurements?.[0];
  if (!measurement) {
    throw new Error("Loudness measurement returned no data.");
  }

  return {
    integratedLufs: measurement.integratedLoudness,
    truePeakDbtp: measurement.maximumTruePeakLevel
  };
}

export async function analyzeLoudness(audioBuffer: AudioBuffer): Promise<LoudnessResult> {
  const context = createLoudnessOfflineContext(
    audioBuffer.numberOfChannels,
    audioBuffer.length,
    audioBuffer.sampleRate
  );
  let latestMeasurements: LoudnessMeasurements[] | undefined;

  await LoudnessWorkletNode.loadModule(context);

  const source = new AudioBufferSourceNode(context, { buffer: audioBuffer });
  const worklet = new LoudnessWorkletNode(context, {
    processorOptions: {
      capacity: audioBuffer.duration,
      interval: 0.05
    }
  });

  worklet.port.onmessage = (event: MessageEvent) => {
    latestMeasurements = event.data?.currentMeasurements;
  };

  source.connect(worklet).connect(context.destination);
  source.start();

  await context.startRendering();
  return readFinalMeasurement(latestMeasurements);
}
