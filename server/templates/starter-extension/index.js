// __ID__ — a Reverie extension. See docs/EXTENSIONS.md for the full `rv` API.
// Everything you register through `rv` is removed automatically when the extension is turned off.

export function activate(rv) {
    // 1. A prompt injection that follows a setting (settings come from reverie-extension.json).
    const sync = () => {
        if (rv.settings.get('enabled')) rv.prompt.inject('reminder', rv.settings.get('reminder'), { position: 'depth', depth: 2 });
        else rv.prompt.remove('reminder');
    };
    sync();
    rv.settings.onChange(sync);

    // 2. A tab in the character sheet panel.
    rv.ui.addPanel({
        id: 'stats',
        title: 'Stats',
        icon: 'chart-simple',
        render(container) {
            container.innerHTML = `<div class="__ID__-panel"><div class="__ID__-stat">${rv.chat.messages().length}</div><div>messages in this story</div></div>`;
        },
    });

    // 3. Render a custom code block. If the AI writes:
    //      ```mood
    //      {"mood": "happy", "level": 7}
    //      ```
    //    this draws it natively (no iframe), styled by your theme.
    rv.renderers.register('mood', (code, container) => {
        const data = JSON.parse(code);
        container.innerHTML = `<div class="__ID__-mood"><b>Mood:</b> ${rv.ui.el('span', {}, data.mood).outerHTML} (${Number(data.level) || 0}/10)</div>`;
    });

    // 4. A slash command and a per-message action.
    rv.commands.register({
        name: 'wordcount',
        help: 'Count the words in this chat',
        run: () => String(rv.chat.messages().reduce((n, m) => n + m.text.split(/\s+/).filter(Boolean).length, 0)),
    });
    rv.ui.addMessageAction({
        id: 'words',
        icon: 'calculator',
        title: 'Word count',
        onClick: message => rv.ui.toast(`${message.text.split(/\s+/).filter(Boolean).length} words`),
    });

    // 5. Data that syncs across your devices (needs the "storage" permission).
    rv.events.on('message:received', async () => {
        const total = ((await rv.storage.get('replies')) || 0) + 1;
        await rv.storage.set('replies', total);
    });
}

export function deactivate() {}
