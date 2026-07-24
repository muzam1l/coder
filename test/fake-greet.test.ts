import { test, expect } from 'bun:test';

import { greet } from './fake-greet';

// Flow-demo test: this file states the contract — fix ./fake-greet.ts, not this.
test('greet greets', () => {
  expect(greet('coder')).toBe('hello coder');
});
