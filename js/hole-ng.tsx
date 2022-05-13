import { ASMStateField }                       from '@defasm/codemirror';
import { ComponentItem, ComponentItemConfig, ContentItem, GoldenLayout } from 'golden-layout';
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

let lang = '';
let latestSubmissionID = 0;
let solution = scorings.indexOf(localStorage.getItem('solution') ?? 'Bytes') as 0 | 1;
let scoring  = scorings.indexOf(localStorage.getItem('scoring')  ?? 'Bytes') as 0 | 1;

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

    setCodeForLangAndSolution();
})();

onkeydown = e => (e.ctrlKey || e.metaKey) && e.key == 'Enter' ? submit() : undefined;

// Handle showing/hiding alerts
for (const alert of $$<HTMLDivElement>('.alert')) {
    const closeBtn = alert.querySelector('.main_close') as HTMLDivElement | null;
    if (!closeBtn) continue;
    closeBtn.addEventListener('click', () => {
        const child = (alert.querySelector('svg') as any).cloneNode(true);
        $<HTMLDivElement>('#alert-pool').appendChild(child);
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
    $('#deleteBtn')?.classList.toggle('hide',
        experimental || (!dbBytes && !dbChars));

    const scoreboard = $('#scoreboard');
    if (scoreboard) await populateScores();
}

async function populateScores() {
    // Populate the rankings table.
    const scoringID = scorings[scoring].toLowerCase();
    const path      = `/${hole}/${lang}/${scoringID}`;
    const view      = $('#rankingsView a:not([href])').innerText.toLowerCase();
    const res       = await fetch(`/api/mini-rankings${path}/${view}`);
    const rows      = res.ok ? await res.json() : [];

    $<HTMLAnchorElement>('#allLink').href = '/rankings/holes' + path;

    $('#scores').replaceChildren(<tbody class={scoringID}>{
        // Rows.
        rows.map((r: any) => <tr class={r.me ? 'me' : ''}>
            <td>{r.rank}<sup>{ord(r.rank)}</sup></td>
            <td>
                <a href={`/golfers/${r.golfer.name}`}>
                    <img src={`//avatars.githubusercontent.com/${r.golfer.name}?s=24`}/>
                    <span>{r.golfer.name}</span>
                </a>
            </td>
            <td data-tooltip={tooltip(r, 'Bytes')}>{comma(r.bytes)}</td>
            <td data-tooltip={tooltip(r, 'Chars')}>{comma(r.chars)}</td>
        </tr>)
    }{
        // Padding.
        [...Array(7 - rows.length).keys()].map(() =>
            <tr><td colspan="4">&nbsp;</td></tr>)
    }</tbody>);

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
    $('#restoreLink').classList.toggle('hide',
        !serverCode || editor?.state.doc.toString() == serverCode);
}

/* Temporary golden layout testing */

/**
 * Actual Golden Layout docs are at
 *  https://golden-layout.github.io/golden-layout
 * golden-layout.com is for the old GL.
 */
const layout = new GoldenLayout($<HTMLDivElement>('#golden-container'));
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

            $('#strokes').innerText = scoringKeys
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

layout.registerComponentFactoryFunction('code', async container => {
    container.setTitle('Code');

    const restoreLinkOnClick = (e: MouseEvent) => {
        // TODO (GL) check
        setState(getSolutionCode(lang, solution));
        e.preventDefault();
    };

    const header = (<header>
        <div id="strokes">0 bytes, 0 chars</div>
        <a class="hide" href id="restoreLink" onclick={restoreLinkOnClick}>Restore solution</a>
    </header>) as HTMLElement;
    const editor = <div id="editor"></div> as HTMLDivElement;

    makeEditor(editor);

    header.append($<HTMLTemplateElement>('#template-run').content.cloneNode(true));

    container.element.id = 'editor-section';
    container.element.append(editor, header);

    await afterDOM();

    // Wire submit to clicking a button and a keyboard shortcut.
    $('#runBtn').onclick = submit;

    $('#deleteBtn')?.addEventListener('click', () => {
        $('dialog b').innerText = langs[lang].name;
        $<HTMLInputElement>('dialog [name=lang]').value = lang;
        $<HTMLInputElement>('dialog [name=text]').value = '';
        // Dialog typings are not available yet
        $<any>('dialog').showModal();
    });

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
    const section = $<HTMLTemplateElement>('#template-scoreboard').content.cloneNode(true);
    container.element.append(section);
    container.element.id = 'scoreboard-section';
    await afterDOM();
    populateScores();
    delinkRankingsView();
});

layout.registerComponentFactoryFunction('details', container => {
    container.setTitle('Details');
    const details = $<HTMLTemplateElement>('#template-details').content.cloneNode(true) as HTMLDetailsElement;
    container.element.append(details);
    container.element.id = 'details-content';
});

function plainComponent(componentType: string): ComponentItemConfig {
    return {
        type: 'component',
        componentType: componentType,
    };
}

layout.loadLayout({
    settings: {
        showPopoutIcon: false,
    },
    root: {
        type: 'column',
        content: [
            {
                type: 'row',
                content: [
                    plainComponent('code'),
                    plainComponent('scoreboard'),
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
});

addPoolItem('details', 'Details');

function addItemFromPool(componentType: string) {
    layout.newItem(plainComponent(componentType));
}

function addPoolItem(componentType: string, title: string) {
    const el = (<span class="btn">{title}</span>);
    $('#pool').appendChild(el);
    layout.newDragSource(el, componentType);
    el.addEventListener('click', () => addItemFromPool(componentType));
}

// Add an item to the tab pool when a component gets destroyed
layout.addEventListener('itemDestroyed', e => {
    const _target = e.target as ContentItem;
    if (_target.isComponent) {
        const target = _target as ComponentItem;
        addPoolItem(target.componentType as string, target.title);
    }
});

// Remove an item from the tab pool when it gets added
layout.addEventListener('itemCreated', e => {
    const _target = e.target as ContentItem;
    if (_target.isComponent) {
        const target = _target as ComponentItem;
        for (const poolItem of $$('#pool > span')) {
            if (poolItem.innerText === target.title) {
                poolItem.remove();
                break;
            }
        }
    }
});
