// Dummy module for flow demos: intentionally buggy. The fix is to correct
// this implementation so fake-clamp.test.ts passes — do not edit the test.
export function clamp(value: number, min: number, max: number): number {
  return Math.max(value, max);
}
