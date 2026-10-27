import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

export async function runtime(anchor) {
  const require=createRequire(anchor);
  const load=async n=>import(pathToFileURL(require.resolve(n)).href);
  const [s,f,p,c]=await Promise.all([
    load('@deepseek-ai/dsh-session'),
    load('@deepseek-ai/dsh-session-format-v3-to-v4'),
    load('@deepseek-ai/dsh-session-format-catalog/message-projections'),
    load('@deepseek-ai/cordis'),
  ]);
  function validate(header,events,inheritedEventCount=0){
    const canonical={...header,delegationDepth:header.delegationDepth??0,isSeeded:header.isSeeded??false};
    f.restoreReleasedV4Artifact({header:canonical,events,inheritedEventCount},s.KNOWN_SESSION_EVENT_TYPES);
    s.Session.fromRestore(canonical.id,structuredClone(events),structuredClone(canonical),inheritedEventCount,'detached',p.currentSessionMessageProjections);
  }
  return {load,validate,...s,Context:c.Context};
}
