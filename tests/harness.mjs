/**
 * 极简测试框架（零依赖）。
 * 刻意不引 jest / vitest：这个项目要在没有任何 node_modules 的情况下也能跑测试。
 */

const suites = [];
let current = null;

export function describe(name, fn) {
  current = { name, tests: [] };
  suites.push(current);
  fn();
  current = null;
}

export function it(name, fn) {
  if (!current) throw new Error('it() 必须写在 describe() 里');
  current.tests.push({ name, fn });
}

export class AssertionError extends Error {}

export function assert(cond, msg = '断言失败') {
  if (!cond) throw new AssertionError(msg);
}

export function equal(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new AssertionError(`${msg}\n  期望: ${fmt(expected)}\n  实际: ${fmt(actual)}`);
  }
}

export function notEqual(actual, expected, msg = '') {
  if (actual === expected) {
    throw new AssertionError(`${msg}\n  不应该等于: ${fmt(expected)}`);
  }
}

export function close(actual, expected, tol = 1e-6, msg = '') {
  if (Math.abs(actual - expected) > tol) {
    throw new AssertionError(`${msg}\n  期望: ${expected} ±${tol}\n  实际: ${actual}`);
  }
}

export function deepEqual(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new AssertionError(`${msg}\n  期望: ${b}\n  实际: ${a}`);
  }
}

export function between(actual, lo, hi, msg = '') {
  if (!(actual >= lo && actual <= hi)) {
    throw new AssertionError(`${msg}\n  期望区间: [${lo}, ${hi}]\n  实际: ${actual}`);
  }
}

export function throws(fn, msg = '期望抛错但没有') {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new AssertionError(msg);
}

function fmt(v) {
  if (typeof v === 'number') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** 运行全部用例，返回是否全部通过 */
export async function run() {
  let passed = 0;
  let failed = 0;
  const failures = [];
  const t0 = Date.now();

  for (const suite of suites) {
    console.log(`\n\x1b[36m${suite.name}\x1b[0m`);
    for (const t of suite.tests) {
      try {
        await t.fn();
        passed += 1;
        console.log(`  \x1b[32m✓\x1b[0m ${t.name}`);
      } catch (err) {
        failed += 1;
        const detail = err instanceof AssertionError ? err.message : (err && err.stack) || String(err);
        failures.push({ suite: suite.name, test: t.name, detail });
        console.log(`  \x1b[31m✗\x1b[0m ${t.name}`);
        console.log(`      ${String(detail).split('\n').join('\n      ')}`);
      }
    }
  }

  const ms = Date.now() - t0;
  console.log(`\n${'─'.repeat(56)}`);
  if (failed === 0) {
    console.log(`\x1b[32m全部通过\x1b[0m：${passed} 个用例（${ms} ms）`);
  } else {
    console.log(`\x1b[31m失败 ${failed} 个\x1b[0m，通过 ${passed} 个（${ms} ms）`);
    for (const f of failures) {
      console.log(`  · [${f.suite}] ${f.test}`);
    }
  }
  return failed === 0;
}
