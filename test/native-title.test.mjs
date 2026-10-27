import test from 'node:test';
import assert from 'node:assert/strict';
import {anchor} from './native-support.mjs';
import {runtime} from '../packages/dsh-plugin/src/runtime.mjs';
import {runtimeAnchor} from '../packages/dsh-plugin/src/configuration.mjs';

test('native title schema accepts the bundle budget and preserves long Codex names',{skip:!anchor},async()=>{
  const r=await runtime(anchor),title=await r.load('@deepseek-ai/dsh-session-title');
  const config=title.default.Config['~standard'].validate({fallbackMaxWords:5,fallbackMaxBytes:40,maxTitleBytes:8192});
  assert(!config.issues);
  const source='Continuing from '+ '较长的中文聊天名称'.repeat(8);
  assert.notEqual(title.normalizeSessionTitle(source,80),source);
  assert.equal(title.normalizeSessionTitle(source,8192),source);
  assert.equal(title.titleProjectionDefinition.wire.view(source),source);
  assert(runtimeAnchor({}, {},[process.execPath,anchor]).includes('dsh-session'));
});
