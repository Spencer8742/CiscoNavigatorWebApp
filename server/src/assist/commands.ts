import parseDuration from 'parse-duration';
import { wordsToNumbers } from 'words-to-numbers';
import type { AssistResult, PanelCommand } from '@shared/protocol.ts';

type ParsedCommand = PanelCommand | { type: 'invalid'; message: string };
const UNIT = '(?:hours?|hrs?|minutes?|mins?|seconds?|secs?)';
const DURATION_PART = new RegExp(`(.+?)\\s+(${UNIT})(?=\\s|$)`, 'g');

export function parsePanelCommand(raw: string): ParsedCommand | null {
  if (raw.length > 200) return null;
  const text = raw.toLowerCase().trim().replace(/[.!?,]+$/g, '')
    .replace(/^(?:please\s+|(?:hey|okay|ok) jarvis[ ,]+|can you\s+|could you\s+)/g, '')
    .replace(/\s+please$/, '').replace(/\s+/g, ' ');
  // Never let "stop the music" or "cancel my meeting" become a panel cancellation.
  if (/^(?:stop|cancel|never ?mind|stop listening|cancel that)$/.test(text)) return { type: 'cancel-assist' };
  if (/^(?:show|open)(?: me)? (?:the |my )?timers?$/.test(text)) return { type: 'timer-show' };
  const control = /^(pause|resume|continue|cancel|stop|delete) (?:the |my )?(?:(all)(?: the)? |(.+?) )?timers?$/.exec(text);
  if (control) {
    const verb = control[1];
    return { type: 'timer-control', operation: verb === 'pause' ? 'pause' : /^(resume|continue)$/.test(verb!) ? 'resume' : 'cancel',
      ...(control[2] ? { all: true } : {}), ...(control[3] ? { label: control[3] } : {}) };
  }
  const start = /^(?:start|set|create)(?: me)? (?:a |an )?timer (?:for )?(.+)$/.exec(text)
    ?? /^(?:start|set|create)(?: me)? (?:a |an )?(.+?) timer$/.exec(text);
  if (!start) return null;
  const [, durationText, label] = /^(.+?)(?: (?:called|named) (.+))?$/.exec(start[1]!)!;
  const durationMs = parseTimerDuration(durationText!);
  if (durationMs === null) return { type: 'invalid', message: 'Choose a timer from 1 second to 24 hours.' };
  return { type: 'timer-start', durationMs, ...(label ? { label: label.slice(0, 40) } : {}) };
}

export function parseTimerDuration(raw: string): number | null {
  if (raw.length > 99) return null;
  if (/(?:^|\s)-\s*\d|\b(?:negative|minus)\b/.test(raw)) return null;
  const text = raw.replace(/-/g, ' ').trim();
  const parts: string[] = [];
  let end = 0;
  for (const match of text.matchAll(DURATION_PART)) {
    if (match.index !== end) return null;
    const amount = match[1]!.trim().replace(/^and /, '').replace(/^(?:a|an)$/, 'one');
    // Convert quantities separately: words-to-numbers also treats "second" as an ordinal.
    const numeric = wordsToNumbers(amount);
    if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(String(numeric))) return null;
    parts.push(`${numeric} ${match[2]}`);
    end = match.index + match[0].length;
  }
  if (end !== text.length || parts.length === 0) return null;
  const ms = parseDuration(parts.join(' '));
  return ms !== null && Number.isFinite(ms) && ms >= 1000 && ms <= 86400000 ? Math.round(ms) : null;
}

export function panelCommandResult(text: string): AssistResult | null {
  const command = parsePanelCommand(text);
  if (!command) return null;
  return {
    text, speech: command.type === 'invalid' ? command.message : null,
    audioUrl: null, conversationId: null, responseType: 'panel_command',
    success: command.type !== 'invalid',
    ...(command.type !== 'invalid' ? { panelCommand: command } : {}),
  };
}
