import { useEffect, useRef } from 'preact/hooks';
import { canRecordVoice, PcmRecorder, TARGET_SAMPLE_RATE } from '~/assist/audio.ts';
import { askAssistWakeAudio } from '~/net/socket.ts';
import {
  assistOpen,
  assistWakePaused,
  assistWakeResult,
  linkStatus,
  markActivity,
  ready,
  showToast,
} from '~/state/ui.ts';

const RETRY_MS = 2_000;
const SPEECH_RMS = 0.018;
const SILENCE_RMS = 0.012;
const MIN_SPEECH_MS = 350;
const END_SILENCE_MS = 900;
const MAX_SEGMENT_MS = 8_000;

export function AssistWakeListener() {
  const seq = useRef(0);
  const lastError = useRef<string | null>(null);
  const shouldListen =
    ready.value &&
    linkStatus.value === 'connected' &&
    !assistWakePaused.value &&
    canRecordVoice();

  useEffect(() => {
    if (!shouldListen) return;

    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let recorder: PcmRecorder | null = null;
    let sending = false;
    let segmenting = false;
    let segment: Int16Array[] = [];
    let segmentSamples = 0;
    let speechMs = 0;
    let silenceMs = 0;

    const clearRetry = (): void => {
      if (!retry) return;
      clearTimeout(retry);
      retry = null;
    };

    const resetSegment = (): void => {
      segmenting = false;
      segment = [];
      segmentSamples = 0;
      speechMs = 0;
      silenceMs = 0;
    };

    const stopRecorder = (): void => {
      const active = recorder;
      recorder = null;
      if (active) void active.stop();
    };

    const close = (): void => {
      clearRetry();
      stopRecorder();
      resetSegment();
    };

    const schedule = (): void => {
      if (stopped || retry) return;
      retry = setTimeout(() => {
        retry = null;
        start();
      }, RETRY_MS);
    };

    const reportError = (err: unknown, fallback: string): void => {
      const message = err instanceof Error ? err.message : fallback;
      console.warn('[assist] wake listener error', message);
      if (message !== lastError.current) {
        lastError.current = message;
        showToast(message, 'error');
      }
    };

    const submitSegment = (): void => {
      if (sending || segmentSamples === 0) {
        resetSegment();
        return;
      }

      const audio = concatPcm(segment, segmentSamples);
      resetSegment();
      sending = true;
      void askAssistWakeAudio(audio)
        .then((msg) => {
          sending = false;
          if (stopped || !msg.matched) return;
          seq.current += 1;
          assistWakePaused.value = true;
          assistOpen.value = true;
          assistWakeResult.value = { seq: seq.current, result: msg.result };
          markActivity();
          stopped = true;
          close();
        })
        .catch((err) => {
          sending = false;
          if (stopped) return;
          reportError(err, 'Wake word listener failed');
        });
    };

    const onChunk = (chunk: Int16Array): void => {
      if (stopped || sending) return;
      const rms = pcmRms(chunk);
      const ms = (chunk.length / TARGET_SAMPLE_RATE) * 1000;

      if (!segmenting) {
        if (rms < SPEECH_RMS) return;
        segmenting = true;
      }

      segment.push(chunk);
      segmentSamples += chunk.length;

      if (rms >= SILENCE_RMS) {
        speechMs += ms;
        silenceMs = 0;
      } else {
        silenceMs += ms;
      }

      const segmentMs = (segmentSamples / TARGET_SAMPLE_RATE) * 1000;
      if (segmentMs >= MAX_SEGMENT_MS || (speechMs >= MIN_SPEECH_MS && silenceMs >= END_SILENCE_MS)) {
        submitSegment();
      }
    };

    const start = (): void => {
      if (stopped || recorder) return;
      void PcmRecorder.startWithChunks(onChunk)
        .then((next) => {
          if (stopped) {
            void next.stop();
            return;
          }
          recorder = next;
        })
        .catch((err) => {
          reportError(err, 'Wake capture failed');
          close();
          schedule();
        });
    };

    start();

    return () => {
      stopped = true;
      close();
    };
  }, [shouldListen]);

  return null;
}

function concatPcm(chunks: Int16Array[], samples: number): ArrayBuffer {
  const out = new Int16Array(samples);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out.buffer.slice(0);
}

function pcmRms(chunk: Int16Array): number {
  if (chunk.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < chunk.length; i += 1) {
    const sample = (chunk[i] ?? 0) / 0x8000;
    sum += sample * sample;
  }
  return Math.sqrt(sum / chunk.length);
}
