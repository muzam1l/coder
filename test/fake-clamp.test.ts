import { test, expect } from 'bun:test';

import { clamp } from './fake-clamp';

// Flow-demo test: this file states the contract — fix ./fake-clamp.ts, not this.
test('clamp clamps', () => {
  expect(clamp(5, 0, 3)).toBe(3);
  expect(clamp(-2, 0, 3)).toBe(0);
  expect(clamp(1, 0, 3)).toBe(1);
});
