import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { Sheet } from '~/components/Sheet.tsx';
import { askAssist, askAssistAudio } from '~/net/socket.ts';
import { assistOpen, markActivity, showToast } from '~/state/ui.ts';
import type { AssistResult } from '@shared/protocol.ts';

type AssistPhase = 'idle' | 'recording' | 'sending' | 'answered' | 'unsupported';

const LANG = 'en-US';
const TARGET_SAMPLE_RATE = 16_000;
const MAX_RECORDING_MS = 7_000;

export function AssistSheet() {
  const [phase, setPhase] = useState<AssistPhase>('idle');
  const [draft, setDraft] = useState('');
  const [heard, setHeard] = useState('');
  const [reply, setReply] = useState<AssistResult | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const recorder = useRef<PcmRecorder | null>(null);
  const autoStop = useRef<ReturnType<typeof setTimeout> | null>(null);

  const open = assistOpen.value;
  const voiceSupported = canRecordVoice();

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
    const audio = await active.stop();
    if (!sendAudio) {
      setPhase('idle');
      return;
    }
    await sendVoice(audio);
  };

  useEffect(() => {
    if (!open) void stopRecording(false);
    return () => {
      void stopRecording(false);
    };
  }, [open]);

  const sendText = async (raw: string): Promise<void> => {
    const text = raw.trim();
    if (!text || phase === 'sending') return;
    markActivity();
    void stopRecording(false);
    setPhase('sending');
    setHeard(text);
    setReply(null);
    try {
      const result = await askAssist({ text, conversationId, language: LANG });
      setConversationId(result.conversationId);
      setReply(result);
      setPhase('answered');
      if (!result.success) showToast(result.speech ?? 'Assist could not complete that', 'error');
    } catch (err) {
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
    setPhase('sending');
    setHeard('Listening complete');
    setReply(null);
    try {
      const result = await askAssistAudio(audio, { conversationId });
      setConversationId(result.conversationId);
      setHeard(result.text);
      setReply(result);
      setPhase('answered');
      if (!result.success) showToast(result.speech ?? 'Assist could not complete that', 'error');
    } catch (err) {
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
    setDraft('');
    setReply(null);
    setHeard('Listening...');
    setPhase('recording');

    try {
      recorder.current = await PcmRecorder.start(TARGET_SAMPLE_RATE);
      autoStop.current = setTimeout(() => {
        void stopRecording(true);
      }, MAX_RECORDING_MS);
    } catch (err) {
      recorder.current = null;
      clearAutoStop();
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
              {reply.speech ?? (reply.success ? 'Done' : 'Assist could not complete that')}
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
      </div>
    </Sheet>
  );
}

class PcmRecorder {
  readonly #context: AudioContext;
  readonly #stream: MediaStream;
  readonly #source: MediaStreamAudioSourceNode;
  readonly #processor: ScriptProcessorNode;
  readonly #chunks: Int16Array[] = [];
  #stopped = false;

  private constructor(
    context: AudioContext,
    stream: MediaStream,
    source: MediaStreamAudioSourceNode,
    processor: ScriptProcessorNode,
  ) {
    this.#context = context;
    this.#stream = stream;
    this.#source = source;
    this.#processor = processor;
  }

  static async start(targetSampleRate: number): Promise<PcmRecorder> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const Ctor = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctor) throw new Error('Audio capture is not available');
    const context = new Ctor();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const recorder = new PcmRecorder(context, stream, source, processor);

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      recorder.#chunks.push(toPcm16(input, context.sampleRate, targetSampleRate));
    };

    source.connect(processor);
    processor.connect(context.destination);
    return recorder;
  }

  async stop(): Promise<ArrayBuffer> {
    if (this.#stopped) return new ArrayBuffer(0);
    this.#stopped = true;
    this.#processor.disconnect();
    this.#source.disconnect();
    for (const track of this.#stream.getTracks()) track.stop();
    await this.#context.close().catch(() => undefined);

    const samples = this.#chunks.reduce((total, chunk) => total + chunk.length, 0);
    const out = new Int16Array(samples);
    let offset = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out.buffer.slice(0);
  }
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

function canRecordVoice(): boolean {
  return Boolean(
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
      (window.AudioContext || window.webkitAudioContext),
  );
}

function toPcm16(input: Float32Array, inputSampleRate: number, outputSampleRate: number): Int16Array {
  const ratio = inputSampleRate / outputSampleRate;
  const length = Math.floor(input.length / ratio);
  const out = new Int16Array(length);

  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j += 1) {
      sum += input[j] ?? 0;
      count += 1;
    }
    const sample = Math.max(-1, Math.min(1, count > 0 ? sum / count : input[start] ?? 0));
    out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return out;
}

function captureErrorMessage(err: unknown): string {
  if (err instanceof DOMException && err.name === 'NotAllowedError') {
    return 'Microphone permission is blocked';
  }
  if (window.isSecureContext === false) {
    return 'Microphone capture needs a secure origin or the Android launcher permission bridge';
  }
  return err instanceof Error ? err.message : 'Microphone capture failed';
}
