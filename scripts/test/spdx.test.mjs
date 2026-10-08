// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { parseSpdx, satisfiesSpdx } from '../lib/spdx.mjs';

const ALLOW = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-3-Clause']);

describe('satisfiesSpdx', () => {
  it.each([
    ['MIT', true],
    ['GPL-2.0-only', false],
    ['(MIT)', true],
    ['MIT OR GPL-2.0-only', true],
    ['GPL-2.0-only OR MIT', true],
    ['MIT AND ISC', true],
    ['MIT AND GPL-2.0-only', false],
    // Parentheses and precedence: the old split-based gate accepted this one.
    ['(MIT OR GPL-2.0-only) AND GPL-2.0-only', false],
    ['GPL-2.0-only AND (MIT OR GPL-2.0-only)', false],
    ['MIT AND (GPL-2.0-only OR ISC)', true],
    // AND binds tighter than OR.
    ['GPL-2.0-only AND MIT OR ISC', true],
    ['MIT OR ISC AND GPL-2.0-only', true],
    ['(MIT OR ISC) AND GPL-2.0-only', false],
    ['((MIT OR GPL-3.0-only) AND (ISC OR Apache-2.0))', true],
    // Lower-case operators as seen in some package.json files.
    ['MIT or GPL-2.0-only', true],
  ])('%s -> %s', (expr, ok) => {
    expect(satisfiesSpdx(expr, ALLOW)).toBe(ok);
  });

  it('WITH exceptions only pass when the exact pair is allowlisted', () => {
    expect(satisfiesSpdx('Apache-2.0 WITH LLVM-exception', ALLOW)).toBe(false);
    const withPair = new Set([...ALLOW, 'Apache-2.0 WITH LLVM-exception']);
    expect(satisfiesSpdx('Apache-2.0 WITH LLVM-exception', withPair)).toBe(true);
    expect(satisfiesSpdx('(Apache-2.0 WITH LLVM-exception) OR GPL-2.0-only', withPair)).toBe(true);
    expect(satisfiesSpdx('MIT AND GPL-2.0-only WITH Classpath-exception-2.0', withPair)).toBe(
      false,
    );
  });

  it.each([
    '',
    '   ',
    '(MIT',
    'MIT)',
    '(GPL-2.0-only OR (MIT)',
    'MIT OR',
    'AND MIT',
    'MIT AND AND ISC',
    'MIT WITH',
    'MIT ISC',
    'SEE LICENSE IN LICENSE.md',
    'UNLICENSED',
    'LicenseRef-Proprietary',
    'MIT, ISC',
  ])('fails closed on malformed or unknown input: %j', (expr) => {
    expect(satisfiesSpdx(expr, ALLOW)).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(satisfiesSpdx(undefined, ALLOW)).toBe(false);
    expect(satisfiesSpdx({ type: 'MIT' }, ALLOW)).toBe(false);
  });

  it('builds an AST with WITH > AND > OR precedence', () => {
    expect(parseSpdx('A OR B AND C WITH D')).toEqual({
      type: 'or',
      parts: [
        { type: 'id', id: 'A' },
        {
          type: 'and',
          parts: [
            { type: 'id', id: 'B' },
            { type: 'with', license: 'C', exception: 'D' },
          ],
        },
      ],
    });
  });
});
