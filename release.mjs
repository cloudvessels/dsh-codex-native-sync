import fs from 'node:fs';
import path from 'node:path';

// Validate the source pair before either side is changed. This is not a live
// connection check: the two apps still require the README acceptance steps.
export function readRelease(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const components = manifest.syncComponents.map(expected => {
    const actual = JSON.parse(fs.readFileSync(path.join(root, expected.path, 'package.json'), 'utf8'));
    if (actual.name !== expected.name || actual.version !== expected.version) {
      throw Error(`配套组件版本不匹配：${expected.path} 需要 ${expected.name}@${expected.version}，实际为 ${actual.name}@${actual.version}。请使用同一份完整发布包。`);
    }
    return {...expected};
  });
  return {version: manifest.version, components};
}
