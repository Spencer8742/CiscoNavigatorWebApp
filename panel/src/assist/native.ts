export interface VoiceRecorder {
  stop(): Promise<ArrayBuffer>;
}

export type NativeAudioEvent = { id: number; type: 'ready' | 'audio' | 'error'; pcm?: string; message?: string };

declare global {
  interface Window {
    CiscoNavigatorAndroid?: {
      audioVersion(): number;
      startCapture(id: number): void;
      stopCapture(id: number): void;
      setWakePaused(paused: boolean): void;
      playTimerAlert?(): void;
    };
    CiscoNavigatorNativeAudio?: (event: NativeAudioEvent) => void;
  }
}

let nextId = 0;
let active: NativeRecorder | null = null;

export function hasNativeAudio(): boolean {
  try { return window.CiscoNavigatorAndroid?.audioVersion() === 1; } catch { return false; }
}

export function setNativeWakePaused(paused: boolean): void {
  try { window.CiscoNavigatorAndroid?.setWakePaused(paused); } catch { /* Optional bridge. */ }
}

export class NativeRecorder implements VoiceRecorder {
  readonly id = ++nextId;
  readonly chunks: Int16Array[] = [];
  stopped = false;
  private constructor(private onChunk: (chunk: Int16Array) => void, private onError?: (error: Error) => void) {}

  static start(onChunk: (chunk: Int16Array) => void, signal?: AbortSignal, onError?: (error: Error) => void): Promise<VoiceRecorder> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException('Capture cancelled', 'AbortError')); return; }
      if (active) { reject(new Error('Microphone is already recording')); return; }
      const recorder = new NativeRecorder(onChunk, onError);
      active = recorder;
      let ready = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      const fail = (error: Error): void => {
        cleanup();
        void recorder.stop();
        if (ready) recorder.onError?.(error);
        else reject(error);
      };
      const abort = (): void => fail(new DOMException('Capture cancelled', 'AbortError'));
      const timer = setTimeout(() => fail(new Error('Native microphone did not start')), 3000);
      signal?.addEventListener('abort', abort, { once: true });
      window.CiscoNavigatorNativeAudio = (event) => {
        if (event.id !== recorder.id || recorder.stopped) return;
        if (event.type === 'error') { fail(new Error(event.message ?? 'Microphone failed')); return; }
        if (event.type === 'ready') {
          ready = true;
          clearTimeout(timer);
          resolve(recorder);
        } else if (event.pcm) {
          const bytes = Uint8Array.from(atob(event.pcm), (c) => c.charCodeAt(0));
          const view = new DataView(bytes.buffer);
          const chunk = Int16Array.from({ length: bytes.length / 2 }, (_, i) => view.getInt16(i * 2, true));
          recorder.chunks.push(chunk);
          recorder.onChunk(chunk);
        }
      };
      recorder.cleanup = cleanup;
      try { window.CiscoNavigatorAndroid!.startCapture(recorder.id); } catch (error) { fail(error as Error); }
    });
  }

  private cleanup = (): void => {};

  async stop(): Promise<ArrayBuffer> {
    if (this.stopped) return new ArrayBuffer(0);
    this.stopped = true;
    this.cleanup();
    if (active === this) {
      active = null;
      window.CiscoNavigatorNativeAudio = undefined;
    }
    window.CiscoNavigatorAndroid?.stopCapture(this.id);
    const pcm = new Int16Array(this.chunks.reduce((n, chunk) => n + chunk.length, 0));
    let offset = 0;
    for (const chunk of this.chunks) { pcm.set(chunk, offset); offset += chunk.length; }
    this.chunks.length = 0;
    // Echo microphone levels can be very low. Preserve quiet speech without clipping.
    let peak = 0;
    for (const sample of pcm) peak = Math.max(peak, Math.abs(sample));
    const gain = peak > 0 ? Math.min(16, Math.max(1, 16000 / peak)) : 1;
    if (gain > 1) for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(pcm[i]! * gain);
    return pcm.buffer;
  }
}
