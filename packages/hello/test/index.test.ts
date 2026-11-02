import { expect, test } from 'vitest';
import { greet } from '../src/index.js';

test('greet', () => {
  expect(greet('world')).toBe('Hello, world!');
});
