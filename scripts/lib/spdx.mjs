// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Small, strict SPDX licence-expression evaluator for the dependency licence gate.
// Grammar (SPDX spec, annex D), highest precedence first:
//   simple   := license-id ["+"] | "LicenseRef-..." | "DocumentRef-...:LicenseRef-..."
//   with     := simple ["WITH" exception-id]
//   and      := with {"AND" with}
//   or       := and {"OR" and}
//   primary  := with | "(" or ")"
// Evaluation: OR is satisfied when any branch is allowed, AND when every branch is
// allowed, and "X WITH Y" only when the exact pair "X WITH Y" is allowlisted.
// Anything that does not parse cleanly fails closed (returns false).

const ID_RE = /^[A-Za-z0-9.\-+:]+$/;

/** Split an expression into tokens; returns null on characters SPDX does not allow. */
export function tokenize(expr) {
  const tokens = [];
  const re = /\s*(\(|\)|[^\s()]+)/y;
  let pos = 0;
  const s = String(expr);
  while (pos < s.length) {
    if (/^\s*$/.test(s.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m) return null;
    tokens.push(m[1]);
    pos = re.lastIndex;
  }
  return tokens;
}

/** Parse to an AST, or null when the expression is malformed. */
export function parseSpdx(expr) {
  const tokens = tokenize(expr);
  if (!tokens || tokens.length === 0) return null;
  let i = 0;
  const peekOp = () => (tokens[i] ?? '').toUpperCase();
  const isOp = (t) => ['AND', 'OR', 'WITH'].includes(t.toUpperCase());

  function primary() {
    const t = tokens[i];
    if (t === undefined) throw new Error('unexpected end');
    if (t === '(') {
      i++;
      const node = or();
      if (tokens[i] !== ')') throw new Error('missing )');
      i++;
      return node;
    }
    if (t === ')' || isOp(t) || !ID_RE.test(t)) throw new Error(`unexpected ${t}`);
    i++;
    if (peekOp() === 'WITH') {
      i++;
      const exc = tokens[i];
      if (exc === undefined || exc === '(' || exc === ')' || isOp(exc) || !ID_RE.test(exc))
        throw new Error('bad exception');
      i++;
      return { type: 'with', license: t, exception: exc };
    }
    return { type: 'id', id: t };
  }
  function and() {
    const parts = [primary()];
    while (peekOp() === 'AND') {
      i++;
      parts.push(primary());
    }
    return parts.length === 1 ? parts[0] : { type: 'and', parts };
  }
  function or() {
    const parts = [and()];
    while (peekOp() === 'OR') {
      i++;
      parts.push(and());
    }
    return parts.length === 1 ? parts[0] : { type: 'or', parts };
  }

  try {
    const ast = or();
    return i === tokens.length ? ast : null;
  } catch {
    return null;
  }
}

/** Does `expr` satisfy the allowlist? Unknown, malformed or empty input fails closed. */
export function satisfiesSpdx(expr, allowed) {
  if (typeof expr !== 'string') return false;
  const ast = parseSpdx(expr);
  if (!ast) return false;
  const evalNode = (n) => {
    switch (n.type) {
      case 'id':
        return allowed.has(n.id);
      case 'with':
        return allowed.has(`${n.license} WITH ${n.exception}`);
      case 'and':
        return n.parts.every(evalNode);
      case 'or':
        return n.parts.some(evalNode);
      default:
        return false;
    }
  };
  return evalNode(ast);
}
