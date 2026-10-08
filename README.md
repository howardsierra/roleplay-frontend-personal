# ✦ Reverie

A self-hosted roleplay frontend that looks good on phones and computers and needs very little setup.
It's inspired by [SillyTavern](https://github.com/SillyTavern/SillyTavern) (staging), [Lumiverse](https://github.com/prolix-oc/Lumiverse) and [Marinara Engine](https://github.com/Pasta-Devs/Marinara-Engine).
It only does two things, **chat completion** and **image generation**, and it can show **live HTML / CSS / JavaScript and Python** inside replies.

- **No database or build step.** It runs on Node.js and stores everything as plain files in one `data/` folder.
- **Phone-first UI.** It works in a phone browser and can be installed to your home screen.
- **Compatible with your existing stuff:**
  - SillyTavern **character cards**: PNG (V2 `chara` / V3 `ccv3`) and JSON, including embedded lorebooks and card-scoped regex
  - SillyTavern **chat-completion presets**: prompt manager order, markers, depth injections, samplers, prefill, nudges and the formats for World Info / scenario / personality
  - **Lumiverse "Loom" presets**: blocks, categories (including radio categories), `in_history` depth placement, `*_append` roles, and **prompt variables** (`{{var::name}}`, `ison`). These show up as real controls: select, slider, switch and multi-select.
  - SillyTavern **themes** (`.json`) and custom CSS. The chat uses ST's DOM names (`#chat`, `.mes`, `.mes_text`, `#send_form`…) and its `--SmartTheme*` CSS variables.
  - SillyTavern **third-party extensions**: install them from a Git URL (see [what works](#sillytavern-extensions))
  - SillyTavern **World Info / lorebooks**, **regex scripts**, **chats** (`.jsonl` import/export) and **macros**

## Features

| | |
|---|---|
| 💬 Chat | Streaming, swipes (buttons, arrow keys or a horizontal swipe on touch screens), edit, continue, impersonate, branch, hide-from-AI, delete, chat list, author's note, collapsible "thinking" blocks for reasoning models, per-message edit history (word diff + restore), "Previously on…" recaps when you come back to a story |
| 🎭 Characters | Gallery of portrait cards, editor with alternate greetings, PNG/JSON export, favourites, duplicate |
| 🧠 Prompting | Block-based prompt manager with drag-to-reorder (touch too), token estimates, a Prompt / Context Inspector (prompt stack, lore activation, the exact provider request, raw JSON) and per-reply generation details (think/post time, tokens in/out), per-generation-type triggers, World Info with keywords / regex keys / recursion / groups / budget / @depth |
| 🔌 Providers | OpenRouter, Anthropic (native, with prompt caching and extended thinking), OpenAI, Google AI Studio, DeepSeek, xAI, Mistral, NanoGPT, or any OpenAI-compatible URL (save as many custom endpoints as you like, each with its own URL and key). Connection profiles let you switch quickly. |
| 🎨 Images | Pollinations (free, no key), OpenAI gpt-image / DALL·E, OpenRouter image models, Gemini / Imagen, NovelAI (V3/V4/V4.5), xAI, NanoGPT, A1111/Forge, ComfyUI (workflows). Illustrate any message, an image studio, a gallery, and **inline `<pic prompt="…">` tags** that the model can write and that are generated automatically. |
| ✨ Rich replies | ```` ```html ```` blocks and full HTML documents become live sandboxed mini-apps. Loose `<script>` from regex "status panels" also works. ```` ```python ```` blocks run in the browser with Pyodide. |
| 🖌️ Looks | 6 built-in themes, ST theme import, colour editor, 4 message styles (cards, bubbles, flat, novel), serif/sans fonts, background images per chat or global, animated aurora backdrop, scene-reactive lighting that follows the story (candlelight, moonlight, storms, snow…) |

## Run it

### Option A: Railway (use it from your phone anywhere)

1. Fork or push this repo to your GitHub, then in [Railway](https://railway.com) choose **New Project → Deploy from GitHub repo**.
2. In the service's **Variables**, add `APP_PASSWORD` with a strong password. Reverie won't serve anything on Railway until you do, so strangers can't use your API keys.
3. Right-click the service → **Attach volume** (any mount path; Reverie detects it). **Without a volume, your characters and chats are wiped on every redeploy.**
4. In **Settings → Networking**, click **Generate Domain** and open it on your phone. In your browser menu, choose *Add to Home Screen*.
5. *(Optional)* Put API keys in Variables instead of the UI: `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`, `MISTRAL_API_KEY`, `NANOGPT_API_KEY`, `NOVELAI_API_KEY`, `CUSTOM_API_KEY`.

The repo includes a `Dockerfile` and `railway.json` (with a health check), so there's nothing else to configure.

### Option B: your computer

Requires [Node.js](https://nodejs.org) 20 or newer.

```bash
git clone <this repo> reverie && cd reverie
npm install
npm start            # → http://localhost:8000
```

To reach it from your phone on the same Wi-Fi, run `APP_PASSWORD=something npm start` and open `http://<your-computer's-IP>:8000`.

### Option C: on an Android phone itself (Termux)

```bash
pkg install nodejs git
git clone <this repo> reverie && cd reverie && npm install && npm start
```

Then open `http://localhost:8000` in your phone's browser.

### Option D: Docker

```bash
docker compose up -d   # edit APP_PASSWORD in docker-compose.yml first
```

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8000` | HTTP port |
| `APP_PASSWORD` | — | Password for the login screen. Strongly recommended anywhere but localhost. |
| `DATA_DIR` | `./data` (or the Railway volume) | Where everything is stored |
| `REQUIRE_PASSWORD` | — | Set to `1` to refuse to run without `APP_PASSWORD` (automatic on Railway) |

## Interactive replies (HTML / CSS / JS / Python)

The default preset tells the model it may send ```` ```html ```` blocks. Each one runs in a **sandboxed iframe**: it can't read your cookies, keys or the app. The iframe sizes itself to its content and has buttons to restart it, view its source, or go fullscreen. Inside it, scripts can talk back to the chat:

```js
Reverie.send('I open the left door')     // send a message as you (and get a reply)
Reverie.setInput('text')                 // put text in your input box
Reverie.slash('/echo hi | /setvar key=x {{pipe}}')
await Reverie.getVar('hp'); Reverie.setVar('hp', 10)   // chat variables, the same ones as {{getvar::hp}}
await Reverie.getChat()                  // message list
await Reverie.generateImage('a red door') // returns an image URL
// JS-Slash-Runner / TavernHelper-style aliases: triggerSlash, getVariables, insertOrAssignVariables, getChatMessages
```

Python code blocks get a **Run** button (or run automatically; see Settings → More). They run with [Pyodide](https://pyodide.org) in the browser. `print()` output is shown, and `display_html("<b>hi</b>")` renders HTML.

## SillyTavern extensions

Go to **Settings → Extensions**, paste a repository URL and choose **Install**. Reverie serves the extension from the same path SillyTavern would (`/scripts/extensions/third-party/<name>/`). It also rewrites the extension's imports of ST core files (`script.js`, `extensions.js`, `popup.js`, `slash-commands/*`, `utils.js`…) so they point at a compatibility layer that provides:

- `SillyTavern.getContext()`: chat, characters, `eventSource` with SillyTavern's full event list, `extensionSettings`, `generateQuietPrompt`, `generateRaw`, `setExtensionPrompt`, `substituteParams`, macros, popups, variables, lorebook helpers, persona data, **Connection Manager** (`ConnectionManagerRequestService`, `extensionSettings.connectionManager`, backed by Reverie's connection profiles) and `ChatCompletionService`
- SillyTavern's bundled libraries as globals and in `SillyTavern.libs`: lodash, Handlebars, moment, localforage, showdown, Fuse, Popper and DOMPurify
- ST's page structure where extensions attach: `#send_form` / `#leftSendForm` / `#nonQRFormItems` / `#rightSendForm`, `#extensionsMenu`, `#extensions_settings`, `#movingDivs` with draggable panels, `#CustomCSS-block`, `#connection_profiles`, and ST's CSS variables
- an STscript subset: pipes, `{{pipe}}`, `//` comments, `{: closures :}`, `/if`, `/inject` / `/flushinject` / `/listinjects` (ephemeral injections included), `/trigger await=true`, `/impersonate`, `/gen`, `/genraw`, `/sendas`, `/sys`, `/echo`, `/setvar` and friends, `/hide`, `/messages`, `/sampler-get` / `/sampler-set`, `/imagine`, `/bg`…
- ST server endpoints that extensions call: image and file uploads (`user/images/...` paths), `/api/backends/chat-completions/generate`, world info lookup and background lists. API keys are never handed to extensions.
- `generate_interceptor` from the manifest. Extensions load before the first chat opens, as in SillyTavern.

If an extension imports a name Reverie doesn't provide, it gets a harmless no-op and a console warning instead of crashing.

### Tested extensions

| Works | Extensions |
|---|---|
| ✅ Tested working | Phone & PC, Offstage, Wardrobe, Surtitle, Context Lens, Extension Organizer, Silly Sim Tracker, Clickable Inputs, Guided Generations, Code Runner, Input History, LALib, Quick Persona |
| ✅ Loads, UI appears (not exercised in depth) | Saucepan Seasoning, CSS Snippets, Custom Theme Style Inputs, Chat Top Bar (TopInfoBar), Inline Image Generation (needs its own image API settings) |
| ✅ Built in instead | Preset Organizer & Prompt Checkboxes (sections, search, bulk toggles, checkboxes and the preset navigator are part of Reverie's prompt manager), Sampler Commands (`/sampler-get` and `/sampler-set` are native), Backup Manager (Settings → More → Backup), Background Manager (per-chat backgrounds are native) |
| ⚪ Nothing to attach to | Persona Manager, Avatar Banner: they restyle SillyTavern's own persona and character panels, which Reverie replaces with its own. They load without errors. |
| ✅ With the classic layout | Moonlit Echoes Theme reskins SillyTavern's whole interface. Turn on **Settings → Look → Interface layout → Classic** (or click **Switch to classic layout** on its card). Reverie then uses SillyTavern's geometry: a fixed top bar, a centred chat column and side drawers. In the Reverie layout it's skipped unless you choose **Load anyway**. |
| ➡️ Built in instead | Smart Dialogue Colorizer depends on SillyTavern's own character editor; use **Dialogue colors** instead (or Prism). |
| ❌ Needs ST server plugin | WebSearch calls SillyTavern's search server plugin, which Reverie doesn't include. |

## Lumiverse extensions

Reverie can also run extensions made for [Lumiverse](https://github.com/prolix-oc/Lumiverse) (they ship a `spindle.json`). Install them by URL in **Settings → Extensions** like any other, then reload.

- Their **server part** runs in a worker thread inside Reverie's server, with Lumiverse's `spindle` API: storage, encrypted secrets, the CORS proxy, macros, prompt interceptors, events, child processes (for LumiScript), OAuth callbacks, and the chat/character/persona/generation/image APIs (answered by your open Reverie tab).
- Their **interface** runs in the page with Lumiverse's `ctx` API: drawer tabs appear as tabs on the character sheet, input-bar actions go in the ✨ menu, plus floating widgets, dock panels, modals, context menus, message tag interceptors and DOM helpers. Lumiverse's `--lumiverse-*` theme variables are generated from your Reverie theme.
- Extensions must include their built `dist/` folder (Reverie doesn't compile TypeScript).

| Extension | Status |
|---|---|
| Silly Sim Tracker (Lumiverse) | ✅ Tracker cards render in messages; prompt interceptor and macros work |
| Prism | ✅ Palette, scene setup, dialogue painting, prompt registry (Hybrid/LLM modes) |
| Pocket | ✅ Phone (dock on desktop, full screen on phones), world-state extraction, tag fallback. Native tool calling isn't available, so Pocket uses its `<lumi-phone>` tag mode |
| Lumiverse Timeline | ✅ Weave posts, replies, actor roster |
| Inlay Illustrator | ✅ Panel, parser and image generation through Reverie's image settings (pick a parser connection in its panel first) |
| LumiScript | ✅ Scripts run in child processes; the editor loads Monaco from cdn.jsdelivr.net |
| Spotify Controls | ✅ Panel and mini player; connect your Spotify account from its settings |
| Palette | ⚠️ Loads; colour "Boost", tokens and custom CSS work, but its element recipes target Lumiverse's own page structure |

## Dialogue colors

**Settings → Look → Dialogue colors** colours each speaker's quotes, Smart Dialogue Colorizer–style (colour from the avatar, a fixed colour, or a per-character override, plus saturation/brightness boosts and coloured names). With **multiple speakers**, the AI tags each line with `<font color title="Name">`; known speakers are always repainted with their cast colour and new named speakers are learned into the chat's cast (✨ menu → **Cast colors**). Custom CSS can use `var(--character-color)`.

## Story tools

- **Generation details** — under each reply, *Show generation details* reveals how long the model thought, how long it wrote, and the tokens in/out (from the provider, or estimated with ≈). *Inspect* opens the **Prompt / Context Inspector** for that reply: every message in the prompt stack with where it came from (preset block, lore, chat message, extension) and a search, which lore entries fired, the exact body sent to the provider (captured on the server, never with headers or keys) and raw JSON, with *Copy stack* / *Copy payload*. ✨ menu → *Prompt inspector* shows a dry run of the next message.
- **Edit history** — every edit keeps the previous text (per swipe, including changes made by extensions). The *edited* chip next to the name shows each version with a word diff; restoring keeps the current text too.
- **Scene lighting** — the room's light shifts with the story. The toolbar chip shows the current scene; tap it to pin one or turn it off for that chat. Strength and on/off are in **Look**.
- **Previously on…** — come back to a story after 6+ hours and a short recap of where things stand appears under the last message (written once and cached). ✨ menu → *Previously on…* writes one any time.

## Reverie extensions, presets and themes

Reverie also has its own formats that go beyond what SillyTavern's can do. See [docs/EXTENSIONS.md](docs/EXTENSIONS.md) for the details.

- **Extensions** (`reverie-extension.json`): turn on and off without a reload, declare permissions, get a settings form from the manifest, keep data on the server, and add sheet tabs, composer buttons, menu items, message actions, slash commands, macros and **custom renderers** that draw ```` ```lang ```` blocks from the AI as native UI. **Settings → Extensions → Create starter extension** scaffolds a working example.
- **Presets** (`.rvpreset.json`): blocks with **conditions** (`type == 'impersonate'`, `chat.length > 40`, `char.tags has 'horror'`…), **model profiles** that switch samplers and prefill per model, and author metadata.
- **Themes** (`.rvtheme.json`): named colour tokens with **light and dark variants**, Google Fonts, embedded image assets, corner radius, and layout preferences, all in one shareable file.

## Where things are stored

```
data/
  settings.json       UI settings, personas, global regex, extension settings
  secrets.json        API keys (never sent back to the browser)
  characters/ avatars/ chats/<character>/<chat>.jsonl
  presets/ worlds/ themes/ backgrounds/ images/ extensions/
```

To back up, copy the folder. Chats are SillyTavern-format `.jsonl` files, so you can move them between the two apps.

## Development

```bash
npm run dev     # restarts on server changes; the frontend is plain ES modules (no build)
npm test        # format-compatibility tests (ST/Lumiverse presets, cards, macros, regex, shims)
```

Licensed AGPL-3.0, the same licence as SillyTavern.
