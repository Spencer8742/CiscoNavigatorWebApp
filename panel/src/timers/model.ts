export type TimerState = 'running' | 'paused' | 'ringing' | 'finished';
export interface PanelTimer {
  id: string;
  label: string;
  durationMs: number;
  remainingMs: number;
  deadline: number | null;
  state: TimerState;
}
export const MAX_TIMERS = 12;
export const MAX_DURATION_MS = 86400000;

export function remaining(timer: PanelTimer, now: number): number {
  return timer.state === 'running' && timer.deadline !== null
    ? Math.max(0, timer.deadline - now) : timer.remainingMs;
}

export function formatCountdown(ms: number): string {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds / 60) % 60;
  const s = String(seconds % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function durationLabel(ms: number): string {
  const total = Math.round(ms / 1000);
  return [[Math.floor(total / 3600), 'hour'], [Math.floor(total / 60) % 60, 'minute'], [total % 60, 'second']]
    .filter(([n]) => n !== 0).map(([n, unit]) => `${n} ${unit}${n === 1 ? '' : 's'}`).join(' ');
}

/** Absolute deadlines survive navigation, reloads, and delayed browser ticks. */
export class TimerStore {
  items: PanelTimer[] = [];
  constructor(private now: () => number = Date.now, private newId: () => string = () => crypto.randomUUID()) {}

  start(durationMs: number, label?: string): PanelTimer {
    if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > MAX_DURATION_MS) throw new Error('Choose a timer from 1 second to 24 hours.');
    if (this.items.length >= MAX_TIMERS) throw new Error('Remove a timer before adding another.');
    const timer: PanelTimer = { id: this.newId(), label: label?.trim().slice(0, 40) || durationLabel(durationMs),
      durationMs, remainingMs: durationMs, deadline: this.now() + durationMs, state: 'running' };
    this.items = [...this.items, timer];
    return timer;
  }

  update(id: string, operation: 'pause' | 'resume' | 'cancel' | 'restart' | 'dismiss' | 'add-minute'): void {
    this.tick();
    if (operation === 'cancel') { this.items = this.items.filter((timer) => timer.id !== id); return; }
    this.items = this.items.map((timer) => {
      if (timer.id !== id) return timer;
      if (operation === 'pause' && timer.state === 'running')
        return { ...timer, state: 'paused', remainingMs: remaining(timer, this.now()), deadline: null };
      if (operation === 'resume' && timer.state === 'paused')
        return { ...timer, state: 'running', deadline: this.now() + timer.remainingMs };
      if (operation === 'restart')
        return { ...timer, state: 'running', remainingMs: timer.durationMs, deadline: this.now() + timer.durationMs };
      if (operation === 'dismiss' && timer.state === 'ringing') return { ...timer, state: 'finished' };
      if (operation === 'add-minute' && (timer.state === 'running' || timer.state === 'paused')) {
        const ms = Math.min(MAX_DURATION_MS, remaining(timer, this.now()) + 60000);
        return { ...timer, remainingMs: ms, durationMs: Math.min(MAX_DURATION_MS, timer.durationMs + 60000),
          deadline: timer.state === 'running' ? this.now() + ms : null };
      }
      return timer;
    });
  }

  tick(): boolean {
    let changed = false;
    this.items = this.items.map((timer) => {
      if (timer.state !== 'running' || remaining(timer, this.now()) > 0) return timer;
      changed = true;
      return { ...timer, state: 'ringing', remainingMs: 0, deadline: null };
    });
    return changed;
  }

  restore(raw: string | null): void {
    try {
      const data: unknown = JSON.parse(raw ?? 'null');
      if (!data || typeof data !== 'object' || !('version' in data) || data.version !== 1 || !('timers' in data) || !Array.isArray(data.timers)) return;
      const ids = new Set<string>();
      this.items = data.timers.filter((value: unknown): value is PanelTimer => {
        if (!value || typeof value !== 'object') return false;
        const t = value as PanelTimer;
        if (typeof t.id !== 'string' || !t.id || ids.has(t.id) || typeof t.label !== 'string' || t.label.length > 40 ||
          !Number.isFinite(t.durationMs) || t.durationMs < 1000 || t.durationMs > MAX_DURATION_MS ||
          !Number.isFinite(t.remainingMs) || t.remainingMs < 0 || t.remainingMs > MAX_DURATION_MS ||
          !['running', 'paused', 'ringing', 'finished'].includes(t.state) ||
          (t.state === 'running' ? typeof t.deadline !== 'number' || !Number.isFinite(t.deadline) || t.deadline > this.now() + MAX_DURATION_MS : t.deadline !== null)) return false;
        ids.add(t.id);
        return true;
      }).slice(0, MAX_TIMERS);
      this.tick();
    } catch { /* A damaged cache must not prevent the dashboard from starting. */ }
  }

  serialize(): string { return JSON.stringify({ version: 1, timers: this.items }); }
}
