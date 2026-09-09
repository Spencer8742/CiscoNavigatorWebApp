import { computed, signal } from '@preact/signals';
import type { PanelCommand } from '@shared/protocol.ts';
import { getPanelId } from '~/net/auth.ts';
import { TimerStore, type PanelTimer } from '~/timers/model.ts';

const store = new TimerStore();
export const timers = signal<PanelTimer[]>([]);
export const timerNow = signal(Date.now());
export const ringingTimers = computed(() => timers.value.filter((timer) => timer.state === 'ringing'));
let key = '';
let ticker: ReturnType<typeof setTimeout> | undefined;
export const timerStorageFailed = signal(false);

function publish(): void {
  timers.value = store.items;
  timerNow.value = Date.now();
  try { localStorage.setItem(key, store.serialize()); timerStorageFailed.value = false; }
  catch { timerStorageFailed.value = true; }
  schedule();
}

function tick(): void {
  timerNow.value = Date.now();
  if (store.tick()) publish();
  else schedule();
}

function schedule(): void {
  clearTimeout(ticker);
  ticker = undefined;
  if (store.items.some((timer) => timer.state === 'running')) ticker = setTimeout(tick, 1000 - Date.now() % 1000 + 10);
}

export function startTimers(): void {
  if (key) return;
  key = `np.timers.${getPanelId() ?? 'default'}`;
  try { store.restore(localStorage.getItem(key)); } catch { timerStorageFailed.value = true; }
  publish();
  document.addEventListener('visibilitychange', tick);
}

export function createTimer(durationMs: number, label?: string): void {
  store.start(durationMs, label);
  publish();
}

export function updateTimer(id: string, operation: Parameters<TimerStore['update']>[1]): void {
  store.update(id, operation);
  publish();
}

export function dismissTimerAlerts(): void {
  for (const timer of store.items) if (timer.state === 'ringing') store.update(timer.id, 'dismiss');
  publish();
}

export function runTimerCommand(command: Exclude<PanelCommand, { type: 'cancel-assist' }>): void {
  if (command.type === 'timer-start') { createTimer(command.durationMs, command.label); return; }
  if (command.type !== 'timer-control') return;
  if (store.tick()) publish();
  const candidates = store.items.filter((timer) => command.operation === 'resume' ? timer.state === 'paused'
    : command.operation === 'pause' ? timer.state === 'running' : timer.state !== 'finished');
  const matches = command.label ? candidates.filter((timer) => timer.label.toLowerCase() === command.label!.toLowerCase()) : candidates;
  if (matches.length === 0) throw new Error('No matching timer.');
  if (!command.all && matches.length > 1) throw new Error('More than one timer matches. Choose one in the timer popup.');
  for (const timer of matches) store.update(timer.id, command.operation);
  publish();
}
