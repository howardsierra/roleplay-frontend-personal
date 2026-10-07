# Reverie formats: extensions, presets and themes

Reverie loads SillyTavern extensions, presets and themes as they are. It also has its own
formats that do things the SillyTavern ones can't. This page documents those formats.

| | SillyTavern format | Reverie format |
|---|---|---|
| **Extensions** | `manifest.json` and scripts that reach into ST's DOM and globals | `reverie-extension.json` and an `activate(rv)` function that uses a small, versioned API |
| **Presets** | Prompt blocks plus samplers | Adds conditional blocks, per-model profiles and metadata (`.rvpreset.json`) |
| **Themes** | Flat colour list plus custom CSS | Adds named tokens, light and dark variants, fonts, embedded assets and layout preferences (`.rvtheme.json`) |

Reverie formats export back to SillyTavern formats where that's possible. Features ST has no
equivalent for are dropped on export.

---

## Extensions

A Reverie extension is a folder in `data/extensions/<name>/` that contains a
`reverie-extension.json` manifest. Install one from a git URL in **Settings → Extensions**,
just like an ST extension. To start from a working example, click
**Create starter extension**.

### Differences from ST extensions

- **On and off without a reload.** Everything an extension registers through `rv` is undone
  automatically when it's turned off.
- **Permissions are listed up front.** The extension card shows them. Calls that need a
  permission the manifest didn't declare throw an error.
- **Settings without UI code.** Declare them in the manifest and Reverie builds the form.
  Settings are stored in Reverie's settings file, so they follow you across devices.
- **Server-side storage.** `rv.storage` saves JSON on your Reverie server rather than in one
  browser's localStorage.
- **Contribution points.** Extensions can add character-sheet tabs, composer buttons,
  wand-menu items, message actions, slash commands, macros and custom code-block renderers.
  These work in both the Reverie and classic layouts.
- **A stable API.** Extensions use `rv` rather than DOM ids, so a Reverie redesign won't
  break them. `apiVersion` protects against running an extension on a Reverie that's too old
  for it.

### Manifest (`reverie-extension.json`)

```json
{
  "id": "my-extension",
  "name": "My Extension",
  "version": "0.1.0",
  "author": "you",
  "description": "What it does.",
  "apiVersion": 1,
  "main": "index.js",
  "styles": ["style.css"],
  "permissions": ["prompt", "storage"],
  "settings": [
    { "key": "enabled", "type": "toggle", "label": "Turn it on", "default": true },
    { "key": "reminder", "type": "textarea", "label": "Reminder", "default": "Stay in character." },
    { "key": "tone", "type": "select", "label": "Tone", "options": [["soft", "Soft"], ["dark", "Dark"]], "default": "soft" },
    { "key": "depth", "type": "number", "label": "Depth", "min": 0, "max": 20, "default": 4 }
  ]
}
```

Setting types: `toggle`, `text`, `textarea`, `select`, `number`, `slider` and `color`. Each
one can also take a `hint`.

#### Permissions

| Permission | Allows |
|---|---|
| `generate` | `rv.generate()`: send requests to your AI model |
| `chat.write` | `rv.chat.send`, `addMessage` and `editMessage` |
| `prompt` | `rv.prompt.inject` and `onBuild`: add text to the prompt |
| `storage` | `rv.storage`: keep data on the server |
| `network` | `rv.fetch()`: contact other websites |

Everything else needs no permission: reading the chat, UI, events, settings, renderers,
commands and macros.

### `index.js`

```js
export function activate(rv) {
    rv.ui.addPanel({ id: 'stats', title: 'Stats', icon: 'chart-simple', render(container) {
        container.textContent = `${rv.chat.messages().length} messages`;
    } });
}
export function deactivate() {} // optional; registrations are cleaned up for you
```

### The `rv` API

| Area | Members |
|---|---|
| Info | `rv.apiVersion`, `rv.id`, `rv.manifest`, `rv.baseUrl` (URL of your folder, for images and other assets) |
| Settings | `rv.settings.get(key?)`, `set(key, value)`, `onChange(fn)` |
| Storage | `rv.storage.get(key)`, `set(key, value)`, `delete(key)`, `all()` (async) |
| Events | `rv.events.on(name, fn)` with `message:sent`, `message:received`, `message:edited`, `message:deleted`, `message:swiped`, `message:rendered`, `chat:changed`, `generation:started`, `generation:ended`, `stream:token`, `persona:changed` or `settings:changed`. Raw ST event names also work. |
| Chat | `rv.chat.messages()`, `character()`, `persona()`, `id()`, `getVar(k)`, `setVar(k, v)`, `send(text, {generate})`, `addMessage({name, text, isUser, hidden, avatar})`, `editMessage(index, text)` |
| AI | `rv.generate({prompt \| messages, system, maxTokens, onToken, signal})` returns the text. Pass `onToken` to stream. |
| Prompt | `rv.prompt.inject(key, text, {position: 'before' \| 'after' \| 'depth', depth, role})`, `remove(key)`, `onBuild((messages, ctx) => …)` |
| UI | `rv.ui.toast(msg, type)`, `modal(opts)`, `confirm(msg)`, `el(tag, attrs, ...children)`, `addPanel({id, title, icon, render})`, `addComposerButton({id, icon, title, onClick})`, `addMenuItem({id, icon, label, onClick})`, `addMessageAction({id, icon, title, onClick(message, index)})` |
| Renderers | `rv.renderers.register(lang, (code, container, ctx) => …)` |
| Commands | `rv.commands.register({name, help, run(args, value)})`, `rv.commands.run('/script')` |
| Macros | `rv.macros.register('name', () => 'value')`, which you then use as `{{name}}` |
| Network | `rv.fetch(url, init)` |

Every `on…`, `add…` and `register…` call returns a function that removes what it added.
Icons are [Font Awesome](https://fontawesome.com/icons) solid names without the `fa-` prefix.

#### Custom renderers

A renderer turns fenced blocks from the AI into native UI. No iframe is involved, so the
result picks up your theme. For example, ask the AI (in your preset) to end each reply with:

````
```mood
{"mood": "happy", "level": 7}
```
````

Then register a renderer for it:

```js
rv.renderers.register('mood', (code, container) => {
    const { mood, level } = JSON.parse(code);
    container.append(rv.ui.el('div', { class: 'my-mood' }, `${mood} (${level}/10)`));
});
```

If a renderer throws, the error appears inline in the message. The rest of the reply is
unaffected.

---

## Presets (`.rvpreset.json`)

A Reverie preset is the normal preset with three additions. Import it anywhere you'd import a
preset. To get one, use **Preset → Export → Export as Reverie preset**. To get an ST preset
back, use the plain export.

```json
{
  "format": "reverie-preset",
  "formatVersion": 1,
  "name": "My Preset",
  "meta": { "author": "", "version": "1.0", "description": "", "homepage": "" },
  "blocks": [
    { "name": "Impersonation rules", "role": "system", "content": "…", "when": "type == 'impersonate'" },
    { "name": "Long-chat summary nudge", "content": "…", "when": "chat.length > 40" },
    { "name": "Dark tone", "content": "…", "when": "var.tone == 'dark' or char.tags has 'horror'" }
  ],
  "modelProfiles": [
    { "name": "Claude", "match": "claude", "assistantPrefill": "", "samplers": { "temperature": 1 } },
    { "name": "DeepSeek R1", "match": "/deepseek.*r1/", "samplers": { "temperature": 0.6 } }
  ],
  "samplers": { }
}
```

### Conditions (`when`)

A block is sent only when its condition is true. An empty condition means the block is always
sent. Conditions use a small expression language. Nothing in them is run as code.

| Name | Value |
|---|---|
| `type` | `normal`, `continue`, `impersonate`, `swipe`, `regenerate` or `quiet` |
| `model`, `provider` | The connection's model id and provider |
| `chat.length`, `chat.last` | Number of messages, and the last message's text |
| `char.name`, `char.tags` | The current character |
| `user.name`, `persona.name` | Your persona |
| `var.X`, `global.X` | Chat and global variables (`/setvar`, `{{setvar}}`) |
| `profile` | Name of the active model profile |

Operators: `==`, `!=`, `>`, `<`, `>=`, `<=`, `~` (contains, or `/regex/`), `has` (a list or
text contains a value), `and`, `or`, `not`, and parentheses. Text comparisons ignore case.

### Model profiles

The first enabled profile whose `match` fits the current model wins. `match` is either a
substring or a `/regex/`. The winning profile's `samplers` override the preset's samplers, and
its `assistantPrefill` replaces the prefill. One preset can then work well with several
models without being duplicated.

---

## Themes (`.rvtheme.json`)

```json
{
  "format": "reverie-theme",
  "formatVersion": 1,
  "name": "Rose Haven",
  "author": "", "version": "1.0", "description": "",
  "variants": {
    "dark":  { "text": "#f3e8ee", "em": "#f9a8d4", "quote": "#fda4af", "panel": "#1a0f16cc", "chatTint": "#12090fcc",
               "botMessage": "#2a1520aa", "userMessage": "#1f1a2baa", "border": "#4a2238", "shadow": "#00000080",
               "accent": "#f472b6", "accent2": "#fb7185", "background": "#0d070b", "aurora": ["#f472b6", "#a855f7"] },
    "light": { "text": "#2b1620", "accent": "#db2777", "panel": "#fff5f8ee" }
  },
  "fonts": { "ui": "Inter", "chat": "Lora", "heading": "Playfair Display" },
  "radius": 14,
  "blur": 14,
  "shadowWidth": 2,
  "layout": { "messageStyle": "cards", "avatars": "round", "layout": "reverie" },
  "assets": { "blossom": "data:image/svg+xml;base64,…" },
  "css": ".mes { background-image: var(--rv-asset-blossom); }"
}
```

- **Variants**: under **Look → Light / dark**, Reverie uses `light` or `dark`, or follows your
  device when set to Auto. Tokens set under `tokens` apply to both variants.
- **Fonts**: [Google Fonts](https://fonts.google.com) family names, loaded automatically. In CSS
  they're available as `--rv-ui-font`, `--rv-chat-font` and `--rv-heading-font`.
- **Assets**: images embedded in the file as `data:` or `https:` URLs. Each one is available
  as `var(--rv-asset-<name>)`, so a theme can be shared as a single file.
- **Layout**: applying the theme also applies its message style, avatar shape and interface
  layout. Use `"classic"` for themes built on SillyTavern's geometry, such as Moonlit Echoes.
- **Exporting**: **Look → Export** writes a SillyTavern theme from the dark variant. Fonts
  and assets go into its custom CSS.
