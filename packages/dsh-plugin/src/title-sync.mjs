// Rename bound live mirrors through the native API. Archived old copies are
// deliberately outside the binding map; no message or binding is rewritten.
export function sessionTitle(row) {
  const projected=row.projections?.values?.title;
  return (typeof projected==='string'?projected:projected?.title) ?? row.title ?? null;
}
export async function syncBoundTitles(ctx, bindings, rows, dry = false, receipts = new Map()) {
  const titles = new Map(rows.filter(row => typeof row.title === 'string' && row.title.trim()).map(row => [row.id, row.title]));
  const list = await ctx.sessionController.list({}, AbortSignal.timeout(10000));
  const sessions = new Map((list.items ?? []).map(row => [row.sessionId, row]));
  const result = {dry, checked: bindings.size, changed: [], unchanged: 0, skipped: [], errors: []};
  let wrote=false;
  for (const [threadId, sessionId] of bindings) {
    const wanted = titles.get(threadId), current = sessions.get(sessionId);
    if (!wanted || !current) { result.skipped.push({threadId, sessionId, reason: !wanted ? 'NO_CODEX_TITLE' : 'NO_DSH_SESSION'}); continue; }
    const previous = sessionTitle(current) ?? '';
    if (previous === wanted) { result.unchanged++;receipts.delete(sessionId); continue; }
    const change = {threadId, sessionId, previous, title: wanted};
    if (dry) { result.changed.push(change); continue; }
    const receipt=receipts.get(sessionId);
    if(receipt?.wanted===wanted&&receipt.stored===previous){result.errors.push({...change,error:'DSH_TITLE_LIMIT: increase session-title.maxTitleBytes and restart DSH'});continue;}
    try {
      const accepted = await ctx.sessionController.rename({sessionId, title: wanted});
      wrote=true;
      const stored = String(accepted?.title ?? '');
      if(stored!==wanted){receipts.set(sessionId,{wanted,stored});throw Error('DSH_TITLE_LIMIT_OR_NORMALIZATION: '+stored);}
      receipts.delete(sessionId);
      result.changed.push({...change, stored});
    } catch (error) { result.errors.push({...change, error: error.message}); }
  }
  if (!dry && wrote) await ctx.sessionPersistence.flush();
  return result;
}
