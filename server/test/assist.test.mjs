import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, URL } from 'node:url';
import { WebSocket } from 'ws';
import { MockHomeAssistant } from './mock-ha.mjs';

const HA_PORT = 19323;
const PANEL_PORT = 19399;
const TOKEN = 'assist-test-token';
const SERVER = fileURLToPath(new URL('../dist/server.js', import.meta.url));

let dir;
let configPath;
let ha;
let backend;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, description, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await sleep(20);
  }
  assert.fail(`Timed out waiting for: ${description}`);
}

class TestPanel {
  messages = [];
  seq = 0;

  async connect() {
    this.ws = new WebSocket(`ws://127.0.0.1:${PANEL_PORT}/ws?t=${TOKEN}`);
    this.ws.on('message', (data) => {
      this.messages.push(JSON.parse(data.toString()));
    });

    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    await waitFor(() => this.messages.find((msg) => msg.t === 'hello'), 'hello');
  }

  assist(text, conversationId) {
    this.seq += 1;
    this.ws.send(JSON.stringify({
      t: 'assist',
      id: this.seq,
      text,
      language: 'en-US',
      ...(conversationId ? { conversationId } : {}),
    }));
    return this.seq;
  }

  replyFor(ref) {
    return waitFor(
      () => this.messages.find((msg) => msg.t === 'assist' && msg.ref === ref),
      `Assist reply ${ref}`,
    );
  }

  errorFor(ref) {
    return waitFor(
      () => this.messages.find((msg) => msg.t === 'error' && msg.ref === ref),
      `Assist error ${ref}`,
    );
  }

  close() {
    this.ws?.close();
  }
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'navigator-assist-'));
  configPath = join(dir, 'dashboard.yaml');
  await writeFile(configPath, 'version: 1\n', 'utf8');

  ha = new MockHomeAssistant(HA_PORT);
  ha.conversationSpeech = 'The desk lights are on';
  await ha.start();

  backend = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(PANEL_PORT),
      HOST: '127.0.0.1',
      PANEL_TOKEN: TOKEN,
      CONFIG_PATH: configPath,
      HA_URL: `http://127.0.0.1:${HA_PORT}`,
      HA_TOKEN: 'mock-ha-token',
      IMMICH_URL: '',
      IMMICH_API_KEY: '',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  backend.stdout.on('data', (d) => process.stderr.write(`[backend] ${d}`));
  backend.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`));

  await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${PANEL_PORT}/api/health`);
      return res.ok;
    } catch {
      return false;
    }
  }, 'backend to listen');
});

beforeEach(() => {
  ha.assistTranscript = 'turn on the desk lights';
  ha.conversationSpeech = 'The desk lights are on';
  ha.conversationResponseType = 'action_done';
  ha.conversationResponseData = { success: [], failed: [] };
  ha.conversations = [];
  ha.assistPipelineRuns = [];
  ha.assistAudioChunks = [];
});

after(async () => {
  if (backend && backend.exitCode === null) {
    backend.kill('SIGTERM');
    await new Promise((resolve) => {
      backend.once('exit', resolve);
      setTimeout(() => {
        backend.kill('SIGKILL');
        resolve();
      }, 3000);
    });
  }
  await ha?.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('Assist text is forwarded through the Home Assistant pipeline with TTS', async () => {
  const panel = new TestPanel();
  try {
    await panel.connect();

    const first = panel.assist('turn on the desk lights');
    const reply = await panel.replyFor(first);

    assert.equal(ha.conversations.length, 0);
    assert.equal(ha.assistPipelineRuns.length, 1);
    assert.equal(ha.assistPipelineRuns[0].type, 'assist_pipeline/run');
    assert.equal(ha.assistPipelineRuns[0].start_stage, 'intent');
    assert.equal(ha.assistPipelineRuns[0].end_stage, 'tts');
    assert.equal(ha.assistPipelineRuns[0].input.text, 'turn on the desk lights');
    assert.equal(reply.result.speech, 'The desk lights are on');
    assert.equal(reply.result.audioUrl, '/api/assist/tts?p=%2Fapi%2Ftts_proxy%2Fmock.mp3');
    assert.equal(reply.result.conversationId, 'mock-text-conversation');
    assert.equal(reply.result.success, true);

    const second = panel.assist('what about the fan', reply.result.conversationId);
    await panel.replyFor(second);
    assert.equal(ha.assistPipelineRuns[1].conversation_id, 'mock-text-conversation');
  } finally {
    panel.close();
  }
});

test('Assist rejects empty text before it reaches Home Assistant', async () => {
  const panel = new TestPanel();
  try {
    await panel.connect();
    const ref = panel.assist('   ');
    const error = await panel.errorFor(ref);
    assert.equal(error.message, 'Nothing to send');
  } finally {
    panel.close();
  }
});

test('Assist normalizes Home Assistant unknown error responses', async () => {
  const panel = new TestPanel();
  try {
    ha.conversationResponseType = 'error';
    ha.conversationSpeech = 'Error Unknown';
    ha.conversationResponseData = { code: 'unknown' };

    await panel.connect();
    const ref = panel.assist('turn on the desk lights');
    const reply = await panel.replyFor(ref);

    assert.equal(reply.result.success, false);
    assert.equal(reply.result.responseType, 'error');
    assert.equal(reply.result.speech, 'Home Assistant returned an unknown Assist error');
  } finally {
    panel.close();
  }
});

test('Assist audio is streamed through Home Assistant pipeline STT and TTS', async () => {
  const pcm = Buffer.alloc(16_000 * 2, 0);
  const res = await fetch(
    `http://127.0.0.1:${PANEL_PORT}/api/assist/audio?conversationId=existing-voice`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/octet-stream',
      },
      body: pcm,
    },
  );

  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(ha.assistPipelineRuns.length, 1);
  assert.equal(ha.assistPipelineRuns[0].type, 'assist_pipeline/run');
  assert.equal(ha.assistPipelineRuns[0].start_stage, 'stt');
  assert.equal(ha.assistPipelineRuns[0].end_stage, 'tts');
  assert.equal(ha.assistPipelineRuns[0].input.sample_rate, 16_000);
  assert.equal(ha.assistPipelineRuns[0].conversation_id, 'existing-voice');
  assert.ok(Buffer.concat(ha.assistAudioChunks).equals(pcm));
  assert.equal(body.text, ha.assistTranscript);
  assert.equal(body.speech, 'The desk lights are on');
  assert.equal(body.audioUrl, '/api/assist/tts?p=%2Fapi%2Ftts_proxy%2Fmock.mp3');
  assert.equal(body.conversationId, 'mock-voice-conversation');
  assert.equal(body.success, true);

  const audioRes = await fetch(`http://127.0.0.1:${PANEL_PORT}${body.audioUrl}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(audioRes.status, 200);
  assert.equal(audioRes.headers.get('content-type'), 'audio/mpeg');
  assert.ok(Buffer.from(await audioRes.arrayBuffer()).equals(ha.assistTtsAudio));
});

test('Assist wake socket streams through Home Assistant wake word pipeline', async () => {
  const messages = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PANEL_PORT}/api/assist/wake?t=${TOKEN}`);
  ws.on('message', (data) => {
    messages.push(JSON.parse(data.toString()));
  });

  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    ws.send(Buffer.alloc(4096, 1));
    const msg = await waitFor(
      () => messages.find((item) => item.t === 'result'),
      'wake Assist result',
    );

    assert.equal(ha.assistPipelineRuns.length, 1);
    assert.equal(ha.assistPipelineRuns[0].type, 'assist_pipeline/run');
    assert.equal(ha.assistPipelineRuns[0].start_stage, 'wake_word');
    assert.equal(ha.assistPipelineRuns[0].end_stage, 'tts');
    assert.equal(ha.assistPipelineRuns[0].input.sample_rate, 16_000);
    assert.equal(ha.assistPipelineRuns[0].input.timeout, 120);
    assert.equal(ha.assistPipelineRuns[0].input.noise_suppression_level, 2);
    assert.equal(ha.assistPipelineRuns[0].input.auto_gain_dbfs, 31);
    assert.equal(ha.assistPipelineRuns[0].input.volume_multiplier, 2);
    assert.equal(ha.assistPipelineRuns[0].timeout, 150);
    assert.ok(Buffer.concat(ha.assistAudioChunks).length >= 4096);
    assert.equal(msg.result.text, ha.assistTranscript);
    assert.equal(msg.result.speech, 'The desk lights are on');
    assert.equal(msg.result.audioUrl, '/api/assist/tts?p=%2Fapi%2Ftts_proxy%2Fmock.mp3');
    assert.equal(msg.result.conversationId, 'mock-wake-conversation');
    assert.equal(msg.result.success, true);
  } finally {
    ws.close();
  }
});

test('Assist wake audio fallback runs a command only after the wake phrase', async () => {
  ha.assistTranscript = 'Okay Nabu turn on the desk lights';
  const res = await fetch(`http://127.0.0.1:${PANEL_PORT}/api/assist/wake-audio`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/octet-stream',
    },
    body: Buffer.alloc(16_000, 1),
  });

  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.matched, true);
  assert.equal(body.text, 'Okay Nabu turn on the desk lights');
  assert.equal(body.command, 'turn on the desk lights');
  assert.equal(body.result.speech, 'The desk lights are on');
  assert.equal(body.result.audioUrl, '/api/assist/tts?p=%2Fapi%2Ftts_proxy%2Fmock.mp3');
  assert.equal(ha.assistPipelineRuns.length, 2);
  assert.equal(ha.assistPipelineRuns[0].start_stage, 'stt');
  assert.equal(ha.assistPipelineRuns[0].end_stage, 'stt');
  assert.equal(ha.assistPipelineRuns[1].start_stage, 'intent');
  assert.equal(ha.assistPipelineRuns[1].end_stage, 'tts');
  assert.equal(ha.assistPipelineRuns[1].input.text, 'turn on the desk lights');
});

test('Assist wake audio fallback ignores speech without the wake phrase', async () => {
  ha.assistTranscript = 'turn on the desk lights';
  const res = await fetch(`http://127.0.0.1:${PANEL_PORT}/api/assist/wake-audio`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/octet-stream',
    },
    body: Buffer.alloc(16_000, 1),
  });

  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.matched, false);
  assert.equal(body.text, 'turn on the desk lights');
  assert.equal(ha.assistPipelineRuns.length, 1);
  assert.equal(ha.assistPipelineRuns[0].start_stage, 'stt');
  assert.equal(ha.assistPipelineRuns[0].end_stage, 'stt');
});

test('Assist audio upload requires the panel token', async () => {
  const res = await fetch(`http://127.0.0.1:${PANEL_PORT}/api/assist/audio`, {
    method: 'POST',
    body: Buffer.alloc(16_000 * 2, 0),
  });

  assert.equal(res.status, 401);
});
