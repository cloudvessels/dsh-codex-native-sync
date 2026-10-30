// Snapshot messages are public-text projections, not the original content blocks.
// Older bridges reject a whole row if contentTypes contains image/tool-call, so
// describe only the exported blocks and retain source types as separate metadata.
export function publicTextMessage(message, event) {
  const blocks = message.content.filter(block => block.type === 'text' && typeof block.text === 'string');
  return {
    id: message.id, role: message.role,
    text: blocks.map(block => block.text).join(''), seq: event.seq, time: event.time,
    contentTypes: blocks.map(() => 'text'),
    sourceContentTypes: message.content.map(block => block.type),
  };
}
