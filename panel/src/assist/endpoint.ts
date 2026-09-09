/** End after sustained speech followed by silence, with bounded waits for quiet rooms. */
export class SpeechEndpoint {
  private elapsed = 0;
  private speech = 0;
  private silence = 0;
  private noise = 0.001;
  hasSpeech = false;

  push(chunk: Int16Array, sampleRate = 16000): 'speech-end' | 'no-speech' | null {
    const ms = chunk.length * 1000 / sampleRate;
    this.elapsed += ms;
    // The listening chime is not a spoken command.
    if (this.elapsed < 400) return null;
    let energy = 0;
    for (const sample of chunk) energy += (sample / 32768) ** 2;
    const rms = Math.sqrt(energy / Math.max(1, chunk.length));
    const threshold = Math.max(0.0015, this.noise * 1.7);
    if (rms >= threshold) {
      this.speech += ms;
      this.silence = 0;
      if (this.speech >= 240) this.hasSpeech = true;
    } else {
      this.noise = this.noise * 0.95 + rms * 0.05;
      this.silence += ms;
      if (!this.hasSpeech && this.silence >= 240) this.speech = 0;
    }
    if (this.hasSpeech && (this.silence >= 650 || this.elapsed >= 15000)) return 'speech-end';
    if (!this.hasSpeech && this.elapsed >= 6000) return 'no-speech';
    return null;
  }
}
