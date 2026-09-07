import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { Sheet } from '~/components/Sheet.tsx';
import { askAssist } from '~/net/socket.ts';
import { assistOpen, markActivity, showToast } from '~/state/ui.ts';
import type { AssistResult } from '@shared/protocol.ts';

type AssistPhase = 'idle' | 'listening' | 'sending' | 'answered' | 'unsupported';

interface SpeechRecognitionAlternative {
  transcript: string;
}

interface SpeechRecognitionResult {
  readonly length: number;
  readonly isFinal: boolean;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  error?: string;
}

interface SpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionCtor = new () => SpeechRecognition;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}

const LANG = 'en-US';

export function AssistSheet() {
  const [phase, setPhase] = useState<AssistPhase>('idle');
  const [draft, setDraft] = useState('');
  const [heard, setHeard] = useState('');
  const [reply, setReply] = useState<AssistResult | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const recognition = useRef<SpeechRecognition | null>(null);
  const recognitionSubmitted = useRef(false);

  const open = assistOpen.value;
  const supported = speechCtor() !== null;

  const stopListening = (): void => {
    const rec = recognition.current;
    if (!rec) return;
    recognition.current = null;
    rec.onresult = null;
    rec.onerror = null;
    rec.onend = null;
    try {
      rec.abort();
    } catch {
      /* already stopped */
    }
  };

  useEffect(() => {
    if (!open) stopListening();
    return stopListening;
  }, [open]);

  if (!open) return null;

  const sendText = async (raw: string): Promise<void> => {
    const text = raw.trim();
    if (!text || phase === 'sending') return;
    markActivity();
    stopListening();
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

  const startListening = (): void => {
    const Ctor = speechCtor();
    if (!Ctor) {
      setPhase('unsupported');
      return;
    }

    stopListening();
    const rec = new Ctor();
    recognition.current = rec;
    recognitionSubmitted.current = false;
    setDraft('');
    setReply(null);
    setHeard('');
    setPhase('listening');

    rec.lang = LANG;
    rec.continuous = false;
    rec.interimResults = true;
    rec.onresult = (event) => {
      let interim = '';
      let finalText = '';
      for (let i = 0; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (!result) continue;
        const text = result?.[0]?.transcript ?? '';
        if (!text) continue;
        if (result.isFinal) finalText += text;
        else interim += text;
      }
      const spoken = (finalText || interim).trim();
      if (spoken) setHeard(spoken);
      if (finalText.trim() && !recognitionSubmitted.current) {
        recognitionSubmitted.current = true;
        void sendText(finalText);
      }
    };
    rec.onerror = (event) => {
      setPhase(event.error === 'not-allowed' ? 'unsupported' : 'idle');
      if (event.error === 'not-allowed') showToast('Microphone permission is blocked', 'error');
    };
    rec.onend = () => {
      if (recognition.current === rec) recognition.current = null;
      setPhase((current) => (current === 'listening' ? 'idle' : current));
    };

    try {
      rec.start();
    } catch {
      recognition.current = null;
      setPhase('unsupported');
    }
  };

  const primary = phase === 'listening' ? stopListening : startListening;
  const status =
    phase === 'listening'
      ? 'Listening'
      : phase === 'sending'
        ? 'Sending'
        : phase === 'unsupported'
          ? 'Keyboard'
          : 'Ready';

  return (
    <Sheet title="Assist" subtitle={status} onClose={() => (assistOpen.value = false)}>
      <div class="assist-panel">
        <Pressable
          class={phase === 'listening' ? 'assist-mic is-listening p-lg' : 'assist-mic p-lg'}
          onPress={primary}
          disabled={phase === 'sending'}
          ariaLabel={phase === 'listening' ? 'Stop listening' : 'Start listening'}
        >
          <Icon name={phase === 'listening' ? 'micOff' : 'mic'} size="2.6rem" weight={1.9} />
        </Pressable>

        <div class="assist-exchange" aria-live="polite">
          {heard ? (
            <div class="assist-bubble assist-bubble-user">{heard}</div>
          ) : (
            <div class="assist-bubble assist-bubble-muted">
              {supported ? 'Ready' : 'Voice unavailable'}
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

function speechCtor(): SpeechRecognitionCtor | null {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}
