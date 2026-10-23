// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const styles = readFileSync(`${root}/packages/web/src/styles.css`, 'utf8');
const v1 = readFileSync(`${root}/packages/web/src/v1.css`, 'utf8');
const chart = readFileSync(`${root}/packages/web/src/chart.ts`, 'utf8');

describe('narrow viewport layout', () => {
  it('stacks .grid3 to one column at the 1000px breakpoint', () => {
    const block = styles.slice(styles.indexOf('@media (max-width: 1000px)'));
    expect(block).toMatch(/\.grid3 \{\s*grid-template-columns:\s*minmax\(0,\s*1fr\);/);
    expect(block).toMatch(/min-width:\s*0/);
    expect(v1).not.toMatch(/\.grid3 \{\s*grid-template-columns:\s*1fr 1fr;/);
  });

  it('keeps the practice chart flexible and the indicator list out of the cell', () => {
    expect(v1).toMatch(/\.indicator-panel \{\s*position:\s*fixed;/);
    expect(v1).toMatch(
      /@media \(max-width: 520px\) \{[\s\S]*\.bottom \.tabbar \{\s*flex-wrap:\s*wrap;/,
    );
    expect(styles).toMatch(/\.chart-cell \{\s*min-height:\s*0;/);
  });

  it('does not let a global border-box rule stretch chart axis canvases', () => {
    expect(styles).toMatch(/\.tv-lightweight-charts \* \{\s*box-sizing:\s*content-box;/);
    expect(chart).toContain('entireTextOnly: true');
    expect(chart).toContain('leftPriceScale:');
  });
});
