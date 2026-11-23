/**
 * scriptExec.cwasm.js
 *
 * Integrates the C WASM Browser (wasm-clang/worker.js) with the
 * HTML elements of slides (Reveal.js / cwasm.html).
 *
 * HTML usage:
 *   <script src="/wasm/scriptExec.cwasm.js"></script>
 *   ...
 *   CWasmExec.startScript('inputCodeId', 'btnRunId', 'consoleOutputId');
 *
 * Options via data- attributes on the <script> tag:
 *   data-animation  → shows a "compiling..." overlay during execution
 *   data-worker="/path/worker.js" → custom path to the worker
 *
 * Behavior:
 *   - stdout/stderr  → rendered into the consoleId element (innerHTML)
 *   - scanf / reads  → pre-collected via a styled prompt() modal BEFORE
 *                      execution, injected as stdinStr into the worker
 *   - No timeout after execution: the button is re-enabled right at the end
 *   - Supports multiple independent instances on the same page
 *
 * SINGLETON WORKER
 *   A single Web Worker is created and reused by all instances (slides).
 *   This avoids the ~200 MB cost per execution (sysroot + clang + lld
 *   loaded in the worker). Executions are queued: if one slide is
 *   compiling, the others wait in the queue.
 */

(function (global) {
    'use strict';

    /* ------------------------------------------------------------------ */
    /* Utilities                                                            */
    /* ------------------------------------------------------------------ */

    function escapeHtml(str) {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function ansiToHtml(str) {
        const ANSI_COLORS = {
            '30': 'color:#000', '31': 'color:#e74c3c', '32': 'color:#2ecc71',
            '33': 'color:#f39c12', '34': 'color:#3498db', '35': 'color:#9b59b6',
            '36': 'color:#1abc9c', '37': 'color:#ecf0f1', '0': '', '1': 'font-weight:bold',
            '90': 'color:#7f8c8d', '91': 'color:#e74c3c', '92': 'color:#2ecc71',
            '93': 'color:#f1c40f', '94': 'color:#3498db', '95': 'color:#9b59b6',
            '96': 'color:#1abc9c', '97': 'color:#fff',
        };
        str = str.replace(/\x1b\[([0-9;]*)m/g, function (_, codes) {
            if (!codes || codes === '0') return '</span>';
            const style = codes.split(';')
                .map(c => ANSI_COLORS[c] || '')
                .filter(Boolean)
                .join(';');
            return style ? `<span style="${style}">` : '</span>';
        });
        str = str.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
        str = str.replace(/\x1b[^[]/g, '');
        return str;
    }

    function textToHtml(raw) {
        return ansiToHtml(escapeHtml(raw)).replace(/\n/g, '<br>');
    }

    /* ------------------------------------------------------------------ */
    /* Counting stdin reads in the C code                                  */
    /* ------------------------------------------------------------------ */

    function detectStdinReads(code) {
        const reads = [];

        const stripped = code
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/\/\/[^\n]*/g, ' ')
            .replace(/"(?:[^"\\]|\\.)*"/g, '""')
            .replace(/'(?:[^'\\]|\\.)*'/g, "''");

        const scanfRe = /\b(scanf|fscanf)\s*\(/g;
        let m;
        while ((m = scanfRe.exec(stripped)) !== null) {
            if (m[1] === 'fscanf') {
                const rest = stripped.slice(m.index + m[0].length);
                if (!/^\s*stdin\s*,/.test(rest)) continue;
            }
            const fmtMatch = stripped.slice(m.index).match(/"([^"]*)"/);
            const fmt = fmtMatch ? fmtMatch[1] : '';
            const specs = (fmt.match(/%[^%\s*][^\s,)"]*/g) || ['?']);
            for (const spec of specs) {
                reads.push({ label: `scanf (${spec})`, hint: spec });
            }
        }

        const fgetsRe = /\bfgets\s*\((?:[^()]|\([^()]*\))*stdin\s*\)/g;
        while ((m = fgetsRe.exec(stripped)) !== null) {
            reads.push({ label: '', hint: 'string' });
        }

        const getcharRe = /\bgetchar\s*\(\s*\)/g;
        let gcCount = 0;
        while ((m = getcharRe.exec(stripped)) !== null) gcCount++;
        for (let i = 0; i < gcCount; i++) {
            reads.push({ label: `getchar #${i + 1}`, hint: 'char' });
        }

        const getsRe = /\bgets\s*\(/g;
        while ((m = getsRe.exec(stripped)) !== null) {
            reads.push({ label: 'gets (text line)', hint: 'string' });
        }

        return reads;
    }

    /* ------------------------------------------------------------------ */
    /* Styled input modal (replaces the native prompt())                   */
    /* ------------------------------------------------------------------ */

    (function injectModalStyles() {
        if (document.getElementById('cwasm-modal-style')) return;
        const style = document.createElement('style');
        style.id = 'cwasm-modal-style';
        style.textContent = `
#cwasm-modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 999999;
    font-family: 'Arial', sans-serif;
    backdrop-filter: blur(2px);
}
#cwasm-modal-box {
    background: var(--bg-editor, #ffffff);
    border: none;
    border-top: 4px solid var(--blue, #003893);
    border-radius: 8px;
    padding: 0;
    min-width: 360px;
    max-width: 480px;
    width: 88vw;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.22), 0 1.5px 6px rgba(0, 0, 0, 0.10);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: _cwasmModalIn 0.18s ease;
}
@keyframes _cwasmModalIn {
    from { opacity: 0; transform: translateY(-10px) scale(0.97); }
    to   { opacity: 1; transform: translateY(0)    scale(1);    }
}
#cwasm-modal-header {
    background: var(--blue, #003893);
    padding: 10px 18px 9px;
    display: flex;
    align-items: center;
    gap: 8px;
}
#cwasm-modal-title {
    font-size: 0.72rem;
    color: rgba(var(--wbs-on-accent-rgb, 255,255,255), .92);
    letter-spacing: 0.10em;
    text-transform: uppercase;
    font-weight: 600;
    font-family: 'Courier New', monospace;
}
#cwasm-modal-body {
    padding: 20px 22px 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
}
#cwasm-modal-label {
    font-size: 0.93rem;
    color: var(--text-main, #222);
    font-family: 'Courier New', monospace;
    white-space: pre-wrap;
    word-break: break-word;
    background: var(--bg-page, #f4f6fb);
    border-left: 3px solid var(--blue, #003893);
    padding: 6px 10px;
    border-radius: 0 4px 4px 0;
    display: none;
}
#cwasm-modal-label.has-content {
    display: block;
}
#cwasm-modal-progress {
    font-size: 0.72rem;
    color: var(--text-muted, #7a8aaa);
    text-align: right;
    margin-top: -4px;
    font-family: Arial, sans-serif;
}
#cwasm-modal-input {
    width: 100%;
    box-sizing: border-box;
    background: var(--bg-page, #f8f9fc);
    border: 1.5px solid var(--border, #b8c6e0);
    border-radius: 5px;
    color: var(--text-main, #111);
    font-family: 'Courier New', monospace;
    font-size: 1rem;
    padding: 8px 12px;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
}
#cwasm-modal-input:focus {
    border-color: var(--blue, #003893);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--blue, #003893) 25%, transparent);
    background: var(--bg-editor, #fff);
}
#cwasm-modal-footer {
    padding: 0 22px 16px;
    display: flex;
    justify-content: flex-end;
}
#cwasm-modal-btn {
    background: var(--blue, #003893);
    color: rgb(var(--wbs-on-accent-rgb, 255,255,255));
    border: none;
    border-radius: 5px;
    padding: 8px 26px;
    font-size: 0.92rem;
    font-family: Arial, sans-serif;
    font-weight: 600;
    cursor: pointer;
    letter-spacing: 0.03em;
    transition: background 0.15s, transform 0.1s;
}
#cwasm-modal-btn:hover  { background: color-mix(in srgb, var(--blue, #003893) 85%, #000); }
#cwasm-modal-btn:active { transform: scale(0.97); }
        #cwasm-modal-header svg {
    /* the inline fill (#b8cfff) comes from JS; CSS beats a presentation
       attribute, so this is enough for the icon to follow the theme */
    fill: rgba(var(--wbs-on-accent-rgb, 255,255,255), .85);
}
`;
        (document.head || document.documentElement).appendChild(style);
    })();

    function showInputModal(promptLabel, hint, current, total) {
        return new Promise(function (resolve) {
            var backdrop = document.createElement('div');
            backdrop.id = 'cwasm-modal-backdrop';

            var box = document.createElement('div');
            box.id = 'cwasm-modal-box';

            var header = document.createElement('div');
            header.id = 'cwasm-modal-header';

            var icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            icon.setAttribute('viewBox', '0 0 16 16');
            icon.setAttribute('width', '14');
            icon.setAttribute('height', '14');
            icon.setAttribute('fill', '#b8cfff');
            icon.setAttribute('aria-hidden', 'true');
            icon.style.flexShrink = '0';
            icon.innerHTML =
                '<path d="M0 3a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2zm9.5 5.5-3-3-.707.707L8.086 8.5 5.793 10.793l.707.707 3-3a.5.5 0 0 0 0-.707z"/>';

            var title = document.createElement('div');
            title.id = 'cwasm-modal-title';
            title.textContent = 'Input (stdin)';

            header.appendChild(icon);
            header.appendChild(title);

            var body = document.createElement('div');
            body.id = 'cwasm-modal-body';

            var label = document.createElement('div');
            label.id = 'cwasm-modal-label';
            if (promptLabel && promptLabel.trim()) {
                label.textContent = promptLabel.trim();
                label.classList.add('has-content');
            }

            var progress = document.createElement('div');
            progress.id = 'cwasm-modal-progress';
            if (total > 1) {
                progress.textContent = 'Input ' + current + ' of ' + total;
            }

            var input = document.createElement('input');
            input.type = 'text';
            input.id = 'cwasm-modal-input';
            input.autocomplete = 'off';
            input.spellcheck = false;
            if (hint && hint.includes('d'))              input.placeholder = 'integer';
            else if (hint && /lf|f|g/.test(hint))        input.placeholder = 'decimal number';
            else if (hint && hint.includes('c'))         input.placeholder = 'character';
            else                                         input.placeholder = 'Input';

            body.appendChild(label);
            if (total > 1) body.appendChild(progress);
            body.appendChild(input);

            var footer = document.createElement('div');
            footer.id = 'cwasm-modal-footer';

            var btn = document.createElement('button');
            btn.id = 'cwasm-modal-btn';
            btn.textContent = (total > 1 && current < total) ? 'Next →' : 'OK ↵';

            footer.appendChild(btn);

            box.appendChild(header);
            box.appendChild(body);
            box.appendChild(footer);
            backdrop.appendChild(box);
            document.body.appendChild(backdrop);

            function confirm() {
                var val = input.value;
                if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
                resolve(val);
            }

            btn.addEventListener('click', confirm);
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') confirm();
            });
            backdrop.addEventListener('keydown', function (e) {
                if (e.key === 'Escape') confirm();
            });

            setTimeout(function () { input.focus(); }, 40);
        });
    }

    async function collectStdin(reads, outputSoFar) {
        var lines = [];
        for (var i = 0; i < reads.length; i++) {
            var r = reads[i];
            var label = (outputSoFar && outputSoFar.trim())
                ? outputSoFar.trim()
                : r.label;
            var val = await showInputModal(label, r.hint, i + 1, reads.length);
            lines.push(val);
        }
        return lines.join('\n') + (lines.length ? '\n' : '');
    }

    /* ------------------------------------------------------------------ */
    /* Resolve the worker path                                              */
    /* ------------------------------------------------------------------ */

    function resolveWorkerPath() {
        const scripts = document.querySelectorAll('script[src]');
        for (let i = 0; i < scripts.length; i++) {
            const src = scripts[i].getAttribute('src') || '';
            if (src.includes('scriptExec.cwasm')) {
                const custom = scripts[i].getAttribute('data-worker');
                if (custom) return custom;
                /* Derive the worker path from scriptExec's OWN URL, so the
                   cwasm/ folder can live anywhere (/wasm/cwasm/, …) with no
                   edits. scriptExec.cwasm.js lives in cwasm/; the worker is
                   cwasm/web/worker.js. */
                try { return new URL('web/worker.js', new URL(src, document.baseURI)).href; }
                catch (_) { /* falls through to the fallback below */ }
                break;
            }
        }
        return '/wasm/cwasm/web/worker.js';
    }

    function hasAnimationFlag() {
        const scripts = document.querySelectorAll('script[src]');
        for (let i = 0; i < scripts.length; i++) {
            const src = scripts[i].getAttribute('src') || '';
            if (src.includes('scriptExec.cwasm')) {
                return scripts[i].hasAttribute('data-animation');
            }
        }
        return false;
    }

    /* ------------------------------------------------------------------ */
    /* "Compiling" overlay                                                 */
    /* ------------------------------------------------------------------ */

    let _overlayEl = null;

    function showOverlay(msg) {
        if (!_overlayEl) {
            _overlayEl = document.createElement('div');
            _overlayEl.style.cssText = [
                'position:fixed', 'top:0', 'left:0', 'width:100%', 'height:100%',
                'background:rgba(0,0,0,0.55)', 'display:flex', 'align-items:center',
                'justify-content:center', 'z-index:99998', 'font-family:monospace',
                'font-size:1.4rem', 'color:#fff', 'letter-spacing:0.05em',
                'pointer-events:none',
            ].join(';');
            document.body.appendChild(_overlayEl);
        }
        _overlayEl.textContent = msg || 'Compilando…';
        _overlayEl.style.display = 'flex';
    }

    function hideOverlay() {
        if (_overlayEl) _overlayEl.style.display = 'none';
    }

    /* ------------------------------------------------------------------ */
    /* Heuristic: printf before the first scanf                            */
    /* ------------------------------------------------------------------ */

    function _extractPrintfBeforeFirstScanf(code) {
        const stripped = code
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/\/\/[^\n]*/g, ' ');

        const scanfPos = stripped.search(/\bscanf\s*\(/);
        if (scanfPos === -1) return '';

        const before = stripped.slice(0, scanfPos);
        const printfRe = /\bprintf\s*\(\s*"([^"]*)"/g;
        let last = '';
        let m;
        while ((m = printfRe.exec(before)) !== null) {
            last = m[1];
        }

        return last
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\/g, '')
            .trim();
    }

    /* ------------------------------------------------------------------ */
    /* Interactive stdin channel (SharedArrayBuffer + Atomics)              */
    /*                                                                      */
    /* Requires crossOriginIsolated (COOP/COEP), configured in the          */
    /* production vhost and in .vscode/router.php for local dev, restricted */
    /* to the /disciplines/, /wasm/ and /Ceditor.html routes.               */
    /*                                                                      */
    /* When available, each stdin read (scanf/fgets/getchar) the C program  */
    /* actually performs at runtime triggers a modal — instead of           */
    /* pre-collecting a fixed number of inputs via regex BEFORE running,     */
    /* which broke validation loops (e.g. a do-while re-asking until the     */
    /* input is valid), since the program received EOF once the             */
    /* pre-collected buffer was exhausted.                                   */
    /*                                                                      */
    /* Without crossOriginIsolated, it falls back to the legacy behavior     */
    /* (static pre-collection via detectStdinReads/collectStdin).            */
    /* ------------------------------------------------------------------ */

    const SAB_SUPPORTED =
        typeof SharedArrayBuffer !== 'undefined' &&
        typeof Atomics !== 'undefined' &&
        typeof self !== 'undefined' && !!self.crossOriginIsolated;

    const STDIN_SAB_HEADER_BYTES  = 8;     /* 2 × Int32 (state, size)     */
    const STDIN_SAB_PAYLOAD_BYTES = 4096;  /* UTF-8 bytes per read         */
    const STDIN_SAB_BYTES = STDIN_SAB_HEADER_BYTES + STDIN_SAB_PAYLOAD_BYTES;

    /* ================================================================== */
    /*  SINGLETON WORKER — a single worker shared by all slides            */
    /*                                                                      */
    /*  wasm-clang loads the sysroot (~100 MB) + clang + lld at startup.   */
    /*  With N independent workers: N × ~200 MB of RAM that the GC cannot  */
    /*  reclaim while the tab stays open.                                   */
    /*                                                                      */
    /*  With a singleton: a fixed 1 × ~200 MB, regardless of how many      */
    /*  slides exist or how many compilations are run.                      */
    /*                                                                      */
    /*  Executions are queued: if the worker is busy, the request waits    */
    /*  in the queue and is dispatched as soon as the worker is free.       */
    /* ================================================================== */

    const _singleton = {
        worker:      null,       /* the single Web Worker                     */
        port:        null,       /* MessageChannel.port1                      */
        busy:        false,      /* true while a compilation is in progress   */
        queue:       [],         /* queue of pending { job }                  */
        current:     null,       /* { consoleId, onDone, useAnimation }       */
        _watchJobId: 0,          /* counter to identify each watchdog         */
        stdinSAB:    null,       /* interactive stdin channel (see above)     */
        awaitingStdin: false,    /* true while the input modal is open        */
    };

    /* WBS: explicit cache (Cache API) for the worker.js source text, in
       the same spirit as section 1.18 (clang/lld/sysroot.tar). Without it,
       `new Worker(workerPath)` relies solely on the ambient interception
       of the Service Worker / browser HTTP cache, which proved
       inconsistent (sometimes "cached", sometimes a full download) — the
       same kind of fragility seen with clang/lld before 1.18, except here
       the file is small (a few KB), so the gain is latency, not avoiding a
       stall. We fetch the script text ourselves and instantiate the Worker
       from a local Blob URL. */
    const SRC_CACHE_NAME = 'cwasm-src-v8';

    async function _fetchScriptCached(url) {
        let cache = null;
        try {
            if (typeof caches !== 'undefined') {
                cache = await caches.open(SRC_CACHE_NAME);
                const cached = await cache.match(url);
                if (cached) return await cached.text();
            }
        } catch (_) {
            cache = null;
        }
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' fetching ' + url);
        const text = await resp.text();
        if (cache) {
            try {
                await cache.put(url, new Response(text, {
                    headers: { 'Content-Type': 'text/javascript' }
                }));
            } catch (_) { /* quota exceeded etc.: proceed without cache */ }
        }
        return text;
    }

    /* WBS: pre-warm the Cache Storage of the large binaries
       (clang/lld/sysroot.tar/memfs — section 1.18), kicked off as soon as
       the page loads instead of only on the "Compile & Run" click. Same
       idea Pyodide uses (pyeditor.js: starts downloading the runtime on
       widget load, not on click). Since Cache Storage is shared between
       the page and the Workers of the same origin, this runs 100% on the
       main thread — no need to even create a Worker. `worker.js`
       (fetchResiliente, section 1.18) already checks this same cache
       before any fetch, so when the student later clicks "Compile & Run"
       the files should already be ready. BIN_CACHE_NAME/BIN_FILES are
       duplicated here (also defined in worker.js) — there is no way to
       import those constants from inside the worker; if they change there,
       they must change here too. */
    const BIN_CACHE_NAME = 'cwasm-bin-v1';
    const BIN_FILES = ['assets/clang.wasm', 'assets/lld.wasm', 'assets/sysroot.tar'];
    let _binPreloadStarted = false;

    function _preloadBinCache(workerPath) {
        if (_binPreloadStarted) return;
        _binPreloadStarted = true;
        if (typeof caches === 'undefined') return;

        const baseUrl = new URL('.', new URL(workerPath, location.href)).href;

        BIN_FILES.forEach(async (filename) => {
            const url = new URL(filename, baseUrl).href;
            try {
                const cache = await caches.open(BIN_CACHE_NAME);
                if (await cache.match(url)) return; /* already cached */
                /* {priority:'low'} is ignored by browsers that don't
                   support it — it does not compete with the page's visible
                   resources (images, fonts) for network priority. */
                const response = await fetch(url, {priority : 'low'});
                if (!response.ok) return;
                await cache.put(url, response);
            } catch (_) {
                /* Preload is best-effort: any failure here (network,
                   cache quota, etc.) should not bother the user — the
                   fetchResiliente in worker.js retries, the usual
                   resilient way, on the "Compile & Run" click. */
            }
        });
    }

    /* Instantiate the Worker from the cached text (Blob URL) instead of
       `new Worker(workerPath)` directly. The Object URL is revoked right
       after creation: the Worker has already captured the Blob's content
       at that point. */
    async function _createWorkerCached(workerPath) {
        const absUrl = new URL(workerPath, location.href).href;
        const baseUrl = new URL('.', absUrl).href; /* worker.js directory */
        const text   = await _fetchScriptCached(absUrl);
        const blob   = new Blob([text], { type: 'text/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        let worker;
        try {
            worker = new Worker(blobUrl);
        } finally {
            URL.revokeObjectURL(blobUrl);
        }
        /* WBS: a worker created from a Blob URL has
           self.location === blob:..., so relative paths inside it
           (shared.js, clang, lld, sysroot.tar) don't resolve against the
           real server. We send the real base URL (worker.js directory)
           via 'constructor' for the worker to resolve against — see
           worker.js, `WORKER_BASE_URL`/`_resolveUrl`. */
        return { worker, baseUrl };
    }

    /**
     * Initializes the singleton worker (idempotent: created only once).
     * @param {string}   workerPath
     * @param {Function} onReady(ok) — called when ready (or on error)
     */
    function _ensureWorker(workerPath, onReady) {
        /* Worker already exists and is healthy → ready immediately */
        if (_singleton.worker && _singleton.port) {
            setTimeout(() => onReady(true), 0);
            return;
        }

        /* Clean up any leftover from a previous worker (if it crashed) */
        if (_singleton.worker) {
            try { _singleton.worker.terminate(); } catch (_) {}
            _singleton.worker = null;
            _singleton.port   = null;
        }

        _createWorkerCached(workerPath).then(function (result) {
            _singleton.worker = result.worker;

            const channel      = new MessageChannel();
            _singleton.port    = channel.port1;

            _singleton.port.onmessage = function (event) {
                _handleSingletonMessage(event.data);
            };

            _singleton.worker.onerror = function (e) {
                hideOverlay();
                /* Notify the current job of the error */
                if (_singleton.current) {
                    const cur = _singleton.current;
                    const el  = document.getElementById(cur.consoleId);
                    if (el) {
                        el.innerHTML +=
                            '<span style="color:#e74c3c">Internal worker error: ' +
                            escapeHtml(e.message || String(e)) + '</span>';
                    }
                    _singleton.current = null;
                }
                _singleton.busy = false;
                /* Try to recover by recreating the worker on the next run */
                try { _singleton.worker.terminate(); } catch (_) {}
                _singleton.worker = null;
                _singleton.port   = null;
                /* Process the next job in the queue (if any) */
                _processQueue();
            };

            _singleton.worker.postMessage(
                { id: 'constructor', data: channel.port2, baseUrl: result.baseUrl },
                [channel.port2]
            );

            /* Each worker is recreated from scratch on every run (see
               _onJobDone), so the interactive stdin channel must also be
               recreated and re-sent here, right after the 'constructor'. */
            if (SAB_SUPPORTED) {
                _singleton.stdinSAB = new SharedArrayBuffer(STDIN_SAB_BYTES);
                _singleton.port.postMessage({ id: 'setStdinChannel', data: _singleton.stdinSAB });
            } else {
                _singleton.stdinSAB = null;
            }

            /* Wait for the worker to actually be ready before signaling.
             * Some wasm-clang builds emit an initial message; we wait a
             * tick so the channel is established.                        */
            setTimeout(() => onReady(true), 0);
        }).catch(function (e) {
            console.error('[CWasmExec] Failed to create worker:', e);
            onReady(false);
        });
        /* NOTE: the Worker is only created here (_ensureWorker), which is
         * called only inside _enqueue → runner.run(), i.e. only when the
         * user clicks "Compile". It is not created on page load, saving the
         * ~100-200 MB of the sysroot until it is actually needed. */
    }

    /**
     * Message router for the singleton worker.
     * Forwards to the console of the current job.
     */
    function _handleSingletonMessage(msg) {
        if (!msg || !msg.id) return;
        const cur = _singleton.current;

        switch (msg.id) {
            case 'write':
                if (cur) {
                    const el = document.getElementById(cur.consoleId);
                    if (el) {
                        el.innerHTML += textToHtml(msg.data || '');
                        el.scrollTop  = el.scrollHeight;
                    }
                }
                break;

            case 'done':
                _onJobDone();
                break;

            case 'progress':
                /* Worker download/boot progress → status bar. During a run it
                   goes to the active widget's console; during page-load warmup
                   (no active job) it is broadcast on window so idle widgets can
                   show it (cterminal listens on both). */
                if (cur) {
                    const el = document.getElementById(cur.consoleId);
                    if (el) el.dispatchEvent(new CustomEvent('cwasm:progress', { detail: msg }));
                } else {
                    try { window.dispatchEvent(new CustomEvent('cwasm:progress', { detail: msg })); } catch (e) {}
                }
                break;

            case 'needStdin':
                /* Signal the silence watchdog (below) not to finish the
                   job while the modal is open — the worker goes silent on
                   purpose while waiting for the user. */
                _singleton.awaitingStdin = true;
                _onNeedStdin();
                break;

            /* Ignored messages (canvas, memory, etc.) */
            case 'setMemory':
            case 'setPixels':
            case 'canvas':
                break;

            default:
                break;
        }
    }

    /**
     * Called when the worker emits 'done' (or by the silence watchdog).
     * Finalizes the current job and processes the next one in the queue.
     */
    function _onJobDone() {
        if (!_singleton.current) return;
        const cur = _singleton.current;
        _singleton.current = null;
        _singleton.busy    = false;

        if (cur.useAnimation) hideOverlay();

        /* Fire the cwasm:done event on the slide's console */
        const el = document.getElementById(cur.consoleId);
        if (el) el.dispatchEvent(new CustomEvent('cwasm:done'));

        if (cur.onDone) cur.onDone();

        /* ── Discard the worker after each run ───────────────────────────
           The upstream wasm-clang binary is NOT designed to run main()
           more than once in the same WebAssembly instance: clang's heap
           (dlmalloc/realloc) and the memfs keep main.o/main.wasm from the
           previous round, and the 2nd fd_write overflows the index
           ("Error: index out of bounds"). Terminating and recreating the
           worker guarantees a clean instance. The sysroot stays in the
           browser cache, so the real cost is only re-instantiating the
           WASM module. */
        try { _singleton.worker.terminate(); } catch (_) {}
        _singleton.worker = null;
        _singleton.port   = null;

        /* Next job in the queue (will recreate the worker via _ensureWorker) */
        _processQueue();
    }

    /**
     * Serves a request for more stdin made by the worker in real time
     * (host_read exhausted the current buffer and called _requestMoreStdin,
     * which is blocked in Atomics.wait). Shows the modal, writes the answer
     * into the SharedArrayBuffer, and wakes the worker via Atomics.notify.
     */
    async function _onNeedStdin() {
        const cur = _singleton.current;
        const sab = _singleton.stdinSAB;
        if (!cur || !sab) return; /* shouldn't happen if SAB_SUPPORTED */

        const sync  = new Int32Array(sab, 0, 2);
        const bytes = new Uint8Array(sab, STDIN_SAB_HEADER_BYTES);

        /* Use the output already printed by the program (the prompt's own
           printf) as the modal's context — more faithful than parsing the
           source, since it reflects the real execution state. */
        const el    = document.getElementById(cur.consoleId);
        const label = el ? (el.textContent || '').slice(-200) : '';

        const val = await showInputModal(label, '', 1, 1);

        const encoded = new TextEncoder().encode((val || '') + '\n');
        const n = Math.min(encoded.length, bytes.length);
        bytes.set(encoded.subarray(0, n));
        Atomics.store(sync, 1, n);
        Atomics.store(sync, 0, 2); /* 2 = pronto */
        Atomics.notify(sync, 0);

        _singleton.awaitingStdin = false;
    }

    /**
     * Silence watchdog: detects end of execution even when the worker does
     * not emit 'done' (behavior of some wasm-clang builds). Uses an
     * independent flag instead of replacing port.onmessage, avoiding
     * handler chaining across consecutive runs.
     */
    function _watchForCompletion() {
        /* Flag local to this run; incremented on each received message */
        const jobId     = ++_singleton._watchJobId;
        let   msgCount  = 0;

        /* Intercepts the message count without replacing the main handler */
        const _origOnMsg = _singleton.port.onmessage;
        _singleton.port.onmessage = function (event) {
            msgCount++;
            _origOnMsg(event);
        };

        const SILENCE_MS  = 800;
        const CHECK_DELAY = 200;
        const START_AFTER = 500;
        const startTime   = Date.now();
        let   lastCount   = 0;
        let   lastChange  = Date.now();

        function check() {
            /* Job already finished by 'done' or belongs to another run? */
            if (!_singleton.busy || !_singleton.current) return;
            if (_singleton._watchJobId !== jobId) return;

            /* stdin modal open: the worker is blocked on purpose waiting
               for the user to type, not hung. Don't count it as silence —
               reset the clock on each check until it resolves. */
            if (_singleton.awaitingStdin) {
                lastChange = Date.now();
                setTimeout(check, CHECK_DELAY);
                return;
            }

            if (msgCount !== lastCount) {
                lastCount  = msgCount;
                lastChange = Date.now();
            }

            const elapsed   = Date.now() - startTime;
            const silentFor = Date.now() - lastChange;
            if (elapsed > START_AFTER && silentFor > SILENCE_MS) {
                _onJobDone();
                return;
            }
            setTimeout(check, CHECK_DELAY);
        }

        setTimeout(check, START_AFTER + CHECK_DELAY);
    }

    /**
     * Processes the next job in the queue (if the worker is free).
     */
    function _processQueue() {
        if (_singleton.busy || _singleton.queue.length === 0) return;
        const job = _singleton.queue.shift();

        /* The worker is discarded at the end of each job, so it may no
           longer exist here. Recreate it (if needed) before dispatching. */
        if (_singleton.worker && _singleton.port) {
            _dispatchJob(job);
        } else {
            _ensureWorker(job.workerPath || WORKER_PATH, function (ok) {
                if (!ok) {
                    const el = document.getElementById(job.consoleId);
                    if (el) {
                        el.innerHTML =
                            '<span style="color:#e74c3c">Error: could not recreate the WASM worker.</span>';
                    }
                    if (job.onDone) job.onDone();
                    /* Segue tentando os demais jobs */
                    _processQueue();
                    return;
                }
                _dispatchJob(job);
            });
        }
    }

    /**
     * Dispatches a job to the worker (should be called only when free).
     */
    function _dispatchJob(job) {
        _singleton.busy          = true;
        _singleton.current       = job;
        _singleton.awaitingStdin = false;

        /* Clear the slide's console before starting */
        const el = document.getElementById(job.consoleId);
        if (el) el.innerHTML = '';

        if (job.useAnimation) showOverlay('Compilando…');

        _singleton.port.postMessage({ id: 'setStdin',        data: job.stdinStr });
        const msg = {
            id:       'compileLinkRun',
            data:     job.code,
            filename: job.filename,
            flags:    job.cflags || ''
        };
        if (job.files) msg.files = job.files;
        _singleton.port.postMessage(msg);

        _watchForCompletion();
    }

    /**
     * Enqueues (or dispatches immediately) a compilation.
     *
     * @param {string}   workerPath
     * @param {string}   code          C code to compile
     * @param {string}   filename      File name (widget's data-filename)
     * @param {string}   stdinStr      Pre-collected stdin
     * @param {string}   consoleId     ID of the output div
     * @param {boolean}  useAnimation
     * @param {Function} onDone        Callback at the end
     */
    function _enqueue(workerPath, code, filename, stdinStr, consoleId, useAnimation, onDone, cflags, files) {
        const job = { code, filename, stdinStr, consoleId, useAnimation, onDone, workerPath, cflags: cflags || '', files: files || null };

        _ensureWorker(workerPath, function (ok) {
            if (!ok) {
                const el = document.getElementById(consoleId);
                if (el) {
                    el.innerHTML =
                        '<span style="color:#e74c3c">Error: could not load the WASM worker.</span>';
                }
                if (onDone) onDone();
                return;
            }

            if (_singleton.busy) {
                /* Worker busy: enqueue */
                _singleton.queue.push(job);
            } else {
                /* Worker free: dispatch immediately */
                _dispatchJob(job);
            }
        });
    }

    /* ================================================================== */
    /*  Public interface of each slide (replaces WorkerInstance)           */
    /* ================================================================== */

    /**
     * SlideRunner — a lightweight object bound to a slide's button/console.
     * It has no worker of its own: it delegates everything to the singleton.
     */
    function SlideRunner(workerPath, consoleId, useAnimation) {
        this.workerPath   = workerPath;
        this.consoleId    = consoleId;
        this.useAnimation = useAnimation;
    }

    SlideRunner.prototype.run = async function (code, filename, onDone, cflags, files) {
        /* If this slide is already queued or running, cancel the previous
           request (the user clicked again before it finished). */
        const myConsoleId = this.consoleId;
        const idx = _singleton.queue.findIndex(j => j.consoleId === myConsoleId);
        if (idx !== -1) _singleton.queue.splice(idx, 1);

        /* With the interactive channel available (crossOriginIsolated),
           each stdin read is requested on demand during the real execution
           (see _onNeedStdin) — nothing is pre-collected here. This fixes
           validation loops (do-while) that ask for input again at runtime,
           which the static pre-collection below does not support. Without
           the channel (legacy fallback), it pre-collects a fixed number of
           inputs via static analysis of the source code. */
        let stdinStr = '';
        if (!SAB_SUPPORTED) {
            const reads = detectStdinReads(code);
            if (reads.length > 0) {
                const label = _extractPrintfBeforeFirstScanf(code);
                stdinStr    = await collectStdin(reads, label);
            }
        }

        _enqueue(
            this.workerPath,
            code,
            filename,
            stdinStr,
            this.consoleId,
            this.useAnimation,
            onDone,
            cflags,
            files
        );
    };

    /* ------------------------------------------------------------------ */
    /* Public API: CWasmExec                                               */
    /* ------------------------------------------------------------------ */

    var _runners      = {};
    var WORKER_PATH   = resolveWorkerPath();
    var USE_ANIMATION = hasAnimationFlag();

    /* Pre-warm on page load: create the singleton worker and let it boot
       (download + compile the toolchain) BEFORE the first click, so the first
       "Compile & Run" is instant. Fires as soon as the script loads (same
       eager pattern as Pyodide). Progress is shown on the widgets' status bars
       via window 'cwasm:progress' events (no active job during warmup →
       _handleSingletonMessage broadcasts on window). The worker stays alive
       (idle) until the first run; afterwards it is recreated as usual, hitting
       the now-warm cache. Replaces the old cache-only _preloadBinCache (single
       download, no double-fetch). */
    function _prewarmWorker(workerPath) {
        if (_singleton.worker) return;
        _ensureWorker(workerPath, function () { /* created; it boots on its own */ });
    }
    _prewarmWorker(WORKER_PATH);

    /* Reads the default C standard from the toolchain manifest (defaultStd
       field, detected at build time = the newest standard clang accepts)
       and publishes it for the cterminal badge. Async and best-effort:
       cterminal already uses 'C23' as a fallback and updates on the event. */
    (function fetchDefaultStd() {
        try {
            var base = new URL('.', new URL(WORKER_PATH, location.href)).href;
            fetch(new URL('assets/manifest.json', base).href)
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (mf) {
                    if (mf && mf.defaultStd) {
                        window.__cwasmDefaultStd = mf.defaultStd;
                        try {
                            window.dispatchEvent(new CustomEvent(
                                'cwasm:defaultstd', { detail: mf.defaultStd }));
                        } catch (e) { /* CustomEvent unavailable: ignore */ }
                    }
                })
                .catch(function () { /* manifest opcional */ });
        } catch (e) { /* ignora */ }
    })();

    var CWasmExec = {

        /**
         * Binds a button to a C WASM editor and console.
         *
         * @param {string} inputId   - ID of the element holding the C code
         * @param {string} btnId     - ID of the run button
         * @param {string} consoleId - ID of the output div
         */
        startScript: function (inputId, btnId, consoleId) {

            function init() {
                var btn     = document.getElementById(btnId);
                var inputEl = document.getElementById(inputId);
                var consEl  = document.getElementById(consoleId);

                if (!btn || !inputEl || !consEl) {
                    setTimeout(init, 100);
                    return;
                }

                if (!_runners[btnId]) {
                    _runners[btnId] = new SlideRunner(
                        WORKER_PATH,
                        consoleId,
                        USE_ANIMATION
                    );
                }

                var runner = _runners[btnId];

                btn.addEventListener('click', function () {
                    var code = _getCode(inputEl);
                    /* Do NOT convert to escapes: wasm-clang writes the .c
                       file as UTF-8 and the compiler accepts accented
                       characters directly in the source. The old conversion
                       to \xHH merged a character's two bytes (e.g. ó →
                       \xC3B3), causing "hex escape sequence out of range". */

                    if (!code || !code.trim()) {
                        document.getElementById(consoleId).innerHTML =
                            '<span style="color:#f39c12">No code found.</span>';
                        return;
                    }

                    /* Compilation flags coming from the .cterminal widget.
                       Looks for data-* on the code element or on the
                       ancestor .cterminal. Supports:
                         data-cflags="-Wall -Wextra"   (free-form list)
                         data-wall="true"              (shortcut for -Wall) */
                    var host = inputEl.closest ? inputEl.closest('.cterminal') : null;
                    var ds   = (host && host.dataset) || {};
                    var ids  = inputEl.dataset || {};
                    var cflags = ds.cflags || ids.cflags || '';
                    var wall   = (ds.wall || ids.wall);
                    if ((wall === '' || wall === 'true' || wall === '1') &&
                        !/\B-Wall\b/.test(cflags)) {
                        cflags = (cflags ? cflags + ' ' : '') + '-Wall';
                    }

                    var filename = ids.filename || ds.filename || 'main.c';

                    var files = null;
                    var inst = host && host._ctInstance;
                    if (inst && inst.getAllFiles) {
                        files = inst.getAllFiles();
                    }
                    if (inst && inst.getMainCode) {
                        code = inst.getMainCode();
                    }
                    if (inst && inst.getMainFilename) {
                        filename = inst.getMainFilename();
                    }

                    btn.disabled = true;

                    runner.run(code, filename, function () {
                        btn.disabled = false;
                    }, cflags, files);
                });
            }

            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', init);
            } else {
                init();
            }
        },

        setWorkerPath: function (path) {
            WORKER_PATH = path;
            /* Restart the singleton when the path changes */
            if (_singleton.worker) {
                try { _singleton.worker.terminate(); } catch (_) {}
                _singleton.worker = null;
                _singleton.port   = null;
                _singleton.busy   = false;
                _singleton.queue  = [];
                _singleton.current = null;
            }
            _runners = {};
        },

        /**
         * Clears the explicit Cache Storage used by C-WASM (sections
         * 1.18/1.19: clang/lld/sysroot.tar/memfs + worker.js/shared.js) and
         * tears down the singleton worker in use, if any. Does not affect
         * the Service Worker cache (service_worker.js) or the browser's
         * normal HTTP cache — only the Cache Storage opened explicitly by
         * this widget. Useful to force a clean download if something got
         * into an inconsistent state (e.g. a download interrupted midway, a
         * local test build with old cache names, etc.).
         *
         * @returns {Promise<void>}
         */
        clearCache: function () {
            /* BIN_CACHE_NAME/SRC_CACHE_NAME already exist in this file
               (1.19/1.21) and also in worker.js — Cache Storage is per
               origin, not per script, so matching the name is enough; there
               is no way to import the constant from inside the worker, but
               here we already have our own. */
            var CACHE_NAMES = [BIN_CACHE_NAME, SRC_CACHE_NAME];

            if (_singleton.worker) {
                try { _singleton.worker.terminate(); } catch (_) {}
                _singleton.worker = null;
                _singleton.port   = null;
                _singleton.busy   = false;
                _singleton.queue  = [];
                _singleton.current = null;
            }

            if (typeof caches === 'undefined') return Promise.resolve();
            return Promise.all(CACHE_NAMES.map(function (name) {
                return caches.delete(name).catch(function () {});
            })).then(function () {});
        },
    };

    /* ------------------------------------------------------------------ */
    /* Converts UTF-8 to C hexadecimal escapes                            */
    /* ------------------------------------------------------------------ */

    /* NOT used in the normal flow (code goes to the FS as raw UTF-8). Kept
       only as a utility. Uses OCTAL escapes (\NNN, fixed width of 3 digits)
       because \xHH has variable width and "sticks" to the following hex
       digits: ó (C3 B3) would become \xC3B3 (a single escape, out of
       range). Octal avoids that: ó → \303\263. Even so, escapes are only
       valid INSIDE strings — for accents in comments/identifiers use raw
       UTF-8 (the current default). */
    function utf8ToCEscapes(str) {              // eslint-disable-line no-unused-vars
        return str.replace(/[^\x00-\x7F]/g, function (ch) {
            return Array.from(new TextEncoder().encode(ch))
                .map(function (b) {
                    return '\\' + b.toString(8).padStart(3, '0');
                })
                .join('');
        });
    }

    /* ------------------------------------------------------------------ */
    /* Extracts code from different element types                          */
    /* ------------------------------------------------------------------ */

    function _getCode(el) {
        if (!el) return '';
        var tag = el.tagName.toLowerCase();
        if (tag === 'textarea') return el.value;
        if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
            return el.innerText;
        }
        if (tag === 'pre') {
            var codeChild = el.querySelector('code');
            if (codeChild) return codeChild.innerText || codeChild.textContent;
            return el.innerText || el.textContent;
        }
        if (tag === 'code') return el.innerText || el.textContent;
        return el.value || el.innerText || el.textContent || '';
    }

    /* ------------------------------------------------------------------ */
    /* Global exposure                                                      */
    /* ------------------------------------------------------------------ */

    global.CWasmExec = CWasmExec;

}(window));
