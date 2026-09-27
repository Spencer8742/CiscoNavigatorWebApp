import { useEffect } from 'preact/hooks';
import { ringingTimers } from '~/state/timers.ts';
import { assistWakePaused, markActivity, openTimerPopup } from '~/state/ui.ts';

let context: AudioContext | null = null;

export function TimerAlerts() {
  const ids = ringingTimers.value.map((timer) => timer.id).join(',');
  const quiet = assistWakePaused.value;
  useEffect(() => {
    if (!ids || quiet) return;
    markActivity();
    openTimerPopup();
    let cancelled = false;
    const pulse = (): void => {
      if (cancelled) return;
      try {
        if (window.CiscoNavigatorAndroid?.playTimerAlert) {
          window.CiscoNavigatorAndroid.playTimerAlert();
          return;
        }
        const ctx = context ?? new AudioContext();
        context = ctx;
        void ctx.resume().then(() => {
          if (cancelled) return;
          const oscillator = ctx.createOscillator();
          const gain = ctx.createGain();
          gain.gain.setValueAtTime(0, ctx.currentTime);
          gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + 0.02);
          gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.25);
          oscillator.frequency.value = 1000;
          oscillator.connect(gain);
          gain.connect(ctx.destination);
          oscillator.start();
          oscillator.stop(ctx.currentTime + 0.25);
          oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
        }).catch(() => {});
      } catch { /* The visible alert remains available when audio is blocked. */ }
    };
    pulse();
    const interval = setInterval(pulse, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      /*
       * Park the audio graph when the alert stops.
       *
       * A running AudioContext is not idle: Chromium keeps an audio render
       * quantum ticking and holds its out-of-process AudioService open for
       * as long as the context is running. In a browser tab that lasts
       * minutes. Here the page lives for weeks, so one timer that went off
       * on Monday leaves the audio pipeline running until the panel
       * reboots — and RoomOS has the web engine's speaker output disabled
       * anyway, so nothing is gained by holding it.
       */
      void context?.suspend().catch(() => {});
    };
  }, [ids, quiet]);

  useEffect(() => {
    /*
     * Capture the autoplay gesture, then park the context again.
     *
     * Resuming inside a real gesture is what marks the context as allowed to
     * make sound; the engine remembers that, so a later `resume()` from an
     * alert needs no second gesture. Suspending straight afterwards keeps
     * that permission without leaving an audio thread running from the first
     * touch until the panel reboots.
     */
    const unlock = (): void => {
      if (window.CiscoNavigatorAndroid?.playTimerAlert) return;
      try {
        context ??= new AudioContext();
        void context
          .resume()
          .then(() => context?.suspend())
          .catch(() => {});
      } catch { /* Optional audio. */ }
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);
  return null;
}
