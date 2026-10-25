// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const library = readFileSync(`${root}/src/library.ts`, 'utf8');
const main = readFileSync(`${root}/src/main.ts`, 'utf8');
const format = readFileSync(`${root}/src/format.ts`, 'utf8');
const styles = readFileSync(`${root}/src/styles.css`, 'utf8');
const phone = readFileSync(`${root}/src/phone.css`, 'utf8');

describe('library delete icon', () => {
  it('uses one red ✕ button on the dataset card and the practice row', () => {
    expect(library).toMatch(
      /deleteIconButton\(\s*`\$\{t\('lib\.delete'\)\} \$\{d\.name\}`,\s*`delete-dataset-\$\{d\.id\}`,?\s*\)/,
    );
    expect(library).toContain("if (!confirm(t('lib.confirmDelete'))) return;");
    expect(library).not.toContain("class: 'small ghost'");

    expect(main).toContain(
      "deleteIconButton(`${t('lib.delete')} ${s.name}`, `delete-session-${s.id}`)",
    );
    expect(main).toContain("if (!confirm(t('lib.delete') + '?')) return;");
    expect(main).not.toMatch(/class: 'small ghost'[^)]*t\('lib\.delete'\)/);

    expect(format).toContain("class: 'icon-delete'");
    expect(format).toContain('aria-hidden');
    expect(format).toContain("stroke', 'currentColor'");
    const icon = styles.slice(
      styles.indexOf('button.icon-delete {'),
      styles.indexOf('input,', styles.indexOf('button.icon-delete {')),
    );
    expect(icon).toMatch(/width:\s*44px;/);
    expect(icon).toMatch(/height:\s*44px;/);
    expect(icon).toMatch(/min-width:\s*44px;/);
    expect(icon).toMatch(/min-height:\s*44px;/);
    expect(icon).toMatch(/color:\s*var\(--down\)/);
    expect(icon).toMatch(/button\.icon-delete svg \{[^}]*width:\s*24px;/);
    expect(icon).toMatch(/button\.icon-delete svg \{[^}]*height:\s*24px;/);
    expect(phone).toMatch(/#session-table td:last-child button\.icon-delete \{\s*width:\s*100%;/);
  });
});
