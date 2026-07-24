import { test, expect } from 'bun:test';

import { add } from './fake-add';

// Flow-demo test: this file states the contract — fix ./fake-add.ts, not this.
test('add adds', () => {
  expect(add(2, 3)).toBe(5);
});
