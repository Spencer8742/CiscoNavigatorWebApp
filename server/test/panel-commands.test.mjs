import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePanelCommand, parseTimerDuration, panelCommandResult } from '../dist/testkit.js';

test('stop and cancellation are exact commands, not prefixes of device commands', () => {
  for (const text of ['stop', 'Stop!', 'please stop', 'stop please', 'cancel', 'never mind', 'stop listening', 'Hey Jarvis, stop.'])
    assert.deepEqual(parsePanelCommand(text), { type: 'cancel-assist' });
  for (const text of ['stop the music', 'cancel my meeting', 'stop the fan', 'do not stop', 'never mind turn off the lights'])
    assert.equal(parsePanelCommand(text), null);
  assert.equal(panelCommandResult('stop').audioUrl, null, 'cancellation is silent');
});

test('timer requests accept spoken numbers, compound units and named timers', () => {
  for (const text of ['start timer for 5 minutes', 'set a five-minute timer', 'please start a timer for five minutes'])
    assert.deepEqual(parsePanelCommand(text), { type: 'timer-start', durationMs: 300000 });
  assert.deepEqual(parsePanelCommand('start a timer for one hour and thirty minutes called pasta'), {
    type: 'timer-start', durationMs: 5400000, label: 'pasta',
  });
  assert.equal(parseTimerDuration('twenty five seconds'), 25000);
  assert.equal(parseTimerDuration('one second'), 1000);
  assert.equal(parseTimerDuration('1.5 minutes'), 90000);
  assert.equal(parseTimerDuration('24 hours'), 86400000);
});

test('timer parsing rejects guesses, negative, excessive and unrelated durations', () => {
  for (const text of ['5', '-5 minutes', 'minus five minutes', 'zero minutes', '25 hours', 'forever', 'five minutes then turn off lights', '1e10 seconds'])
    assert.equal(parseTimerDuration(text), null, text);
  assert.equal(panelCommandResult('start timer for zero minutes').success, false);
  assert.equal(parsePanelCommand('turn off the lights in five minutes'), null);
});

test('timer controls have explicit targets and all requires an explicit command', () => {
  assert.deepEqual(parsePanelCommand('cancel all timers'), { type: 'timer-control', operation: 'cancel', all: true });
  assert.deepEqual(parsePanelCommand('pause the pasta timer'), { type: 'timer-control', operation: 'pause', label: 'pasta' });
  assert.deepEqual(parsePanelCommand('resume timer'), { type: 'timer-control', operation: 'resume' });
  assert.deepEqual(parsePanelCommand('show my timers'), { type: 'timer-show' });
});
