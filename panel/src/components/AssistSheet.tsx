import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { Sheet } from '~/components/Sheet.tsx';
import { canRecordVoice, PcmRecorder, TARGET_SAMPLE_RATE } from '~/assist/audio.ts';
import { hasNativeAudio, type VoiceRecorder } from '~/assist/native.ts';
import { SpeechEndpoint } from '~/assist/endpoint.ts';
import { getToken } from '~/net/auth.ts';
import { askAssist, askAssistAudio } from '~/net/socket.ts';
import {
  assistListenRequests, assistOpen, assistWakePaused, assistWakeResult, markActivity, showToast,
} from '~/state/ui.ts';
import type { AssistResult } from '@shared/protocol.ts';

type AssistPhase = 'idle' | 'starting' | 'recording' | 'sending' | 'answered' | 'unsupported';
const UNKNOWN_ASSIST_ERROR = /^error:? unknown$/i;
let chimeContext: AudioContext | null = null;

export function AssistSheet() {
  const [phase, setPhase] = useState<AssistPhase>('idle');
  const [draft, setDraft] = useState('');
  const [heard, setHeard] = useState('');
  const [reply, setReply] = useState<AssistResult | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const recorder = useRef<VoiceRecorder | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const autoStop = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captureAbort = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const currentPhase = useRef<AssistPhase>('idle');
  const lastListenRequest = useRef(0);
  const lastWakeResult = useRef(0);
  const open = assistOpen.value;
  const voiceSupported = canRecordVoice();
  const listenRequest = assistListenRequests.value;
  const wakeResult = assistWakeResult.value;

  const updatePhase = (value: AssistPhase): void => {
    currentPhase.current = value;
    setPhase(value);
  };
  const clearAutoStop = (): void => {
    if (autoStop.current) clearTimeout(autoStop.current);
    autoStop.current = null;
  };
  const cancel = (): void => {
    generation.current++;
    clearAutoStop();
    captureAbort.current?.abort();
    captureAbort.current = null;
    const active = recorder.current;
    recorder.current = null;
    if (active) void active.stop();
    player.current?.pause();
    assistWakePaused.value = false;
    updatePhase('idle');
  };
  const isCurrent = (id: number): boolean => generation.current === id && assistOpen.value;

  useLayoutEffect(() => {
    if (!open) cancel();
    return cancel;
  }, [open]);

  useLayoutEffect(() => {
    if (!open || listenRequest <= lastListenRequest.current) return;
    lastListenRequest.current = listenRequest;
    void startRecording();
  }, [open, listenRequest]);

  useEffect(() => {
    if (!wakeResult || wakeResult.seq <= lastWakeResult.current) return;
    lastWakeResult.current = wakeResult.seq;
    applyReply(wakeResult.result, generation.current);
  }, [wakeResult]);

  function applyReply(result: AssistResult, id: number): void {
    if (!isCurrent(id)) return;
    setConversationId(result.success ? result.conversationId : null);
    setHeard(result.text);
    setReply(result);
    updatePhase('answered');
    playReply(result, id);
    if (!result.success) showToast(assistReplyText(result), 'error');
  }

  async function sendText(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text || currentPhase.current === 'sending') return;
    cancel();
    const id = generation.current;
    assistWakePaused.value = true;
    updatePhase('sending');
    setHeard(text);
    setReply(null);
    markActivity();
    try {
      applyReply(await askAssist({ text, conversationId, language: 'en-US' }), id);
    } catch (error) { reportError(error, id); }
  }

  function reportError(error: unknown, id: number): void {
    if (!isCurrent(id)) return;
    assistWakePaused.value = false;
    updatePhase('idle');
    showToast(captureErrorMessage(error), 'error');
  }

  async function stopRecording(sendAudio: boolean): Promise<void> {
    const active = recorder.current;
    if (!active) return;
    recorder.current = null;
    clearAutoStop();
    captureAbort.current = null;
    const id = generation.current;
    updatePhase(sendAudio ? 'sending' : 'idle');
    const audio = await active.stop();
    if (!isCurrent(id)) return;
    if (!sendAudio || audio.byteLength < TARGET_SAMPLE_RATE) {
      assistWakePaused.value = false;
      updatePhase('idle');
      setHeard('');
      showToast('I did not hear a command. Try again.', 'error');
      return;
    }
    setHeard('Processing...');
    try {
      applyReply(await askAssistAudio(audio, { conversationId }), id);
    } catch (error) { reportError(error, id); }
  }

  async function startRecording(): Promise<void> {
    if (['starting', 'recording', 'sending'].includes(currentPhase.current)) return;
    if (!voiceSupported) {
      updatePhase('unsupported');
      showToast('Microphone capture is not available in this WebView', 'error');
      return;
    }
    player.current?.pause();
    const id = ++generation.current;
    const abort = new AbortController();
    captureAbort.current = abort;
    assistWakePaused.value = true;
    updatePhase('starting');
    setDraft('');
    setReply(null);
    setHeard('');
    markActivity();
    const endpoint = new SpeechEndpoint();
    try {
      const next = await PcmRecorder.startWithChunks((chunk) => {
        if (!isCurrent(id)) return;
        const result = endpoint.push(chunk);
        if (result) void stopRecording(result === 'speech-end');
      }, TARGET_SAMPLE_RATE, {
        signal: abort.signal,
        onError: (error) => {
          if (!isCurrent(id)) return;
          cancel();
          showToast(captureErrorMessage(error), 'error');
        },
      });
      if (!isCurrent(id) || abort.signal.aborted) { await next.stop(); return; }
      recorder.current = next;
      updatePhase('recording');
      setHeard('Listening...');
      if (!hasNativeAudio()) void playListeningChime();
      autoStop.current = setTimeout(() => void stopRecording(endpoint.hasSpeech), 16000);
    } catch (error) {
      if (abort.signal.aborted || !isCurrent(id)) return;
      recorder.current = null;
      clearAutoStop();
      reportError(error, id);
    }
  }

  const primary = (): void => {
    if (phase === 'recording') void stopRecording(true);
    else void startRecording();
  };
  const status = phase === 'starting' ? 'Starting microphone' : phase === 'recording' ? 'Listening'
    : phase === 'sending' ? 'Thinking' : phase === 'unsupported' ? 'Keyboard' : 'Ready';
  if (!open) return null;

  return (
    <Sheet title="Assist" subtitle={status} onClose={() => (assistOpen.value = false)}>
      <div class="assist-panel">
        <Pressable
          class={phase === 'recording' ? 'assist-mic is-listening p-lg' : 'assist-mic p-lg'}
          onPress={primary}
          disabled={phase === 'sending' || phase === 'starting'}
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

  function playReply(result: AssistResult, id: number): void {
    const src = audioSrc(result.audioUrl);
    const el = player.current;
    if (!src || !el) { assistWakePaused.value = false; return; }
    assistWakePaused.value = true;
    el.pause();
    el.src = src;
    el.currentTime = 0;
    const done = (): void => { if (isCurrent(id)) assistWakePaused.value = false; };
    el.onended = done;
    el.onerror = () => {
      done();
      if (isCurrent(id)) showToast('Assist answered, but its audio could not play', 'error');
    };
    void el.play().catch(() => {
      done();
      if (isCurrent(id)) showToast('Assist answered, but audio playback was blocked', 'error');
    });
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
