window.__ModuleLoader__.load({
  id: 'dsh-codex-link',
  factory: (require) => {
    const {jsx, jsxs} = require('react/jsx-runtime');
    const {SettingsFormModel, Switch, Button} = require('@deepseek-ai/dsh-client-ui-primitives');
    const NS = 'settings.codex-link';
    const ENTRY = 'codex-native-sync';
    const KEYS = ['enabled', 'autoBind', 'reverseBind', 'archiveMirror'];
    const zh = {
      nav: 'Codex 同步', title: 'Codex 聊天同步',
      description: '在 Codex 和 DSH 的原有聊天中，自动接续双方的公开文字消息。',
      enabled: '启用聊天同步', enabledHelp: '暂停后保留全部历史，重新启用后继续补齐。',
      autoBind: '自动接入 Codex 新聊天', autoBindHelp: '发现新的项目或聊天时，自动在 DSH 建立对应会话。',
      reverseBind: '自动接入 DSH 新聊天', reverseBindHelp: '将 DSH 新建的非空聊天接入 Codex；已经绑定的聊天继续双向同步。',
      archiveMirror: '跟随 Codex 的归档状态', archiveMirrorHelp: '在 DSH 跟随归档或恢复对应聊天，历史数据仍然保留。',
      textOnly: '同步内容：你的消息和 AI 的公开回复。命令、工具输出和中间操作不参与同步。',
      runtime: '保存后 DSH 自动应用。Codex 端首次更新需要正常重启一次，此后设置自动生效。',
      loading: '正在读取设置…', readOnly: '当前部署不允许修改设置。',
      save: '保存设置', saving: '正在保存…', discard: '撤销修改', saved: '设置已保存',
      failed: '保存失败，修改仍已保留，请重试。',
    };
    const en = {
      nav: 'Codex sync', title: 'Codex chat sync',
      description: 'Continue public text conversations in the original Codex and DSH chats.',
      enabled: 'Enable chat sync', enabledHelp: 'Keep all history when paused and catch up when resumed.',
      autoBind: 'Connect new Codex chats', autoBindHelp: 'Create matching DSH sessions for new Codex chats and projects.',
      reverseBind: 'Connect new DSH chats', reverseBindHelp: 'Mirror new non-empty DSH chats into Codex. Existing bindings remain bidirectional.',
      archiveMirror: 'Follow Codex archive state', archiveMirrorHelp: 'Archive or restore matching DSH chats while keeping their history.',
      textOnly: 'Only user messages and public AI replies are synced. Commands, tool output and intermediate operations stay out.',
      runtime: 'DSH applies saved settings automatically. Restart Codex once after this initial update; later changes apply automatically.',
      loading: 'Loading settings…', readOnly: 'This deployment stores settings read-only.',
      save: 'Save settings', saving: 'Saving…', discard: 'Discard changes', saved: 'Settings saved',
      failed: 'Could not save. Your edits are retained; please retry.',
    };
    function Card({useCard, t, edit, save, discard}) {
      const state = useCard(snapshot => snapshot);
      const disabled = !state.available || !state.writable || state.saving;
      return jsxs('section', {style: {maxWidth: 760, padding: '4px 0 24px'}, children: [
        jsx('h2', {style: {fontSize: 22, margin: '0 0 12px'}, children: t('title')}),
        jsx('p', {style: {opacity: .72, lineHeight: 1.7}, children: t('description')}),
        !state.available ? jsx('p', {role: 'status', children: t('loading')}) : null,
        state.available && !state.writable ? jsx('p', {role: 'status', children: t('readOnly')}) : null,
        jsx('div', {children: KEYS.map(key => jsxs('div', {
          style: {display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24,
            padding: '18px 0', borderBottom: '1px solid var(--dsw-alias-border-l2, #8883)'},
          children: [jsxs('div', {children: [
            jsx('div', {style: {fontWeight: 500, marginBottom: 5}, children: t(key)}),
            jsx('div', {style: {fontSize: 13, opacity: .65, lineHeight: 1.6}, children: t(key + 'Help')}),
          ]}), jsx(Switch, {label: t(key), checked: state[key].text === 'true', disabled,
            onChange: checked => edit(key, checked ? 'true' : 'false')})],
        }, key))}),
        jsx('p', {style: {fontSize: 13, lineHeight: 1.7, opacity: .7}, children: t('textOnly')}),
        jsx('p', {style: {fontSize: 12, lineHeight: 1.7, opacity: .6}, children: t('runtime')}),
        jsxs('div', {style: {display: 'flex', gap: 12, alignItems: 'center', marginTop: 20}, children: [
          jsx(Button, {disabled: disabled || !state.dirty || state.invalid, onClick: save,
            children: t(state.saving ? 'saving' : 'save')}),
          jsx(Button, {disabled: disabled || !state.dirty, onClick: discard, children: t('discard')}),
          state.available && !state.dirty && !state.failed ? jsx('span', {role: 'status',
            style: {fontSize: 13, opacity: .65}, children: t('saved')}) : null,
        ]}),
        state.failed ? jsx('p', {role: 'alert', children: t('failed')}) : null,
      ]});
    }
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, {zh, en}), 'codex-link: translations');
      const t = ctx.locale.bind(NS);
      const scope = ctx.configForms.get(ENTRY);
      const model = new SettingsFormModel(scope, KEYS.map(field => ({
        field, format: value => value === true ? 'true' : 'false',
        parse: text => text === 'true' || text === 'false' ? {kind: 'set', value: text === 'true'} : undefined,
      })));
      const store = model.bind(() => Object.assign(model.shell(),
        Object.fromEntries(KEYS.map(key => [key, model.field(key)]))));
      ctx.effect(() => () => model.dispose(), 'codex-link: form');
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'codex-link', order: 27, label: () => t('nav'),
        inject: () => ({hooks: {card: store}, t, ...model.actions()}),
      }, Card));
    }
    return {apply, inject: ['slots', 'locale', 'configForms']};
  },
});
