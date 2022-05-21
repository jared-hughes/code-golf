import { ASMStateField }                       from '@defasm/codemirror';
import {
    ComponentItem, ComponentItemConfig, ContentItem, GoldenLayout,
    RowOrColumn, LayoutConfig, ResolvedRootItemConfig,
    ResolvedLayoutConfig, DragSource, LayoutManager, ComponentContainer,
} from 'golden-layout';
import LZString                                from 'lz-string';
import { EditorState, EditorView, extensions } from './_codemirror.js';
import                                              './_copy-as-json';
import diffTable                               from './_diff';
import pbm                                     from './_pbm.js';
import { $, $$, byteLen, charLen, comma, ord } from './_util';

const experimental = JSON.parse($('#experimental').innerText);
const hole         = decodeURI(location.pathname.slice(4));
const langs        = JSON.parse($('#langs').innerText);
const scorings     = ['Bytes', 'Chars'];
const solutions    = JSON.parse($('#solutions').innerText);
const sortedLangs  =
    Object.values(langs).sort((a: any, b: any) => a.name.localeCompare(b.name));

const darkMode =
    matchMedia(JSON.parse($('#darkModeMediaQuery').innerText)).matches;

const baseExtensions =
    darkMode ? [...extensions.dark, ...extensions.base] : extensions.base;

const poolDragSources: {[key: string]: DragSource} = {};
const poolElements: {[key: string]: HTMLElement} = {};

let lang = '';
let latestSubmissionID = 0;
let solution = scorings.indexOf(localStorage.getItem('solution') ?? 'Bytes') as 0 | 1;
let scoring  = scorings.indexOf(localStorage.getItem('scoring')  ?? 'Bytes') as 0 | 1;

let hideDeleteBtn: boolean = false;

/**
 * Is mobile mode activated? Start at false as default since Golden Layout
 * uses desktop as default. Change to true and apply changes if width is less
 * than or equal to 768px (it seems to be a common breakpoint idk).
 *
 * Changes on mobile mode:
 * - golden layout reflowed to columns-only
 * - full-page scrolling is enabled
 * - dragging is disabled (incompatible with being able to scroll)
 * - maximized windows take the full screen
 *
 * TODO: respect "Request desktop site" from mobile browsers to force
 * isMobile = false. Or otherwise configuration option.
 */
let isMobile = false;
let applyingDefault = false;

interface SubmitResponse {
    Pass: boolean,
    Out: string,
    Exp: string,
    Err: string,
    Argv: string[],
    Cheevos: {
        emoji: string,
        name: string
    }[],
    LoggedIn: boolean
}

let subRes: SubmitResponse | null = null;
const readonlyOutputs: {[key: string]: HTMLElement | undefined} = {};

// The savedInDB state is used to avoid saving solutions in localStorage when
// those solutions match the solutions in the database. It's used to avoid
// restoring a solution from localStorage when the user has improved that
// solution on a different browser. Assume the user is logged-in by default
// for non-experimental holes. At this point, it doesn't matter whether the
// user is actually logged-in, because solutions dictionaries will be empty
// for users who aren't logged-in, so the savedInDB state won't be used.
// By the time they are non-empty, the savedInDB state will have been updated.
let savedInDB = !experimental;

let editor: EditorView | null = null;

(onhashchange = () => {
    const hashLang = location.hash.slice(1) || localStorage.getItem('lang');

    // Kick 'em to Python if we don't know the chosen language, or if there is no given language.
    lang = hashLang && langs[hashLang] ? hashLang : 'python';

    $('#hole-lang summary').innerHTML = langs[lang].name;

    // Assembly only has bytes.
    if (lang == 'assembly')
        setSolution(0);

    localStorage.setItem('lang', lang);

    history.replaceState(null, '', '#' + lang);

    refreshScores();
    setCodeForLangAndSolution();
})();

onkeydown = e => (e.ctrlKey || e.metaKey) && e.key == 'Enter' ? submit() : undefined;

// Handle showing/hiding alerts
for (const alert of $$('.alert')) {
    const closeBtn = alert.querySelector('.main_close');
    if (!closeBtn) continue;
    closeBtn.addEventListener('click', () => {
        const child = (alert.querySelector('svg') as any).cloneNode(true);
        $('#alert-pool').appendChild(child);
        alert.classList.add('hide');
        child.addEventListener('click', () => {
            child.parentNode.removeChild(child);
            alert.classList.remove('hide');
        });
    });
}

// Handle showing/hiding lang picker
// can't be done in CSS because the picker is one parent up
const langToggle = $<HTMLDetailsElement>('#hole-lang details');
langToggle.addEventListener('toggle', () => {
    $('#picker').classList.toggle('hide', !langToggle.open);
});

$('dialog [name=text]').addEventListener('input', (e: Event) => {
    const target = e.target as HTMLInputElement;
    target.form!.confirm.toggleAttribute('disabled',
        target.value !== target.placeholder);
});

function getAutoSaveKey(lang: string, solution: 0 | 1) {
    return `code_${hole}_${lang}_${solution}`;
}

function getOtherScoring(value: 0 | 1) {
    return 1 - value as 0 | 1;
}

function getScoring(str: string, index: 0 | 1) {
    return scorings[index] == 'Bytes' ? byteLen(str) : charLen(str);
}

function getSolutionCode(lang: string, solution: 0 | 1) {
    return lang in solutions[solution] ? solutions[solution][lang] : '';
}

function updateLangPicker() {
    // Populate the language picker with accurate stroke counts.
    $('#picker').replaceChildren(...sortedLangs.map((l: any) => {
        const tab = <a href={l.id == lang ? null : '#'+l.id}>{l.name}</a>;

        if (getSolutionCode(l.id, 0)) {
            const bytes = byteLen(getSolutionCode(l.id, 0));
            const chars = charLen(getSolutionCode(l.id, 1));

            let text = comma(bytes);
            if (chars && bytes != chars) text += '/' + comma(chars);

            tab.append(' ', <sup>{text}</sup>);
        }

        return tab;
    }));
}

async function refreshScores() {
    updateLangPicker();

    // Populate (and show) the solution picker if necessary.
    //
    // We have two database solutions (or local solutions) and they differ.
    // Or if a logged-in user has an auto-saved solution for the other metric,
    // that they have not submitted since logging in, they must be allowed to
    // switch to it, so they can submit it.
    const dbBytes = getSolutionCode(lang, 0);
    const dbChars = getSolutionCode(lang, 1);
    const lsBytes = localStorage.getItem(getAutoSaveKey(lang, 0));
    const lsChars = localStorage.getItem(getAutoSaveKey(lang, 1));

    if ((dbBytes && dbChars && dbBytes != dbChars)
     || (lsBytes && lsChars && lsBytes != lsChars)
     || (dbBytes && lsChars && dbBytes != lsChars && solution == 0)
     || (lsBytes && dbChars && lsBytes != dbChars && solution == 1)) {
        $('#solutionPicker').replaceChildren(...scorings.map((scoring, iNumber) => {
            const i = iNumber as 0 | 1;
            const a = <a>Fewest {scoring}</a>;

            const code = getSolutionCode(lang, i);
            if (code) a.append(' ', <sup>{comma(getScoring(code, i))}</sup>);

            if (i != solution) {
                a.href = '';
                a.onclick = (e: MouseEvent) => {
                    e.preventDefault();
                    setSolution(i);
                    setCodeForLangAndSolution();
                };
            }

            return a;
        }));

        $('#solutionPicker').classList.remove('hide');
    }
    else
        $('#solutionPicker').classList.add('hide');

    // Hide the delete button for exp holes or if we have no solutions.
    hideDeleteBtn = experimental || (!dbBytes && !dbChars);
    $('#deleteBtn')?.classList.toggle('hide', hideDeleteBtn);

    if ($('#scoreboard-section')) await populateScores();
}

async function populateScores() {
    // Populate the rankings table.
    const scoringID = scorings[scoring].toLowerCase();
    const path      = `/${hole}/${lang}/${scoringID}`;
    const view      = $('#rankingsView a:not([href])').innerText.trim().toLowerCase();
    const res       = await fetch(`/api/mini-rankings${path}/${view}?ng=1`);
    const rows      = res.ok ? await res.json() : [];

    $<HTMLAnchorElement>('#allLink').href = '/rankings/holes' + path;

    $('#scores').replaceChildren(<tbody class={scoringID}>{
        // Rows.
        rows.length ? rows.map((r: any) => <tr class={r.me ? 'me' : ''}>
            <td>{r.rank}<sup>{ord(r.rank)}</sup></td>
            <td>
                <a href={`/golfers/${r.golfer.name}`}>
                    <img src={`//avatars.githubusercontent.com/${r.golfer.name}?s=24`}/>
                    <span>{r.golfer.name}</span>
                </a>
            </td>
            <td data-tooltip={tooltip(r, 'Bytes')}>{comma(r.bytes)}</td>
            <td data-tooltip={tooltip(r, 'Chars')}>{comma(r.chars)}</td>
        </tr>): <tr><td colspan="4">(Empty)</td></tr>
    }</tbody>);

    if (view === 'me') {
        $('.me')?.scrollIntoView({block: 'center'});
    }
    else {
        $('#scores-wrapper').scrollTop = 0;
    }

    $$<HTMLAnchorElement>('#scoringTabs a').forEach((tab, i) => {
        if (tab.innerText == scorings[scoring]) {
            tab.removeAttribute('href');
            tab.onclick = () => {};
        }
        else {
            tab.href = '';
            tab.onclick = e  => {
                e.preventDefault();
                // Moving `scoring = i` to the line above, outside the list access,
                // causes legacy CodeMirror (UMD) to be imported improperly.
                // Leave as-is to avoid "CodeMirror is not a constructor".
                localStorage.setItem('scoring', scorings[scoring = i as 0 | 1]);
                refreshScores();
            };
        }
    });
}

function setCodeForLangAndSolution() {
    if (solution != 0 && getSolutionCode(lang, 0) == getSolutionCode(lang, 1)) {
        const autoSave0 = localStorage.getItem(getAutoSaveKey(lang, 0));
        const autoSave1 = localStorage.getItem(getAutoSaveKey(lang, 1));
        if (autoSave0 && !autoSave1)
            setSolution(0);
    }

    setState(localStorage.getItem(getAutoSaveKey(lang, solution)) ||
        getSolutionCode(lang, solution) || langs[lang].example);

    if (lang == 'assembly') scoring = 0;
    // TODO (GL) change
    const charsTab = $('#scoringTabs a:last-child');
    if (charsTab)
        charsTab.classList.toggle('hide', lang == 'assembly');

    updateLangPicker();

    $$('main .info').forEach(
        i => i.classList.toggle('hide', !i.classList.contains(lang)));
}

function setSolution(value: 0 | 1) {
    // Moving `solution = value` to the line above, outside the list access,
    // causes legacy CodeMirror (UMD) to be imported improperly.
    // Leave as-is to avoid "CodeMirror is not a constructor".
    localStorage.setItem('solution', scorings[solution = value]);
}

function setState(code: string) {
    if (!editor) return;
    editor.setState(
        EditorState.create({
            doc: code,
            extensions: [
                ...baseExtensions,

                extensions[lang as keyof typeof extensions] || [],

                // These languages shouldn't match brackets.
                ['brainfuck', 'fish', 'j', 'hexagony'].includes(lang)
                    ? [] : extensions.bracketMatching,

                // These languages shouldn't wrap lines.
                ['assembly', 'fish', 'hexagony'].includes(lang)
                    ? [] : EditorView.lineWrapping,
            ],
        }),
    );

    editor.dispatch();  // Dispatch to update strokes.
}

async function submit() {
    if (!editor) return;
    $('h2').innerText = '…';
    $('#status').className = 'grey';
    $$('canvas').forEach(e => e.remove());

    const code = editor.state.doc.toString();
    const codeLang = lang;
    const submissionID = ++latestSubmissionID;

    const res  = await fetch('/solution', {
        method: 'POST',
        body: JSON.stringify({
            Code: code,
            Hole: hole,
            Lang: lang,
        }),
    });

    if (res.status != 200) {
        alert('Error ' + res.status);
        return;
    }

    const data = await res.json() as SubmitResponse;
    subRes = data;
    savedInDB = data.LoggedIn && !experimental;

    if (submissionID != latestSubmissionID)
        return;

    if (data.Pass) {
        for (const i of [0, 1] as const) {
            const solutionCode = getSolutionCode(codeLang, i);
            if (!solutionCode || getScoring(code, i) <= getScoring(solutionCode, i)) {
                solutions[i][codeLang] = code;

                // Don't need to keep solution in local storage because it's
                // stored on the site. This prevents conflicts when the
                // solution is improved on another browser.
                if (savedInDB && localStorage.getItem(getAutoSaveKey(codeLang, i)) == code)
                    localStorage.removeItem(getAutoSaveKey(codeLang, i));
            }
        }
    }

    for (const i of [0, 1] as const) {
        const key = getAutoSaveKey(codeLang, i);
        if (savedInDB) {
            // If the auto-saved code matches either solution, remove it to
            // avoid prompting the user to restore it.
            const autoSaveCode = localStorage.getItem(key);
            for (const j of [0, 1] as const) {
                if (getSolutionCode(codeLang, j) == autoSaveCode)
                    localStorage.removeItem(key);
            }
        }
        else if (getSolutionCode(codeLang, i)) {
            // Autosave the best solution for each scoring metric, but don't
            // save two copies of the same solution, because that can lead to
            // the solution picker being show unnecessarily.
            if ((i == 0 || getSolutionCode(codeLang, 0) != getSolutionCode(codeLang, i)) &&
                getSolutionCode(codeLang, i) !== langs[codeLang].example)
                localStorage.setItem(key, getSolutionCode(codeLang, i));
            else
                localStorage.removeItem(key);
        }
    }

    // Automatically switch to the solution whose code matches the current
    // code after a new solution is submitted. Don't change scoring,
    // refreshScores will update the solution picker.
    if (data.Pass && getSolutionCode(codeLang, solution) != code &&
        getSolutionCode(codeLang, getOtherScoring(solution)) == code)
        setSolution(getOtherScoring(solution));

    // Update the restore link visibility, after possibly changing the active
    // solution.
    updateRestoreLinkVisibility();

    $('h2').innerText = data.Pass ? 'Pass 😀' : 'Fail ☹️';

    for (const name in readonlyOutputs) {
        updateReadonlyPanel(name);
    }

    $('#status').className = data.Pass ? 'green' : 'red';

    // 3rd party integrations.
    let thirdParty = '';
    if (lang == 'hexagony') {
        const payload = LZString.compressToBase64(JSON.stringify({
            code, input: data.Argv.join('\0') + '\0', inputMode: 'raw' }));

        thirdParty = <a href={'//hexagony.net#lz' + payload}>
            Run on Hexagony.net
        </a>;
    }
    $('#thirdParty').replaceChildren(thirdParty);

    if (hole == 'julia-set')
        $('main').append(pbm(data.Exp) as Node, pbm(data.Out) ?? [] as any);

    // Show cheevos.
    $('#popups').replaceChildren(...data.Cheevos.map(c => <div>
        <h3>Achievement Earned!</h3>
        { c.emoji }<p>{ c.name }</p>
    </div>));

    refreshScores();
}

function tooltip(row: any, scoring: 'Bytes' | 'Chars') {
    const bytes = scoring === 'Bytes' ? row.bytes : row.chars_bytes;
    const chars = scoring === 'Chars' ? row.chars : row.bytes_chars;

    if (bytes === null) return;

    return `${scoring} solution is ${comma(bytes)} bytes` +
        (chars !== null ? `, ${comma(chars)} chars.` : '.');
}

function updateRestoreLinkVisibility() {
    const serverCode = getSolutionCode(lang, solution);
    $('#restoreLink')?.classList.toggle('hide',
        !serverCode || editor?.state.doc.toString() == serverCode);
}

const goldenContainer = $('#golden-container');

/**
 * Actual Golden Layout docs are at
 *  https://golden-layout.github.io/golden-layout
 * golden-layout.com is for the old GL.
 */
const layout = new GoldenLayout(goldenContainer);
layout.resizeWithContainerAutomatically = true;

function updateReadonlyPanel(name: string) {
    if (!subRes) return;
    const output = readonlyOutputs[name];
    if (!output) return;
    switch (name) {
    case 'err':
        output.innerHTML = subRes.Err.replace(/\n/g,'<br>');
        break;
    case 'out':
        output.innerText = subRes.Out;
        break;
    case 'exp':
        output.innerText = subRes.Exp;
        break;
    case 'arg':
        // Hide arguments unless we have some.
        output.replaceChildren(
            ...subRes.Argv.map(a => <span>{a}</span>),
        );
        break;
    case 'diff':
        const diff = diffTable(hole, subRes.Exp, subRes.Out, subRes.Argv);
        output.replaceChildren(diff);
    }
}

for (const i of [0,1,2,3,4]) {
    const name = ['exp', 'out', 'err', 'arg', 'diff'][i];
    const title = ['Expected', 'Output', 'Errors', 'Arguments', 'Diff'][i];
    layout.registerComponentFactoryFunction(name, container => {
        container.setTitle(title);
        autoFocus(container);
        container.element.id = name;
        container.element.classList.add('readonly-output');
        readonlyOutputs[name] = container.element;
        updateReadonlyPanel(name);
    });
}

function makeEditor(parent: HTMLDivElement) {
    editor = new EditorView({
        dispatch: tr => {
            if (!editor) return;
            const result = editor.update([tr]) as unknown;

            const code = tr.state.doc.toString();
            const scorings: {byte?: number, char?: number} = {};
            const scoringKeys = ['byte', 'char'] as const;

            if (lang == 'assembly')
                scorings.byte = (editor.state.field(ASMStateField) as any).head.length();
            else {
                scorings.byte = byteLen(code);
                scorings.char = charLen(code);
            }

            const strokes = $('#strokes');
            if (strokes)
                strokes.innerText = scoringKeys
                    .filter(s => s in scorings)
                    .map(s => `${comma(scorings[s])} ${s}${scorings[s] != 1 ? 's' : ''}`)
                    .join(', ');

            // Avoid future conflicts by only storing code locally that's
            // different from the server's copy.
            const serverCode = getSolutionCode(lang, solution);

            const key = getAutoSaveKey(lang, solution);
            if (code && (code !== serverCode || !savedInDB) && code !== langs[lang].example)
                localStorage.setItem(key, code);
            else
                localStorage.removeItem(key);

            updateRestoreLinkVisibility();

            return result;
        },
        parent: parent,
    });

    editor.contentDOM.setAttribute('data-gramm', 'false');  // Disable Grammarly.
}

function autoFocus(container: ComponentContainer) {
    container.element.addEventListener('focusin', () => container.focus());
    container.element.addEventListener('click', () => container.focus());
}

layout.registerComponentFactoryFunction('code', async container => {
    container.setTitle('Code');
    autoFocus(container);

    const header = (<header>
        <div id="strokes">0 bytes, 0 chars</div>
        <a class="hide" href="/" id="restoreLink">Restore solution</a>
    </header>) as HTMLElement;
    const editor = <div id="editor"></div> as HTMLDivElement;

    makeEditor(editor);

    header.append($<HTMLTemplateElement>('#template-run').content.cloneNode(true));

    container.element.id = 'editor-section';
    container.element.append(editor, header);

    await afterDOM();

    $('#restoreLink').onclick = (e: MouseEvent) => {
        setState(getSolutionCode(lang, solution));
        e.preventDefault();
    };

    // Wire submit to clicking a button and a keyboard shortcut.
    $('#runBtn').onclick = submit;

    const deleteBtn = $('#deleteBtn');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
            $('dialog b').innerText = langs[lang].name;
            $<HTMLInputElement>('dialog [name=lang]').value = lang;
            $<HTMLInputElement>('dialog [name=text]').value = '';
            // Dialog typings are not available yet
            $<any>('dialog').showModal();
        });
        deleteBtn.classList.toggle('hide', hideDeleteBtn);
    }

    setCodeForLangAndSolution();
});

async function afterDOM() {}

function delinkRankingsView() {
    $$('#rankingsView a').forEach(a => a.onclick = e => {
        e.preventDefault();

        $$<HTMLAnchorElement>('#rankingsView a').forEach(a => a.href = '');
        a.removeAttribute('href');

        document.cookie =
            `rankings-view=${a.innerText.toLowerCase()};SameSite=Lax;Secure`;

        refreshScores();
    });
}

layout.registerComponentFactoryFunction('scoreboard', async container => {
    container.setTitle('Scoreboard');
    autoFocus(container);
    container.element.append(
        $<HTMLTemplateElement>('#template-scoreboard').content.cloneNode(true),
    );
    container.element.id = 'scoreboard-section';
    await afterDOM();
    populateScores();
    delinkRankingsView();
});

layout.registerComponentFactoryFunction('details', container => {
    container.setTitle('Details');
    autoFocus(container);
    container.element.append(
        $<HTMLTemplateElement>('#template-details').content.cloneNode(true) as HTMLDetailsElement,
    );
    container.element.id = 'details-content';
});

function plainComponent(componentType: string): ComponentItemConfig {
    return {
        type: 'component',
        componentType: componentType,
        reorderEnabled: !isMobile,
    };
}

const defaultLayout: LayoutConfig = {
    settings: {
        showPopoutIcon: false,
    },
    dimensions: {
        headerHeight: 28,
    },
    root: {
        type: 'column',
        content: [
            {
                type: 'row',
                content: [
                    {
                        ...plainComponent('code'),
                        width: 75,
                    },
                    {
                        ...plainComponent('scoreboard'),
                        width: 25,
                    },
                ],
            }, {
                type: 'row',
                content: [
                    {
                        type: 'stack',
                        content: [
                            plainComponent('arg'),
                            plainComponent('exp'),
                        ],
                    }, {
                        type: 'stack',
                        content: [
                            plainComponent('out'),
                            plainComponent('err'),
                            plainComponent('diff'),
                        ],
                    },
                ],
            },
        ],
    },
};

async function applyDefaultLayout() {
    applyingDefault = true;
    toggleMobile(false);
    Object.keys(poolElements).map(removePoolItem);
    addPoolItem('details', 'Details');
    layout.loadLayout(defaultLayout);
    await afterDOM();
    checkMobile();
    applyingDefault = false;
}

applyDefaultLayout();

/**
 * Try to add after selected item, with sensible defaults
 */
function addItemFromPool(componentName: string) {
    (window as any).layout = layout;
    layout.addItemAtLocation(
        plainComponent(componentName),
        LayoutManager.afterFocusedItemIfPossibleLocationSelectors,
    );
}

/**
 * Add the first element from the pool to the root column, or create a new
 * column containing the root and the first pool element if non exist.
 */
function addRow() {
    if (!layout.rootItem) return;
    const newComponentName = Object.keys(poolElements)[0];
    if (!newComponentName) return;
    const newConfig = plainComponent(newComponentName);
    if (layout.rootItem.type === 'column') {
        // Add to existing column
        (layout.rootItem as RowOrColumn).addItem(newConfig);
    }
    else {
        // Create new column
        const oldParent = layout.rootItem;
        const newParent = (layout as any).createContentItem({
            type: 'column',
            content: [],
        });
        const oldParentParent = oldParent.parent!;
        // removeChild(_, true): don't remove the node entirely, just remove
        // it from the current tree before re-inserting
        oldParentParent.removeChild(oldParent, true);
        oldParentParent.addChild(newParent);
        newParent.addChild(oldParent);
        newParent.addItem(newConfig);
    }
    (layout as any).getAllContentItems().find(
        (item: ComponentItem) => item.componentType === newComponentName,
    )?.focus();
}

$('#add-row').addEventListener('click', addRow);

$('#revert-layout').addEventListener('click', applyDefaultLayout);

$('#make-wide').addEventListener('click',
    () => document.documentElement.classList.toggle('full-width', true),
);

$('#make-narrow').addEventListener('click',
    () => document.documentElement.classList.toggle('full-width', false),
);

function addPoolItem(componentType: string, title: string) {
    poolElements[componentType]?.remove();
    const el = (<span class="btn">{title}</span>);
    $('#pool').appendChild(el);
    poolDragSources[componentType] = layout.newDragSource(el, componentType);
    poolElements[componentType] = el;
    checkShowAddRow();
    el.addEventListener('click', () => addItemFromPool(componentType));
}

// Add an item to the tab pool when a component gets destroyed
layout.addEventListener('itemDestroyed', e => {
    if (applyingDefault) return;
    const _target = e.target as ContentItem;
    if (_target.isComponent) {
        const target = _target as ComponentItem;
        addPoolItem(target.componentType as string, target.title);
    }
    checkShowAddRow();
});

function removePoolItem(componentType: string) {
    if (!poolElements[componentType]) return;
    poolElements[componentType].remove();
    delete poolElements[componentType];
    checkShowAddRow();
    if (!isMobile) removeDragSource(componentType);
}

async function checkShowAddRow() {
    // Await to ensure that rootItem === undefined after removing last item
    await afterDOM();
    $('#add-row').classList.toggle(
        'hide',
        Object.keys(poolElements).length === 0
            || layout.rootItem === undefined,
    );
}

function removeDragSource(componentType: string) {
    layout.removeDragSource(poolDragSources[componentType]);
    delete poolDragSources[componentType];
}

// Remove an item from the tab pool when it gets added
layout.addEventListener('itemCreated', e => {
    if (applyingDefault) return;
    const target = e.target as ContentItem;
    if (target.isComponent) {
        removePoolItem((target as ComponentItem).componentType as string);
    }
});


/**
 * There's a bug with the dragging from layout.newDragSource where dragging up
 * from the tab pool causes a .lm_dragProxy to appear, but it doesn't get
 * removed due to an error "Ground node can only have a single child." Rather
 * than fix the bug, just remove all .lm_dragProxy elements after mouseups that
 * follow a state change.
 *
 * The error message still gets logged in console
 */
layout.addEventListener('stateChanged', () => {
    document.addEventListener('mouseup', removeDragProxies);
    document.addEventListener('touchend', removeDragProxies);
    document.documentElement.classList.toggle('has_lm_maximised', !!$('.lm_maximised'));
});

function removeDragProxies() {
    $$('.lm_dragProxy').forEach(e => e.remove());
    document.removeEventListener('mouseup', removeDragProxies);
    document.removeEventListener('touchend', removeDragProxies);
}

/**
 * LayoutConfig has a bunch of optional properties, while ResolvedLayoutConfig
 * marks everything as readonly for no reason. We converted ResolvedLayoutConfig
 * to a superset of LayoutConfig by making everything mutable.
 */
type DeepMutable<T> = { -readonly [key in keyof T]: DeepMutable<T[key]> };

/**
 * Mutate the given item recursively to:
 * - change reorderEnabled (false if isMobile, otherwise true)
 * - change rows to columns (if isMobile, otherwise no change)
 *
 * I don't know what it's necessary to change reorderEnabled on a per-item
 * basis. Should be able to just do currLayout.settings.reorderEnabled = ...,
 * but that is not respected at all, even for new items.
 */
function mutateDeep(item: DeepMutable<ResolvedRootItemConfig>, isMobile: boolean) {
    if (isMobile && item.type === 'row') {
        (item as any).type = 'column';
    }
    (item as any).reorderEnabled = !isMobile;
    if (item.content.length > 0) {
        item.content.forEach(child => mutateDeep(child, isMobile));
    }
}

function toggleMobile(_isMobile: boolean) {
    isMobile = _isMobile;
    // This could be a CSS media query, but I'm keeping generality in case of
    // other config options ("request desktop site", button config, etc.)
    document.documentElement.classList.toggle('mobile', isMobile);
    const currLayout = layout.saveLayout() as DeepMutable<ResolvedLayoutConfig>;
    if (currLayout.root) {
        mutateDeep(currLayout.root, isMobile);
        layout.loadLayout(currLayout as any as LayoutConfig);
    }
    if (isMobile) {
        for (const componentType in poolDragSources)
            removeDragSource(componentType);
    }
    else {
        for (const componentType in poolElements)
            poolDragSources[componentType] = layout.newDragSource(poolElements[componentType], componentType);
    }
    updateMobileContainerHeight();
}

function checkMobile() {
    if ((window.innerWidth < 768) !== isMobile) {
        toggleMobile(!isMobile);
    }
}

window.addEventListener('resize', checkMobile);

/**
 * Golden Layout has handlers for both "touchstart" and "click," which is a
 * problem because a touch on mobile triggers both events (example symptom:
 * tapping "close" button closes two tabs instead of one).
 *
 * Duplicate handlers are present on:
 * - header maximize/close buttons
 * - tab "close" button
 * - tab itself (doesn't matter because selection is idempotent)
 * - header bar (doesn't matter because we don't use it)
 *
 * We work around this by going into GL internals and disabling the touchstart
 * callbacks. This is not supported behavior, but it works.
 */
function deepCancelTouchStart(item: any) {
    if (!item) return;
    if (item.type === 'stack') {
        item._header._closeButton.onTouchStart = () => {};
        item._header._maximiseButton.onTouchStart = () => {};
    }
    else if (item.type === 'component') {
        item._tab.onCloseTouchStart = () => {};
    }
    item._contentItems?.forEach((child: any) => deepCancelTouchStart(child));
}

deepCancelTouchStart(layout.rootItem);

layout.addEventListener('stateChanged', () => {
    deepCancelTouchStart(layout.rootItem);
    updateMobileContainerHeight();
});

function rowCount(item: ContentItem | undefined): number {
    if (!item) return 0;
    if (item.type === 'row')
        return Math.max(...item.contentItems.map(rowCount));
    else if (item.type === 'column')
        return item.contentItems.map(rowCount).reduce((a, b) => a + b);
    else
        return 1;
}

function updateMobileContainerHeight() {
    goldenContainer.style.height =
        isMobile ? rowCount(layout.rootItem) * 25 + 'rem' : '';
}
