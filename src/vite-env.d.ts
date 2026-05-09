/// <reference types="vite/client" />

declare module "web-audio-beat-detector" {
  export interface TempoSettings {
    minTempo?: number;
    maxTempo?: number;
  }

  export interface GuessResult {
    bpm: number;
    offset: number;
    tempo: number;
  }

  export function analyze(
    audioBuffer: AudioBuffer,
    offset?: number | TempoSettings,
    duration?: number,
    tempoSettings?: TempoSettings
  ): Promise<number>;

  export function guess(
    audioBuffer: AudioBuffer,
    offset?: number | TempoSettings,
    duration?: number,
    tempoSettings?: TempoSettings
  ): Promise<GuessResult>;
}
