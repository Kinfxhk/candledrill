# Licensing decisions

## Project licence: AGPL-3.0-or-later

Chosen so that anyone who modifies CandleDrill and offers it to others as a hosted
(network) service must publish their source code under the same licence. This keeps
the project free and makes it hard to wrap it into a closed, paid subscription
service, which is the opposite of the project's goal.

- `LICENSE` is the unmodified text from https://www.gnu.org/licenses/agpl-3.0.txt
  (fetched 2026-10-07, 661 lines, SHA-256
  `0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0`). Its terms
  section was compared (whitespace-normalised) with the SPDX
  `AGPL-3.0-or-later` text and is identical.
- Every source file carries `SPDX-License-Identifier: AGPL-3.0-or-later`.

## Compatibility of dependencies

| Licence                         | Compatible with AGPLv3?                                    | Source                                                                                                                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apache-2.0 (lightweight-charts) | Yes (one-way)                                              | FSF licence list: "a free software license, compatible with version 3 of the GNU GPL"; Apache Software Foundation: "Apache 2 software can therefore be included in GPLv3 projects". AGPLv3 §13 permits combining with GPLv3 works. |
| MIT, ISC, BSD-2/3-Clause, 0BSD  | Yes                                                        | FSF licence list (lax permissive, GPL-compatible)                                                                                                                                                                                  |
| MPL-2.0                         | Yes (unless marked "Incompatible With Secondary Licenses") | FSF licence list; MPL-2.0 §3.3                                                                                                                                                                                                     |
| GPL-2.0-only                    | **No**                                                     | Blocked by `scripts/check-licenses.mjs`                                                                                                                                                                                            |

Pages read on 2026-10-07:

- https://www.gnu.org/licenses/license-list.html#apache2
- https://www.apache.org/licenses/GPL-compatibility.html

The enforced allowlist lives in `scripts/check-licenses.mjs`. Dev-only tooling may
additionally use CC-BY and Python-2.0 licences because it is never distributed.

## Contributions

Contributions are accepted under AGPL-3.0-or-later with a Developer Certificate of
Origin sign-off (`git commit -s`). See `CONTRIBUTING.md`.

_This document is an engineering record, not legal advice._
