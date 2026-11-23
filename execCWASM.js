/*
 * execCWASM.js
 * Initializes every .cterminal found on the page via the <template> syntax.
 *
 * IMPORTANT: must be loaded AFTER configReveal.js at the end of <body>.
 *
 * data-* parameters (all optional):
 *   data-filename            string                     (default: 'main.c')
 *   data-terminal-position   right|left|top|bottom      (default: right)
 *   data-sepbar              number %                   (default: auto)
 *   data-font-size           number px                  (default: 22)
 *   data-terminal-font-size  number px                  (default: 22)
 *   data-editor-lines        N                          automatic height (N lines)
 *   data-terminal-lines      M                          terminal height (M lines)
 *   data-linenumbers         e.g. "1-3|5-8"             code fragments
 *   data-highlight           e.g. "2[1-8]"              column highlighting
 *   data-spellcheck          true|false                 (default: false)
 *   data-autocomplete        on|off                     (default: off)
 *   data-autocorrect         on|off                     (default: off)
 *   data-autocapitalize      on|off                     (default: off)
 *   data-files               CSV or JSON array          files (reserved)
 *   data-dirs                CSV or JSON array          directories (reserved)
 *
 * Extra toolbar slot:
 *   <template data-slot="extra">
 *     <button class="ct-tb-btn">...</button>
 *   </template>
 *
 * Minimal example:
 *   <div class="cterminal"
 *        data-filename="main.c"
 *        data-terminal-position="right"
 *        data-editor-lines="12">
 *     <template>
 * #include <stdio.h>
 * int main() { printf("Hello!\n"); return 0; }
 *     </template>
 *   </div>
 */

(function () {
    'use strict';

    /* ── Read the raw C code from the widget ────────────────────────────
       PREFERRED source: <script type="text/plain"> … </script>
       This is an HTML "raw text element": the parser interprets NOTHING
       inside it until it reaches </script>. So every character typical of
       C — < > & # $ % " * etc. — is preserved literally, WITHOUT escaping.
       textContent returns exactly what was typed.

       COMPATIBILITY source: <template> … </template>
       The parser interprets the content as markup (<stdio.h> becomes an
       element, legitimate & and < become entities). We recover it via
       innerHTML, stripping the invented tags and un-escaping entities once.

       The one caveat of <script>: the literal sequence "</script>" cannot
       appear in the code (it never occurs in C). */
    function _readCode(el) {
        /* (1) <script type="text/plain"> — the ideal raw source */
        var scr = el.querySelector('script[type="text/plain"]:not([data-slot])');
        if (scr) {
            return scr.textContent.replace(/^\n/, '').replace(/\n$/, '');
        }

        /* (2) <template> — compatibility */
        var tmpl = el.querySelector('template:not([data-slot])');
        if (!tmpl) return '';

        var raw = tmpl.innerHTML;

        if (raw == null || raw === '') {
            var s = new XMLSerializer();
            var parts = [];
            tmpl.content.childNodes.forEach(function (n) {
                parts.push(s.serializeToString(n));
            });
            raw = parts.join('');
        }

        /* Strip closing tags of unknown elements: </stdio.h> */
        raw = raw.replace(/<\/[a-zA-Z][^>]*>/g, '');

        /* Decode HTML entities once */
        var ta = document.createElement('textarea');
        ta.innerHTML = raw;
        return ta.value.replace(/^\n/, '').replace(/\n$/, '');
    }

    function _createAll(cache) {
        cache.forEach(function (item) {
            var el = item.el;
            var d  = el.dataset;

            /* data-files */
            var files;
            if (d.files) {
                try { files = JSON.parse(d.files); }
                catch (_) { files = d.files.split(',').map(function(s){ return s.trim(); }).filter(Boolean); }
            }

            /* data-dirs */
            var dirs;
            if (d.dirs) {
                try { dirs = JSON.parse(d.dirs); }
                catch (_) { dirs = d.dirs.split(',').map(function(s){ return s.trim(); }).filter(Boolean); }
            }

            CTerminal.create(el, {
                fontSize:         d.fontSize         ? +d.fontSize         : 22,
                terminalFontSize: d.terminalFontSize  ? +d.terminalFontSize  : 22,
                terminalPosition: (d.terminalPosition || 'right').toLowerCase(),
                sepbar:           d.sepbar            ? +d.sepbar            : undefined,
                editorLines:      d.editorLines       ? +d.editorLines       : undefined,
                terminalLines:    d.terminalLines     ? +d.terminalLines     : undefined,
                filename:         d.filename          || 'main.c',
                spellcheck:       d.spellcheck        !== 'false',
                autocomplete:     d.autocomplete      || 'off',
                autocorrect:      d.autocorrect       || 'off',
                autocapitalize:   d.autocapitalize    || 'off',
                linenumbers:      d.linenumbers        || undefined,
                highlight:        d.highlight          || undefined,
                files:            files,
                dirs:             dirs,
                allowNewFiles:    d.allowNewFiles !== undefined,
                code:             item.code,
            });
        });
    }

    /* Read the code NOW (before Reveal rearranges the DOM) */
    var cache = [];
    document.querySelectorAll('.cterminal').forEach(function (el) {
        if (el._ctInstance) return;  /* avoid double initialization */
        cache.push({ el: el, code: _readCode(el) });
    });

    /* Create the widgets after Reveal.initialize() or DOMContentLoaded */
    if (typeof Reveal !== 'undefined') {
        Reveal.addEventListener('ready', function () { _createAll(cache); });
    } else {
        document.addEventListener('DOMContentLoaded', function () { _createAll(cache); });
    }

})();
