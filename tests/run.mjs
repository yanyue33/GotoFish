/**
 * 测试入口：node tests/run.mjs
 *
 * 只覆盖「逻辑层」（src/core、src/data、src/systems）。
 * 渲染层（three.js / DOM）靠 tools/smoke.mjs 做静态检查，靠浏览器做人工验收。
 */

import { run } from './harness.mjs';
import './items.test.mjs';
import './state.test.mjs';

const ok = await run();
process.exit(ok ? 0 : 1);
