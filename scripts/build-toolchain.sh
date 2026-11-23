#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# build-toolchain.sh — Build a modern, 64-bit C→WASM toolchain FROM SOURCE
#
# Produces, with nothing but the local clang-19 / wasm-ld (no wasi-sdk, no
# binji prebuilts):
#     web/assets/clang.wasm     clang compiled to wasm32-wasi (patched LLVM)
#     web/assets/lld.wasm       lld (wasm-ld) compiled to wasm32-wasi
#     web/assets/sysroot.tar    wasm64-wasi C sysroot for student programs
#     web/assets/manifest.json  sha256 of each asset
#   (+ .br/.gz for each large asset)
#
# The in-browser compiler itself is wasm32 (small, stable); it CROSS-COMPILES
# student code to the chosen target (default wasm64-wasi → long/pointer/size_t
# are 64-bit, like gcc x86_64). long double is IEEE binary128 (quad), provided
# by compiler-rt softfloat in the target sysroot.
#
# Usage:
#   ./scripts/install-deps.sh                 # once, to get packages + sources
#   ./scripts/build-toolchain.sh              # default target wasm64-wasi
#   ./scripts/build-toolchain.sh --target wasm32-wasi   # diagnostic fallback
#   ./scripts/build-toolchain.sh --jobs 8
#   ./scripts/build-toolchain.sh --stage sysroot-target # run one stage only
#
# Stages are resumable: each writes a .done marker in .build/ and is skipped
# on re-run unless you pass --force or delete the marker.
#
# ⚠ This build is long (hours) and large (tens of GB). It is NOT expected to
#   run inside a chat session; run it on the Debian/Ubuntu host. The LLVM→wasm
#   stage is the most likely to need flag tuning on the first real run on a
#   new machine — each stage logs independently so failures are localized.
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SRC_DIR="$PROJECT_DIR/.src"
BUILD_DIR="$PROJECT_DIR/.build"
ASSETS_DIR="$PROJECT_DIR/web/assets"

LLVM_SRC="$SRC_DIR/llvm-project"
WASI_LIBC_SRC="$SRC_DIR/wasi-libc"

HOST_SYSROOT="$BUILD_DIR/sysroot-host-wasm32"   # C++ sysroot that hosts clang.wasm
# target sysroot dir depends on --target, set after arg parse

# ── Args ──────────────────────────────────────────────────────────────────
# Student target. wasm32-wasi is the default: upstream wasi-libc's WASI preview1
# headers (<wasi/api.h>) support ONLY wasm32 and static-assert the 32-bit ABI,
# so a wasm64 sysroot does not build. wasm32 still gives working `long double`
# (binary128) and 64-bit integer math, and runs in any modern browser (no
# memory64). Passing --target wasm64-wasi is kept but will fail in wasi-libc.
TARGET="wasm32-wasi"
JOBS="$(nproc 2>/dev/null || echo 4)"
ONLY_STAGE=""
FORCE=0
for ((i=1; i<=$#; i++)); do
    case "${!i}" in
        --target) i=$((i+1)); TARGET="${!i}" ;;
        --jobs)   i=$((i+1)); JOBS="${!i}" ;;
        --stage)  i=$((i+1)); ONLY_STAGE="${!i}" ;;
        --force)  FORCE=1 ;;
        -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: ${!i}" >&2; exit 2 ;;
    esac
done

case "$TARGET" in
    wasm64-wasi) TARGET_ARCH="wasm64" ;;
    wasm32-wasi) TARGET_ARCH="wasm32" ;;
    *) echo "unsupported --target: $TARGET (use wasm64-wasi | wasm32-wasi)" >&2; exit 2 ;;
esac
TARGET_SYSROOT="$BUILD_DIR/sysroot-target-$TARGET"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

marker() { echo "$BUILD_DIR/.stage-$1.done"; }
need_stage() {
    local s="$1"
    [ -n "$ONLY_STAGE" ] && [ "$ONLY_STAGE" != "$s" ] && return 1
    if [ "$FORCE" -eq 0 ] && [ -f "$(marker "$s")" ] && [ -z "$ONLY_STAGE" ]; then
        log "stage '$s' already done — skipping (--force to redo)"; return 1
    fi
    return 0
}
done_stage() { touch "$(marker "$1")"; }

# ── Tool discovery ────────────────────────────────────────────────────────
# Prefer the pinned host LLVM 23 that install-deps.sh downloads (official
# prebuilt, no apt) so the WHOLE toolchain — bootstrap AND the wasm
# cross-compiler — is LLVM 23. Fall back to the apt clang-19 if the prebuilt is
# absent (an older bootstrap still builds the 23 source fine; the clang.wasm
# output is 23 either way).
pick() { for c in "$@"; do command -v "$c" >/dev/null 2>&1 && { echo "$c"; return; }; done; echo "$1"; }
HOST_LLVM_DIR="$SRC_DIR/llvm-host"
if [ -x "$HOST_LLVM_DIR/bin/clang" ]; then
    export PATH="$HOST_LLVM_DIR/bin:$PATH"
    CC="$HOST_LLVM_DIR/bin/clang"
    CXX="$HOST_LLVM_DIR/bin/clang++"
    AR="$HOST_LLVM_DIR/bin/llvm-ar"
    NM="$HOST_LLVM_DIR/bin/llvm-nm"
    RANLIB="$HOST_LLVM_DIR/bin/llvm-ranlib"
    WASMLD="$HOST_LLVM_DIR/bin/wasm-ld"
else
    CC="$(pick clang-19 clang)"
    CXX="$(pick clang++-19 clang++)"
    AR="$(pick llvm-ar-19 llvm-ar ar)"
    NM="$(pick llvm-nm-19 llvm-nm nm)"
    RANLIB="$(pick llvm-ranlib-19 llvm-ranlib ranlib)"
    WASMLD="$(pick wasm-ld-19 wasm-ld)"
fi

# ── 0. Dependency check (fail fast) ───────────────────────────────────────
check_deps() {
    log "Checking host tools…"
    local miss=0
    for t in "$CC" "$CXX" "$AR" "$NM" cmake ninja git python3 brotli gzip tar "$WASMLD"; do
        if command -v "$t" >/dev/null 2>&1; then
            printf '    %-12s %s\n' "$t" "$(command -v "$t")"
        else
            warn "missing: $t"; miss=1
        fi
    done
    [ "$miss" -eq 0 ] || die "install missing tools first: ./scripts/install-deps.sh"
    [ -d "$LLVM_SRC" ]      || die "missing $LLVM_SRC — run ./scripts/install-deps.sh"
    [ -d "$WASI_LIBC_SRC" ] || die "missing $WASI_LIBC_SRC — run ./scripts/install-deps.sh"
    "$CC" --version | head -1
    log "Target: $TARGET ($TARGET_ARCH) · jobs: $JOBS"
}

# ── 0b. WASI POSIX shim (replaces the old LLVM source patch) ──────────────
# We no longer patch LLVM. The POSIX APIs wasi-libc lacks (signals/sigaction,
# fork/exec, mmap-protect, flock, pwd, dup2, alarm…) are instead DECLARED by a
# force-included header and LINKED via weak stubs — see scripts/shim/. Because
# that completes a version-stable surface (POSIX), the build tracks the latest
# LLVM with no per-version patching. The shim object is built in stage_clang_wasm
# (alongside the cxa stub); these vars point at the sources.
SHIM_DIR="$SCRIPT_DIR/shim"
SHIM_H="$SHIM_DIR/wasi-posix-shim.h"
SHIM_C="$SHIM_DIR/wasi-posix-shim.c"

# `--target=wasm32-wasi` is deprecated in favour of `wasm32-wasip1` (same target);
# -Wno-deprecated silences the warning that otherwise repeats on every object.
NOWARN="-Wno-deprecated"
# WebAssembly setjmp/longjmp needs the EH-based SjLj lowering. LLVM's own Support
# (CrashRecoveryContext) uses setjmp unconditionally; wasi-libc's <setjmp.h> hard
# #errors without this. Modern browsers (which we already require for SAB/COOP)
# implement wasm EH, so the resulting clang.wasm runs fine.
SJLJ="-mllvm -wasm-enable-sjlj"

# ── 0c. Source fixups (a few genuine source-dispatch points can't be shimmed) ─
# These are NOT the old context patch: each is ONE exact-line, idempotent,
# anchor-based edit, registered in scripts/source-fixups.sh (the "memory" of
# per-upstream tweaks, documenting the version each was needed for). They
# re-apply cleanly after `rm -rf .src && install-deps.sh`.
fixup_line() {
    local rel="$1" old="$2" new="$3" why="$4"
    local f="$SRC_DIR/$rel"
    [ -f "$f" ] || { warn "fixup target missing: $rel ($why) — skipping"; return 0; }
    # Idempotent: already-applied iff the exact (possibly multi-line) $new block
    # appears as consecutive lines. (A plain grep of $new is wrong when $new
    # contains $old, e.g. an insert-before-anchor edit.)
    if awk -v n="$new" 'BEGIN{k=split(n,L,"\n")} {buf[NR]=$0}
        END{for(i=1;i+k-1<=NR;i++){ok=1; for(j=1;j<=k;j++) if(buf[i+j-1]!=L[j]){ok=0;break}; if(ok) exit 0} exit 1}' "$f"; then
        log "fixup already applied — $why"; return 0
    fi
    grep -qF -- "$old" "$f" || { warn "fixup ANCHOR NOT FOUND in $rel ($why) — upstream layout changed; review scripts/source-fixups.sh"; return 0; }
    local tmp; tmp="$(mktemp)"
    # Replace only the FIRST exact full-line match of $old with $new (literal).
    awk -v o="$old" -v n="$new" '!done && $0==o {print n; done=1; next} {print}' "$f" > "$tmp" && mv "$tmp" "$f"
    log "fixup applied — $why"
}
# Wrap a whole file region — from the line AFTER <anchor> to EOF — in
# `#if !defined(__wasi__)`, to drop code that can't exist on WASI (AF_UNIX
# sockets, etc.). Idempotent via a sentinel marker. Used for the handful of
# files the shim can't cover (genuine source-dispatch, like the old patch did).
fixup_wrap_eof() {
    local rel="$1" anchor="$2" why="$3"
    local f="$SRC_DIR/$rel"
    [ -f "$f" ] || { warn "fixup target missing: $rel ($why) — skipping"; return 0; }
    if grep -qF 'CWASM_WASI_WRAP' "$f"; then log "fixup already applied — $why"; return 0; fi
    grep -qF -- "$anchor" "$f" || { warn "fixup ANCHOR NOT FOUND in $rel ($why) — review scripts/source-fixups.sh"; return 0; }
    local tmp; tmp="$(mktemp)"
    awk -v a="$anchor" '
        { print }
        $0==a && !done { print "#if !defined(__wasi__) /* CWASM_WASI_WRAP */"; done=1 }
        END { print "#endif /* CWASM_WASI_WRAP */" }
    ' "$f" > "$tmp" && mv "$tmp" "$f"
    log "fixup applied (wrap→EOF) — $why"
}
apply_source_fixups() {
    # shellcheck source=source-fixups.sh
    [ -f "$SCRIPT_DIR/source-fixups.sh" ] || { warn "scripts/source-fixups.sh missing — no source fixups applied"; return 0; }
    . "$SCRIPT_DIR/source-fixups.sh"
    log "Applying source fixups (scripts/source-fixups.sh)…"
    source_fixups
}

# ── 1. Native tablegen (needed to cross-build LLVM to wasm) ────────────────
stage_tblgen() {
    need_stage tblgen || return 0
    local b="$BUILD_DIR/stage1-native"
    log "[1/5] Building native llvm-tblgen + clang-tblgen…"
    cmake -G Ninja -S "$LLVM_SRC/llvm" -B "$b" \
        -DCMAKE_BUILD_TYPE=Release \
        -DLLVM_ENABLE_PROJECTS="clang" \
        -DLLVM_TARGETS_TO_BUILD="WebAssembly" \
        -DCMAKE_C_COMPILER="$CC" -DCMAKE_CXX_COMPILER="$CXX" \
        -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF -DLLVM_ENABLE_LIBXML2=OFF
    ninja -C "$b" -j "$JOBS" llvm-tblgen clang-tblgen
    done_stage tblgen
}

# A tiny empty archive, passed as -DBUILTINS_LIB so wasi-libc's CMake does NOT
# download a prebuilt compiler-rt from wasi-sdk CI. With BUILD_SHARED=OFF and
# BUILD_TESTS=OFF nothing actually links it, so an empty stub is fine.
STUB_BUILTINS=""
make_stub_builtins() {
    STUB_BUILTINS="$BUILD_DIR/stub-builtins.a"
    [ -f "$STUB_BUILTINS" ] || "$(command -v "$AR")" rc "$STUB_BUILTINS" 2>/dev/null || true
}

# ── 2a. wasi-libc (CMake; modern layout include/<triple>, lib/<triple>) ───
# Static-only build archives .o — it does NOT need a working compiler-rt, so it
# runs BEFORE builtins and provides the headers (limits.h, …) builtins need.
build_wasi_libc() {
    local triple="$1" sysroot="$2"
    local b="$BUILD_DIR/wasi-libc-$triple"
    make_stub_builtins
    rm -rf "$b"                          # clean reconfigure (avoid stale cache)
    log "    wasi-libc → $triple"
    cmake -G Ninja -S "$WASI_LIBC_SRC" -B "$b" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_C_COMPILER="$CC" \
        -DCMAKE_AR="$(command -v "$AR")" \
        -DCMAKE_RANLIB="$(command -v "$RANLIB")" \
        -DTARGET_TRIPLE="$triple" \
        -DMALLOC=dlmalloc \
        -DBUILD_TESTS=OFF -DBUILD_SHARED=OFF \
        -DBUILTINS_LIB="$STUB_BUILTINS" \
        -DCMAKE_C_FLAGS="$NOWARN" \
        -DCMAKE_INSTALL_PREFIX="$sysroot"
    ninja -C "$b" -j "$JOBS"
    ninja -C "$b" install
}

# ── 2b. compiler-rt builtins (softfloat incl. binary128 → long double) ────
# Built AFTER wasi-libc, with --sysroot so clang's limits.h #include_next
# resolves to wasi-libc's headers (not the host glibc). Sets global BUILTINS_A.
BUILTINS_A=""
build_builtins() {
    local triple="$1" sysroot="$2"
    local b="$BUILD_DIR/builtins-$triple"
    local out="$b/libclang_rt.builtins.a"
    if [ -f "$out" ]; then BUILTINS_A="$out"; log "    builtins ($triple) cached"; return 0; fi
    rm -rf "$b"                          # clean reconfigure (avoid stale cache)
    log "    compiler-rt builtins → $triple (sysroot: $sysroot)"
    cmake -G Ninja -S "$LLVM_SRC/compiler-rt/lib/builtins" -B "$b" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_SYSTEM_NAME=WASI \
        -DCMAKE_C_COMPILER="$CC" \
        -DCMAKE_C_COMPILER_TARGET="$triple" \
        -DCMAKE_C_COMPILER_WORKS=ON \
        -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
        -DCMAKE_SYSROOT="$sysroot" \
        -DCMAKE_C_FLAGS="-O2 -isystem $sysroot/include/$triple $NOWARN" \
        -DCMAKE_AR="$(command -v "$AR")" \
        -DCMAKE_NM="$(command -v "$NM")" \
        -DCMAKE_RANLIB="$(command -v "$RANLIB")" \
        -DCOMPILER_RT_BAREMETAL_BUILD=ON \
        -DCOMPILER_RT_DEFAULT_TARGET_ONLY=ON
    ninja -C "$b" -j "$JOBS"
    local a; a="$(find "$b" -name 'libclang_rt.builtins*.a' | head -1)"
    [ -n "$a" ] || die "builtins archive not found for $triple (check $b)"
    cp "$a" "$out"
    BUILTINS_A="$out"
}

# ── 2c. libc++ / libc++abi for wasm32 (needed to HOST clang) ──────────────
build_host_cxx() {
    local triple="wasm32-wasi" sysroot="$HOST_SYSROOT"
    local b="$BUILD_DIR/hostcxx"
    log "    libc++/libc++abi → $triple (to host clang.wasm)"
    rm -rf "$b"                          # ensure flags below take effect on rerun
    cmake -G Ninja -S "$LLVM_SRC/runtimes" -B "$b" \
        -DCMAKE_BUILD_TYPE=Release \
        -DLLVM_ENABLE_RUNTIMES="libcxx;libcxxabi" \
        -DCMAKE_C_COMPILER="$CC" -DCMAKE_CXX_COMPILER="$CXX" \
        -DCMAKE_C_COMPILER_TARGET="$triple" -DCMAKE_CXX_COMPILER_TARGET="$triple" \
        -DCMAKE_C_COMPILER_WORKS=ON -DCMAKE_CXX_COMPILER_WORKS=ON \
        -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
        -DCMAKE_SYSROOT="$sysroot" \
        -DCMAKE_C_FLAGS="-isystem $sysroot/include/$triple $NOWARN" \
        -DCMAKE_CXX_FLAGS="-isystem $sysroot/include/$triple $NOWARN" \
        -DCMAKE_AR="$(command -v "$AR")" -DCMAKE_RANLIB="$(command -v "$RANLIB")" \
        -DCMAKE_INSTALL_PREFIX="$sysroot" \
        -DLIBCXX_ENABLE_THREADS=ON -DLIBCXXABI_ENABLE_THREADS=ON \
        -DLIBCXX_HAS_PTHREAD_API=ON -DLIBCXXABI_HAS_PTHREAD_API=ON \
        -DLIBCXX_ENABLE_SHARED=OFF -DLIBCXXABI_ENABLE_SHARED=OFF \
        -DLIBCXX_ENABLE_EXCEPTIONS=OFF -DLIBCXXABI_ENABLE_EXCEPTIONS=OFF \
        -DLIBCXX_ENABLE_FILESYSTEM=ON -DLIBCXX_ENABLE_LOCALIZATION=ON \
        -DLIBCXX_ENABLE_EXPERIMENTAL_LIBRARY=OFF \
        -DLIBCXX_ENABLE_TIME_ZONE_DATABASE=OFF \
        -DLIBCXX_CXX_ABI=libcxxabi \
        -DLIBCXXABI_USE_LLVM_UNWINDER=OFF
    # Build/install ONLY libc++.a + libc++abi.a (+ headers). Avoids the
    # cxx_experimental target, whose tzdb.cpp #errors on wasi (no IANA TZ path).
    ninja -C "$b" -j "$JOBS" cxx cxxabi
    ninja -C "$b" install-cxx install-cxxabi
}

stage_host_sysroot() {
    need_stage host-sysroot || return 0
    log "[2/5] Host (wasm32) C++ sysroot — to compile clang/lld to wasm…"
    mkdir -p "$HOST_SYSROOT"
    build_wasi_libc "wasm32-wasi" "$HOST_SYSROOT"                  # headers first
    build_builtins  "wasm32-wasi" "$HOST_SYSROOT"                  # sets BUILTINS_A
    mkdir -p "$HOST_SYSROOT/lib/wasm32-wasi"
    cp -f "$BUILTINS_A" "$HOST_SYSROOT/lib/wasm32-wasi/libclang_rt.builtins.a"
    build_host_cxx
    done_stage host-sysroot
}

# ── 3. Build clang + lld → wasm32-wasi ────────────────────────────────────
stage_clang_wasm() {
    need_stage clang-wasm || return 0
    local b="$BUILD_DIR/clang-wasm"
    local s1="$BUILD_DIR/stage1-native"
    log "[3/5] Building clang + lld → wasm32-wasi (default student target: $TARGET)…"

    # Assemble a resource-dir clang can use for the wasm32 target: its own
    # builtin headers + the compiler-rt builtins we built (clang looks for the
    # exact name libclang_rt.builtins-wasm32.a under <resource>/lib/wasi/).
    local RES="$HOST_SYSROOT/resource"
    local BWASM32="$BUILD_DIR/builtins-wasm32-wasi/libclang_rt.builtins.a"
    [ -f "$BWASM32" ] || die "wasm32 builtins missing ($BWASM32) — rerun host-sysroot stage"
    mkdir -p "$RES/lib/wasi"
    rm -f "$RES/include"; ln -s "$("$CC" -print-resource-dir)/include" "$RES/include"
    cp -f "$BWASM32" "$RES/lib/wasi/libclang_rt.builtins-wasm32.a"

    # Shim: LLVM's ADT/bit.h falls back to <machine/endian.h> on targets it
    # doesn't special-case (wasi among them). wasi-libc has no machine/endian.h,
    # but its <endian.h> defines BYTE_ORDER, so redirect to it.
    mkdir -p "$HOST_SYSROOT/include/wasm32-wasi/machine"
    echo '#include <endian.h>' > "$HOST_SYSROOT/include/wasm32-wasi/machine/endian.h"

    # Stub __cxa_thread_atexit_impl: libc++abi references it (its check wrongly
    # found it in libc), but wasi-libc has no such symbol. wasi is single-threaded
    # and the tools proc_exit without running atexit, so a no-op is correct.
    local CXA_STUB="$BUILD_DIR/cxa_thread_atexit_stub.o"
    echo 'int __cxa_thread_atexit_impl(void(*d)(void*),void*o,void*s){(void)d;(void)o;(void)s;return 0;}' > "$BUILD_DIR/cxa_stub.c"
    "$CC" --target=wasm32-wasi --sysroot="$HOST_SYSROOT" -resource-dir="$RES" $NOWARN -c "$BUILD_DIR/cxa_stub.c" -o "$CXA_STUB"

    # The emulated-* defines must be in BOTH C and C++ flags: CMake's
    # check_include_file(sys/mman.h …) compiles as C, and without the define
    # wasi-libc's <sys/mman.h> is empty → HAVE_SYS_MMAN_H=0 → Memory.inc/Path.inc
    # skip the include and PROT_*/mmap come up undeclared.
    local EMUL="-D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_GETPID"

    # WASI POSIX shim (replaces the old LLVM source patch): weak stubs for the
    # POSIX symbols wasi-libc lacks, plus a force-included header declaring them.
    local SHIM_O="$BUILD_DIR/wasi-posix-shim.o"
    "$CC" --target=wasm32-wasi --sysroot="$HOST_SYSROOT" -resource-dir="$RES" $EMUL $NOWARN \
          -I"$SHIM_DIR" -O2 -c "$SHIM_C" -o "$SHIM_O"

    # Linking clang.wasm needs: builtins (via resource-dir), libc++/libc++abi
    # (in $HOST_SYSROOT/lib), and the wasi emulated libs the defines below pull in.
    local LFLAGS="-resource-dir=$RES -L$HOST_SYSROOT/lib -L$HOST_SYSROOT/lib/wasm32-wasi $CXA_STUB $SHIM_O"
    LFLAGS="$LFLAGS -lwasi-emulated-mman -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-getpid"
    # -lsetjmp provides the wasm SjLj runtime (__wasm_setjmp/__wasm_longjmp/
    # __c_longjmp) that -mllvm -wasm-enable-sjlj makes CrashRecoveryContext call.
    LFLAGS="$LFLAGS -lsetjmp"
    LFLAGS="$LFLAGS -Wl,--stack-first -Wl,-z,stack-size=16777216 -Wl,--initial-memory=67108864"
    # -include wasi-posix-shim.h force-declares the missing POSIX APIs so LLVM's
    # generic Unix paths compile unpatched (the header self-guards on __wasi__).
    local SHIMF="-include $SHIM_H -I$SHIM_DIR"
    # LLVM 23's export-annotation macros (LLVM_ABI/CLANG_TEMPLATE_ABI…) are
    # selected by target: clang's Compiler.h tests `__WASM__` (uppercase) which
    # clang never defines for wasm (it defines `__wasm__`), so for our target
    # CLANG_TEMPLATE_ABI ends up UNDEFINED and `extern template class
    # CLANG_TEMPLATE_ABI Registry<…>` fails to parse. The static-build branch
    # (`#ifdef CLANG_BUILD_STATIC`) makes them all empty — which is correct for
    # our fully-static wasm libraries.
    local ABIDEF="-DLLVM_BUILD_STATIC -DCLANG_BUILD_STATIC"
    local CF="-resource-dir=$RES $EMUL $SHIMF $SJLJ $NOWARN $ABIDEF"
    local CXXF="-fno-exceptions -resource-dir=$RES $EMUL $SHIMF $SJLJ $NOWARN $ABIDEF"

    # NOTE: no rm -rf "$b" here — this is the multi-hour build; CMake
    # reconfigures in place and ninja resumes incrementally on re-runs.
    cmake -G Ninja -S "$LLVM_SRC/llvm" -B "$b" \
        -DCMAKE_BUILD_TYPE=MinSizeRel \
        -DCMAKE_SYSTEM_NAME=WASI -DCMAKE_SYSTEM_VERSION=1 \
        -DUNIX=1 \
        -DCMAKE_C_COMPILER="$CC" -DCMAKE_CXX_COMPILER="$CXX" \
        -DCMAKE_C_COMPILER_TARGET="wasm32-wasi" \
        -DCMAKE_CXX_COMPILER_TARGET="wasm32-wasi" \
        -DCMAKE_SYSROOT="$HOST_SYSROOT" \
        -DCMAKE_C_FLAGS="$CF" \
        -DCMAKE_CXX_FLAGS="$CXXF" \
        -DCMAKE_EXE_LINKER_FLAGS="$LFLAGS" \
        -DLLVM_TABLEGEN="$s1/bin/llvm-tblgen" \
        -DCLANG_TABLEGEN="$s1/bin/clang-tblgen" \
        -DLLVM_ENABLE_PROJECTS="clang;lld" \
        -DLLVM_TARGETS_TO_BUILD="WebAssembly" \
        -DLLVM_DEFAULT_TARGET_TRIPLE="$TARGET" \
        -DLLVM_HOST_TRIPLE="wasm32-wasi" \
        -DLLVM_ENABLE_THREADS=OFF -DLLVM_ENABLE_PIC=OFF \
        -DLLVM_ENABLE_ZLIB=OFF -DLLVM_ENABLE_ZSTD=OFF -DLLVM_ENABLE_LIBXML2=OFF \
        -DLLVM_ENABLE_TERMINFO=OFF -DLLVM_ENABLE_LIBEDIT=OFF \
        -DLLVM_ENABLE_EH=OFF -DLLVM_ENABLE_RTTI=OFF \
        -DLLVM_BUILD_TOOLS=OFF -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF \
        -DLLVM_INCLUDE_BENCHMARKS=OFF \
        -DLLVM_ENABLE_CRASH_OVERRIDES=OFF -DLLVM_ENABLE_BACKTRACES=OFF \
        -DCLANG_ENABLE_ARCMT=OFF -DCLANG_ENABLE_STATIC_ANALYZER=OFF \
        -DCLANG_HAVE_RLIMITS=0 \
        -DLLVM_ENABLE_PLUGINS=OFF \
        -DCLANG_SPAWN_CC1=OFF
    # Separate binaries (standard ninja targets). lld is the multicall linker
    # driver; invoked with argv[0]=wasm-ld (the worker does this) it links wasm.
    # CLANG_SPAWN_CC1=OFF → clang runs cc1 in-process, so a one-shot `clang -c`
    # needs no fork/exec (which wasi lacks).
    ninja -C "$b" -j "$JOBS" clang lld

    mkdir -p "$ASSETS_DIR"
    cp -v "$b/bin/clang" "$ASSETS_DIR/clang.wasm"
    cp -v "$b/bin/lld"   "$ASSETS_DIR/lld.wasm"
    done_stage clang-wasm
}

# ── 4. Target (wasm64) sysroot for student programs → sysroot.tar ─────────
stage_target_sysroot() {
    need_stage target-sysroot || return 0
    log "[4/5] Student target sysroot ($TARGET) — C, with long double (binary128)…"
    mkdir -p "$TARGET_SYSROOT"
    build_wasi_libc "$TARGET" "$TARGET_SYSROOT"                    # headers first
    build_builtins  "$TARGET" "$TARGET_SYSROOT"                    # sets BUILTINS_A

    # Assemble a FLAT sysroot the worker mounts at /sysroot:
    #   /sysroot/include/*                 (wasi-libc headers, flattened)
    #   /sysroot/lib/<triple>/*            (libc.a, crt1.o, libc-printscan-long-double.a, builtins)
    #   /sysroot/clang/include/*           (clang resource headers → -resource-dir=/sysroot/clang)
    local PKG="$BUILD_DIR/sysroot-pkg-$TARGET"
    rm -rf "$PKG"; mkdir -p "$PKG/include" "$PKG/lib/$TARGET" "$PKG/clang"

    cp -a "$TARGET_SYSROOT/include/$TARGET/." "$PKG/include/"      # flatten include/<triple> → include/
    cp -a "$TARGET_SYSROOT/lib/$TARGET/."     "$PKG/lib/$TARGET/"
    cp -f "$BUILTINS_A" "$PKG/lib/$TARGET/libclang_rt.builtins.a"

    # Guarantee a crt1.o (older name) exists for the linker invocation.
    if [ ! -f "$PKG/lib/$TARGET/crt1.o" ] && [ -f "$PKG/lib/$TARGET/crt1-command.o" ]; then
        cp -f "$PKG/lib/$TARGET/crt1-command.o" "$PKG/lib/$TARGET/crt1.o"
    fi

    # clang builtin headers (stddef.h, stdarg.h, float.h, …) MUST match the
    # clang.wasm version (23.x), NOT the apt bootstrap (clang-19). Generate them
    # from the 23 build itself via the host-side `clang-resource-headers` target
    # (arch-independent: it just assembles clang's own headers), then copy that
    # versioned dir. Fall back to the bootstrap clang's resource dir only if the
    # clang-wasm build tree is missing (keeps the stage runnable in isolation).
    local cw="$BUILD_DIR/clang-wasm" clang_inc=""
    if [ -d "$cw" ]; then
        ninja -C "$cw" clang-resource-headers >/dev/null 2>&1 || true
        clang_inc="$(ls -d "$cw"/lib/clang/*/include 2>/dev/null | head -1)"
    fi
    [ -n "$clang_inc" ] && [ -d "$clang_inc" ] || clang_inc="$("$CC" -print-resource-dir)/include"
    [ -d "$clang_inc" ] || die "clang resource headers not found at $clang_inc"
    cp -a "$clang_inc" "$PKG/clang/include"

    mkdir -p "$ASSETS_DIR"
    log "    packing sysroot.tar…"
    tar -C "$PKG" -cf "$ASSETS_DIR/sysroot.tar" .
    echo "    sysroot.tar: $(du -h "$ASSETS_DIR/sysroot.tar" | cut -f1)"
    done_stage target-sysroot
}

# Newest C standard the host clang accepts. clang.wasm is the same LLVM release
# as $CC, so its front-end accepts the same -std values — probing the host is
# equivalent and needs no WASI runtime. Speculative future tags (gnu2z) are
# tried first so a newer toolchain auto-adopts a newer default with no edit;
# unknown tags are rejected by clang and skipped. Fallback: gnu23.
detect_default_std() {
    local s
    for s in gnu2z gnu2y gnu23 gnu17 gnu11 gnu99; do
        if printf 'int main(void){return 0;}\n' \
             | "$CC" -std="$s" -fsyntax-only -xc - >/dev/null 2>&1; then
            printf '%s' "$s"; return 0
        fi
    done
    printf 'gnu23'
}

# ── 5. Compress + manifest ────────────────────────────────────────────────
stage_package() {
    need_stage package || return 0
    log "[5/5] Compressing assets (brotli + gzip) and writing manifest…"
    for f in "$ASSETS_DIR"/clang.wasm "$ASSETS_DIR"/lld.wasm "$ASSETS_DIR"/sysroot.tar; do
        [ -f "$f" ] || { warn "missing asset $f (did an earlier stage fail?)"; continue; }
        local name; name="$(basename "$f")"
        command -v brotli >/dev/null && brotli -q 11 -f -o "$f.br" "$f"
        gzip -9 -k -f "$f"
        printf '    %-14s %s → %s (br) / %s (gz)\n' "$name" \
            "$(du -h "$f" | cut -f1)" \
            "$(du -h "$f.br" 2>/dev/null | cut -f1)" \
            "$(du -h "$f.gz" | cut -f1)"
    done

    local DEFSTD; DEFSTD="$(detect_default_std)"
    log "    default C std: $DEFSTD (newest -std the toolchain accepts)"
    local M="$ASSETS_DIR/manifest.json"
    {
        echo "{"
        echo "  \"target\": \"$TARGET\","
        echo "  \"llvm\": \"$LLVM_SRC_TAG\","
        echo "  \"defaultStd\": \"$DEFSTD\","
        # Uncompressed byte sizes → used by the widget to show an accurate
        # download percentage (assets are served br/gz, so Content-Length is
        # the compressed size).
        printf '  "sizes": { '
        local sfirst=1
        for f in "$ASSETS_DIR"/clang.wasm "$ASSETS_DIR"/lld.wasm "$ASSETS_DIR"/sysroot.tar; do
            [ -f "$f" ] || continue
            [ "$sfirst" -eq 0 ] && printf ', '
            printf '"%s": %s' "$(basename "$f")" "$(stat -c%s "$f")"
            sfirst=0
        done
        printf ' },\n'
        echo "  \"built\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
        echo "  \"assets\": {"
        local first=1
        for f in "$ASSETS_DIR"/clang.wasm "$ASSETS_DIR"/lld.wasm "$ASSETS_DIR"/sysroot.tar; do
            [ -f "$f" ] || continue
            [ "$first" -eq 0 ] && echo ","
            printf '    "%s": "%s"' "$(basename "$f")" "$(sha256sum "$f" | cut -d' ' -f1)"
            first=0
        done
        echo ""
        echo "  }"
        echo "}"
    } > "$M"
    done_stage package
}

LLVM_SRC_TAG="$(git -C "$LLVM_SRC" describe --tags 2>/dev/null || echo unknown)"

# ── Run pipeline ──────────────────────────────────────────────────────────
mkdir -p "$BUILD_DIR" "$ASSETS_DIR"
check_deps
apply_source_fixups
stage_tblgen
stage_host_sysroot
stage_clang_wasm
stage_target_sysroot
stage_package

log "Build complete."
echo ""
echo "    Assets: $ASSETS_DIR"
ls -lh "$ASSETS_DIR" 2>/dev/null | sed 's/^/    /'
echo ""
echo "  Deploy: copy cwasm/ to the web root. Production MUST serve with"
echo "  COOP/COEP (crossOriginIsolated) so SharedArrayBuffer works:"
echo "      Cross-Origin-Opener-Policy: same-origin"
echo "      Cross-Origin-Embedder-Policy: require-corp   (or credentialless)"
echo "  Test page: disciplines/ine5201/C/INE5201_13_cwasm.html  (needs"
echo "  Chrome ~133+ / recent Firefox for wasm64 memory64)."
