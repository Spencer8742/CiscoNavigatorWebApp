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
    return () => { cancelled = true; clearInterval(interval); };
  }, [ids, quiet]);

  useEffect(() => {
    const unlock = (): void => {
      if (window.CiscoNavigatorAndroid?.playTimerAlert) return;
      try { context ??= new AudioContext(); void context.resume().catch(() => {}); } catch { /* Optional audio. */ }
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, []);
  return null;
}
