import { useEffect, useRef } from 'preact/hooks';
import { canRecordVoice, pcmChunkBytes, PcmRecorder } from '~/assist/audio.ts';
import { wakeSocketUrl } from '~/net/auth.ts';
import {
  assistOpen,
  assistWakePaused,
  assistWakeResult,
  linkStatus,
  markActivity,
  ready,
  showToast,
} from '~/state/ui.ts';
import type { AssistResult } from '@shared/protocol.ts';

const RETRY_MS = 1_000;

type WakeMessage =
  | { t: 'result'; result: AssistResult }
  | { t: 'timeout' }
  | { t: 'error'; message?: string };

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
    let socket: WebSocket | null = null;
    let recorder: PcmRecorder | null = null;

    const clearRetry = (): void => {
      if (!retry) return;
      clearTimeout(retry);
      retry = null;
    };

    const stopRecorder = (): void => {
      const active = recorder;
      recorder = null;
      if (active) void active.stop();
    };

    const schedule = (): void => {
      if (stopped || retry) return;
      retry = setTimeout(() => {
        retry = null;
        start();
      }, RETRY_MS);
    };

    const close = (): void => {
      clearRetry();
      stopRecorder();
      const active = socket;
      socket = null;
      if (active && active.readyState <= WebSocket.OPEN) active.close();
    };

    const start = (): void => {
      if (stopped) return;

      const ws = new WebSocket(wakeSocketUrl());
      ws.binaryType = 'arraybuffer';
      socket = ws;

      ws.onopen = () => {
        void PcmRecorder.startWithChunks((chunk) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(pcmChunkBytes(chunk));
        })
          .then((next) => {
            if (stopped || socket !== ws) {
              void next.stop();
              return;
            }
            recorder = next;
          })
          .catch((err) => {
            console.warn('[assist] wake capture failed', err);
            close();
          });
      };

      ws.onmessage = (event) => {
        const msg = parseWakeMessage(event.data);
        if (!msg) return;

        if (msg.t === 'result') {
          seq.current += 1;
          assistWakePaused.value = true;
          assistOpen.value = true;
          assistWakeResult.value = { seq: seq.current, result: msg.result };
          markActivity();
          stopped = true;
          close();
          return;
        }

        stopped = true;
        close();
        if (msg.t === 'timeout') {
          stopped = false;
          schedule();
        } else {
          const message = msg.message ?? 'Wake word listener failed';
          console.warn('[assist] wake listener error', message);
          if (message !== lastError.current) {
            lastError.current = message;
            showToast(message, 'error');
          }
          stopped = false;
          schedule();
        }
      };

      ws.onclose = () => {
        if (socket === ws) socket = null;
        stopRecorder();
        schedule();
      };

      ws.onerror = () => {
        close();
        schedule();
      };
    };

    start();

    return () => {
      stopped = true;
      close();
    };
  }, [shouldListen]);

  return null;
}

function parseWakeMessage(raw: unknown): WakeMessage | null {
  if (typeof raw !== 'string') return null;
  try {
    const msg = JSON.parse(raw) as WakeMessage;
    return msg && typeof msg === 'object' && 't' in msg ? msg : null;
  } catch {
    return null;
  }
}
