import assert from 'node:assert/strict';
import { attachVideoComparison } from '../../assets/video-controls.js';

function assertSeekSettles(durations, native) {
  const pending = [];
  class Player {
    constructor(duration) {
      this.duration = duration;
      this.time = 0;
      this.currentSrc = 'fixture.mp4';
      this.paused = true;
      this.listeners = new Map();
    }

    get currentTime() { return this.time; }
    set currentTime(value) {
      this.time = value;
      // Browsers dispatch seeking asynchronously, including same-position seeks.
      pending.push(() => this.listeners.get('seeking')?.({ currentTarget: this }));
    }

    addEventListener(type, handler) { this.listeners.set(type, handler); }
    removeEventListener(type) { this.listeners.delete(type); }
    closest() { return null; }
  }

  const players = durations.map(duration => new Player(duration));
  const root = {
    dataset: {},
    querySelector: () => null,
    querySelectorAll: selector => selector === '[data-video-player]' ? players : [],
  };
  const controller = attachVideoComparison(root);
  if (native) players[0].currentTime = players[0].duration / 2;
  else controller.seek(0.5);

  for (let count = 0; pending.length && count < 20; count++) pending.shift()();
  assert.equal(pending.length, 0, 'asynchronous seeking events must settle');
  for (const player of players) assert.equal(player.currentTime, player.duration / 2);

  controller.seek(0.5);
  assert.equal(pending.length, 0, 'an already synchronized seek must not enqueue another seek');
  controller.dispose();
}

assertSeekSettles([5], true);
assertSeekSettles([5, 8.3], true);
assertSeekSettles([5, 8.3], false);
console.log('PASS asynchronous video seeking fixture');
