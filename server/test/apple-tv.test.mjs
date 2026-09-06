import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { swipeBridgeRequest } from '../dist/testkit.js';

describe('Apple TV swipe bridge protocol', () => {
  it('does not let fields from the browser message overwrite the Python request type', () => {
    const browserMessage = {
      t: 'apple-tv-swipe',
      id: 41,
      appleTv: 'living-room',
      startX: 100,
      startY: 200,
      endX: 800,
      endY: 200,
      durationMs: 350,
    };

    assert.deepEqual(swipeBridgeRequest('living-room', browserMessage), {
      t: 'swipe',
      device: 'living-room',
      startX: 100,
      startY: 200,
      endX: 800,
      endY: 200,
      durationMs: 350,
    });
  });
});
