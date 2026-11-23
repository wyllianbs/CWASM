/* ═══════════════════════════════════════════════════════════════════
   CTerminal — embedded C editor + WASM terminal
   Public API:
     CTerminal.create(selector, options) → instance

   Features ported from PyEditor:
     • <template data-slot="extra"> — extra toolbar buttons
     • data-editor-lines / data-terminal-lines — automatic height
     • data-files / data-dirs — preloaded files (unused in WASM, but the
       attribute is parsed for future extensibility)
     • Keyboard shortcuts — draggable floating popup
     • Hourglass animation — during compilation
     • Alt+= / Alt+- / Alt+0 — font size
     • Ctrl+/ — comment/uncomment
     • Ctrl+D — duplicate line
     • Alt+↑/↓ — move line
     • Smart Home (ignores indentation)
     • Auto-indent on Enter
     • Drag-to-snap with improved ghost preview
     • _frozenH / _canonicalH — stable height after the first render
     • _lockContainerHeight — avoids drift during snap
     • _getLineWidth() — DOM probe for the real line width
═══════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════
   Constantes
══════════════════════════════════════════════════════════════════ */
const _LH        = 1.4;
const _FONTSIZE  = 22;
const _fontMin   = 4;
const _fontMax   = 172;
const _fontTerminal =
    `'Hack Nerd Font Mono',
    Consolas,Con
    monospace`;
const _gutterW   = 52;
const _resizerW  = 5;
const _defaultTabSpace = 4;
const _defaultFile     = 'main.c';
const _defaultPosTerm  = 'right';
const _timeRunCode     = 45000;   // 45s compilation timeout
const _minTerminalWidth = 200;

/* ── Instance counter ────────────────────────────────────────── */
let _ctInstCounter = 0;

/* ══════════════════════════════════════════════════════════════════
   MathJax protection  (shell dollar sign vs. formula delimiter)
   ──────────────────────────────────────────────────────────────────
   When the widget lives in a Reveal.js deck with the math plugin active,
   MathJax treats "$ … $" as inline math and DEVOURS the dollar signs —
   corrupting code like  ./$f  or  $PATH.

   Instead of requiring a change to configReveal.js (shared by other
   projects), CTerminal shields its own widgets: it marks each editor's
   root with the CT_IGNORE class and injects that class into
   MathJax.options.ignoreHtmlClass — making MathJax SKIP the whole editor
   subtree, in any version (3/4) and on every typeset (initial and on each
   slidechanged). It does not depend on load order. */
const CT_IGNORE = 'ct-no-mathjax';

const _CTMathGuard = (function () {
    let _patched = false;

    /* Ensures the CT_IGNORE class is present in ignoreHtmlClass of the
       already-initialized MathJax document (regex or string). */
    function _ensureIgnoreOnDoc(mj) {
        try {
            const doc = mj && mj.startup && mj.startup.document;
            if (!doc || !doc.options) return;
            const cur = doc.options.ignoreHtmlClass;
            const has = cur && new RegExp(cur).test(CT_IGNORE);
            if (!has) {
                doc.options.ignoreHtmlClass =
                    (cur ? cur + '|' : '') + CT_IGNORE;
            }
        } catch (_) { /* noop */ }
    }

    /* Also inject into the raw config (in case the document doesn't exist yet). */
    function _ensureIgnoreOnConfig(mj) {
        try {
            mj.options = mj.options || {};
            const cur = mj.options.ignoreHtmlClass;
            const has = cur && new RegExp(cur).test(CT_IGNORE);
            if (!has) {
                mj.options.ignoreHtmlClass =
                    (cur ? cur + '|' : '') + CT_IGNORE;
            }
        } catch (_) { /* noop */ }
    }

    function _apply() {
        const mj = window.MathJax;
        /* Mark the host containers (they exist in the static HTML, before
           the widget renders) so they are skipped from the start. */
        try {
            document.querySelectorAll('.cterminal').forEach(function (el) {
                el.classList.add(CT_IGNORE);
            });
        } catch (_) { /* noop */ }
        if (!mj) return;
        _ensureIgnoreOnConfig(mj);
        _ensureIgnoreOnDoc(mj);
        if (mj.startup && mj.startup.promise && mj.startup.promise.then) {
            mj.startup.promise.then(function () { _ensureIgnoreOnDoc(mj); })
                              .catch(function () {});
        }
    }

    /* Installs a getter/setter on window.MathJax to capture ANY moment the
       plugin assigns the config (window.MathJax = a). */
    function install() {
        if (_patched) { _apply(); return; }
        _patched = true;

        let _val = window.MathJax;
        try {
            Object.defineProperty(window, 'MathJax', {
                configurable: true,
                get() { return _val; },
                set(v) { _val = v; _apply(); }
            });
        } catch (_) {
            /* If it can't be redefined (already non-configurable), apply
               directly and schedule a few retries. */
        }
        _apply();

        /* Safety net: re-apply a few moments later and on slidechanged. */
        let tries = 0;
        const iv = setInterval(function () {
            _apply();
            if (++tries >= 20 || (window.MathJax && window.MathJax.startup
                && window.MathJax.startup.document)) {
                clearInterval(iv);
            }
        }, 250);

        if (typeof Reveal !== 'undefined' && Reveal.addEventListener) {
            Reveal.addEventListener('ready',        _apply);
            Reveal.addEventListener('slidechanged', _apply);
        }
        document.addEventListener('DOMContentLoaded', _apply);
    }

    return { install: install, apply: _apply };
})();
try { _CTMathGuard.install(); } catch (_) { /* noop */ }


/* ── Syntax highlight C ──────────────────────────────────────── */
const _C_KEYWORDS = new Set([
    'auto','break','case','const','continue','default','do','else','enum',
    'extern','for','goto','if','inline','register','restrict','return',
    'sizeof','static','struct','switch','typedef','union','volatile','while',
    '_Alignas','_Alignof','_Atomic','_Bool','_Complex','_Generic',
    '_Imaginary','_Noreturn','_Static_assert','_Thread_local','nullptr'
]);
const _C_TYPES = new Set([
    'void','int','char','short','long','float','double','signed','unsigned',
    'bool','size_t','ssize_t','ptrdiff_t','intptr_t','uintptr_t',
    'int8_t','int16_t','int32_t','int64_t',
    'uint8_t','uint16_t','uint32_t','uint64_t',
    'FILE','NULL','true','false','EOF'
]);

function _escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function _colorizePreproc(line) {
    const m = line.match(/^([ \t]*)(#)([ \t]*)([a-zA-Z_]+)([ \t]*)(.*)?$/s);
    if (!m) return `<span class="tk-pre">${_escHtml(line)}</span>`;
    const [, indent, hash, sp1, directive, sp2, rest = ''] = m;

    /* Split off a comment (// ... or /* ... *​/) appearing at the END of
       the directive. Without this, "#include <stdio.h> /* text *​/" swallows
       the comment as part of the preprocessor (the regex's preproc branch
       consumes the whole line), leaving it without the tk-cmt color.
       Only considers a comment outside quotes and <...>. */
    let body = rest;
    let tail = '';
    {
        let inStr = null;   /* ", ' or < (for <...>) */
        for (let i = 0; i < body.length; i++) {
            const c = body[i];
            if (inStr) {
                if ((inStr === '"' && c === '"') ||
                    (inStr === "'" && c === "'") ||
                    (inStr === '<' && c === '>')) inStr = null;
            } else if (c === '"' || c === "'" || c === '<') {
                inStr = c;
            } else if (c === '/' && (body[i + 1] === '/' || body[i + 1] === '*')) {
                tail = body.slice(i);       /* from // or /* to end of line */
                body = body.slice(0, i);    /* directive without the comment */
                break;
            }
        }
    }
    const tailHtml = tail ? `<span class="tk-cmt">${_escHtml(tail)}</span>` : '';

    let out = _escHtml(indent)
            + `<span class="tk-pre">${_escHtml(hash + sp1 + directive)}</span>`
            + _escHtml(sp2);
    const dir = directive.toLowerCase();
    if (dir === 'include' || dir === 'include_next') {
        const hm = body.match(/^(<[^>]*>|"[^"]*")(.*)?$/s);
        if (hm) out += `<span class="tk-pre-str">${_escHtml(hm[1])}</span>` + _escHtml(hm[2] || '');
        else    out += _escHtml(body);
    } else if (dir === 'define') {
        const dm = body.match(/^([a-zA-Z_][a-zA-Z0-9_]*)(\([^)]*\))?([ \t]*)(.*)?$/s);
        if (dm) out += `<span class="tk-pre-name">${_escHtml(dm[1])}</span>`
                     + _escHtml(dm[2]||'') + _escHtml(dm[3]||'') + _escHtml(dm[4]||'');
        else    out += _escHtml(body);
    } else {
        out += _escHtml(body);
    }
    return out + tailHtml;
}

function _highlightC(code) {
    const re = new RegExp(
        '(\\/\\/[^\\n]*)' +
        '|(\\/\\*[\\s\\S]*?\\*\\/)' +
        '|(\"(?:[^\"\\\\]|\\\\.)*\"|\'(?:[^\'\\\\]|\\\\.)*\')' +
        '|(^[ \\t]*#[^\\n]*)' +
        '|\\b([0-9]+(?:\\.[0-9]*)?(?:[eEfFlLuU]*)' +
          '|0[xX][0-9a-fA-F]+[lLuU]*)\\b' +
        '|\\b([a-zA-Z_][a-zA-Z0-9_]*)\\b' +
        '|([\\+\\-\\*\\/\\%\\=\\!\\<\\>\\&\\|\\^\\~\\?\\:\\;\\,\\.\\(\\)\\[\\]\\{\\}])'
        , 'gm'
    );
    let out = '', last = 0;
    code.replace(re, (match, cmt1, cmt2, strlit, preproc, num, ident, op, offset) => {
        if (offset > last) out += _escHtml(code.slice(last, offset));
        last = offset + match.length;
        if      (cmt1   !== undefined || cmt2    !== undefined) out += `<span class="tk-cmt">${_escHtml(match)}</span>`;
        else if (strlit  !== undefined) out += `<span class="tk-str">${_escHtml(match)}</span>`;
        else if (preproc !== undefined) out += _colorizePreproc(preproc);
        else if (num     !== undefined) out += `<span class="tk-num">${_escHtml(match)}</span>`;
        else if (ident   !== undefined) {
            if      (_C_KEYWORDS.has(match)) out += `<span class="tk-kw">${_escHtml(match)}</span>`;
            else if (_C_TYPES.has(match))    out += `<span class="tk-type">${_escHtml(match)}</span>`;
            else                             out += `<span class="tk-ident" data-id="${_escHtml(match)}">${_escHtml(match)}</span>`;
        } else if (op !== undefined) {
            out += `<span class="tk-op">${_escHtml(match)}</span>`;
        }
        return match;
    });
    if (last < code.length) out += _escHtml(code.slice(last));
    out = out.replace(
        /<span class="tk-ident" data-id="([^"]+)">([^<]+)<\/span>\s*<span class="tk-op">\(<\/span>/g,
        (_, id, txt) => `<span class="tk-fn">${_escHtml(txt)}</span><span class="tk-op">(</span>`
    );
    out = out.replace(/<span class="tk-ident" data-id="[^"]*">/g, '<span>');
    return out;
}

/* ── Fragment helpers ───────────────────────────────────────── */
function _parseLineNumbers(attr) {
    if (!attr || !attr.trim()) return [];
    return attr.split('|').map(seg => {
        seg = seg.trim();
        if (seg === '') return null;
        const set = new Set();
        seg.split(',').forEach(part => {
            part = part.trim();
            const range = part.match(/^(\d+)-(\d+)$/);
            if (range) { const lo=parseInt(range[1]),hi=parseInt(range[2]); for(let i=lo;i<=hi;i++) set.add(i); }
            else if (/^\d+$/.test(part)) set.add(parseInt(part));
        });
        return set.size ? set : null;
    });
}

function _parseHighlightAttr(attr) {
    const map = new Map();
    if (!attr || !attr.trim()) return map;
    const tokenRe = /(\d+)\[(\d+)-(\d+)\](?:\[([^\]]+)\])?/g;
    let m;
    while ((m = tokenRe.exec(attr)) !== null) {
        const lineNum  = parseInt(m[1]);
        const colStart = parseInt(m[2]);
        const colEnd   = parseInt(m[3]);
        const color    = m[4] ? m[4].trim() : 'yellow';
        if (!map.has(lineNum)) map.set(lineNum, []);
        map.get(lineNum).push({ start: colStart, end: colEnd, color });
    }
    return map;
}

function _buildLineMarkBackground(marks) {
    if (!marks || marks.length === 0) return '';
    const sorted = [...marks].sort((a, b) => a.start - b.start);
    const stops = [];
    let cursor = 0;
    sorted.forEach(({ start, end, color }) => {
        const s = start - 1, e = end;
        if (s > cursor) stops.push(`transparent ${cursor}ch`, `transparent ${s}ch`);
        stops.push(`${color} ${s}ch`, `${color} ${e}ch`);
        cursor = e;
    });
    stops.push(`transparent ${cursor}ch`);
    return `linear-gradient(90deg, ${stops.join(', ')})`;
}

/* Splits already-tokenized HTML into one string per line, closing and
   reopening active spans at each break — just like pyeditor. */
function _splitHtmlByNewlines(html, expectedLines) {
    const result = [];
    let current = '', inTag = false;
    const openSpans = [];
    let tagBuf = '';

    for (let i = 0; i < html.length; i++) {
        const ch = html[i];
        if (ch === '<') {
            inTag = true; tagBuf = '<';
        } else if (ch === '>' && inTag) {
            inTag = false; tagBuf += '>';
            current += tagBuf;
            if (tagBuf.startsWith('</')) openSpans.pop();
            else if (!tagBuf.endsWith('/>')) openSpans.push(tagBuf);
            tagBuf = '';
        } else if (inTag) {
            tagBuf += ch;
        } else if (ch === '\n') {
            for (let k = openSpans.length - 1; k >= 0; k--) current += '</span>';
            result.push(current); current = '';
            for (let k = 0; k < openSpans.length; k++) current += openSpans[k];
        } else {
            current += ch;
        }
    }
    for (let k = openSpans.length - 1; k >= 0; k--) current += '</span>';
    result.push(current);
    while (result.length < expectedLines) result.push('');
    return result.slice(0, expectedLines);
}

/* ── Shortcuts overlay CSS (injected once) ────────────────────── */
let _shortcutsCSSInjected = false;
function _injectShortcutsCSS() {
    if (_shortcutsCSSInjected) return;
    _shortcutsCSSInjected = true;
    const st = document.createElement('style');
    st.id = 'ct-shortcuts-style';
    st.textContent = `
.ct-shortcuts-float {
    position: fixed;
    z-index: 99999;
    box-shadow: 0 8px 32px rgba(0,0,0,.22), 0 2px 8px rgba(0,0,0,.14);
    border-radius: 10px;
    animation: ct-sf-in 0.15s ease;
}
.ct-shortcuts-float .ct-shortcuts-header { cursor: grab; user-select: none; }
.ct-shortcuts-float .ct-shortcuts-close  { cursor: pointer; }
@keyframes ct-sf-in {
    from { opacity:0; transform: scale(0.96) translateY(-4px); }
    to   { opacity:1; transform: scale(1)    translateY(0);     }
}
`;
    document.head.appendChild(st);
}


/* ═══════════════════════════════════════════════════════════════
   CTerminalInstance
═══════════════════════════════════════════════════════════════ */
/* Standard-number → badge-label map. */
const _STD_LABELS = { '89': 'C89', '90': 'C90', '99': 'C99', '9x': 'C99',
                      '11': 'C11', '1x': 'C11', '17': 'C17', '18': 'C18',
                      '23': 'C23', '2x': 'C23', '2y': 'C2Y', '2z': 'C2Z' };

/* Converts a standard token (c23 / gnu17 / gnu2y / 2y) into a label (C23…). */
function _stdLabel(std) {
    const m = /(?:gnu|c)?([0-9]+[xyz]?)/i.exec(String(std || ''));
    if (!m) return null;
    const n = m[1].toLowerCase();
    return _STD_LABELS[n] || ('C' + n.toUpperCase());
}

/* Label of the default standard (no -std in the widget): comes from the
   toolchain manifest via window.__cwasmDefaultStd (published by scriptExec =
   the newest standard clang accepts, detected at build time). Falls back to
   'C23' while the manifest hasn't resolved. */
function _defaultStdLabel() {
    const g = (typeof window !== 'undefined') ? window.__cwasmDefaultStd : null;
    return _stdLabel(g) || 'C23';
}

/* Derives the C-standard label from the flags (-std=cNN / -std=gnuNN).
   E.g. "-std=c23" → "C23"; "-std=gnu17" → "C17". No -std → the toolchain's
   default standard (dynamic, _defaultStdLabel). */
function _stdBadge(cflags) {
    const m = /-std=(\S+)/i.exec(cflags || '');
    if (!m) return _defaultStdLabel();
    return _stdLabel(m[1]) || _defaultStdLabel();
}

/* When scriptExec resolves the manifest's defaultStd (async), update the
   badges showing the default standard (widgets with no explicit -std). */
if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('cwasm:defaultstd', function () {
        const label = _defaultStdLabel();
        document.querySelectorAll('.ct-lang-badge[data-std-default="1"]')
            .forEach(function (b) { b.textContent = label; });
    });
}

class CTerminalInstance {

    constructor(container, opts) {
        this._id        = ++_ctInstCounter;
        this._container = container;
        this._opts      = opts;

        /* C-standard label in the toolbar badge, derived from -std= in
           data-cflags (e.g. data-cflags="-Wall -Wextra -std=c23" → "C23"). */
        this._cflags    = (opts.cflags || (container.dataset && container.dataset.cflags) || '').toString();

        /* ── Read the raw code from the widget ──────────────────────
           Preferred source: <script type="text/plain"> (raw text: every C
           character — < > & # $ % — preserved without escaping).
           Fallback: <template> (read via content.textContent).
           Multi-file: multiple <script type="text/plain"> with
           data-filename define extra (local .h/.c) files. */
        const _scripts = container.querySelectorAll('script[type="text/plain"]:not([data-slot])');
        const _tmpl = container.querySelector('template:not([data-slot])');
        const mainFilename = opts.filename || _defaultFile;

        this._files = new Map();
        this._fileDefaults = new Map();

        if (_scripts.length > 0) {
            for (const scr of _scripts) {
                const fn = scr.dataset.filename || mainFilename;
                const code = (scr.textContent || '').replace(/^\n/, '').replace(/\n$/, '');
                this._files.set(fn, code);
                this._fileDefaults.set(fn, code);
            }
        } else if (_tmpl) {
            const code = (_tmpl.content.textContent || '').replace(/^\n/, '').replace(/\n$/, '');
            this._files.set(mainFilename, code);
            this._fileDefaults.set(mainFilename, code);
        } else {
            const code = (opts.code || '').replace(/^\n/, '').replace(/\n$/, '');
            this._files.set(mainFilename, code);
            this._fileDefaults.set(mainFilename, code);
        }

        this._mainFile = mainFilename;
        this._activeFile = mainFilename;
        this._defaultCode = this._files.get(mainFilename) || '';
        this._allowNewFiles = !!opts.allowNewFiles;
        this._multiFile = this._files.size > 1 || this._allowNewFiles;

        /* ── Slot extra da toolbar (<template data-slot="extra">) ── */
        const _tmplExtra = container.querySelector('template[data-slot="extra"]');
        this._extraHtml = _tmplExtra
            ? _tmplExtra.innerHTML.trim()
            : (opts.extraHtml || '');

        /* ── data-files / data-dirs (parseados, reservados p/ extensibilidade) */
        {
            let files = opts.files || null;
            let dirs  = opts.dirs  || null;
            if (!files && container.dataset.files) {
                const raw = container.dataset.files.trim();
                try { files = JSON.parse(raw); }
                catch (_) { files = raw.split(',').map(s => s.trim()).filter(Boolean); }
            }
            if (!dirs && container.dataset.dirs) {
                const raw = container.dataset.dirs.trim();
                try { dirs = JSON.parse(raw); }
                catch (_) { dirs = raw.split(',').map(s => s.trim()).filter(Boolean); }
            }
            this._serverFiles = (files || dirs) ? { files: files || [], dirs: dirs || [] } : null;
        }

        /* ── Estado ──────────────────────────────────────────────── */
        this._activeLine  = 1;
        this._currentFz   = opts.fontSize        || _FONTSIZE;
        this._currentTfz  = opts.terminalFontSize || _FONTSIZE;
        this._FZ_MIN      = _fontMin; this._FZ_MAX = _fontMax;
        this._cachedChW   = 0;

        /* Stable-height flags (ported from pyeditor) */
        this._userResized         = false;
        this._lockContainerHeight = null;
        this._snapHeight          = null;
        this._canonicalH          = null;
        this._frozenH             = null;

        this._fragState = { fragments: [], current: -1 };
        this._lhPx      = this._currentFz * _LH;
        this._nLines    = 1;
        this._declaredN = NaN;

        _injectShortcutsCSS();
        this._build();
        this._applyFontSizes();
        this._init();
        this._bindAll();
        if (this._multiFile) this._rebuildFiletree();
    }

    /* ── Unique ID per instance ─────────────────────────────── */
    _uid(n) { return `ct${this._id}-${n}`; }

    /* ── Build the widget's DOM ─────────────────────────────── */
    _build() {
        const id   = n => this._uid(n);
        const opts = this._opts;
        const fname       = opts.filename || _defaultFile;
        const langIcon    = '<i class="nf nf-custom-c" style="font-size:18px;color:#7eb3ff;"></i>';
        const langBadge   = _stdBadge(this._cflags);
        /* Mark the badge as "default" when the widget doesn't set -std, so
           the cwasm:defaultstd updater can fix it if the manifest resolves
           after rendering. */
        const langStdDefault = /-std=/i.test(this._cflags) ? '' : ' data-std-default="1"';
        const langDotIcon = '<i class="nf nf-custom-c ct-icon-term"></i>';
        const langSbIcon  = '<i class="nf nf-dev-c"></i> <i class="nf nf-fa-ellipsis_vertical"></i><i class="nf nf-dev-wasm"></i>';
        /* Real toolchain target: the worker compiles with wasm32-wasip1
           (the canonical/modern spelling of the same WASI preview1 target;
           wasm32-wasi is deprecated in clang 23). Comes from a variable —
           override via data-target on the widget, otherwise the canonical. */
        const langTarget  = (this._container.dataset && this._container.dataset.target) || 'wasm32-wasip1';
        const langAria    = 'C code editor';

        const pos    = String(opts.terminalPosition || _defaultPosTerm).trim().toLowerCase();
        const isVert = pos === 'top' || pos === 'bottom';

        let wDir = 'row';
        if (pos === 'top')    wDir = 'column-reverse';
        if (pos === 'bottom') wDir = 'column';
        if (pos === 'left')   wDir = 'row-reverse';

        const spellVal = String(opts.spellcheck) === 'true' ? 'true' : 'false';
        const sA  = `spellcheck="${spellVal}"`;
        const aC  = `autocomplete="${opts.autocomplete  !== undefined ? opts.autocomplete  : 'off'}"`;
        const aR  = `autocorrect="${opts.autocorrect    !== undefined ? opts.autocorrect   : 'off'}"`;
        const aP  = `autocapitalize="${opts.autocapitalize !== undefined ? opts.autocapitalize : 'off'}"`;
        const lnA = opts.linenumbers ? ` data-line-numbers="${_escHtml(opts.linenumbers)}"` : '';
        const hlA = opts.highlight   ? ` data-highlight="${_escHtml(opts.highlight)}"` : '';

        this._container.innerHTML = `
<div class="ct-widget ${CT_IGNORE}" id="${id('root')}"
     style="display:flex;flex-direction:column;height:100%;width:100%;overflow:hidden;position:relative;">

  <!-- Toolbar -->
  <div class="ct-toolbar" id="${id('toolbar')}">
    <div class="ct-toolbar-title">
      ${langIcon}
      <span class="ct-filename">${_escHtml(fname)}</span>
      <span class="ct-lang-badge"${langStdDefault}>${langBadge}</span>
    </div>
    <div class="ct-tb-sep"></div>
    <button class="ct-tb-btn ct-primary" id="${id('btnRun')}" title="Compile and run (Ctrl+Enter)">
      <i class="nf nf-fa-gear ct-tb-btn-icon"></i><span>Compile &amp; Run</span>
    </button>
    <div class="ct-tb-sep"></div>
    <button class="ct-tb-btn" id="${id('btnReset')}" title="Restore code (Alt+Enter)">
      <i class="nf nf-md-restore ct-tb-btn-icon"></i><span>Restore</span>
    </button>
    <div class="ct-tb-extra" id="${id('tb-extra')}">${this._extraHtml}</div>
    <div style="flex:1"></div>
    <button class="ct-tb-btn" id="${id('btnCopy')}" title="Copy code">
      <i class="nf nf-md-content_copy ct-tb-btn-icon"></i><span>Copy</span>
    </button>
    <div class="ct-tb-sep"></div>
    <button class="ct-tb-btn" id="${id('btnShortcuts')}" title="Keyboard shortcuts">
      <i class="nf nf-md-keyboard ct-tb-btn-icon"></i>
    </button>
  </div>

  <!-- Workspace -->
  <div class="ct-workspace" id="${id('workspace')}" style="flex-direction:${wDir};">

    <!-- Editor pane -->
    <div class="ct-editor-pane" id="${id('editor-pane')}">
      <div class="ct-editor-pane-header">
        <div class="ct-drag-handle" id="${id('editor-drag-h')}" title="Drag panel"><i class="nf nf-md-drag ct-icon-term"></i></div>
        <div class="ct-dot" id="${id('edit-dot')}">${langDotIcon}</div>
        ${this._multiFile ? `<div class="ct-filetree-wrap" id="${id('filetree-wrap')}">
          <button class="ct-filetree-btn" id="${id('filetree-btn')}" title="Project files">
            <i class="nf nf-md-file_tree"></i>
          </button>
          <div class="ct-filetree-dropdown" id="${id('filetree-dd')}" style="display:none"></div>
        </div>` : ''}<span class="ct-editor-filename" id="${id('editor-fname')}">${_escHtml(fname)}</span>
        <div class="ct-editor-center">
          <div class="ct-frag-bar" id="${id('frag-bar')}" style="display:none">
            <button id="${id('frag-prev')}" title="Previous fragment">‹</button>
            <span id="${id('frag-label')}">1 / 1</span>
            <button id="${id('frag-next')}" title="Next fragment">›</button>
          </div>
          <div class="ct-tb-fz" title="Editor font size">
            <button id="${id('fz-dn')}">−</button>
            <span   id="${id('fz-val')}">${this._currentFz}</span>
            <button id="${id('fz-up')}">+</button>
          </div>
        </div>
        <span class="ct-cursor-info" id="${id('cursor-info')}" style="margin-left:auto">Ln 1, Col 1</span>
      </div>
      <div class="ct-editor-scroll" id="${id('editor-scroll')}">
        <div class="ct-code-area" id="${id('code-area')}">
          <div class="ct-gutter" id="${id('gutter')}"></div>
          <div class="ct-code-inner" id="${id('code-inner')}">
            <div class="ct-highlight-layer" id="${id('hl-layer')}" aria-hidden="true"></div>
            <textarea id="${id('code-input')}" class="ct-code-input"
              ${sA} ${aC} ${aR} ${aP}
              data-gramm="false" data-gramm_editor="false" data-enable-grammarly="false"
              aria-label="${langAria}"
              ${lnA} ${hlA}></textarea>
          </div>
        </div>
      </div>
    </div>

    <!-- Resizer -->
    <div class="ct-resizer" id="${id('resizer')}"
         style="cursor:${isVert ? 'row-resize' : 'col-resize'};"></div>

    <!-- Output pane -->
    <div class="ct-output-pane" id="${id('output-pane')}">
      <div class="ct-output-pane-header">
        <div class="ct-drag-handle" id="${id('output-drag-h')}" title="Drag panel"><i class="nf nf-md-drag ct-icon-term"></i></div>
        <div class="ct-output-left">
          <i class="nf nf-oct-terminal ct-icon-term"></i>
          <span id="${id('out-status')}" style="font-size:11px;color:var(--text-muted);margin-left:4px;"></span>
        </div>
        <div class="ct-output-center">
          <div class="ct-out-fz" title="Terminal font size">
            <button id="${id('tfz-dn')}">−</button>
            <span   id="${id('tfz-val')}">${this._currentTfz}</span>
            <button id="${id('tfz-up')}">+</button>
          </div>
        </div>
        <div class="ct-output-right">
          <button class="ct-out-btn" id="${id('btnClear')}" title="Clear terminal">
            <i class="nf nf-md-broom"></i><span>Clear</span>
          </button>
        </div>
      </div>
      <div class="ct-output-scroll" id="${id('output-scroll')}" tabindex="0">
        <div class="ct-console-out" id="${id('console-out')}"></div>
      </div>
    </div>

  </div><!-- /.ct-workspace -->

  <!-- Snap overlay -->
  <div class="ct-snap-overlay" id="${id('snap-overlay')}"
       style="display:none;position:absolute;inset:0;pointer-events:none;">
    <div class="ct-snap-zone" data-zone="left">  <span class="ct-snap-zone-label">⬅ Left</span></div>
    <div class="ct-snap-zone" data-zone="right"> <span class="ct-snap-zone-label">Right ➡</span></div>
    <div class="ct-snap-zone" data-zone="top">   <span class="ct-snap-zone-label">⬆ Top</span></div>
    <div class="ct-snap-zone" data-zone="bottom"><span class="ct-snap-zone-label">⬇ Bottom</span></div>
  </div>

  <!-- Status bar -->
  <div class="ct-statusbar">
    <div class="ct-sb-item">
      ${langSbIcon}
    </div>
    <div class="ct-sb-sep"></div>
    <div class="ct-sb-item">
      <i class="nf nf-md-format_list_numbered" style="font-size:12px;"></i>
      <span id="${id('sb-lines')}">1 line</span>
    </div>
    <div class="ct-sb-sep"></div>
    <div class="ct-sb-item">UTF-8</div>
    <div class="ct-sb-sep"></div>
    <div class="ct-sb-item">
      <i class="nf nf-fa-microchip" style="font-size:12px;"></i>
      <span>${langTarget}</span>
    </div>
    <span id="${id('status-msg')}" style="margin-left:auto;"><i class="nf nf-fa-circle_check"></i> Ready</span>
  </div>
</div>

<!-- CWasmExec bridge (hidden) -->
<div style="display:none">
  <code id="${id('inputCode')}" data-filename="${_escHtml(fname)}"></code>
  <button id="${id('btnCWasm')}"></button>
  <div id="${id('consoleHidden')}"></div>
</div>`;

        /* ── Shortcuts overlay in the <body> ─────────────────── */
        {
            const _ov = document.createElement('div');
            _ov.id = id('shortcuts-overlay');
            _ov.className = 'ct-shortcuts-float';
            _ov.style.display = 'none';
            _ov.innerHTML = `
              <div class="ct-shortcuts-modal">
                <div class="ct-shortcuts-header">
                  <span>Keyboard shortcuts</span>
                  <button class="ct-shortcuts-close" id="${id('shortcuts-close')}">✕</button>
                </div>
                <div class="ct-shortcuts-body">
                  <table class="ct-shortcuts-table">
                    <tr><td><kbd>Ctrl</kbd>+<kbd>Enter</kbd></td><td>Compile and run</td></tr>
                    <tr><td><kbd>Ctrl</kbd>+<kbd>/</kbd></td><td>Comment / uncomment line(s)</td></tr>
                    <tr><td><kbd>Ctrl</kbd>+<kbd>D</kbd></td><td>Duplicate line</td></tr>
                    <tr><td><kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>↓</kbd></td><td>Move line</td></tr>
                    <tr><td><kbd>Tab</kbd></td><td>Indent (4 spaces)</td></tr>
                    <tr><td><kbd>Shift</kbd>+<kbd>Tab</kbd></td><td>Unindent</td></tr>
                    <tr><td><kbd>Home</kbd></td><td>Go to beginning of line (ignore indentation)</td></tr>
                    <tr><td><kbd>Alt</kbd>+<kbd>Enter</kbd></td><td>Restore initial code</td></tr>
                    <tr class="ct-shortcuts-sep"><td colspan="2"></td></tr>
                    <tr><td><kbd>Ctrl</kbd>+<kbd>→</kbd> / <kbd>↓</kbd></td><td>Next code fragment</td></tr>
                    <tr><td><kbd>Ctrl</kbd>+<kbd>←</kbd> / <kbd>↑</kbd></td><td>Previous fragment</td></tr>
                    <tr><td><kbd>Ctrl</kbd>+<kbd>Home</kbd></td><td>First fragment</td></tr>
                    <tr><td><kbd>Ctrl</kbd>+<kbd>End</kbd></td><td>Last fragment</td></tr>
                    <tr class="ct-shortcuts-sep"><td colspan="2"></td></tr>
                    <tr><td><kbd>Alt</kbd>+<kbd>=</kbd></td><td>Increase font size (editor or terminal*)</td></tr>
                    <tr><td><kbd>Alt</kbd>+<kbd>−</kbd></td><td>Decrease font size (editor or terminal*)</td></tr>
                    <tr><td><kbd>Alt</kbd>+<kbd>0</kbd></td><td>Reset font size (editor or terminal*)</td></tr>
                  </table>
                  <p class="ct-shortcuts-note">On Mac, use <kbd>Cmd</kbd> instead of <kbd>Ctrl</kbd>.</p>
                  <p class="ct-shortcuts-note">* Click the output panel to focus it and change the terminal font size.</p>
                </div>
              </div>`;
            document.body.appendChild(_ov);
        }

        /* ── Refs ─────────────────────────────────────────────── */
        const q = n => document.getElementById(this._uid(n));
        this._el = {
            root:          q('root'),
            workspace:     q('workspace'),
            codeInput:     q('code-input'),
            hlLayer:       q('hl-layer'),
            gutter:        q('gutter'),
            editorScroll:  q('editor-scroll'),
            codeArea:      q('code-area'),
            codeInner:     q('code-inner'),
            editDot:       q('edit-dot'),
            cursorInfo:    q('cursor-info'),
            sbLines:       q('sb-lines'),
            statusMsg:     q('status-msg'),
            fzVal:         q('fz-val'),
            tfzVal:        q('tfz-val'),
            btnRun:        q('btnRun'),
            btnReset:      q('btnReset'),
            btnCopy:       q('btnCopy'),
            btnClear:      q('btnClear'),
            btnShortcuts:  q('btnShortcuts'),
            tbExtra:       q('tb-extra'),
            outStatus:     q('out-status'),
            shortcutsOverlay: document.getElementById(this._uid('shortcuts-overlay')),
            shortcutsClose:   document.getElementById(this._uid('shortcuts-close')),
            fragBar:       q('frag-bar'),
            fragLabel:     q('frag-label'),
            fragPrev:      q('frag-prev'),
            fragNext:      q('frag-next'),
            editorPane:    q('editor-pane'),
            resizer:       q('resizer'),
            outputPane:    q('output-pane'),
            outputScroll:  q('output-scroll'),
            consoleOut:    q('console-out'),
            snapOverlay:   q('snap-overlay'),
            editorDragH:   q('editor-drag-h'),
            outputDragH:   q('output-drag-h'),
            hiddenCode:    q('inputCode'),
            hiddenBtn:     q('btnCWasm'),
            hiddenConsole: q('consoleHidden'),
            filetreeWrap:  q('filetree-wrap'),
            filetreeBtn:   q('filetree-btn'),
            filetreeDd:    q('filetree-dd'),
            editorFname:   q('editor-fname'),
        };
    }

    /* ── CSS vars ─────────────────────────────────────────────── */
    _applyFontSizes() {
        const r = this._el.root;
        r.style.setProperty('--editor-fs',   this._currentFz  + 'px');
        r.style.setProperty('--terminal-fs', this._currentTfz + 'px');
        r.style.setProperty('--line-h',      `${_LH}`);
        r.style.setProperty('--gutter-w',    `${_gutterW}px`);
        r.style.setProperty('--font-editor', `${_fontTerminal}`);
    }

    /* ── Syntax highlight + gutter ───────────────────────────── */
    _updateHighlight() {
        const el   = this._el;
        const code = el.codeInput.value;
        const lines = code.split('\n');
        const n     = lines.length;

        const fullHtml  = _highlightC(code);
        const lineHtmls = _splitHtmlByNewlines(fullHtml, n);
        const hlAttr    = el.codeInput.getAttribute('data-highlight') || '';
        const hlMarks   = _parseHighlightAttr(hlAttr);

        el.hlLayer.innerHTML = lineHtmls.map((h, i) => {
            const lineNum = i + 1;
            const marks   = hlMarks.get(lineNum);
            const bgStyle = marks ? ` style="background-image:${_buildLineMarkBackground(marks)}"` : '';
            const trail   = (i < n - 1) ? '\n' : '';
            return `<span class="hl-line" data-ln="${lineNum}"${bgStyle}>${h}${trail}</span>`;
        }).join('');

        /* Gutter — faithful port of pyeditor
           The gutter has overflow-y:hidden and height = visH (visible window).
           Synced via gutter.scrollTop = editorScroll.scrollTop.
           For gutter.scrollTop = T to work, the gutter content must be
           >= visH + T. nExtra covers the padding + the full visH. */
        const fsStr = el.root.style.getPropertyValue('--editor-fs') || `${_FONTSIZE}px`;
        const lhStr = el.root.style.getPropertyValue('--line-h')    || `${_LH}`;
        const lh    = parseFloat(fsStr) * parseFloat(lhStr);
        this._lhPx  = lh;
        this._nLines = n;

        let visH = el.editorScroll.clientHeight || 200;

        /* Read the declared N */
        let _declaredN = NaN;
        if (this._container.dataset.editorLines) {
            _declaredN = parseInt(this._container.dataset.editorLines, 10);
        } else if (this._opts.editorLines !== undefined) {
            _declaredN = parseInt(this._opts.editorLines, 10);
        }
        this._declaredN = _declaredN;
        const _hasN  = !isNaN(_declaredN);
        const _overN = _hasN && n > _declaredN;
        const _contentH = n * lh;
        const _overH = _contentH > visH;

        /* overflowY:
           - n > N or content doesn't fit → auto (scroll)
           - n <= N and it fits → hidden (no scroll, no blank space) */
        el.editorScroll.style.overflowY = (_overN || _overH) ? 'auto' : (_hasN ? 'hidden' : 'auto');

        /* With syncing via negative marginTop, the gutter needs no extra
           spans to be "scrollable" — only the real code lines are rendered,
           with no blank space below. */
        const nTotal = n;

        const existing = el.gutter.children;
        while (existing.length < nTotal) {
            const s = document.createElement('span');
            s.className = 'gutter-line';
            el.gutter.appendChild(s);
        }
        while (existing.length > nTotal) el.gutter.removeChild(el.gutter.lastChild);

        for (let i = 0; i < nTotal; i++) {
            if (i < n) {
                existing[i].textContent = i + 1;
                existing[i].classList.toggle('active', i + 1 === this._activeLine);
            } else {
                existing[i].textContent = '';
                existing[i].classList.remove('active');
            }
            existing[i].style.height = lh + 'px';
        }

        el.sbLines.textContent = n + (n === 1 ? ' line' : ' lines');
        el.editDot.classList.toggle('edited', code !== this._defaultCode);

        if (this._fragState.current >= 0) this._applyFragment();

        this._syncEditorHeight();

        if (this._opts.sepbar === undefined) {
            const pos = String(this._opts.terminalPosition ?? _defaultPosTerm).trim().toLowerCase();
            if (!['top','bottom'].includes(pos)) this._fitEditorToContent();
        }
    }

    /* ── Fragment helpers ──────────────────────────────────────── */
    _initFragments() {
        const attr = this._el.codeInput.getAttribute('data-line-numbers') || '';
        this._fragState.fragments = _parseLineNumbers(attr);
        this._fragState.current   = this._fragState.fragments.length ? 0 : -1;
    }

    _applyFragment() {
        const lines      = this._el.hlLayer.querySelectorAll('.hl-line');
        const gutterLines= this._el.gutter.querySelectorAll('.gutter-line');
        const frag       = this._fragState.fragments[this._fragState.current];
        lines.forEach((el, i) => el.classList.toggle('hl-dim', frag ? !frag.has(i+1) : false));
        gutterLines.forEach((el, i) => el.classList.toggle('hl-dim', frag ? !frag.has(i+1) : false));
        this._updateFragmentUI();
        this._scrollToFragment(frag);
    }

    _scrollToFragment(frag) {
        const el = this._el;
        if (this._fragAnimID) { cancelAnimationFrame(this._fragAnimID); this._fragAnimID = null; }

        const lhPx = this._lhPx || (this._currentFz * _LH);
        let targetTop;
        if (!frag) {
            targetTop = 0;
        } else {
            const fragLines = [...frag].sort((a,b)=>a-b);
            const firstLn = fragLines[0], lastLn = fragLines[fragLines.length-1];
            const fragTop = (firstLn - 1) * lhPx;
            const fragBot = lastLn * lhPx;
            const fragH   = fragBot - fragTop;
            const viewH   = el.editorScroll.clientHeight || 0;
            targetTop = fragTop + (Math.min(fragH, viewH) - viewH) / 2;
            targetTop = Math.max(0, targetTop);
        }

        const contentH = parseFloat(el.hlLayer.style.height) || el.hlLayer.scrollHeight;
        const viewH2   = el.editorScroll.clientHeight || 0;
        const maxTop   = Math.max(0, contentH - viewH2);
        targetTop      = Math.min(targetTop, maxTop);

        const startTop = el.editorScroll.scrollTop;
        if (Math.abs(startTop - targetTop) < 1) { this._syncScrollStyles(targetTop); return; }

        let progress = 0;
        const self = this;
        const step = () => {
            progress = Math.min(progress + 0.06, 1);
            const t = self._easeInOutQuart(progress);
            self._syncScrollStyles(startTop + (targetTop - startTop) * t);
            if (progress < 1) self._fragAnimID = requestAnimationFrame(step);
            else { self._fragAnimID = null; self._syncScrollStyles(targetTop); }
        };
        this._fragAnimID = requestAnimationFrame(step);
    }

    _syncScrollStyles(top) {
        const el = this._el;
        el.editorScroll.scrollTop = top;
    }

    _easeInOutQuart(t) {
        return t < 0.5 ? 8*t*t*t*t : 1 - 8*(--t)*t*t*t;
    }

    _updateFragmentUI() {
        const { fragBar, fragLabel, fragPrev, fragNext } = this._el;
        const total = this._fragState.fragments.length;
        const cur   = this._fragState.current;
        fragBar.style.display = total > 0 ? 'flex' : 'none';
        if (total > 0) {
            fragLabel.textContent = `${cur + 1} / ${total}`;
            fragPrev.disabled = (cur <= 0);
            fragNext.disabled = (cur >= total - 1);
        }
    }

    _goToFragment(idx) {
        const total = this._fragState.fragments.length;
        if (!total) return;
        this._fragState.current = Math.max(0, Math.min(total - 1, idx));
        this._applyFragment();
    }

    /* ── syncEditorHeight — portado do pyeditor ──────────────── */
    _syncEditorHeight() {
        if (this._lockContainerHeight !== null) return;

        const { hlLayer, codeArea, codeInner, codeInput, gutter, editorScroll } = this._el;

        let hlW = 0, hlH = 0, gutterH = 0;

        const pos = String(this._opts.terminalPosition || _defaultPosTerm).trim().toLowerCase();

        if (['top','bottom','left','right'].includes(pos)) {
            const _eLines = this._opts.editorLines   !== undefined ? parseInt(this._opts.editorLines,   10) : NaN;
            const _tLines = this._opts.terminalLines !== undefined ? parseInt(this._opts.terminalLines, 10) : NaN;

            let _N = isNaN(_eLines) ? (isNaN(_tLines) ? 3 : _tLines) : _eLines;
            let _M = isNaN(_tLines) ? _N : _tLines;
            const _tLinesDeclared = !isNaN(_tLines);

            let _lineH       = this._currentFz  * _LH * _N;
            let _outputHeight = this._currentTfz * _LH * _M;

            const r = this._container;
            const editorHeaderHeight = r.querySelector('.ct-toolbar')?.offsetHeight                ?? 42;
            const editorPanelHeight  = r.querySelector('.ct-editor-pane-header')?.offsetHeight     ?? 32;
            const outputPanelHeight  = r.querySelector('.ct-output-pane-header')?.offsetHeight     ?? 32;
            const statusBar          = r.querySelector('.ct-statusbar')?.offsetHeight              ?? 26;
            const gutterPadTop       = parseFloat(getComputedStyle(gutter).paddingTop)             || 12;

            if (_lineH > 0) {
                let totalH;
                if (_tLinesDeclared) {
                    totalH = editorHeaderHeight + editorPanelHeight + _lineH + gutterPadTop
                           + _resizerW + outputPanelHeight + _outputHeight + statusBar;
                } else {
                    totalH = editorHeaderHeight + editorPanelHeight + _lineH + gutterPadTop + statusBar;
                }

                if (editorHeaderHeight > 0 && statusBar > 0) {
                    this._canonicalH = totalH;
                    if (this._frozenH === null) this._frozenH = totalH;
                }

                if (!this._container.hasAttribute('data-fullscreen')) {
                    const h = (this._frozenH ?? this._canonicalH ?? totalH) + 'px';
                    this._container.style.height    = h;
                    this._container.style.maxHeight = h;
                    this._container.style.minHeight = h;
                }
                this._snapHeight = null;

                /* hlH = Min(_N, realLineCount) × lineH + gutterPadTop
                   Just like pyeditor: the visible window is _N lines; when
                   the code has fewer than _N, hlH = nReal × lH (no blank
                   space). overflow:hidden on editorScroll ensures there is no
                   scroll beyond the content. */
                const nL      = this._nLines || hlLayer.querySelectorAll('.hl-line').length || 1;
                const lHeight = this._currentFz * _LH;
                hlH     = Math.min(_N, nL) * lHeight + gutterPadTop;
                gutterH = gutter.clientHeight;
                hlW     = hlLayer.offsetWidth;

                let ctResizer = _tLinesDeclared ? 0 : (document.querySelector('.ct-resizer')?.offsetWidth || 0);
                hlW = this._getLineWidth() + ctResizer;

                if (this._container.hasAttribute('data-fullscreen')) {
                    const scrollVisW = editorScroll.clientWidth || this._el.editorPane.clientWidth || 0;
                    if (hlW < scrollVisW) hlW = scrollVisW;
                }
            }
        }

        /* Fallback — data-fullscreen or without data-editor-lines */
        if (hlH === 0) {
            const lhReal     = this._lhPx || (this._currentFz * _LH);
            const nReal      = this._nLines || hlLayer.querySelectorAll('.hl-line').length || 1;
            const gutterPadTop = parseFloat(getComputedStyle(gutter).paddingTop) || 12;
            hlH     = nReal * lhReal + gutterPadTop;
            gutterH = hlH;
        } else {
            editorScroll.style.flex      = '';
            editorScroll.style.height    = '';
            editorScroll.style.maxHeight = '';
        }

        if (hlW === 0) {
            const scrollVisW = editorScroll.clientWidth || this._el.editorPane.clientWidth || 0;
            hlW = this._getLineWidth() || scrollVisW;
            if (hlW < scrollVisW) hlW = scrollVisW;
        }

        codeArea.style.minHeight = hlH + 'px';
        codeArea.style.height    = hlH + 'px';
        codeArea.style.minWidth  = hlW + 'px';
        codeArea.style.width     = hlW + 'px';

        codeInner.style.minHeight = hlH + 'px';
        codeInner.style.height    = hlH + 'px';
        codeInner.style.minWidth  = hlW + 'px';
        codeInner.style.width     = hlW + 'px';

        /* In a horizontal layout, codeArea/codeInner fill the entire height
           of editorScroll so the gutter leaves no gap — just like pyeditor. */
        const isHoriz = !['top','bottom'].includes(pos);
        if (isHoriz) {
            codeArea.style.minHeight  = '100%';
            codeInner.style.minHeight = Math.max(hlH, editorScroll.clientHeight) + 'px';
        }

        hlLayer.style.width    = hlW + 'px';
        hlLayer.style.height   = (gutterH || hlH) + 'px';
        codeInput.style.height = (gutterH || hlH) + 'px';
        codeInput.style.width  = hlW + 'px';

        if (isHoriz) gutter.style.minHeight = editorScroll.clientHeight + 'px';
    }



    /* ── Width of the line with the most characters ───────────── */
    _getCharWidth() {
        const fs = parseFloat(this._el.root.style.getPropertyValue('--editor-fs')) || _FONTSIZE;
        if (this._cachedChW && this._cachedChW.fs === fs) return this._cachedChW.value;
        const probe = document.createElement('span');
        probe.style.cssText = [
            `font-family:${this._el.root.style.getPropertyValue('--font-editor') || _fontTerminal}`,
            `font-size:${fs}px`,
            'position:absolute','visibility:hidden','white-space:pre','top:-9999px','left:-9999px',
        ].join(';');
        probe.textContent = '██████████';
        document.body.appendChild(probe);
        const w = probe.getBoundingClientRect().width / 10;
        document.body.removeChild(probe);
        this._cachedChW = { value: w, fs };
        return w;
    }

    _getLineWidth() {
        const lines = this._el.root.querySelectorAll('.hl-line');
        if (!lines.length) return 0;

        const style   = getComputedStyle(this._el.hlLayer);
        const fsPx    = this._el.root.style.getPropertyValue('--editor-fs') || style.fontSize || `${this._currentFz}px`;
        const family  = style.fontFamily ||  _fontTerminal;
        const lhVal   = this._el.root.style.getPropertyValue('--line-h') || _LH;
        const lineH   = `${parseFloat(fsPx) * parseFloat(lhVal)}px`;
        const tabSize = style.tabSize || _defaultTabSpace;

        const probe = document.createElement('div');
        probe.style.cssText =
            'position:fixed;top:-9999px;left:-9999px;' +
            'visibility:hidden;pointer-events:none;' +
            'width:max-content;white-space:pre;' +
            `font-family:${family};font-size:${fsPx};line-height:${lineH};tab-size:${tabSize};`;
        document.body.appendChild(probe);

        probe.textContent = '█';
        const ch1 = probe.getBoundingClientRect().width;

        let maxWidth = 0;
        for (const line of lines) {
            probe.textContent = line.textContent;
            const w = probe.getBoundingClientRect().width;
            if (w > maxWidth) maxWidth = w;
        }
        document.body.removeChild(probe);
        return maxWidth + ch1;
    }

    /* ── Fit the resizer to the content ───────────────────────── */
    _fitEditorToContent() {
        if (this._userResized) return;
        /* data-sepbar sets the split explicitly: the automatic adjustment by
           code width (which reaches total-200px with long lines) must not
           override it. */
        if (this._opts.sepbar !== undefined) return;
        const { workspace, editorPane, resizer, gutter } = this._el;

        const pos = String(this._opts.terminalPosition || _defaultPosTerm).trim().toLowerCase();
        if (['top','bottom'].includes(pos)) return;

        const totalW   = workspace.offsetWidth || this._container.offsetWidth;
        if (!totalW) return;

        const resizerW = resizer.offsetWidth || _resizerW;
        const gutterW  = gutter.offsetWidth  || _gutterW;
        const maxLineW = this._getLineWidth();
        const avail    = totalW - resizerW;
        const ideal    = gutterW + maxLineW;
        const center   = Math.floor(avail / 2);
        const maxEdit  = avail - _minTerminalWidth;
        const target   = ideal > center ? Math.min(ideal, maxEdit) : center;
        const clamped  = Math.max(_minTerminalWidth, target);

        editorPane.style.width      = clamped + 'px';
        editorPane.style.flexShrink = '0';
        editorPane.style.flexGrow   = '0';
    }

    /* ── Cursor ───────────────────────────────────────────────── */
    _updateCursor() {
        const el  = this._el;
        const val = el.codeInput.value;
        const pos = el.codeInput.selectionStart;
        const bef = val.slice(0, pos);
        const ln  = (bef.match(/\n/g) || []).length + 1;
        const col = pos - bef.lastIndexOf('\n');
        this._activeLine = ln;
        el.cursorInfo.textContent = `Ln ${ln}, Col ${col}`;
        el.gutter.querySelectorAll('.gutter-line').forEach((s, i) =>
            s.classList.toggle('active', i + 1 === ln));
        el.editDot.classList.toggle('edited', val !== this._defaultCode);
    }

    /* ── Font size ────────────────────────────────────────────── */
    _setFontSize(n) {
        this._currentFz = Math.max(this._FZ_MIN, Math.min(this._FZ_MAX, n));
        this._el.fzVal.textContent = this._currentFz;
        this._cachedChW = 0;
        this._applyFontSizes();
        this._updateHighlight();
        requestAnimationFrame(() => this._updateHighlight());
    }

    _setTerminalFontSize(n) {
        this._currentTfz = Math.max(this._FZ_MIN, Math.min(this._FZ_MAX, n));
        this._el.tfzVal.textContent = this._currentTfz;
        this._el.root.style.setProperty('--terminal-fs', this._currentTfz + 'px');
        this._el.consoleOut.style.fontSize = this._currentTfz + 'px';
    }

    /* ── Status ───────────────────────────────────────────────── */
    _setStatus(cls, msg) {
        this._el.statusMsg.innerHTML  = msg;
        this._el.statusMsg.className  = cls;
    }

    /* ── Hourglass animation ──────────────────────────────────── */
    _startHourglassAnimation(el, duration, interval = 300) {
        const frames = [
            'nf-fa-hourglass_start','nf-fa-hourglass_1',
            'nf-fa-hourglass_2','nf-fa-hourglass_3','nf-fa-hourglass_end',
        ];
        let i = 0;
        if (el._timer) { clearInterval(el._timer); el._timer = null; }
        const start = Date.now();
        el._timer = setInterval(() => {
            el.classList.remove(...frames);
            el.classList.add(frames[i]);
            i = (i + 1) % frames.length;
            if (Date.now() - start >= duration) { clearInterval(el._timer); el._timer = null; }
        }, interval);
    }

    /* ── Output colorizer ─────────────────────────────────────── */
    _colorizeOutput(html) {
        return html.split(/<br\s*\/?>/i).map(line => {
            const plain = line.replace(/<[^>]+>/g, '').trim();
            if (!plain) return line;
            if (plain.startsWith('&gt;') || plain.startsWith('>'))  return `<span class="out-log">${line}</span>`;
            if (/warning:/i.test(plain))                            return `<span class="out-warn">${line}</span>`;
            if (/error:|undefined|failed/i.test(plain))             return `<span class="out-err">${line}</span>`;
            if (/done\.|✓/i.test(plain))                            return `<span class="out-ok">${line}</span>`;
            return line;
        }).join('<br>');
    }

    /* ── Multi-file support ─────────────────────────────────── */
    getAllFiles() {
        if (!this._multiFile) return null;
        this._files.set(this._activeFile, this._el.codeInput.value);
        const result = {};
        for (const [fn, code] of this._files) {
            if (fn === this._mainFile) continue;
            if (!fn.endsWith('.c') && !fn.endsWith('.h')) continue;
            result[fn] = code;
        }
        return Object.keys(result).length > 0 ? result : null;
    }

    getMainCode() {
        this._files.set(this._activeFile, this._el.codeInput.value);
        return this._files.get(this._mainFile) || '';
    }

    getMainFilename() {
        return this._mainFile;
    }

    _switchFile(filename) {
        if (filename === this._activeFile) return;
        this._files.set(this._activeFile, this._el.codeInput.value);
        this._activeFile = filename;
        const code = this._files.get(filename) || '';
        this._el.codeInput.value = code;
        this._defaultCode = this._fileDefaults.get(filename) || '';
        if (this._el.editorFname) {
            this._el.editorFname.textContent = filename;
        }
        if (this._el.filetreeDd) {
            this._el.filetreeDd.querySelectorAll('.ct-filetree-item').forEach(item => {
                item.classList.toggle('ct-filetree-item-active', item.dataset.file === filename);
            });
        }
        this._updateHighlight();
        this._updateCursor();
    }

    /* ── Dynamic file management (allowNewFiles) ───────── */
    _addFile(filepath) {
        filepath = filepath.trim().replace(/^\/+/, '');
        if (!filepath || this._files.has(filepath)) return false;
        if (!/\.(c|h)$/.test(filepath)) filepath += '.c';
        const template = filepath.endsWith('.h')
            ? `#ifndef ${filepath.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}\n#define ${filepath.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}\n\n\n\n#endif\n`
            : `#include <stdio.h>\n\n`;
        this._files.set(filepath, template);
        this._fileDefaults.set(filepath, template);
        this._multiFile = true;
        this._rebuildFiletree();
        this._switchFile(filepath);
        return true;
    }

    _removeFile(filepath) {
        if (filepath === this._mainFile || !this._files.has(filepath)) return false;
        this._files.delete(filepath);
        this._fileDefaults.delete(filepath);
        if (this._activeFile === filepath) {
            this._switchFile(this._mainFile);
        }
        this._multiFile = this._files.size > 1 || this._allowNewFiles;
        this._rebuildFiletree();
        return true;
    }

    _renameFile(oldPath, newPath) {
        newPath = newPath.trim().replace(/^\/+/, '');
        if (!newPath || newPath === oldPath || this._files.has(newPath)) return false;
        const code = this._files.get(oldPath);
        if (code === undefined) return false;
        const defCode = this._fileDefaults.get(oldPath);
        const newFiles = new Map();
        for (const [k, v] of this._files) newFiles.set(k === oldPath ? newPath : k, v);
        const newDefaults = new Map();
        for (const [k, v] of this._fileDefaults) newDefaults.set(k === oldPath ? newPath : k, v);
        this._files = newFiles;
        this._fileDefaults = newDefaults;
        if (this._mainFile === oldPath) this._mainFile = newPath;
        if (this._activeFile === oldPath) {
            this._activeFile = newPath;
            this._defaultCode = this._fileDefaults.get(newPath) || '';
            if (this._el.editorFname) this._el.editorFname.textContent = newPath;
        }
        this._rebuildFiletree();
        return true;
    }

    _renameDir(oldDir, newDir) {
        newDir = newDir.trim().replace(/^\/+/, '').replace(/\/+$/, '');
        if (!newDir || newDir === oldDir) return false;
        const toRename = new Set([...this._files.keys()].filter(f => f.startsWith(oldDir + '/')));
        if (!toRename.size) return false;
        for (const f of toRename) {
            const newPath = newDir + f.substring(oldDir.length);
            if (!toRename.has(newPath) && this._files.has(newPath)) return false;
        }
        const newFiles = new Map();
        const newDefaults = new Map();
        for (const [k, v] of this._files) {
            if (toRename.has(k)) {
                const newPath = newDir + k.substring(oldDir.length);
                newFiles.set(newPath, v);
                newDefaults.set(newPath, this._fileDefaults.get(k) || v);
                if (this._activeFile === k) {
                    this._activeFile = newPath;
                    this._defaultCode = newDefaults.get(newPath) || '';
                    this._el.codeInput.value = v;
                    if (this._el.editorFname) this._el.editorFname.textContent = newPath;
                    this._updateHighlight();
                }
            } else {
                newFiles.set(k, v);
                newDefaults.set(k, this._fileDefaults.get(k));
            }
        }
        this._files = newFiles;
        this._fileDefaults = newDefaults;
        this._rebuildFiletree();
        return true;
    }

    _rebuildFiletree() {
        const dd = this._el.filetreeDd;
        if (!dd) return;
        const files = [...this._files.keys()];
        const tree = { children: new Map() };
        for (const f of files) {
            const parts = f.split('/');
            let node = tree;
            for (let i = 0; i < parts.length; i++) {
                if (!node.children.has(parts[i])) {
                    node.children.set(parts[i], { children: new Map(), file: i === parts.length - 1 ? f : null });
                } else if (i === parts.length - 1) {
                    node.children.get(parts[i]).file = f;
                }
                node = node.children.get(parts[i]);
            }
        }
        const lines = [];
        const render = (node, prefix) => {
            const entries = [...node.children.entries()];
            entries.forEach(([name, child], idx) => {
                const isLast = idx === entries.length - 1;
                const connector = isLast ? '└── ' : '├── ';
                const nextPrefix = prefix + (isLast ? '    ' : '│   ');
                const isDir = child.children.size > 0 && !child.file;
                if (isDir) {
                    lines.push({ prefix: prefix + connector, name, isDir: true, file: null });
                    render(child, nextPrefix);
                } else {
                    lines.push({ prefix: prefix + connector, name, isDir: false, file: child.file });
                }
            });
        };
        render(tree, '');
        const canDelete = this._allowNewFiles;
        const cIcon = '<i class="nf nf-custom-c" style="color:#015692;margin-right:3px;font-size:12px;"></i>';
        const hIcon = '<i class="nf nf-seti-h" style="color:#a074c4;margin-right:3px;font-size:12px;"></i>';
        dd.innerHTML =
            `<div class="ct-filetree-row ct-filetree-root"><span class="ct-filetree-prefix">.</span></div>` +
            lines.map(l => {
                if (l.isDir) {
                    return `<div class="ct-filetree-row ct-filetree-dir-row">
                        <span class="ct-filetree-prefix">${_escHtml(l.prefix)}</span><i class="nf nf-md-folder" style="color:#e8a838;margin-right:3px;font-size:12px;"></i><span class="ct-filetree-name">${_escHtml(l.name)}</span>${canDelete ? `<span class="ct-filetree-rename" data-rename-dir="${_escHtml(l.name)}" title="Rename"><i class="nf nf-md-pencil"></i></span><button class="ct-filetree-del" data-del-dir="${_escHtml(l.name)}" title="Delete directory"><i class="nf nf-md-close"></i></button>` : ''}</div>`;
                }
                const isDeletable = canDelete && l.file !== this._mainFile;
                const isRenamable = canDelete;
                const icon = l.name.endsWith('.h') ? hIcon : cIcon;
                return `<button class="ct-filetree-item${l.file === this._activeFile ? ' ct-filetree-item-active' : ''}"
                         data-file="${_escHtml(l.file)}">
                    <span class="ct-filetree-prefix">${_escHtml(l.prefix)}</span>${icon}<span class="ct-filetree-name">${_escHtml(l.name)}</span>${isRenamable ? `<span class="ct-filetree-rename" data-rename-file="${_escHtml(l.file)}" title="Rename"><i class="nf nf-md-pencil"></i></span>` : ''}${isDeletable ? `<span class="ct-filetree-del" data-del-file="${_escHtml(l.file)}"><i class="nf nf-md-close"></i></span>` : ''}</button>`;
            }).join('') +
            (this._allowNewFiles ? `<div class="ct-filetree-add-row">
                <button class="ct-filetree-add-btn" title="New file"><i class="nf nf-md-plus"></i> New file</button>
            </div>
            <div class="ct-filetree-input-row" style="display:none">
                <input class="ct-filetree-input" type="text" placeholder="path/file.c" spellcheck="false">
                <button class="ct-filetree-input-ok" title="Create"><i class="nf nf-md-check"></i></button>
                <button class="ct-filetree-input-cancel" title="Cancel"><i class="nf nf-md-close"></i></button>
            </div>` : '');
        this._bindFiletreeActions();
    }

    _bindFiletreeActions() {
        const dd = this._el.filetreeDd;
        if (!dd) return;
        const self = this;
        dd.querySelectorAll('.ct-filetree-item').forEach(item => {
            item.addEventListener('click', (e) => {
                if (e.target.closest('.ct-filetree-del') || e.target.closest('.ct-filetree-rename') || e.target.closest('.ct-filetree-input')) return;
                self._switchFile(item.dataset.file);
                dd.style.display = 'none';
            });
        });
        dd.querySelectorAll('[data-rename-file]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const oldPath = btn.dataset.renameFile;
                const parts = oldPath.split('/');
                const fileName = parts.pop();
                const dir = parts.join('/');
                const item = btn.closest('.ct-filetree-item');
                const nameSpan = item.querySelector('.ct-filetree-name');
                if (!nameSpan) return;
                const inp = document.createElement('input');
                inp.className = 'ct-filetree-input';
                inp.value = fileName;
                inp.style.cssText = 'width:80px;';
                nameSpan.replaceWith(inp);
                btn.style.display = 'none';
                const delBtn = item.querySelector('.ct-filetree-del');
                if (delBtn) delBtn.style.display = 'none';
                inp.focus();
                inp.select();
                const finish = () => {
                    const newName = inp.value.trim();
                    if (newName && newName !== fileName) {
                        const newPath = dir ? dir + '/' + newName : newName;
                        self._renameFile(oldPath, /\.(c|h)$/.test(newPath) ? newPath : newPath + '.c');
                    } else {
                        self._rebuildFiletree();
                    }
                };
                inp.addEventListener('mousedown', (ev) => ev.stopPropagation());
                inp.addEventListener('keydown', (ev) => {
                    ev.stopPropagation();
                    if (ev.key === 'Enter') { ev.preventDefault(); finish(); }
                    if (ev.key === 'Escape') { ev.preventDefault(); self._rebuildFiletree(); }
                });
                inp.addEventListener('keyup', (ev) => ev.stopPropagation());
                inp.addEventListener('blur', finish, { once: true });
            });
        });
        dd.querySelectorAll('[data-del-file]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const f = btn.dataset.delFile;
                if (confirm(`Delete ${f}?`)) self._removeFile(f);
            });
        });
        dd.querySelectorAll('[data-del-dir]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const dir = btn.dataset.delDir;
                const toRemove = [...self._files.keys()].filter(f => f.startsWith(dir + '/'));
                if (toRemove.length && confirm(`Delete directory "${dir}" and ${toRemove.length} file(s)?`)) {
                    toRemove.forEach(f => { self._files.delete(f); self._fileDefaults.delete(f); });
                    if (toRemove.includes(self._activeFile)) self._switchFile(self._mainFile);
                    self._multiFile = self._files.size > 1 || self._allowNewFiles;
                    self._rebuildFiletree();
                }
            });
        });
        dd.querySelectorAll('[data-rename-dir]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const dirName = btn.dataset.renameDir;
                const row = btn.closest('.ct-filetree-dir-row');
                const nameSpan = row.querySelector('.ct-filetree-name');
                if (!nameSpan) return;
                const inp = document.createElement('input');
                inp.className = 'ct-filetree-input';
                inp.value = dirName;
                inp.style.cssText = 'width:80px;';
                nameSpan.replaceWith(inp);
                btn.style.display = 'none';
                const delBtn = row.querySelector('.ct-filetree-del');
                if (delBtn) delBtn.style.display = 'none';
                inp.focus();
                inp.select();
                const finish = () => {
                    const newName = inp.value.trim();
                    if (newName && newName !== dirName) {
                        self._renameDir(dirName, newName);
                    } else {
                        self._rebuildFiletree();
                    }
                };
                inp.addEventListener('mousedown', (ev) => ev.stopPropagation());
                inp.addEventListener('keydown', (ev) => {
                    ev.stopPropagation();
                    if (ev.key === 'Enter') { ev.preventDefault(); finish(); }
                    if (ev.key === 'Escape') { ev.preventDefault(); self._rebuildFiletree(); }
                });
                inp.addEventListener('keyup', (ev) => ev.stopPropagation());
                inp.addEventListener('blur', finish, { once: true });
            });
        });
        const addBtn = dd.querySelector('.ct-filetree-add-btn');
        const inputRow = dd.querySelector('.ct-filetree-input-row');
        const input = dd.querySelector('.ct-filetree-input');
        const okBtn = dd.querySelector('.ct-filetree-input-ok');
        const cancelBtn = dd.querySelector('.ct-filetree-input-cancel');
        if (addBtn && inputRow && input) {
            addBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                addBtn.parentElement.style.display = 'none';
                inputRow.style.display = 'flex';
                input.value = '';
                input.focus();
            });
            const doCreate = () => {
                const path = input.value.trim();
                if (path) {
                    self._addFile(path);
                    dd.style.display = 'none';
                }
            };
            const doCancel = () => {
                inputRow.style.display = 'none';
                addBtn.parentElement.style.display = '';
            };
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); doCreate(); }
                if (e.key === 'Escape') { e.preventDefault(); doCancel(); }
                e.stopPropagation();
            });
            input.addEventListener('keyup', (e) => e.stopPropagation());
            if (okBtn) okBtn.addEventListener('click', (e) => { e.stopPropagation(); doCreate(); });
            if (cancelBtn) cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); doCancel(); });
        }
    }

    /* ── CWasmExec bridge ────────────────────────────────────── */
    _initCWasm() {
        const { hiddenCode, hiddenBtn, hiddenConsole, consoleOut, outputScroll } = this._el;
        if (typeof CWasmExec === 'undefined') return;
        CWasmExec.startScript(
            this._uid('inputCode'),
            this._uid('btnCWasm'),
            this._uid('consoleHidden')
        );
        this._consoleObserver = new MutationObserver(() => {
            consoleOut.innerHTML = this._colorizeOutput(hiddenConsole.innerHTML);
            outputScroll.scrollTop = outputScroll.scrollHeight;
        });
        this._consoleObserver.observe(hiddenConsole, { childList: true, subtree: true, characterData: true });

        /* Toolchain download/boot progress (event dispatched by scriptExec on
           the hidden console) → status bar. Shows the file and percentage, or
           "cached" when served from cache. */
        hiddenConsole.addEventListener('cwasm:progress', (e) => {
            const d = e.detail || {};
            if (d.phase === 'compile') {
                this._setStatus('running', '<i class="nf nf-fa-hourglass_2"></i> Compiling…');
                return;
            }
            const name = d.file || '';
            if (d.cached) {
                this._setStatus('running', `<i class="nf nf-md-cached"></i> ${name} — cached`);
            } else if (d.total) {
                const pct = Math.min(100, Math.round((d.loaded / d.total) * 100));
                this._setStatus('running', `<i class="nf nf-md-download"></i> Downloading ${name} — ${pct}%`);
            } else {
                const mb = (d.loaded / 1048576).toFixed(1);
                this._setStatus('running', `<i class="nf nf-md-download"></i> Downloading ${name} — ${mb} MB`);
            }
        });
    }

    /* ── Run compilation ──────────────────────────────────────── */
    _runCode() {
        const el   = this._el;
        /* Reentrancy: Ctrl+Enter (or a second click) used to call this again
           while already running — it fired another hiddenBtn.click(),
           stacking a 2nd (3rd, ...) run in the singleton worker's queue.
           Each one restarts the console and shows the stdin modal again,
           giving the impression of a "loop"/"asks for input again" unrelated
           to the C code itself. */
        if (el.btnRun.disabled) return;
        const code = el.codeInput.value.trim();
        if (!code || typeof CWasmExec === 'undefined') return;

        if (this._multiFile) {
            this._files.set(this._activeFile, el.codeInput.value);
        }

        el.hiddenCode.textContent  = code;
        el.consoleOut.innerHTML    = '';
        el.hiddenConsole.innerHTML = '';
        el.outStatus.textContent   = '';

        this._setStatus('running',
            '<i class="nf nf-fa-hourglass_1 ct-hourglass" data-interval="300"></i> Compiling…');

        requestAnimationFrame(() => {
            this._container.querySelectorAll('.ct-hourglass').forEach(el => {
                this._startHourglassAnimation(el, _timeRunCode, Number(el.dataset.interval || 300));
            });
        });

        el.btnRun.disabled = true;
        const t0 = Date.now();
        el.hiddenBtn.click();

        const runObs = new MutationObserver(() => {
            if (!el.hiddenBtn.disabled) {
                runObs.disconnect();
                const ms = Date.now() - t0;
                el.outStatus.textContent = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
                el.btnRun.disabled = false;
                const hasErr = el.consoleOut.innerHTML.includes('out-err') ||
                               el.consoleOut.textContent.includes('error:');
                this._setStatus(hasErr ? 'err' : 'ok',
                    hasErr
                        ? '<i class="nf nf-fa-circle_xmark"></i> Compilation error'
                        : '<i class="nf nf-fa-circle_check"></i> Done!');
            }
        });
        runObs.observe(el.hiddenBtn, { attributes: true, attributeFilter: ['disabled'] });

        setTimeout(() => {
            if (el.btnRun.disabled) {
                runObs.disconnect();
                el.btnRun.disabled = false;
                this._setStatus('err', 'Timeout');
            }
        }, _timeRunCode);
    }

    /* ── Sepbar ───────────────────────────────────────────────── */
    _applySepbar() {
        const opts = this._opts;
        const pos    = String(opts.terminalPosition || _defaultPosTerm).trim().toLowerCase();
        const isVert = pos === 'top' || pos === 'bottom';
        const { workspace, editorPane, resizer, outputPane } = this._el;

        resizer.style.cursor = isVert ? 'row-resize' : 'col-resize';

        const applyH = (totalW) => {
            const rw = resizer.offsetWidth || _resizerW;
            const avail = totalW - rw;
            if (opts.sepbar !== undefined) {
                const editW = avail - Math.round(avail * opts.sepbar / 100);
                editorPane.style.width = editW + 'px';
                editorPane.style.flexShrink = '0';
                editorPane.style.flexGrow   = '0';
            } else {
                this._fitEditorToContent();
            }
        };

        const applyV = (totalH) => {
            const rh = resizer.offsetHeight || _resizerW;
            const avail = totalH - rh;
            let pct;
            if (opts.sepbar !== undefined) {
                pct = opts.sepbar / 100;
            } else {
                const _eL = opts.editorLines   !== undefined ? parseInt(opts.editorLines,   10) : NaN;
                const _tL = opts.terminalLines !== undefined ? parseInt(opts.terminalLines, 10) : NaN;
                if (!isNaN(_eL) && !isNaN(_tL)) {
                    const lhE = this._currentFz  * _LH;
                    const lhT = this._currentTfz * _LH;
                    const eC  = _eL * lhE, tC = _tL * lhT;
                    pct = (eC + tC) > 0 ? tC / (eC + tC) : 0.5;
                } else {
                    pct = 0.5;
                }
            }
            if (avail > 0) {
                let termH, editH;
                if (opts.sepbar !== undefined) {
                    termH = Math.round(avail * pct); editH = avail - termH;
                } else if (!isNaN(parseInt(opts.editorLines,10)) && !isNaN(parseInt(opts.terminalLines,10))) {
                    const editorPHdr = this._el.editorPane.querySelector('.ct-editor-pane-header')?.offsetHeight ?? 32;
                    const outputPHdr = this._el.outputPane.querySelector('.ct-output-pane-header')?.offsetHeight ?? 32;
                    const lhE = this._currentFz  * _LH, lhT = this._currentTfz * _LH;
                    const _eL = parseInt(opts.editorLines,10), _tL = parseInt(opts.terminalLines,10);
                    termH = outputPHdr + _tL * lhT;
                    if (termH >= avail) { termH = Math.round(avail * pct); editH = avail - termH; }
                    else { editH = avail - termH; }
                } else {
                    termH = Math.round(avail * pct); editH = avail - termH;
                }
                outputPane.style.flexBasis  = termH + 'px';
                outputPane.style.flexShrink = '0'; outputPane.style.flexGrow = '0';
                editorPane.style.flexBasis  = editH + 'px';
                editorPane.style.flexShrink = '0'; editorPane.style.flexGrow = '0';
            } else {
                outputPane.style.flexBasis  = (pct * 100) + '%';
                outputPane.style.flexShrink = '0'; outputPane.style.flexGrow = '0';
                editorPane.style.flexBasis  = ((1-pct)*100) + '%';
                editorPane.style.flexShrink = '0'; editorPane.style.flexGrow = '0';
            }
        };

        if (!isVert) {
            const totalW = workspace.offsetWidth || this._container.offsetWidth;
            if (totalW > 0) { applyH(totalW); }
            else {
                if (!this._sepbarROH) {
                    this._sepbarROH = new ResizeObserver(entries => {
                        for (const e of entries) {
                            const w = e.contentRect.width;
                            if (w > 0) {
                                this._sepbarROH.disconnect(); this._sepbarROH = null;
                                applyH(w); this._updateHighlight();
                            }
                        }
                    });
                    this._sepbarROH.observe(workspace);
                }
            }
        } else {
            const totalH = workspace.offsetHeight || this._container.offsetHeight;
            if (totalH > 0) { applyV(totalH); }
            else {
                applyV(0);
                if (!this._sepbarROV) {
                    this._sepbarROV = new ResizeObserver(entries => {
                        for (const e of entries) {
                            const h = e.contentRect.height;
                            if (h > 0) {
                                this._sepbarROV.disconnect(); this._sepbarROV = null;
                                applyV(h); this._updateHighlight();
                            }
                        }
                    });
                    this._sepbarROV.observe(workspace);
                }
            }
        }
    }

    /* ── Apply position (snap) ────────────────────────────────── */
    _applyPosition(newPos) {
        this._userResized = false;

        const snapH = this._container.getBoundingClientRect().height;
        this._lockContainerHeight = snapH;
        this._snapHeight = snapH;

        const { workspace, editorPane, resizer, outputPane } = this._el;
        const dirMap = { right:'row', left:'row-reverse', bottom:'column', top:'column-reverse' };
        const isVert = newPos === 'top' || newPos === 'bottom';

        this._opts.terminalPosition = newPos;
        workspace.style.flexDirection = dirMap[newPos];

        [editorPane, outputPane].forEach(p => {
            p.style.width = p.style.height = p.style.flexBasis =
                p.style.flexShrink = p.style.flexGrow = '';
        });

        if (isVert) {
            editorPane.style.borderRight  = '';
            editorPane.style.borderBottom = '1px solid var(--border)';
            resizer.style.width  = '100%';
            resizer.style.height = _resizerW + 'px';
            resizer.style.cursor = 'row-resize';
        } else {
            editorPane.style.borderBottom = '';
            editorPane.style.borderRight  = '1px solid var(--border)';
            resizer.style.width  = _resizerW + 'px';
            resizer.style.height = '100%';
            resizer.style.cursor = 'col-resize';
        }

        requestAnimationFrame(() => {
            this._applySepbar();
            this._updateHighlight();
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    this._lockContainerHeight = null;
                    this._updateHighlight();
                });
            });
        });
    }

    /* ── Resizer drag ─────────────────────────────────────────── */
    _initResizer() {
        const { resizer, workspace, editorPane, outputPane } = this._el;
        let dragging = false, startPos = 0, startSz = 0;

        const onStart = (cx, cy) => {
            const isVert = ['top','bottom'].includes(
                String(this._opts.terminalPosition || _defaultPosTerm).trim().toLowerCase()
            );
            dragging = true;
            this._userResized = true;
            startPos = isVert ? cy : cx;
            startSz  = isVert ? outputPane.offsetHeight : editorPane.offsetWidth;
            resizer.classList.add('dragging');
            document.body.style.cursor    = isVert ? 'row-resize' : 'col-resize';
            document.body.style.userSelect = 'none';
        };

        const onMove = (cx, cy) => {
            if (!dragging) return;
            const pos    = String(this._opts.terminalPosition || _defaultPosTerm).trim().toLowerCase();
            const isVert = ['top','bottom'].includes(pos);

            if (!isVert) {
                const avail = workspace.offsetWidth - resizer.offsetWidth;
                const sign  = pos === 'left' ? -1 : 1;
                const newW  = Math.max(200, Math.min(avail - 200, startSz + sign*(cx - startPos)));
                editorPane.style.width      = newW + 'px';
                editorPane.style.flexShrink = '0';
                editorPane.style.flexGrow   = '0';
                this._syncEditorHeight();
            } else {
                const avail = workspace.offsetHeight - resizer.offsetHeight;
                const sign  = pos === 'top' ? 1 : -1;
                const newH  = Math.max(60, Math.min(avail - 60, startSz + sign*(cy - startPos)));
                outputPane.style.flexBasis  = newH + 'px';
                outputPane.style.height     = outputPane.style.width = '';
                outputPane.style.flexShrink = '0'; outputPane.style.flexGrow = '0';
                editorPane.style.flexBasis  = '0';
                editorPane.style.flexShrink = '1'; editorPane.style.flexGrow = '1';
                editorPane.style.height     = editorPane.style.width = '';
            }
        };

        const onEnd = () => {
            if (!dragging) return;
            dragging = false;
            resizer.classList.remove('dragging');
            document.body.style.cursor = document.body.style.userSelect = '';
            this._updateHighlight();
        };

        resizer.addEventListener('mousedown',  e => onStart(e.clientX, e.clientY));
        document.addEventListener('mousemove', e => onMove(e.clientX, e.clientY));
        document.addEventListener('mouseup',   onEnd);
        resizer.addEventListener('touchstart', e => onStart(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
        document.addEventListener('touchmove', e => { if (dragging) onMove(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
        document.addEventListener('touchend',  onEnd);
    }

    /* ── Drag-to-snap ─────────────────────────────────────────── */
    _initDragToSnap() {
        const { workspace, editorPane, outputPane, snapOverlay, editorDragH, outputDragH } = this._el;
        const zones     = [...snapOverlay.querySelectorAll('.ct-snap-zone')];
        const opposites = { left:'right', right:'left', top:'bottom', bottom:'top' };

        const startDrag = (pane, isEditor) => (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            const cx0 = e.touches ? e.touches[0].clientX : e.clientX;
            const cy0 = e.touches ? e.touches[0].clientY : e.clientY;

            const rect  = pane.getBoundingClientRect();
            const ghost = document.createElement('div');
            ghost.className = 'ct-drag-ghost';
            ghost.style.cssText = `left:${rect.left}px;top:${rect.top}px;`
                + `width:${Math.min(rect.width,280)}px;height:${Math.min(rect.height,120)}px`;
            ghost.innerHTML = `
                <div style="padding:8px 12px;background:var(--bg-gutter);border-bottom:1px solid var(--border);
                     font-size:11px;font-family:var(--font-editor);display:flex;align-items:center;gap:6px;">
                  <span style="font-size:14px;"><i class="nf nf-md-drag ct-icon-term"></i></span>
                  <span style="color:var(--text-main);font-weight:600;">${isEditor ? '[ Editor ]' : '[ Terminal ]'}</span>
                </div>
                <div style="padding:10px 12px;font-size:11px;font-family:var(--font-editor);
                     color:var(--text-muted);font-style:italic;">
                  Drop on a zone to reposition…
                </div>`;
            document.body.appendChild(ghost);
            pane.classList.add('ct-pane-dragging');
            snapOverlay.style.display = 'block';
            zones.forEach(z => z.classList.add('active'));

            let hovered = null;
            const ox = cx0 - rect.left, oy = cy0 - rect.top;

            const onMove = ev => {
                const cx = ev.touches ? ev.touches[0].clientX : ev.clientX;
                const cy = ev.touches ? ev.touches[0].clientY : ev.clientY;
                ghost.style.left = (cx - ox) + 'px';
                ghost.style.top  = (cy - oy) + 'px';

                const wr = workspace.getBoundingClientRect();
                const T  = 0.22;
                let hz = null;
                if      (cx - wr.left < wr.width  * T)       hz = 'left';
                else if (cx - wr.left > wr.width  * (1-T))   hz = 'right';
                else if (cy - wr.top  < wr.height * T)        hz = 'top';
                else if (cy - wr.top  > wr.height * (1-T))    hz = 'bottom';

                if (hz !== hovered) {
                    zones.forEach(z => z.classList.remove('hover'));
                    if (hz) zones.find(z => z.dataset.zone === hz)?.classList.add('hover');
                    hovered = hz;
                    ghost.classList.toggle('snapping', !!hz);
                }
            };

            const onEnd = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup',   onEnd);
                document.removeEventListener('touchmove', onMove);
                document.removeEventListener('touchend',  onEnd);
                ghost.remove();
                pane.classList.remove('ct-pane-dragging');
                snapOverlay.style.display = 'none';
                zones.forEach(z => z.classList.remove('active','hover'));
                if (!hovered) return;
                const newPos = isEditor ? opposites[hovered] : hovered;
                const curPos = String(this._opts.terminalPosition || _defaultPosTerm).trim().toLowerCase();
                if (newPos !== curPos) this._applyPosition(newPos);
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup',   onEnd);
            document.addEventListener('touchmove', onMove, { passive: true });
            document.addEventListener('touchend',  onEnd);
        };

        editorDragH.addEventListener('mousedown',  startDrag(editorPane, true));
        editorDragH.addEventListener('touchstart', startDrag(editorPane, true), { passive: true });
        outputDragH.addEventListener('mousedown',  startDrag(outputPane, false));
        outputDragH.addEventListener('touchstart', startDrag(outputPane, false), { passive: true });
    }

    /* ── Bind all events ──────────────────────────────────────── */
    _bindAll() {
        const el   = this._el;
        const self = this;

        /* Scroll sync */
        el.codeInner.addEventListener('scroll', () => {
            el.hlLayer.style.left  = -el.codeInner.scrollLeft + 'px';
            el.codeInput.style.left = -el.codeInner.scrollLeft + 'px';
        });
        /* Vertical scroll: native to editorScroll (like pyodide).
           hlLayer/codeInput/gutter stay at top:0/marginTop:0 and scroll
           together with codeArea/codeInner — no scroll listener, avoiding the
           "fight" with the browser's native overscroll/bounce. */
        el.codeInput.addEventListener('scroll', () => {
            el.codeInput.scrollTop = 0; el.codeInput.scrollLeft = 0;
        });

        /* Cursor */
        ['keyup','click','mouseup'].forEach(ev =>
            el.codeInput.addEventListener(ev, () => self._updateCursor()));

        /* Input */
        el.codeInput.addEventListener('input', () => {
            self._updateHighlight(); self._updateCursor();
        });

        /* Teclado */
        el.codeInput.addEventListener('keydown', e => {

            /* Tab / shift-tab */
            if (e.key === 'Tab') {
                e.preventDefault();
                const s = el.codeInput.selectionStart, en = el.codeInput.selectionEnd;
                const v = el.codeInput.value;
                if (s === en) {
                    el.codeInput.value = v.slice(0,s) + '    ' + v.slice(en);
                    el.codeInput.selectionStart = el.codeInput.selectionEnd = s + 4;
                } else {
                    const lines = v.split('\n');
                    let pos2 = 0, ls = -1, le = -1;
                    for (let i = 0; i < lines.length; i++) {
                        const len = lines[i].length + 1;
                        if (pos2 <= s && ls === -1) ls = i;
                        if (pos2 + len > en) { le = i; break; }
                        pos2 += len;
                    }
                    if (le === -1) le = lines.length - 1;
                    for (let i = ls; i <= le; i++)
                        lines[i] = e.shiftKey ? lines[i].replace(/^    /, '') : '    ' + lines[i];
                    el.codeInput.value = lines.join('\n');
                }
                self._updateHighlight(); return;
            }

            /* Auto-pares */
            const pairs = { '(':')', '[':']', '{':'}' };
            if (pairs[e.key] && el.codeInput.selectionStart === el.codeInput.selectionEnd) {
                e.preventDefault();
                const s = el.codeInput.selectionStart, v = el.codeInput.value;
                el.codeInput.value = v.slice(0,s) + e.key + pairs[e.key] + v.slice(s);
                el.codeInput.selectionStart = el.codeInput.selectionEnd = s + 1;
                self._updateHighlight(); return;
            }

            /* Ctrl+Enter → compilar */
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault(); self._runCode(); return;
            }

            /* Alt+Enter → restaurar */
            if (e.key === 'Enter' && e.altKey) {
                e.preventDefault(); el.btnReset.click(); return;
            }

            /* Ctrl+/ → comentar/descomentar */
            if (e.key === '/' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                const v = el.codeInput.value;
                const s = el.codeInput.selectionStart, en = el.codeInput.selectionEnd;
                const lines = v.split('\n');
                /* line containing an offset o = largest i with start_i <= o.
                   ls = line of the selection start (s); le = line of end (en). */
                let pos2 = 0, ls = 0, le = 0, startLe = 0;
                for (let i = 0; i < lines.length; i++) {
                    if (pos2 <= s)  ls = i;
                    if (pos2 <= en) { le = i; startLe = pos2; }
                    pos2 += lines[i].length + 1;
                }
                /* a selection ending exactly at the start of a line does not
                   include that line (comment only what was actually selected). */
                if (en > s && en === startLe && le > ls) le--;
                const allCommented = lines.slice(ls, le+1).every(l => /^(\s*)\/\//.test(l));
                for (let i = ls; i <= le; i++) {
                    if (allCommented) lines[i] = lines[i].replace(/^(\s*)\/\/ ?/, '$1');
                    else { const m = lines[i].match(/^(\s*)/); lines[i] = (m?m[1]:'') + '// ' + lines[i].trimStart(); }
                }
                const before   = lines.slice(0, ls).join('\n');
                const selected = lines.slice(ls, le+1).join('\n');
                const after    = lines.slice(le+1).join('\n');
                el.codeInput.value = (before ? before+'\n' : '') + selected + (after ? '\n'+after : '');
                const newS = before ? before.length+1 : 0;
                const newE = newS + selected.length;
                el.codeInput.selectionStart = s <= newS ? newS : Math.min(s, newE);
                el.codeInput.selectionEnd   = Math.min(newE, el.codeInput.value.length);
                self._updateHighlight(); return;
            }

            /* Ctrl+D → duplicate line */
            if (e.key === 'd' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                const v = el.codeInput.value, s = el.codeInput.selectionStart;
                const ls = v.lastIndexOf('\n', s-1)+1;
                const le = v.indexOf('\n', s);
                const line = le === -1 ? v.slice(ls) : v.slice(ls, le);
                const ins  = '\n' + line;
                el.codeInput.value = v.slice(0, le===-1?v.length:le) + ins + v.slice(le===-1?v.length:le);
                el.codeInput.selectionStart = el.codeInput.selectionEnd = (le===-1?v.length:le) + ins.length;
                self._updateHighlight(); return;
            }

            /* Alt+↑/↓ → move line */
            if (e.altKey && (e.key==='ArrowUp' || e.key==='ArrowDown')) {
                e.preventDefault();
                const v = el.codeInput.value, s = el.codeInput.selectionStart;
                const lines = v.split('\n');
                let pos2 = 0, li = 0;
                for (let i = 0; i < lines.length; i++) {
                    if (pos2 + lines[i].length >= s) { li = i; break; }
                    pos2 += lines[i].length + 1;
                }
                const dir = e.key === 'ArrowUp' ? -1 : 1;
                const ni  = li + dir;
                if (ni < 0 || ni >= lines.length) return;
                [lines[li], lines[ni]] = [lines[ni], lines[li]];
                el.codeInput.value = lines.join('\n');
                let newPos = 0;
                for (let i = 0; i < ni; i++) newPos += lines[i].length + 1;
                newPos += Math.min(s - pos2, lines[ni].length);
                el.codeInput.selectionStart = el.codeInput.selectionEnd = newPos;
                self._updateHighlight(); return;
            }

            /* Home inteligente */
            if (e.key === 'Home' && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                const v = el.codeInput.value, s = el.codeInput.selectionStart;
                const ls = v.lastIndexOf('\n', s-1)+1;
                const indent = v.slice(ls).match(/^\s*/)[0].length;
                const target = ls + (s === ls+indent ? 0 : indent);
                if (e.shiftKey) {
                    el.codeInput.selectionStart = Math.min(el.codeInput.selectionStart, target);
                    el.codeInput.selectionEnd   = Math.max(el.codeInput.selectionEnd,   target);
                } else {
                    el.codeInput.selectionStart = el.codeInput.selectionEnd = target;
                }
                return;
            }

            /* Enter with auto-indent */
            if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
                const v = el.codeInput.value, s = el.codeInput.selectionStart;
                const ls  = v.lastIndexOf('\n', s-1)+1;
                const cur = v.slice(ls, s);
                const ind = cur.match(/^(\s*)/)[1];
                const extra = cur.trimEnd().endsWith('{') ? '    ' : '';
                const ins   = '\n' + ind + extra;
                el.codeInput.value = v.slice(0,s) + ins + v.slice(el.codeInput.selectionEnd);
                el.codeInput.selectionStart = el.codeInput.selectionEnd = s + ins.length;
                self._updateHighlight(); self._updateCursor(); return;
            }
        });

        /* Alt+= / Alt+- / Alt+0 → font size of the editor or the terminal,
           depending on where focus is (like pyeditor).
           Clicking the output pane (outputScroll has tabindex=0) focuses it,
           enabling the terminal font-size change. */
        document.addEventListener('keydown', e => {
            if (!e.altKey) return;
            if (e.key !== '=' && e.key !== '+' && e.key !== '-' && e.key !== '0') return;
            const focused = document.activeElement;
            const inTerm   = el.outputPane.contains(focused);
            const inEditor = el.codeInput === focused ||
                             (!inTerm && el.root.contains(focused));
            if (!inEditor && !inTerm) return;
            e.preventDefault();
            if (e.key === '0') {
                if (inTerm) self._setTerminalFontSize(self._opts.terminalFontSize || _FONTSIZE);
                else        self._setFontSize(self._opts.fontSize || _FONTSIZE);
                return;
            }
            const inc = e.key === '-' ? -1 : 1;
            if (inTerm) self._setTerminalFontSize(self._currentTfz + inc);
            else        self._setFontSize(self._currentFz + inc);
        });

        /* Fragmentos via Ctrl+arrows */
        document.addEventListener('keydown', e => {
            if (!e.ctrlKey) return;
            const isNext  = e.key === 'ArrowRight' || e.key === 'ArrowDown';
            const isPrev  = e.key === 'ArrowLeft'  || e.key === 'ArrowUp';
            const isFirst = e.key === 'Home';
            const isLast  = e.key === 'End';
            if (!isNext && !isPrev && !isFirst && !isLast) return;
            if (!self._fragState.fragments.length) return;

            const inReveal = self._container.closest('.present, .slide-background.present');
            const visible  = inReveal !== null ? true : self._container.offsetParent !== null;
            if (!visible) return;

            e.preventDefault(); e.stopPropagation();
            const total = self._fragState.fragments.length;
            if (isNext)       self._goToFragment(self._fragState.current + 1);
            else if (isPrev)  self._goToFragment(self._fragState.current - 1);
            else if (isFirst) self._goToFragment(0);
            else if (isLast)  self._goToFragment(total - 1);
        });

        /* Fragments via buttons */
        el.fragPrev.addEventListener('click', () => self._goToFragment(self._fragState.current - 1));
        el.fragNext.addEventListener('click', () => self._goToFragment(self._fragState.current + 1));

        /* Font size via buttons */
        document.getElementById(this._uid('fz-up'))
            .addEventListener('click', () => self._setFontSize(self._currentFz + 1));
        document.getElementById(this._uid('fz-dn'))
            .addEventListener('click', () => self._setFontSize(self._currentFz - 1));
        document.getElementById(this._uid('tfz-up'))
            .addEventListener('click', () => self._setTerminalFontSize(self._currentTfz + 1));
        document.getElementById(this._uid('tfz-dn'))
            .addEventListener('click', () => self._setTerminalFontSize(self._currentTfz - 1));

        /* Copiar */
        el.btnCopy.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(el.codeInput.value);
                const sp = el.btnCopy.querySelector('span');
                const orig = sp.textContent;
                sp.textContent = 'Copiado!';
                setTimeout(() => { sp.textContent = orig; }, 1500);
            } catch(_) {}
        });

        /* Restaurar */
        el.btnReset.addEventListener('click', () => {
            if (el.codeInput.value === self._defaultCode) return;
            if (!confirm('Restore the initial code?')) return;
            el.codeInput.value = self._defaultCode;
            self._updateHighlight(); self._updateCursor();
        });

        /* File tree dropdown (multi-file) */
        const toggleFiletree = (e) => {
            e.stopPropagation();
            const dd = el.filetreeDd;
            const open = dd.style.display !== 'none';
            dd.style.display = open ? 'none' : 'flex';
            if (!open) {
                const close = (ev) => {
                    if (!dd.contains(ev.target) && ev.target !== el.filetreeBtn
                        && !el.editorFname.contains(ev.target)) {
                        dd.style.display = 'none';
                        document.removeEventListener('click', close);
                    }
                };
                setTimeout(() => document.addEventListener('click', close), 0);
            }
        };
        if (el.filetreeBtn) {
            el.filetreeBtn.addEventListener('click', toggleFiletree);
        }
        if (el.filetreeBtn && el.editorFname) {
            el.editorFname.style.cursor = 'pointer';
            el.editorFname.addEventListener('click', toggleFiletree);
        }
        /* filetree click handlers are bound dynamically in _bindFiletreeActions */

        /* Compilar */
        el.btnRun.addEventListener('click', () => self._runCode());

        /* Limpar */
        el.btnClear.addEventListener('click', () => {
            el.consoleOut.innerHTML = '';
            el.outStatus.textContent = '';
        });

        /* Shortcuts — floating popup */
        el.btnShortcuts.addEventListener('click', () => {
            const ov  = el.shortcutsOverlay;
            const btn = el.btnShortcuts.getBoundingClientRect();
            const vpW = window.innerWidth, vpH = window.innerHeight;

            ov.style.display  = 'block';
            ov.style.position = 'fixed';
            ov.style.zIndex   = '99999';
            ov.style.left = '0'; ov.style.top = '0';
            const ovW = ov.offsetWidth || 340, ovH = ov.offsetHeight || 360;

            let left = btn.right + 8;
            if (left + ovW > vpW - 8) left = btn.left - ovW - 8;
            if (left < 8) left = 8;
            let top = btn.bottom + 4;
            if (top + ovH > vpH - 8) top = btn.top - ovH - 4;
            if (top < 8) top = 8;
            ov.style.left = left + 'px'; ov.style.top = top + 'px';

            /* Drag-to-move — initialized only once */
            if (!ov._dragInit) {
                ov._dragInit = true;
                const header = ov.querySelector('.ct-shortcuts-header');
                const body   = ov.querySelector('.ct-shortcuts-body');
                let dragging2 = false, ox2 = 0, oy2 = 0;

                header.addEventListener('mousedown', e => {
                    if (e.button !== 0) return;
                    dragging2 = true;
                    ox2 = e.clientX - ov.getBoundingClientRect().left;
                    oy2 = e.clientY - ov.getBoundingClientRect().top;
                    document.body.style.userSelect = 'none';
                    document.body.style.cursor     = 'grabbing';
                    header.style.cursor = 'grabbing';
                    body.style.pointerEvents = 'none';
                    e.preventDefault();
                });
                document.addEventListener('mousemove', e => {
                    if (!dragging2) return;
                    const w = ov.offsetWidth, h = ov.offsetHeight;
                    let nx = Math.max(0, Math.min(window.innerWidth  - w, e.clientX - ox2));
                    let ny = Math.max(0, Math.min(window.innerHeight - h, e.clientY - oy2));
                    ov.style.left = nx + 'px'; ov.style.top = ny + 'px';
                });
                document.addEventListener('mouseup', () => {
                    if (!dragging2) return;
                    dragging2 = false;
                    document.body.style.userSelect = '';
                    document.body.style.cursor = '';
                    header.style.cursor = '';
                    body.style.pointerEvents = '';
                }, true);
            }
        });

        el.shortcutsClose.addEventListener('click', () => {
            el.shortcutsOverlay.style.display = 'none';
        });
        document.addEventListener('click', e => {
            if (el.shortcutsOverlay.style.display !== 'none' &&
                !el.shortcutsOverlay.contains(e.target) &&
                e.target !== el.btnShortcuts) {
                el.shortcutsOverlay.style.display = 'none';
            }
        }, true);
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && el.shortcutsOverlay.style.display !== 'none')
                el.shortcutsOverlay.style.display = 'none';
        });

        /* Resize */
        this._initResizer();
        this._initDragToSnap();

        this._resizeHandler = () => {
            self._cachedChW = 0;
            self._updateHighlight();
            if (self._opts.sepbar === undefined) self._applySepbar();
        };
        window.addEventListener('resize', this._resizeHandler);
    }

    /* ── Destroy ──────────────────────────────────────────────── */
    destroy() {
        if (this._consoleObserver) { this._consoleObserver.disconnect(); this._consoleObserver = null; }
        if (this._sepbarROH) { this._sepbarROH.disconnect(); this._sepbarROH = null; }
        if (this._sepbarROV) { this._sepbarROV.disconnect(); this._sepbarROV = null; }
        if (this._resizeHandler) { window.removeEventListener('resize', this._resizeHandler); this._resizeHandler = null; }
        /* Remove shortcuts overlay do body */
        if (this._el && this._el.shortcutsOverlay) {
            try { document.body.removeChild(this._el.shortcutsOverlay); } catch(_) {}
        }
        if (this._container) this._container.innerHTML = '';
    }

    /* ── Init ─────────────────────────────────────────────────── */
    _init() {
        const el  = this._el;
        const pos = String(this._opts.terminalPosition || _defaultPosTerm).trim().toLowerCase();

        if (pos === 'top' || pos === 'bottom') {
            const r = el.resizer;
            r.style.width  = '100%';
            r.style.height = _resizerW + 'px';
            r.style.cursor = 'row-resize';
        } else if (this._container.hasAttribute('data-fullscreen')) {
            /* For horizontal data-fullscreen, apply a temporary 50% to
               editorPane so the resizer is draggable from the first render.
               _fitEditorToContent() will correct it to the ideal value soon. */
            el.editorPane.style.width      = '50%';
            el.editorPane.style.flexShrink = '0';
            el.editorPane.style.flexGrow   = '0';
        }

        el.codeInput.value = this._defaultCode;
        el.codeInput.spellcheck = false;
        el.codeInput.setAttribute('spellcheck', 'false');

        this._initFragments();
        this._updateHighlight();
        this._updateCursor();
        this._initCWasm();

        requestAnimationFrame(() => {
            this._applySepbar();
            this._updateHighlight();
        });

        /* ResizeObserver for late dimensions (hidden Reveal.js slides) */
        if (typeof ResizeObserver !== 'undefined') {
            const self = this;

            /* (1) Wait for editorScroll to have height — triggers initial highlight */
            const roH = new ResizeObserver(() => {
                const h = self._el.editorScroll.clientHeight;
                if (h > 0) { roH.disconnect(); self._updateHighlight(); }
            });
            roH.observe(el.editorScroll);

            /* (2) Wait for workspace to have width — needed for data-fullscreen
                   or any horizontal layout where the width arrives after
                   initialization (hidden Reveal.js slides, iframes, etc.) */
            const posInit = String(this._opts.terminalPosition || _defaultPosTerm).trim().toLowerCase();
            if (!['top', 'bottom'].includes(posInit)) {
                const roW = new ResizeObserver(() => {
                    const w = self._el.workspace.offsetWidth;
                    if (w > 0) {
                        roW.disconnect();
                        self._applySepbar();
                        self._updateHighlight();
                    }
                });
                roW.observe(el.workspace);
            }
        }

        /* Second pass after fonts load */
        if (document.fonts && typeof document.fonts.ready === 'object') {
            const self = this;
            document.fonts.ready.then(() => {
                self._cachedChW = 0;
                if (!self._userResized) self._fitEditorToContent();
            });
        }
    }
}

/* ═══════════════════════════════════════════════════════════════
   Public API
═══════════════════════════════════════════════════════════════ */
const CTerminal = {
    _instances: [],

    /**
     * CTerminal.create(selector, opts) → CTerminalInstance
     *
     * opts: fontSize, terminalFontSize, terminalPosition ('right'|'left'|'top'|'bottom'),
     *       sepbar, filename, editorLines, terminalLines,
     *       spellcheck, autocomplete, autocorrect, autocapitalize,
     *       linenumbers, highlight, code, extraHtml, files, dirs
     */
    create(selector, opts = {}) {
        const container = typeof selector === 'string'
            ? document.querySelector(selector)
            : selector;
        if (!container) {
            console.error('[CTerminal] container not found:', selector);
            return null;
        }
        const inst = new CTerminalInstance(container, opts);
        container._ctInstance = inst;   /* mark to avoid double initialization via execCWASM.js */
        this._instances.push(inst);
        return inst;
    },

    destroyAll() {
        this._instances.forEach(inst => { try { inst.destroy(); } catch(_) {} });
        this._instances = [];
    },
};

window.CTerminal = CTerminal;
