import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { Sheet } from '~/components/Sheet.tsx';
import { canRecordVoice, PcmRecorder, TARGET_SAMPLE_RATE } from '~/assist/audio.ts';
import { getToken } from '~/net/auth.ts';
import { askAssist, askAssistAudio } from '~/net/socket.ts';
import {
  assistListenRequests,
  assistOpen,
  assistWakePaused,
  assistWakeResult,
  markActivity,
  showToast,
} from '~/state/ui.ts';
import type { AssistResult } from '@shared/protocol.ts';

type AssistPhase = 'idle' | 'recording' | 'sending' | 'answered' | 'unsupported';

const LANG = 'en-US';
const MAX_RECORDING_MS = 7_000;
const NATIVE_WAKE_PAUSE_MS = 250;
const UNKNOWN_ASSIST_ERROR = /^error:? unknown$/i;

let chimeContext: AudioContext | null = null;

export function AssistSheet() {
  const [phase, setPhase] = useState<AssistPhase>('idle');
  const [draft, setDraft] = useState('');
  const [heard, setHeard] = useState('');
  const [reply, setReply] = useState<AssistResult | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const recorder = useRef<PcmRecorder | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const autoStop = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastListenRequest = useRef(assistListenRequests.value);
  const lastWakeResult = useRef(assistWakeResult.value?.seq ?? 0);

  const open = assistOpen.value;
  const voiceSupported = canRecordVoice();
  const listenRequest = assistListenRequests.value;
  const wakeResult = assistWakeResult.value;

  const clearAutoStop = (): void => {
    if (!autoStop.current) return;
    clearTimeout(autoStop.current);
    autoStop.current = null;
  };

  const stopRecording = async (sendAudio: boolean): Promise<void> => {
    const active = recorder.current;
    if (!active) return;
    recorder.current = null;
    clearAutoStop();
    assistWakePaused.value = false;
    const audio = await active.stop();
    resumeNativeWake();
    if (!sendAudio) {
      setPhase('idle');
      return;
    }
    await sendVoice(audio);
  };

  useEffect(() => {
    if (!open) {
      player.current?.pause();
      assistWakePaused.value = false;
      void stopRecording(false);
    }
    return () => {
      player.current?.pause();
      assistWakePaused.value = false;
      void stopRecording(false);
    };
  }, [open]);

  useEffect(() => {
    if (!open || listenRequest <= lastListenRequest.current) return;
    lastListenRequest.current = listenRequest;
    if (phase !== 'recording' && phase !== 'sending') void startRecording();
  }, [open, listenRequest, phase]);

  useEffect(() => {
    if (!wakeResult || wakeResult.seq <= lastWakeResult.current) return;
    lastWakeResult.current = wakeResult.seq;
    const result = wakeResult.result;
    setConversationId(result.conversationId);
    setHeard(result.text);
    setReply(result);
    setPhase('answered');
    void playReply(result);
    if (!result.audioUrl) assistWakePaused.value = false;
  }, [wakeResult]);

  const sendText = async (raw: string): Promise<void> => {
    const text = raw.trim();
    if (!text || phase === 'sending') return;
    markActivity();
    void stopRecording(false);
    assistWakePaused.value = true;
    setPhase('sending');
    setHeard(text);
    setReply(null);
    try {
      const result = await askAssist({ text, conversationId, language: LANG });
      setConversationId(result.conversationId);
      setReply(result);
      setPhase('answered');
      void playReply(result);
      if (!result.audioUrl) assistWakePaused.value = false;
      if (!result.success) showToast(assistReplyText(result), 'error');
    } catch (err) {
      assistWakePaused.value = false;
      setPhase('idle');
      showToast(err instanceof Error ? err.message : 'Assist did not respond', 'error');
    }
  };

  const sendVoice = async (audio: ArrayBuffer): Promise<void> => {
    if (audio.byteLength === 0) {
      setPhase('idle');
      showToast('I did not hear anything', 'error');
      return;
    }

    markActivity();
    assistWakePaused.value = true;
    setPhase('sending');
    setHeard('Listening complete');
    setReply(null);
    try {
      const result = await askAssistAudio(audio, { conversationId });
      setConversationId(result.conversationId);
      setHeard(result.text);
      setReply(result);
      setPhase('answered');
      void playReply(result);
      if (!result.audioUrl) assistWakePaused.value = false;
      if (!result.success) showToast(assistReplyText(result), 'error');
    } catch (err) {
      assistWakePaused.value = false;
      setPhase('idle');
      showToast(err instanceof Error ? err.message : 'Assist did not respond', 'error');
    }
  };

  const startRecording = async (): Promise<void> => {
    if (!voiceSupported) {
      setPhase('unsupported');
      showToast('Microphone capture is not available in this WebView', 'error');
      return;
    }

    markActivity();
    assistWakePaused.value = true;
    setDraft('');
    setReply(null);
    setHeard('Listening...');
    setPhase('recording');

    try {
      await pauseNativeWakeForCapture();
      recorder.current = await PcmRecorder.start(TARGET_SAMPLE_RATE);
      if (!window.CiscoNavigatorNative) void playListeningChime();
      autoStop.current = setTimeout(() => {
        void stopRecording(true);
      }, MAX_RECORDING_MS);
    } catch (err) {
      recorder.current = null;
      clearAutoStop();
      resumeNativeWake();
      setPhase('unsupported');
      showToast(captureErrorMessage(err), 'error');
    }
  };

  const primary = (): void => {
    if (phase === 'recording') void stopRecording(true);
    else void startRecording();
  };

  const status =
    phase === 'recording'
      ? 'Listening'
      : phase === 'sending'
        ? 'Sending'
        : phase === 'unsupported'
          ? 'Keyboard'
          : 'Ready';

  if (!open) return null;

  return (
    <Sheet title="Assist" subtitle={status} onClose={() => (assistOpen.value = false)}>
      <div class="assist-panel">
        <Pressable
          class={phase === 'recording' ? 'assist-mic is-listening p-lg' : 'assist-mic p-lg'}
          onPress={primary}
          disabled={phase === 'sending'}
          ariaLabel={phase === 'recording' ? 'Send voice command' : 'Start listening'}
        >
          <Icon name={phase === 'recording' ? 'micOff' : 'mic'} size="2.6rem" weight={1.9} />
        </Pressable>

        <div class="assist-exchange" aria-live="polite">
          {heard ? (
            <div class="assist-bubble assist-bubble-user">{heard}</div>
          ) : (
            <div class="assist-bubble assist-bubble-muted">
              {voiceSupported ? 'Tap mic and speak' : 'Voice unavailable'}
            </div>
          )}
          {reply ? (
            <div class={reply.success ? 'assist-bubble' : 'assist-bubble assist-bubble-error'}>
              {assistReplyText(reply)}
            </div>
          ) : null}
        </div>

        <form
          class="assist-form"
          onSubmit={(event) => {
            event.preventDefault();
            void sendText(draft);
            setDraft('');
          }}
        >
          <input
            class="assist-input"
            value={draft}
            onInput={(event) => setDraft(event.currentTarget.value)}
            disabled={phase === 'sending'}
            autocomplete="off"
            inputMode="text"
            aria-label="Assist text"
          />
          <Pressable class="assist-send p-sm" onPress={() => void sendText(draft)} disabled={!draft.trim() || phase === 'sending'} ariaLabel="Send">
            <Icon name="send" size="1.25rem" weight={2} />
          </Pressable>
        </form>
        <audio ref={player} preload="none" />
      </div>
    </Sheet>
  );

  async function playReply(result: AssistResult): Promise<void> {
    const src = audioSrc(result.audioUrl);
    const el = player.current;
    if (!src || !el) return;

    try {
      assistWakePaused.value = true;
      el.pause();
      el.src = src;
      el.currentTime = 0;
      el.onended = () => {
        assistWakePaused.value = false;
      };
      el.onerror = () => {
        assistWakePaused.value = false;
      };
      await el.play();
    } catch {
      assistWakePaused.value = false;
      showToast('Assist answered, but audio playback was blocked', 'error');
    }
  }
}

function assistReplyText(result: AssistResult): string {
  const speech = result.speech?.trim();
  if (result.success) return speech || 'Done';
  if (!speech || UNKNOWN_ASSIST_ERROR.test(speech)) {
    return 'Home Assistant returned an unknown Assist error';
  }
  return speech;
}

async function playListeningChime(): Promise<void> {
  const AudioContextCtor =
    window.AudioContext ??
    (window as Window & typeof globalThis & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioContextCtor) return;

  try {
    const ctx = chimeContext ?? new AudioContextCtor();
    chimeContext = ctx;
    await ctx.resume();

    const start = ctx.currentTime + 0.01;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.12, start + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
    gain.connect(ctx.destination);

    const first = ctx.createOscillator();
    first.type = 'sine';
    first.frequency.setValueAtTime(880, start);
    first.frequency.exponentialRampToValueAtTime(1320, start + 0.12);
    first.connect(gain);
    first.start(start);
    first.stop(start + 0.18);

    first.onended = () => {
      gain.disconnect();
    };
  } catch {
    /* A blocked chime must not block microphone capture. */
  }
}

async function pauseNativeWakeForCapture(): Promise<void> {
  try {
    window.CiscoNavigatorNativePauseWake?.();
  } catch {
    /* Native bridge is optional outside the Android wrapper. */
  }
  if (window.CiscoNavigatorNativePauseWake) {
    await new Promise((resolve) => setTimeout(resolve, NATIVE_WAKE_PAUSE_MS));
  }
}

function resumeNativeWake(): void {
  try {
    window.CiscoNavigatorNativeResumeWake?.();
  } catch {
    /* Native bridge is optional outside the Android wrapper. */
  }
}

function audioSrc(path: string | null | undefined): string | null {
  if (!path) return null;
  const token = getToken();
  const joiner = path.includes('?') ? '&' : '?';
  return `${path}${token ? `${joiner}t=${encodeURIComponent(token)}` : ''}`;
}

function captureErrorMessage(err: unknown): string {
  if (err instanceof DOMException && err.name === 'NotAllowedError') {
    return 'Microphone permission is blocked';
  }
  if (window.isSecureContext === false) {
    return 'Microphone capture needs a secure origin';
  }
  return err instanceof Error ? err.message : 'Microphone capture failed';
}
