// SillyTavern extensions import named bindings straight out of ST's own source files
// (e.g. `import { eventSource } from '../../../../script.js'`). If even one name is
// missing, the browser refuses to load the whole module. So when we serve an
// extension's JavaScript we rewrite every import that points at an ST core file to a
// generated shim module that exports exactly the names the extension asked for,
// backed by Reverie's compatibility layer (window.__RV_SHIM__) at runtime.

const THIRD_PARTY = '/scripts/extensions/third-party/';
const IDENT = /^[A-Za-z_$][\w$]*$/;

// Names exported for `import * as x from '<core>'` (plus anything registered at runtime).
export const KNOWN_EXPORTS = [
    'eventSource', 'event_types', 'saveSettingsDebounced', 'saveSettings', 'getRequestHeaders', 'chat', 'characters',
    'this_chid', 'name1', 'name2', 'substituteParams', 'substituteParamsExtended', 'generateQuietPrompt', 'generateRaw',
    'addOneMessage', 'saveChatConditional', 'saveChatDebounced', 'saveChat', 'reloadCurrentChat', 'callPopup', 'chat_metadata',
    'sendSystemMessage', 'system_message_types', 'setExtensionPrompt', 'extension_prompt_types', 'extension_prompt_roles',
    'getCurrentChatId', 'updateMessageBlock', 'messageFormatting', 'deleteLastMessage', 'Generate', 'stopGeneration',
    'getCharacters', 'selectCharacterById', 'main_api', 'online_status', 'is_send_press', 'menu_type', 'max_context',
    'amount_gen', 'default_avatar', 'getThumbnailUrl', 'animation_duration', 'animation_easing', 'user_avatar',
    'appendMediaToMessage', 'activateSendButtons', 'deactivateSendButtons', 'saveMetadata', 'updateChatMetadata',
    'setCharacterId', 'setCharacterName', 'printMessages', 'clearChat', 'scrollChatToBottom', 'isStreamingEnabled',
    'getTokenCount', 'getTokenCountAsync', 'extension_settings', 'getContext', 'renderExtensionTemplate',
    'renderExtensionTemplateAsync', 'saveMetadataDebounced', 'ModuleWorkerWrapper', 'doExtrasFetch', 'getApiUrl',
    'modules', 'extensionNames', 'writeExtensionField', 'power_user', 'oai_settings', 'world_info', 'world_names',
    'loadWorldInfo', 'saveWorldInfo', 'Popup', 'POPUP_TYPE', 'POPUP_RESULT', 'callGenericPopup', 'SlashCommandParser',
    'SlashCommand', 'SlashCommandArgument', 'SlashCommandNamedArgument', 'ARGUMENT_TYPE', 'SlashCommandEnumValue',
    'executeSlashCommands', 'executeSlashCommandsWithOptions', 'registerSlashCommand', 'debounce', 'delay', 'uuidv4',
    'getBase64Async', 'escapeHtml', 'isTrueBoolean', 'isFalseBoolean', 'getStringHash', 'waitUntilCondition',
    'onlyUnique', 'sortMoments', 'timestampToMoment', 'download', 'parseJsonFile', 'getCharaFilename', 'stringFormat',
    'trimToEndSentence', 'getSortableDelay', 'copyText', 'debounce_timeout', 'loadFileToDocument', 'getFileText',
    't', 'translate', 'getCurrentLocale', 'DOMPurify', 'showdown', 'moment', 'Fuse', 'hljs', 'localforage', 'Handlebars',
    'lodash', 'seedrandom', 'droll', 'morphdom', 'slideToggle', 'chalk', 'yaml', 'SVGInject', 'Readability',
    'isProbablyReaderable', 'diff_match_patch', 'css', 'Bowser', 'DiffMatchPatch', 'isMobile', 'getMessageTimeStamp',
    'humanizedDateTime', 'getGeneratingApi', 'getGeneratingModel', 'getChatCompletionModel', 'chat_completion_sources',
    'tags', 'tag_map', 'groups', 'selected_group', 'getGroupChat', 'is_group_generating', 'callGenericPopup',
    'accountStorage', 'loader', 'macros', 'MacrosParser', 'getPresetManager', 'ToolManager', 'default',
];

function resolve(fromUrl, spec) {
    if (!/^(\.{1,2}\/|\/)/.test(spec)) return null; // bare specifier or full URL: leave alone
    return new URL(spec, `http://x${fromUrl}`).pathname;
}

function parseClause(clause) {
    clause = clause.trim();
    const names = new Set();
    if (!clause) return names;
    if (clause.includes('*')) names.add('*');
    const braces = clause.match(/\{([\s\S]*)\}/);
    if (braces) {
        for (const part of braces[1].split(',')) {
            const name = part.trim().split(/\s+as\s+/)[0].trim().replace(/^type\s+/, '');
            if (name && IDENT.test(name)) names.add(name);
            else if (name === 'default') names.add('default');
        }
    }
    const head = clause.replace(/\{[\s\S]*\}/, '').replace(/\*\s*as\s+[\w$]+/, '').split(',')[0].trim();
    if (head && IDENT.test(head)) names.add('default');
    return names;
}

function shimUrl(target, names) {
    const list = [...names].join(',');
    return `/st-shim${target}?n=${encodeURIComponent(list)}`;
}

export function rewriteImports(source, fileUrl) {
    const rewrite = (spec, names) => {
        const target = resolve(fileUrl, spec);
        if (!target || target.startsWith(THIRD_PARTY)) return spec;
        return shimUrl(target, names);
    };
    // Static `import ... from '...'` and `export ... from '...'`.
    let out = source.replace(
        /(\b(?:import|export)\s*)((?:(?!\b(?:import|export)\b)[\w$*\s{},])*?)(\s*\bfrom\s*)(['"])([^'"\n]+)\4/g,
        (m, kw, clause, from, q, spec) => {
            if (kw.trim() === 'export' && !/[{*]/.test(clause)) return m;
            return `${kw}${clause}${from}${q}${rewrite(spec, parseClause(clause))}${q}`;
        },
    );
    // Side-effect imports: `import '...';`
    out = out.replace(/(\bimport\s*)(['"])([^'"\n]+)\2/g, (m, kw, q, spec) => `${kw}${q}${rewrite(spec, new Set())}${q}`);
    // Dynamic import('...') with a literal path.
    out = out.replace(/(\bimport\s*\(\s*)(['"])([^'"\n]+)\2(\s*\))/g, (m, a, q, spec, b) => `${a}${q}${rewrite(spec, new Set(['*']))}${q}${b}`);
    return out;
}

export function buildShimModule(modulePath, nameList) {
    const names = new Set(String(nameList || '').split(',').map(s => s.trim()).filter(Boolean));
    if (names.has('*')) {
        names.delete('*');
        for (const n of KNOWN_EXPORTS) names.add(n);
    }
    const mod = JSON.stringify(modulePath.replace(/^\/+/, ''));
    const lines = [
        `const S = globalThis.__RV_SHIM__;`,
        `const M = ${mod};`,
    ];
    const vars = [];
    for (const name of names) {
        if (name === 'default') {
            lines.push(`let __rv_default = S.get(M, 'default');`, `export { __rv_default as default };`);
            vars.push(['__rv_default', 'default']);
        } else if (IDENT.test(name)) {
            lines.push(`export let ${name} = S.get(M, ${JSON.stringify(name)});`);
            vars.push([name, name]);
        }
    }
    if (vars.length) {
        lines.push(`S.watch(() => { ${vars.map(([v, n]) => `${v} = S.get(M, ${JSON.stringify(n)});`).join(' ')} });`);
    }
    return lines.join('\n') + '\n';
}
