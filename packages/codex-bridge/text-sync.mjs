import fs from 'node:fs';
import path from 'node:path';
import {atomicJson, readJson, PREFIX, hash, codexId} from './history.mjs';

export const REVISION = '0.3.5-optional-operations';

export function incomingMessages(view, sessionId, identitySessionId = sessionId) {
  if (view.targetSessionId !== sessionId) throw Error('DSH_BINDING_MISMATCH');
  return (view.messages ?? []).filter(m => typeof m.id === 'string' && !m.id.startsWith('shared-chat-') &&
    ['user', 'assistant'].includes(m.role) && typeof m.text === 'string' && m.text.trim() &&
    !(m.contentTypes ?? []).some(t => !['text', 'thinking', 'reasoning'].includes(t)) && !m.operation)
    .map(m => ({id: codexId(identitySessionId, m.id), dshId: m.id, role: m.role, text: m.text, time: m.time ?? Date.now(), seq: m.seq}));
}

/** Save both directions before acknowledging an automatically created binding. */
export function persistBinding(file, binding) {
  const config = readJson(file, null);
  if (!config || !Array.isArray(config.bindings)) throw Error('INVALID_BINDING_CONFIG');
  const rows = config.bindings;
  const old = rows.find(b => b.threadId === binding.threadId);
  if (old && old.sessionId !== binding.sessionId) throw Error('BINDING_CONFLICT');
  if (rows.some(b => b.sessionId === binding.sessionId && b.threadId !== binding.threadId)) throw Error('SESSION_ALREADY_BOUND');
  const value = {...old, threadId: binding.threadId, sessionId: binding.sessionId, title: binding.title ?? '',
    identitySessionId: binding.identitySessionId ?? old?.identitySessionId ?? binding.sessionId,
    sourceFile: binding.rolloutPath ?? old?.sourceFile, ledgerFile: binding.ledger.file,
    origin: binding.origin ?? old?.origin ?? 'codex', archived: !!binding.archived, registered: binding.registered !== false};
  if (old) rows[rows.indexOf(old)] = value; else rows.push(value);
  atomicJson(file, config);
}

/** Durable per-chat forward outbox. Only complete, public response messages are collected. */
export class TextOutbox {
  constructor(file, threadId) {
    this.file = file; this.threadId = threadId;
    this.data = readJson(file, {version: 1, threadId, sourceFile: null, offset: 0, line: 0, pending: []});
    if (this.data.threadId !== threadId) throw Error('OUTBOX_BINDING_MISMATCH');
  }
  save() { atomicJson(this.file, this.data); }
  scan(sourceFile) {
    if (!sourceFile || !fs.existsSync(sourceFile)) return;
    if (this.data.sourceFile && path.resolve(this.data.sourceFile) !== path.resolve(sourceFile)) {
      const fd = fs.openSync(sourceFile, 'r');
      try {
        const bytes = Buffer.alloc(65536), n = fs.readSync(fd, bytes, 0, bytes.length, 0);
        const text = bytes.subarray(0, n).toString('utf8'), end = text.indexOf('\n');
        if (end < 0) throw Error('SOURCE_PATH_UNVERIFIED');
        const first = JSON.parse(text.slice(0, end));
        if (first.type !== 'session_meta' || first.payload?.id !== this.threadId) throw Error('SOURCE_PATH_CHANGED');
      } finally { fs.closeSync(fd); }
    }
    const size = fs.statSync(sourceFile).size;
    if (size < this.data.offset) throw Error('SOURCE_TRUNCATED');
    if (size === this.data.offset) return;
    const fd = fs.openSync(sourceFile, 'r');
    let position = this.data.offset, pending = Buffer.alloc(0);
    const known = new Set(this.data.pending.map(m => m.id));
    try {
      while (position < size) {
        const buffer = Buffer.alloc(Math.min(1024 * 1024, size - position));
        const n = fs.readSync(fd, buffer, 0, buffer.length, position); if (!n) break;
        position += n; pending = Buffer.concat([pending, buffer.subarray(0, n)]);
        let end;
        while ((end = pending.indexOf(10)) >= 0) {
          const bytes = pending.subarray(0, end); pending = pending.subarray(end + 1);
          this.data.offset += end + 1; this.data.line++;
          if (!bytes.length) continue;
          const row = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')), p = row.payload;
          if (row.type !== 'response_item' || p?.type !== 'message' || !['user', 'assistant'].includes(p.role)) continue;
          if (String(p.id ?? '').startsWith(PREFIX)) continue;
          if (p.role === 'assistant' && !['commentary', 'final_answer'].includes(p.phase)) continue;
          const text = (p.content ?? []).filter(b => ['text', 'input_text', 'output_text'].includes(b.type)).map(b => b.text ?? '').join('').trim();
          if (!text || (p.role === 'user' && /^\s*<(environment_context|external_codex_apps_open_page)>/.test(text))) continue;
          const id = p.id ?? 'line-' + this.data.line;
          if (known.has(id)) continue;
          this.data.pending.push({id, role: p.role, text, time: Date.parse(row.timestamp) || 0}); known.add(id);
        }
      }
    } finally { fs.closeSync(fd); }
    this.data.sourceFile = sourceFile; this.save();
  }
  forget(ids) { this.data.pending = this.data.pending.filter(m => !ids.has(m.id)); this.save(); }
  importedId(id) { return 'shared-chat-' + hash('codex:' + this.threadId + '\0' + id); }
}
