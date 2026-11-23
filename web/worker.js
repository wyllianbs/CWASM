/**
 * worker.js — cwasm C→WASM64 compiler Web Worker (modern, binji-free)
 *
 * Runs clang + wasm-ld (compiled to wasm32-wasi by scripts/build-toolchain.sh)
 * inside a Web Worker to compile the student's C to a wasm64-wasi module, then
 * executes that module. The WASI host below is self-contained preview1 — it
 * follows the same pattern as gowasm/web/worker.js (no binji memfs/shared.js).
 *
 * The compiler (clang/lld) is wasm32; the STUDENT program is wasm64 (long,
 * pointer and size_t are 64-bit, like gcc x86_64). The WASI host is therefore
 * parameterized by pointer width (`bits64`): for wasm64 modules the imported
 * functions receive pointers/sizes as BigInt and iovecs are 16 bytes wide.
 *
 * Protocol (set by scriptExec.cwasm.js — preserved, NOT binji):
 *   Main → Worker (via worker.postMessage):
 *     { id:'constructor', data: MessagePort, baseUrl: string }
 *   Main → Worker (via the MessagePort):
 *     { id:'setStdinChannel', data: SharedArrayBuffer }   // 8B header + 4096B
 *     { id:'setStdin',        data: string }               // fallback stdin
 *     { id:'compileLinkRun',  data: code, filename, flags, files? }
 *   Worker → Main (via the MessagePort):
 *     { id:'write',    data: string }   // stdout+stderr, written live
 *     { id:'needStdin' }                // program blocked on a stdin read
 *     { id:'done' }                     // job finished
 */

/* global self, WebAssembly, fetch, caches, crypto, performance,
          TextDecoder, TextEncoder, URL, Atomics, Int32Array, SharedArrayBuffer */

'use strict';

const BIN_CACHE_NAME = 'cwasm-bin-v1';   // keep in sync with scriptExec.cwasm.js
const decoder = new TextDecoder();
const encoder = new TextEncoder();

let PORT = null;          // MessagePort to the main thread
let BASE = null;          // base URL (directory of this worker.js)
let STDIN_SAB = null;     // interactive stdin channel (optional)
let STDIN_STR = '';       // fallback / pre-collected stdin

let clangModule = null;
let lldModule = null;
let sysrootFiles = null;  // Map<path, Uint8Array> extracted from sysroot.tar
let TARGET = 'wasm64-wasi';
/* Default C standard when the widget passes no -std=… Filled from the manifest
   (defaultStd field, detected at build time = the newest standard this
   toolchain's clang accepts). Falls back to gnu23 if the manifest omits it. */
let DEFAULT_STD = 'gnu23';
let bootPromise = null;

// ── Message wiring ─────────────────────────────────────────────────────────

self.onmessage = function (e) {
    const m = e.data;
    if (!m || m.id !== 'constructor') return;
    PORT = m.data;
    BASE = m.baseUrl || self.location.href;
    PORT.onmessage = onPortMessage;
    bootPromise = boot().catch((err) => {
        writeErr('Error loading the toolchain: ' + (err && err.message || err) + '\n');
    });
};

function onPortMessage(e) {
    const m = e.data;
    if (!m || !m.id) return;
    switch (m.id) {
        case 'setStdinChannel': STDIN_SAB = m.data || null; break;
        case 'setStdin':        STDIN_STR = m.data || '';   break;
        case 'compileLinkRun':
            compileLinkRun(m.data || '', m.filename || 'main.c', m.flags || '', m.files || null)
                .catch((err) => {
                    writeErr('panic: ' + (err && (err.stack || err.message) || err) + '\n');
                    finish();
                });
            break;
        default: break;
    }
}

function write(text) { if (PORT && text) PORT.postMessage({ id: 'write', data: text }); }
function finish()    { if (PORT) PORT.postMessage({ id: 'done' }); }

// Colorize compiler diagnostics for the terminal's ANSI renderer, using the
// SAME palette as the binji terminal (wasm/binji): error lines bold red
// (1;31 → #e74c3c), warning lines amber (93 → #f1c40f); everything else
// (source line, caret, notes, program stdout) stays default. Per-line, reset
// before each newline so spans stay balanced. The ANSI map lives in
// scriptExec.cwasm.js (ansiToHtml) and is identical to binji's.
function colorizeDiag(text) {
    return text.split(/(\n)/).map((part) => {
        if (part === '\n' || part === '') return part;
        if (/(?:^|[\s:])error:/i.test(part)   || /^wasm-ld:.*\berror\b/i.test(part))
            return '\x1b[1;31m' + part + '\x1b[0m';
        if (/(?:^|[\s:])warning:/i.test(part) || /^wasm-ld:.*\bwarning\b/i.test(part))
            return '\x1b[93m' + part + '\x1b[0m';
        return part;
    }).join('');
}
// Our own error lines (not from the compiler) → bold red, like binji's `Error:`.
function writeErr(text) { write('\x1b[1;91m' + text + '\x1b[0m'); }

// ── Resilient asset loading (cache-first) ──────────────────────────────────

function assetUrl(name) { return new URL('assets/' + name, BASE).href; }

async function openCache() {
    try { return await caches.open(BIN_CACHE_NAME); } catch { return null; }
}

async function fetchBytes(name) {
    const url = assetUrl(name);
    const cache = await openCache();
    if (cache) {
        try { const hit = await cache.match(url); if (hit) return new Uint8Array(await hit.arrayBuffer()); }
        catch { /* miss */ }
    }
    // Retry a few times — large assets over flaky networks.
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(url + ': HTTP ' + res.status);
            const bytes = new Uint8Array(await res.arrayBuffer());
            if (cache) { try { await cache.put(url, new Response(bytes)); } catch { /* quota */ } }
            return bytes;
        } catch (e) { lastErr = e; }
    }
    throw lastErr;
}

async function fetchText(name) { return decoder.decode(await fetchBytes(name)); }

async function boot() {
    let manifestTarget = null;
    try {
        const mf = JSON.parse(await fetchText('manifest.json'));
        manifestTarget = mf.target;
        if (mf.defaultStd) DEFAULT_STD = mf.defaultStd;
    } catch { /* optional */ }
    if (manifestTarget) TARGET = manifestTarget;

    const [clangBytes, lldBytes, sysrootTar] = await Promise.all([
        fetchBytes('clang.wasm'),
        fetchBytes('lld.wasm'),
        fetchBytes('sysroot.tar'),
    ]);

    [clangModule, lldModule] = await Promise.all([
        WebAssembly.compile(clangBytes),
        WebAssembly.compile(lldBytes),
    ]);
    sysrootFiles = extractTar(sysrootTar);
}

// ── TAR extraction (ustar, regular files + dirs) ───────────────────────────

function extractTar(tarBytes) {
    const files = new Map();
    let offset = 0;
    while (offset + 512 <= tarBytes.length) {
        const header = tarBytes.subarray(offset, offset + 512);
        if (header.every((b) => b === 0)) break;
        let name = '';
        for (let i = 0; i < 100 && header[i] !== 0; i++) name += String.fromCharCode(header[i]);
        // ustar prefix (bytes 345..499) for long paths
        let prefix = '';
        for (let i = 345; i < 500 && header[i] !== 0; i++) prefix += String.fromCharCode(header[i]);
        if (prefix) name = prefix + '/' + name;
        name = name.replace(/^\.\//, '').replace(/^\/+/, '');
        let sizeStr = '';
        for (let i = 124; i < 136 && header[i] !== 0; i++) sizeStr += String.fromCharCode(header[i]);
        const size = parseInt(sizeStr.trim(), 8) || 0;
        const type = header[156];
        offset += 512;
        if ((type === 0 || type === 48) && size > 0 && name) {
            files.set(name, tarBytes.slice(offset, offset + size));
        }
        offset += Math.ceil(size / 512) * 512;
    }
    return files;
}

// ── In-memory VFS (generic; from gowasm) ───────────────────────────────────

class MemFS {
    constructor() { this.files = new Map(); this.dirs = new Set(['/']); this.inodes = new Map(); this.nextIno = 1; }
    // Stable, unique inode per path. clang dedups include dirs by (dev,ino);
    // without distinct inodes it drops /sysroot/include as a "duplicate" of
    // /sysroot/clang/include and <stdio.h> vanishes from the search list.
    inode(path) { let n = this.inodes.get(path); if (n === undefined) { n = this.nextIno++; this.inodes.set(path, n); } return n; }
    mkdirp(path) {
        const parts = path.split('/').filter(Boolean);
        let cur = '';
        for (const p of parts) { cur += '/' + p; this.dirs.add(cur); }
    }
    writeFile(path, data) {
        if (typeof data === 'string') data = encoder.encode(data);
        this.files.set(path, data);
        const dir = path.substring(0, path.lastIndexOf('/'));
        if (dir) this.mkdirp(dir);
    }
    readFile(path) { return this.files.get(path) || null; }
    exists(path)   { return this.files.has(path) || this.dirs.has(path); }
    isDir(path)    { return this.dirs.has(path); }
    stat(path) {
        if (this.files.has(path)) return { size: this.files.get(path).length, isDir: false, ino: this.inode(path) };
        if (this.dirs.has(path))  return { size: 0, isDir: true, ino: this.inode(path) };
        return null;
    }
    list(path) {
        const prefix = path.endsWith('/') ? path : path + '/';
        const entries = [];
        const add = (p) => { if (p.startsWith(prefix)) { const n = p.slice(prefix.length).split('/')[0]; if (n && !entries.includes(n)) entries.push(n); } };
        for (const p of this.files.keys()) add(p);
        for (const d of this.dirs) if (d !== path) add(d);
        return entries;
    }
    unlink(path) { this.files.delete(path); }
}

// ── WASI preview1 host (pointer width parameterized for wasm64) ─────────────

class WasiExit extends Error { constructor(code) { super('exit ' + code); this.code = code; } }

class WasiHost {
    /**
     * @param {object} opts { fs, args, env, stdout, stderr, bits64, interactive }
     */
    constructor(opts) {
        this.fs = opts.fs;
        this.args = opts.args;
        this.env = opts.env || {};
        this.stdout = opts.stdout;
        this.stderr = opts.stderr;
        this.bits64 = !!opts.bits64;
        this.interactive = !!opts.interactive;
        this.exitCode = null;

        // stdin byte buffer (fallback string first)
        this.stdinBuf = encoder.encode(STDIN_STR || '');
        this.stdinPos = 0;
        this.stdinEOF = false;

        this.fds = new Map();
        this.nextFd = 4;
        this.fds.set(3, { type: 'dir', path: '/', offset: 0 }); // preopen "/"
    }

    // Pull the next chunk of stdin, blocking the worker on the SAB when the
    // program reads past what we already have (interactive scanf/fgets).
    pumpStdin() {
        if (this.stdinPos < this.stdinBuf.length) return true;
        if (this.stdinEOF) return false;
        if (!(this.interactive && STDIN_SAB &&
              typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined')) {
            this.stdinEOF = true; return false;
        }
        const sync    = new Int32Array(STDIN_SAB, 0, 2);
        const payload = new Uint8Array(STDIN_SAB, 8);
        Atomics.store(sync, 0, 1);              // 1 = waiting
        if (PORT) PORT.postMessage({ id: 'needStdin' });
        Atomics.wait(sync, 0, 1);              // block until main stores 2
        const n = Atomics.load(sync, 1);
        Atomics.store(sync, 0, 0);
        if (n <= 0) { this.stdinEOF = true; return false; }
        const chunk = payload.slice(0, n);
        // append remaining unread + new chunk
        const rem = this.stdinBuf.subarray(this.stdinPos);
        const merged = new Uint8Array(rem.length + chunk.length);
        merged.set(rem); merged.set(chunk, rem.length);
        this.stdinBuf = merged; this.stdinPos = 0;
        return true;
    }

    getImports(memBox) {
        const self = this;
        const bits64 = this.bits64;
        const mem = () => memBox.mem.buffer;
        const IOV = bits64 ? 16 : 8;

        // Per-call views (memory may grow/detach between calls).
        const V = () => new DataView(mem());
        const B = () => new Uint8Array(mem());
        const rdPtr = (v, o) => bits64 ? Number(v.getBigUint64(o, true)) : v.getUint32(o, true);
        const wrPtr = (v, o, x) => bits64 ? v.setBigUint64(o, BigInt(x >>> 0 === x ? x : Math.trunc(x)), true)
                                          : v.setUint32(o, x, true);
        const wrSize = wrPtr;
        const iov = (v, base, i) => ({
            ptr: rdPtr(v, base + i * IOV),
            len: rdPtr(v, base + i * IOV + (bits64 ? 8 : 4)),
        });

        const api = {
            args_sizes_get(argcPtr, bufSizePtr) {
                const v = V(); let size = 0;
                for (const a of self.args) size += encoder.encode(a).length + 1;
                wrSize(v, argcPtr, self.args.length); wrSize(v, bufSizePtr, size); return 0;
            },
            args_get(argvPtr, bufPtr) {
                const v = V(), b = B(); let off = bufPtr;
                for (let i = 0; i < self.args.length; i++) {
                    wrPtr(v, argvPtr + i * (bits64 ? 8 : 4), off);
                    const e = encoder.encode(self.args[i] + '\0'); b.set(e, off); off += e.length;
                }
                return 0;
            },
            environ_sizes_get(cntPtr, bufSizePtr) {
                const v = V(); const en = Object.entries(self.env); let size = 0;
                for (const [k, val] of en) size += encoder.encode(k + '=' + val).length + 1;
                wrSize(v, cntPtr, en.length); wrSize(v, bufSizePtr, size); return 0;
            },
            environ_get(envPtr, bufPtr) {
                const v = V(), b = B(); const en = Object.entries(self.env); let off = bufPtr;
                for (let i = 0; i < en.length; i++) {
                    wrPtr(v, envPtr + i * (bits64 ? 8 : 4), off);
                    const e = encoder.encode(en[i][0] + '=' + en[i][1] + '\0'); b.set(e, off); off += e.length;
                }
                return 0;
            },
            clock_time_get(id, prec, resPtr) { V().setBigUint64(resPtr, BigInt(Math.round(performance.now() * 1e6)), true); return 0; },
            clock_res_get(id, resPtr) { V().setBigUint64(resPtr, 1000n, true); return 0; },

            fd_write(fd, iovsPtr, iovsLen, nwrittenPtr) {
                const v = V(), b = B(); let written = 0;
                const entry = (fd > 2) ? self.fds.get(fd) : null;
                let data = entry && entry.type === 'file' ? (self.fs.readFile(entry.path) || new Uint8Array(0)) : null;
                for (let i = 0; i < iovsLen; i++) {
                    const { ptr, len } = iov(v, iovsPtr, i);
                    const bytes = b.slice(ptr, ptr + len);
                    if (fd === 1) self.stdout(decoder.decode(bytes));
                    else if (fd === 2) self.stderr(decoder.decode(bytes));
                    else if (data) {
                        const need = entry.offset + bytes.length;
                        if (need > data.length) { const g = new Uint8Array(need); g.set(data); data = g; }
                        data.set(bytes, entry.offset); entry.offset += bytes.length;
                    } else { wrSize(v, nwrittenPtr, 0); return 8; }
                    written += len;
                }
                if (data) self.fs.writeFile(entry.path, data);
                wrSize(v, nwrittenPtr, written); return 0;
            },

            fd_read(fd, iovsPtr, iovsLen, nreadPtr) {
                const v = V(), b = B(); let total = 0;
                if (fd === 0) {
                    for (let i = 0; i < iovsLen; i++) {
                        const { ptr, len } = iov(v, iovsPtr, i);
                        let got = 0;
                        while (got < len) {
                            if (self.stdinPos >= self.stdinBuf.length && !self.pumpStdin()) break;
                            const avail = self.stdinBuf.length - self.stdinPos;
                            const n = Math.min(len - got, avail);
                            b.set(self.stdinBuf.subarray(self.stdinPos, self.stdinPos + n), ptr + got);
                            self.stdinPos += n; got += n; total += n;
                            break; // one chunk per iovec; libc loops as needed
                        }
                    }
                    wrSize(v, nreadPtr, total); return 0;
                }
                const entry = self.fds.get(fd);
                if (!entry || entry.type !== 'file') { wrSize(v, nreadPtr, 0); return 8; }
                const data = self.fs.readFile(entry.path);
                if (!data) { wrSize(v, nreadPtr, 0); return 0; }
                for (let i = 0; i < iovsLen; i++) {
                    const { ptr, len } = iov(v, iovsPtr, i);
                    const avail = data.length - entry.offset;
                    const n = Math.min(len, Math.max(0, avail));
                    if (n > 0) { b.set(data.subarray(entry.offset, entry.offset + n), ptr); entry.offset += n; total += n; }
                }
                wrSize(v, nreadPtr, total); return 0;
            },

            fd_close(fd) { self.fds.delete(fd); return 0; },
            fd_seek(fd, offset, whence, newOffPtr) {
                const v = V(); const e = self.fds.get(fd);
                if (!e) { V().setBigUint64(newOffPtr, 0n, true); return 8; }
                const data = self.fs.readFile(e.path); const size = data ? data.length : 0;
                const off = Number(offset);
                if (whence === 0) e.offset = off; else if (whence === 1) e.offset += off; else if (whence === 2) e.offset = size + off;
                v.setBigUint64(newOffPtr, BigInt(e.offset), true); return 0;
            },
            fd_tell(fd, offPtr) { const e = self.fds.get(fd); V().setBigUint64(offPtr, BigInt(e ? e.offset : 0), true); return 0; },
            fd_fdstat_get(fd, bufPtr) {
                const v = V(); const e = self.fds.get(fd);
                const ft = (fd <= 2) ? 2 : (e && e.type === 'dir') ? 3 : 4;
                v.setUint8(bufPtr, ft); v.setUint16(bufPtr + 2, 0, true);
                v.setBigUint64(bufPtr + 8, 0xFFFFFFFFFFFFFFFFn, true);
                v.setBigUint64(bufPtr + 16, 0xFFFFFFFFFFFFFFFFn, true); return 0;
            },
            fd_fdstat_set_flags() { return 0; },
            fd_prestat_get(fd, bufPtr) {
                const v = V();
                if (fd === 3) { v.setUint8(bufPtr, 0); wrSize(v, bufPtr + (bits64 ? 8 : 4), 1); return 0; }
                return 8;
            },
            fd_prestat_dir_name(fd, pathPtr, pathLen) {
                if (fd === 3) { B().set(encoder.encode('/'), pathPtr); return 0; }
                return 8;
            },
            fd_filestat_get(fd, bufPtr) {
                const v = V(); for (let i = 0; i < 64; i++) v.setUint8(bufPtr + i, 0);
                if (fd <= 2) { v.setUint8(bufPtr + 16, 2); return 0; }
                const e = self.fds.get(fd); if (!e) return 8;
                const st = self.fs.stat(e.path); if (!st) return 8;
                v.setBigUint64(bufPtr, 1n, true);                        // dev
                v.setBigUint64(bufPtr + 8, BigInt(st.ino), true);        // ino (unique → no false dedup)
                v.setUint8(bufPtr + 16, st.isDir ? 3 : 4);               // filetype
                v.setBigUint64(bufPtr + 24, 1n, true);                   // nlink
                v.setBigUint64(bufPtr + 32, BigInt(st.size), true); return 0;
            },
            fd_sync() { return 0; }, fd_datasync() { return 0; }, fd_advise() { return 0; },
            fd_allocate() { return 0; }, fd_filestat_set_size() { return 0; },
            fd_filestat_set_times() { return 0; }, fd_renumber() { return 52; },
            fd_pread(fd, iovsPtr, iovsLen, offset, nreadPtr) {
                const v = V(), b = B(); const e = self.fds.get(fd);
                if (!e || e.type !== 'file') { wrSize(v, nreadPtr, 0); return 8; }
                const data = self.fs.readFile(e.path) || new Uint8Array(0); let off = Number(offset); let total = 0;
                for (let i = 0; i < iovsLen; i++) {
                    const { ptr, len } = iov(v, iovsPtr, i);
                    const n = Math.min(len, Math.max(0, data.length - off));
                    if (n > 0) { b.set(data.subarray(off, off + n), ptr); off += n; total += n; }
                }
                wrSize(v, nreadPtr, total); return 0;
            },
            fd_pwrite(fd, iovsPtr, iovsLen, offset, nwrittenPtr) {
                const v = V(), b = B(); const e = self.fds.get(fd);
                if (!e || e.type !== 'file') { wrSize(v, nwrittenPtr, 0); return 8; }
                let data = self.fs.readFile(e.path) || new Uint8Array(0); let off = Number(offset); let total = 0;
                for (let i = 0; i < iovsLen; i++) {
                    const { ptr, len } = iov(v, iovsPtr, i);
                    const chunk = b.slice(ptr, ptr + len); const need = off + chunk.length;
                    if (need > data.length) { const g = new Uint8Array(need); g.set(data); data = g; }
                    data.set(chunk, off); off += chunk.length; total += len;
                }
                self.fs.writeFile(e.path, data); wrSize(v, nwrittenPtr, total); return 0;
            },

            path_open(dirFd, dirFlags, pathPtr, pathLen, oflags, rbase, rinh, fdFlags, fdPtr) {
                const v = V(); let path = self.resolve(dirFd, decoder.decode(B().slice(pathPtr, pathPtr + pathLen)));
                const CREATE = 1, TRUNC = 8;
                if (self.fs.isDir(path)) { const fd = self.nextFd++; self.fds.set(fd, { type: 'dir', path, offset: 0 }); wrSize(v, fdPtr, fd); return 0; }
                if (self.fs.exists(path) || (oflags & CREATE)) {
                    if (oflags & TRUNC) self.fs.writeFile(path, new Uint8Array(0));
                    const fd = self.nextFd++; self.fds.set(fd, { type: 'file', path, offset: 0 }); wrSize(v, fdPtr, fd); return 0;
                }
                return 44; // ENOENT
            },
            path_filestat_get(dirFd, flags, pathPtr, pathLen, bufPtr) {
                const v = V(); const path = self.resolve(dirFd, decoder.decode(B().slice(pathPtr, pathPtr + pathLen)));
                const st = self.fs.stat(path); if (!st) return 44;
                for (let i = 0; i < 64; i++) v.setUint8(bufPtr + i, 0);
                v.setBigUint64(bufPtr, 1n, true);                        // dev
                v.setBigUint64(bufPtr + 8, BigInt(st.ino), true);        // ino (unique → no false dedup)
                v.setUint8(bufPtr + 16, st.isDir ? 3 : 4);               // filetype
                v.setBigUint64(bufPtr + 24, 1n, true);                   // nlink
                v.setBigUint64(bufPtr + 32, BigInt(st.size), true); return 0;
            },
            path_create_directory(dirFd, pathPtr, pathLen) { self.fs.mkdirp(self.resolve(dirFd, decoder.decode(B().slice(pathPtr, pathPtr + pathLen)))); return 0; },
            path_unlink_file(dirFd, pathPtr, pathLen) { self.fs.unlink(self.resolve(dirFd, decoder.decode(B().slice(pathPtr, pathPtr + pathLen)))); return 0; },
            path_remove_directory() { return 0; },
            path_rename(oFd, oPtr, oLen, nFd, nPtr, nLen) {
                const b = B();
                const oldP = self.resolve(oFd, decoder.decode(b.slice(oPtr, oPtr + oLen)));
                const newP = self.resolve(nFd, decoder.decode(b.slice(nPtr, nPtr + nLen)));
                const data = self.fs.readFile(oldP); if (data) { self.fs.writeFile(newP, data); self.fs.unlink(oldP); } return 0;
            },
            path_filestat_set_times() { return 0; }, path_link() { return 52; },
            path_readlink() { return 52; }, path_symlink() { return 52; },
            fd_readdir(fd, bufPtr, bufLen, cookie, sizePtr) {
                const v = V(), b = B(); const e = self.fds.get(fd);
                if (!e || e.type !== 'dir') { wrSize(v, sizePtr, 0); return 8; }
                const entries = self.fs.list(e.path); let off = 0; const start = Number(cookie);
                for (let i = start; i < entries.length; i++) {
                    const nb = encoder.encode(entries[i]); const esz = 24 + nb.length;
                    if (off + esz > bufLen) break;
                    v.setBigUint64(bufPtr + off, BigInt(i + 1), true);
                    v.setBigUint64(bufPtr + off + 8, 0n, true);
                    v.setUint32(bufPtr + off + 16, nb.length, true);
                    v.setUint8(bufPtr + off + 20, self.fs.isDir(e.path + '/' + entries[i]) ? 3 : 4);
                    b.set(nb, bufPtr + off + 24); off += esz;
                }
                wrSize(v, sizePtr, off); return 0;
            },

            poll_oneoff(inPtr, outPtr, nsubs, neventsPtr) {
                const v = V();
                for (let i = 0; i < nsubs; i++) {
                    const sub = inPtr + i * 48, evt = outPtr + i * 32;
                    for (let j = 0; j < 32; j++) v.setUint8(evt + j, 0);
                    v.setBigUint64(evt, v.getBigUint64(sub, true), true); // userdata
                    v.setUint16(evt + 8, 0, true);
                    v.setUint8(evt + 10, v.getUint8(sub + 8));
                }
                wrSize(v, neventsPtr, nsubs); return 0;
            },
            proc_exit(code) { self.exitCode = Number(code); throw new WasiExit(Number(code)); },
            proc_raise() { return 52; }, sched_yield() { return 0; },
            random_get(bufPtr, bufLen) { const r = new Uint8Array(Number(bufLen)); crypto.getRandomValues(r); B().set(r, bufPtr); return 0; },
            sock_accept() { return 52; }, sock_recv() { return 52; }, sock_send() { return 52; }, sock_shutdown() { return 52; },
        };

        // Normalize BigInt args → Number for wasm64 modules (addresses < 2^53).
        // errno returns stay i32; memory writes use wrSize/wrPtr with bits64.
        const wrapped = {};
        for (const k of Object.keys(api)) {
            const fn = api[k];
            wrapped[k] = bits64
                ? (...a) => fn.apply(api, a.map((x) => typeof x === 'bigint' ? Number(x) : x))
                : fn;
        }
        return { wasi_snapshot_preview1: wrapped, wasi_unstable: wrapped };
    }

    resolve(dirFd, path) {
        if (path.startsWith('/')) return this.norm(path);
        const e = this.fds.get(dirFd);
        const base = (e && e.path) || '/';
        return this.norm(base.endsWith('/') ? base + path : base + '/' + path);
    }
    norm(p) { return (p.replace(/\/+/g, '/').replace(/\/(\.\/)+/g, '/').replace(/\/$/, '') || '/'); }
}

async function runModule(module, args, env, fs, stdout, stderr, opts) {
    const memBox = { mem: null };
    const wasi = new WasiHost({ fs, args, env, stdout, stderr, bits64: !!(opts && opts.bits64), interactive: !!(opts && opts.interactive) });
    const instance = await WebAssembly.instantiate(module, wasi.getImports(memBox));
    memBox.mem = instance.exports.memory;
    try {
        if (instance.exports._start) instance.exports._start();
        else if (instance.exports._initialize) instance.exports._initialize();
        return wasi.exitCode || 0;
    } catch (e) {
        if (e instanceof WasiExit) return e.code;
        throw e;
    }
}

// ── Compile → link → run ───────────────────────────────────────────────────

function targetArch() { return TARGET === 'wasm64-wasi' ? 'wasm64' : 'wasm32'; }

async function compileLinkRun(code, filename, flags, files) {
    if (bootPromise) await bootPromise;
    if (!clangModule || !lldModule || !sysrootFiles) { writeErr('Toolchain not loaded.\n'); finish(); return; }

    const arch = targetArch();
    const libdir = '/sysroot/lib/' + TARGET;

    // Fresh FS with the sysroot mounted at /sysroot.
    const fs = new MemFS();
    fs.mkdirp('/work'); fs.mkdirp('/tmp');
    for (const [name, data] of sysrootFiles) fs.writeFile('/sysroot/' + name, data);

    // Student sources
    const srcName = (filename && filename.endsWith('.c')) ? filename : 'main.c';
    fs.writeFile('/work/' + srcName, code);
    if (files) for (const [p, src] of Object.entries(files)) fs.writeFile('/work/' + p.replace(/^\/+/, ''), src);

    const env = { TMPDIR: '/tmp', PWD: '/work', HOME: '/tmp' };
    const userFlags = (flags || '').split(/\s+/).filter(Boolean);

    // Compile with the canonical (non-deprecated) triple spelling. clang 23
    // deprecates wasm32-wasi in favour of wasm32-wasip1 — the SAME target — so
    // using wasip1 avoids the "-Wdeprecated" warning in the student's output.
    // Libraries stay under TARGET (/sysroot/lib/wasm32-wasi) via libdir above;
    // headers are at /sysroot/include (flat), found for either spelling.
    const compileTarget = (TARGET === 'wasm32-wasi') ? 'wasm32-wasip1' : TARGET;

    // Default to C23 when the widget didn't pin a standard: clang 23 supports
    // it fully. gnu23 keeps the common GNU extensions (student-friendly).
    // The widget's own -std=… (data-cflags) overrides this.
    const hasStd = userFlags.some((f) => /^-std=/.test(f));
    const stdFlags = hasStd ? [] : ['-std=' + DEFAULT_STD];

    // Translation units: main.c + every extra .c file (multi-file projects,
    // e.g. separate compilation with headers). Each .c compiles to its own .o
    // and all objects are linked together — mirrors `gcc main.c foo.c …`.
    // Headers (.h) are only written to the FS (above) and found via #include.
    const srcPaths = ['/work/' + srcName];
    if (files) for (const p of Object.keys(files)) {
        const fp = '/work/' + p.replace(/^\/+/, '');
        if (/\.c$/i.test(fp) && !srcPaths.includes(fp)) srcPaths.push(fp);
    }

    // 1) clang -c  (driver runs cc1 in-process; CLANG_SPAWN_CC1=OFF).
    // -I/work so #include "sub/dir/foo.h" from main.c resolves against the
    // project root as well as relative to the including file.
    const objPaths = [];
    for (const sp of srcPaths) {
        const objPath = sp.replace(/\.c$/i, '.o');
        const clangArgs = [
            'clang', '--target=' + compileTarget, '--sysroot=/sysroot',
            '-resource-dir=/sysroot/clang', '-I/work', '-O2', '-Wall',
            ...stdFlags, ...userFlags, '-c', sp, '-o', objPath,
        ];
        let cerr = '';
        const crc = await runModule(clangModule, clangArgs, env, fs, (s) => write(s), (s) => { cerr += s; }, { bits64: false });
        if (cerr) write(colorizeDiag(cerr));   // warnings (gray) even on success
        if (crc !== 0 || !fs.readFile(objPath)) {
            if (!cerr) writeErr('Compilation of ' + sp.replace(/^\/work\//, '') + ' failed (code ' + crc + ').\n');
            finish(); return;
        }
        objPaths.push(objPath);
    }

    // 2) wasm-ld  (crt1 + libc + compiler-rt builtins)
    const wasmPath = '/work/main.wasm';
    const lldArgs = ['wasm-ld'];
    if (arch === 'wasm64') lldArgs.push('-mwasm64');
    // -lc-printscan-long-double BEFORE -lc: enables %Lf/%Le etc. (wasi-libc's
    // default libc.a disables long double in printf/scanf to save size).
    lldArgs.push(
        '-L' + libdir,
        libdir + '/crt1.o', ...objPaths,
        '-lc-printscan-long-double', '-lc', libdir + '/libclang_rt.builtins.a',
        '-o', wasmPath,
    );
    let lerr = '';
    const lrc = await runModule(lldModule, lldArgs, env, fs, (s) => write(s), (s) => { lerr += s; }, { bits64: false });
    if (lerr) write(colorizeDiag(lerr));
    if (lrc !== 0 || !fs.readFile(wasmPath)) {
        if (!lerr) writeErr('Linking failed (code ' + lrc + ').\n');
        finish(); return;
    }

    // 3) Run the student's wasm64 program (memory64 → bits64 WASI host)
    let module;
    try { module = await WebAssembly.compile(fs.readFile(wasmPath)); }
    catch (e) { writeErr('Could not load the program: ' + e.message + '\n'); finish(); return; }

    const runFs = new MemFS(); runFs.mkdirp('/tmp');
    try {
        await runModule(module, [srcName.replace(/\.c$/, '')], { PWD: '/', HOME: '/tmp', TMPDIR: '/tmp', TERM: 'dumb' },
            runFs, (s) => write(s), (s) => write(s),
            { bits64: arch === 'wasm64', interactive: true });
    } catch (e) {
        if (!(e instanceof WasiExit)) writeErr('panic: ' + (e && e.message || e) + '\n');
    }
    finish();
}
