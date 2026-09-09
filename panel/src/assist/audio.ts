import { hasNativeAudio, NativeRecorder, type VoiceRecorder } from './native.ts';

export const TARGET_SAMPLE_RATE = 16_000;

type PcmRecorderOptions = {
  processing?: boolean;
  signal?: AbortSignal;
  onError?: (error: Error) => void;
  retainAudio?: boolean;
};

export class PcmRecorder {
  readonly #context: AudioContext;
  readonly #stream: MediaStream;
  readonly #source: MediaStreamAudioSourceNode;
  readonly #processor: ScriptProcessorNode;
  readonly #chunks: Int16Array[] = [];
  #stopped = false;
  #cleanup = (): void => {};

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

  static async start(
    targetSampleRate = TARGET_SAMPLE_RATE,
    options: PcmRecorderOptions = {},
  ): Promise<VoiceRecorder> {
    return PcmRecorder.startWithChunks(() => undefined, targetSampleRate, options);
  }

  static async startWithChunks(
    onChunk: (chunk: Int16Array) => void,
    targetSampleRate = TARGET_SAMPLE_RATE,
    options: PcmRecorderOptions = {},
  ): Promise<VoiceRecorder> {
    if (hasNativeAudio()) return NativeRecorder.start(onChunk, options.signal, options.onError);
    if (options.signal?.aborted) throw new DOMException('Capture cancelled', 'AbortError');
    const processing = options.processing ?? true;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: processing
        ? {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          }
        : {
            channelCount: { ideal: 1 },
            sampleRate: { ideal: targetSampleRate },
            sampleSize: { ideal: 16 },
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
    });
    if (options.signal?.aborted) {
      stream.getTracks().forEach((track) => track.stop());
      throw new DOMException('Capture cancelled', 'AbortError');
    }
    const Ctor = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctor) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error('Audio capture is not available');
    }
    let context: AudioContext;
    try { context = new Ctor(); } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      throw error;
    }
    try {
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const recorder = new PcmRecorder(context, stream, source, processor);

      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        const chunk = toPcm16(input, context.sampleRate, targetSampleRate);
        if (options.retainAudio !== false) recorder.#chunks.push(chunk);
        onChunk(chunk);
      };

      source.connect(processor);
      processor.connect(context.destination);
      const abort = (): void => { void recorder.stop(); };
      options.signal?.addEventListener('abort', abort, { once: true });
      recorder.#cleanup = () => options.signal?.removeEventListener('abort', abort);
      await context.resume();
      if (options.signal?.aborted) {
        await recorder.stop();
        throw new DOMException('Capture cancelled', 'AbortError');
      }
      return recorder;
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      await context.close().catch(() => undefined);
      throw error;
    }
  }

  async stop(): Promise<ArrayBuffer> {
    if (this.#stopped) return new ArrayBuffer(0);
    this.#stopped = true;
    this.#cleanup();
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

export function canRecordVoice(): boolean {
  return Boolean(
    hasNativeAudio() || (typeof navigator.mediaDevices?.getUserMedia === 'function' &&
      (window.AudioContext || window.webkitAudioContext))
  );
}

export function pcmChunkBytes(chunk: Int16Array): ArrayBuffer {
  const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return bytes.slice().buffer;
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
