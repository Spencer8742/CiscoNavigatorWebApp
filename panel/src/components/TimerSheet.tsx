import { useState } from 'preact/hooks';
import { Icon } from '~/components/Icon.tsx';
import { Pressable } from '~/components/Pressable.tsx';
import { Sheet } from '~/components/Sheet.tsx';
import { createTimer, dismissTimerAlerts, ringingTimers, timers, timerNow, timerStorageFailed, updateTimer } from '~/state/timers.ts';
import { durationLabel, formatCountdown, remaining, type PanelTimer } from '~/timers/model.ts';
import { showToast, timersOpen } from '~/state/ui.ts';

export function TimerSheet() {
  const [hours, setHours] = useState('0');
  const [minutes, setMinutes] = useState('5');
  const [seconds, setSeconds] = useState('0');
  const [label, setLabel] = useState('');
  const [adding, setAdding] = useState(false);
  const list = timers.value;
  const showForm = adding || list.length === 0;
  const start = (ms: number): void => {
    try { createTimer(ms, label); setAdding(false); setLabel(''); }
    catch (error) { showToast(error instanceof Error ? error.message : 'Timer could not start', 'error'); }
  };
  const valid = [hours, minutes, seconds].every((value) => /^\d{1,2}$/.test(value))
    && Number(hours) <= 24 && Number(minutes) < 60 && Number(seconds) < 60;
  const duration = (Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000;
  if (!timersOpen.value) return null;

  return (
    <Sheet title="Timers" onClose={() => { dismissTimerAlerts(); timersOpen.value = false; setAdding(false); }} actions={
        <Pressable class="timer-tool p-sm" onPress={() => setAdding(!adding)} ariaLabel={adding ? 'Close new timer' : 'New timer'}>
          <Icon name={adding ? 'close' : 'plus'} />
        </Pressable>
    }>
      <div class="timer-body">
        {timerStorageFailed.value ? <p role="alert">Timers cannot be saved on this device. Keep the app open.</p> : null}
        {showForm ? (
          <form class="timer-composer" onSubmit={(event) => { event.preventDefault(); if (valid) start(duration); }}>
            <Icon name="clock" size="2rem" />
            <div class="timer-duration-inputs">
              {([
                ['Hours', hours, setHours, 24], ['Minutes', minutes, setMinutes, 59], ['Seconds', seconds, setSeconds, 59],
              ] as const).map(([name, value, set, max]) => (
                <label class="timer-duration-field" key={name}>
                  <span>{name}</span>
                  <input type="number" inputMode="numeric" min="0" max={max} step="1" required
                    value={value} aria-label={name} onInput={(event) => set(event.currentTarget.value)} />
                </label>
              ))}
            </div>
            <label class="timer-name-field">
              <span>Name</span>
              <input type="text" value={label} maxLength={40} aria-label="Timer name" autocomplete="off"
                onInput={(event) => setLabel(event.currentTarget.value)} />
            </label>
            <div class="timer-presets" aria-label="Quick timers">
              {[1, 5, 10, 15].map((value) => (
                <Pressable key={value} class="timer-preset p-sm" onPress={() => start(value * 60000)} ariaLabel={`Start ${value} minute timer`}>
                  <Icon name="clock" size="1.1rem" /><span>{value} min</span>
                </Pressable>
              ))}
            </div>
            <Pressable class="timer-start p-sm" onPress={() => start(duration)} disabled={!valid || duration < 1000 || duration > 86400000} ariaLabel="Start timer">
              <Icon name="play" size="1.2rem" /><span>Start</span>
            </Pressable>
          </form>
        ) : null}
        <div class="timer-list" data-count={list.length}>
          {list.map((timer) => <Timer key={timer.id} timer={timer} />)}
        </div>
      </div>
    </Sheet>
  );
}

function Timer({ timer }: { timer: PanelTimer }) {
  const ms = remaining(timer, timerNow.value);
  const active = timer.state === 'running' || timer.state === 'paused';
  return (
    <section class="timer-item" data-state={timer.state} aria-label={timer.label}>
      <div class="timer-item-head">
        <h2>{timer.label}</h2>
        <Pressable class="timer-tool p-sm" ariaLabel={`Remove ${timer.label} timer`} onPress={() => updateTimer(timer.id, 'cancel')}>
          <Icon name="close" size="1.25rem" />
        </Pressable>
      </div>
      <div class="timer-countdown tnum" role="timer" aria-label={`${timer.label}: ${formatCountdown(ms)}`} aria-live="off">{formatCountdown(ms)}</div>
      <div class="timer-status" role="status">{timer.state === 'ringing' ? 'Time is up' : timer.state === 'finished' ? 'Finished'
        : timer.state === 'paused' ? 'Paused' : durationLabel(timer.durationMs)}</div>
      <progress class="timer-progress" max={timer.durationMs} value={ms} aria-label={`${timer.label} time remaining`} />
      <div class="timer-actions">
        {active ? <>
          <Pressable class="timer-tool timer-primary p-sm" onPress={() => updateTimer(timer.id, timer.state === 'paused' ? 'resume' : 'pause')}
            ariaLabel={`${timer.state === 'paused' ? 'Resume' : 'Pause'} ${timer.label} timer`}>
            <Icon name={timer.state === 'paused' ? 'play' : 'pause'} size="1.5rem" />
          </Pressable>
          <Pressable class="timer-preset p-sm" onPress={() => updateTimer(timer.id, 'add-minute')} ariaLabel={`Add one minute to ${timer.label} timer`}>
            <Icon name="plus" size="1.15rem" /><span>1 min</span>
          </Pressable>
        </> : <>
          {timer.state === 'ringing' ? <Pressable class="timer-start p-sm" onPress={() => {
            updateTimer(timer.id, 'dismiss');
            if (ringingTimers.value.length === 0) timersOpen.value = false;
          }} ariaLabel={`Dismiss ${timer.label} timer`}>
            <Icon name="check" /><span>Dismiss</span>
          </Pressable> : null}
          <Pressable class="timer-tool p-sm" onPress={() => updateTimer(timer.id, 'restart')} ariaLabel={`Restart ${timer.label} timer`}>
            <Icon name="refresh" />
          </Pressable>
        </>}
      </div>
    </section>
  );
}
