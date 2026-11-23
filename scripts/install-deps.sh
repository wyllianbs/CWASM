#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# install-deps.sh — Dependencies for the cwasm C→WASM64 toolchain build
#
# Reproducible on Debian Trixie (local) and Ubuntu 24.04 LTS (VPS).
# Installs host packages (apt) and fetches the PINNED sources that
# build-toolchain.sh compiles entirely from source. No prebuilt wasm
# toolchain is used — not wasi-sdk, not binji's wasm-clang.
#
# Usage:
#   ./scripts/install-deps.sh            # apt install + fetch sources
#   ./scripts/install-deps.sh --no-apt   # only fetch/verify sources
#   ./scripts/install-deps.sh --apt-only # only install host packages
#
# What it guarantees:
#   • HOST LLVM 23.1.6 (official prebuilt, downloaded to .src/llvm-host) — the
#     bootstrap AND the wasm cross-compiler, both LLVM 23, no apt clang needed
#   • cmake, ninja, build-essential, git, curl, brotli, gzip, tar, xz, python3
#     (apt); apt clang-19/lld-19/llvm-19 only as an optional fallback bootstrap
#   • llvm-project source tracking the LATEST STABLE llvmorg-* release
#     (resolved at run time; no source patch — WASI gaps filled by a sysroot
#     shim + CMake flags in build-toolchain.sh). Override with LLVM_TAG=… or
#     stay in a series with LLVM_SERIES=23.1
#   • wasi-libc  pinned at wasi-sdk-34  (newest; wasm32-only ABI — no wasm64)
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SRC_DIR="$PROJECT_DIR/.src"          # pinned upstream sources live here

# ── LLVM version ──────────────────────────────────────────────────────────
# No fixed pin: we track the LATEST STABLE llvmorg-* release, resolved at run
# time (resolve_llvm_tag). This is possible because the build no longer patches
# the LLVM source — the WASI POSIX gaps are filled by a sysroot shim + CMake
# flags (see build-toolchain.sh), which are version-independent. Override by
# exporting LLVM_TAG=llvmorg-X.Y.Z before running, or pin LLVM_SERIES to stay
# in a series (e.g. "23.1" → newest 23.1.z only).
LLVM_REPO="https://github.com/llvm/llvm-project.git"
LLVM_SERIES="${LLVM_SERIES:-}"          # empty = any major; e.g. "23.1" to pin a series
LLVM_TAG="${LLVM_TAG:-}"                 # empty = resolve latest stable below
LLVM_COMMIT=""                           # resolved alongside LLVM_TAG
LLVM_FALLBACK_TAG="llvmorg-23.1.6"       # used only if the tag list can't be fetched

# Resolve the newest stable llvmorg release (optionally within $LLVM_SERIES).
# Excludes -rc/-init prereleases. Sets LLVM_TAG and LLVM_COMMIT (the commit the
# annotated tag dereferences to, tag^{}, which is what actually gets checked out).
resolve_llvm_tag() {
    [ -n "$LLVM_TAG" ] && return 0        # explicit override wins
    local pat raw
    pat="llvmorg-${LLVM_SERIES:+${LLVM_SERIES}.}*"
    raw="$(git ls-remote --tags "$LLVM_REPO" "$pat" 2>/dev/null)" || raw=""
    LLVM_TAG="$(printf '%s\n' "$raw" \
        | sed -n 's#.*refs/tags/\(llvmorg-[0-9][0-9.]*\)$#\1#p' \
        | sort -V | tail -1)"
    if [ -z "$LLVM_TAG" ]; then
        warn "could not resolve latest stable tag (offline?) — using $LLVM_FALLBACK_TAG"
        LLVM_TAG="$LLVM_FALLBACK_TAG"
    fi
    LLVM_COMMIT="$(printf '%s\n' "$raw" | awk -v t="refs/tags/${LLVM_TAG}^{}" '$2==t{print $1}')"
    log "LLVM: tracking $LLVM_TAG${LLVM_COMMIT:+ (commit ${LLVM_COMMIT:0:12})}"
}

WASI_LIBC_TAG="wasi-sdk-34"
WASI_LIBC_REPO="https://github.com/WebAssembly/wasi-libc.git"

# Host bootstrap toolchain: the OFFICIAL LLVM Linux x86_64 prebuilt
# (clang/clang++/lld/llvm-ar…, WebAssembly backend included), tracking the SAME
# version we resolve for the source (fetch_host_llvm derives it from LLVM_TAG).
# Downloaded, not apt — so bootstrap AND wasm cross-compiler are both that LLVM.
# build-toolchain.sh auto-prefers it; if the prebuilt for that exact point
# release isn't published, we fall back to the apt clang (non-fatal).
LLVM_HOST_DIR="$SRC_DIR/llvm-host"
# Optional integrity pin: fill with the official sha256 to verify the download
# (leave empty to skip). After the first run: sha256sum on the .tar.xz.
LLVM_HOST_SHA256=""

DO_APT=1
DO_SRC=1
for arg in "$@"; do
    case "$arg" in
        --no-apt)   DO_APT=0 ;;
        --apt-only) DO_SRC=0 ;;
        -h|--help)  grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. Host packages (apt) ────────────────────────────────────────────────
# The HOST compiler is the downloaded LLVM 23 prebuilt (see fetch_host_llvm),
# so apt only needs the build tooling. clang-19/lld-19/llvm-19 are a best-effort
# fallback bootstrap (used only if the prebuilt is missing); they are NOT
# required, so a distro without clang-19 (e.g. Ubuntu 24.04, which ships
# clang-18) is fine — no apt.llvm.org repo needed.
APT_REQUIRED=(
    cmake ninja-build build-essential
    python3 git curl ca-certificates
    brotli gzip tar xz-utils
    zlib1g-dev libzstd-dev        # LLVM host-build deps
)
APT_OPTIONAL=( clang-19 lld-19 llvm-19 )   # fallback bootstrap only

install_apt() {
    command -v apt-get >/dev/null 2>&1 || { warn "apt-get not found — skipping package install (install the equivalents manually)"; return; }

    . /etc/os-release 2>/dev/null || true
    log "Host: ${PRETTY_NAME:-unknown}"

    log "Installing required host packages via apt…"
    sudo apt-get update
    sudo apt-get install -y "${APT_REQUIRED[@]}"

    # Optional clang-19 fallback — best effort, never fatal (the real host is
    # the prebuilt LLVM 23 downloaded by fetch_host_llvm).
    sudo apt-get install -y "${APT_OPTIONAL[@]}" 2>/dev/null \
        || warn "clang-19 fallback not installed (fine — host bootstrap is the prebuilt LLVM 23)."
}

# ── 2. Pinned sources (git, shallow, at exact ref) ────────────────────────
fetch_pinned() {
    local name="$1" repo="$2" ref="$3" dir="$4" expect_commit="${5:-}"
    if [ -d "$dir/.git" ]; then
        local have; have="$(git -C "$dir" rev-parse HEAD 2>/dev/null || echo '')"
        if [ -n "$expect_commit" ] && [ "$have" != "$expect_commit" ]; then
            warn "$name at ${have:0:12} but pin expects ${expect_commit:0:12} — re-cloning"
            rm -rf "$dir"
            git clone --depth 1 --branch "$ref" "$repo" "$dir"
        else
            log "$name already present at ${have:0:12} (ref $ref) — skipping clone"
        fi
    else
        log "Cloning $name @ $ref (shallow)…"
        git clone --depth 1 --branch "$ref" "$repo" "$dir"
    fi
    if [ -n "$expect_commit" ]; then
        local head; head="$(git -C "$dir" rev-parse HEAD)"
        if [ "$head" != "$expect_commit" ]; then
            warn "$name HEAD $head != pinned $expect_commit (tag may have moved — verify intentionally)"
        else
            log "$name commit verified: $head"
        fi
    fi
}

# ── 2b. Host LLVM 23 prebuilt (official binaries, used as the bootstrap) ──
fetch_host_llvm() {
    if [ -x "$LLVM_HOST_DIR/bin/clang" ]; then
        log "host LLVM already present: $("$LLVM_HOST_DIR/bin/clang" --version | head -1)"
        return
    fi
    command -v curl >/dev/null 2>&1 || { warn "curl not found — skipping host LLVM (apt clang is the fallback)"; return 0; }
    command -v xz   >/dev/null 2>&1 || { warn "xz not found — skipping host LLVM (apt clang is the fallback)"; return 0; }
    # Track the resolved source version (bootstrap == source version).
    local ver asset url
    ver="${LLVM_TAG#llvmorg-}"
    asset="LLVM-${ver}-Linux-X64.tar.xz"
    url="https://github.com/llvm/llvm-project/releases/download/${LLVM_TAG}/${asset}"
    mkdir -p "$SRC_DIR"
    local tmp="$SRC_DIR/.llvm-host-dl"
    rm -rf "$tmp"; mkdir -p "$tmp"
    log "Downloading host LLVM $ver prebuilt (official, large ~1–2 GB)…"
    if ! curl -fL --retry 3 -o "$tmp/$asset" "$url"; then
        warn "host LLVM prebuilt not available for $LLVM_TAG ($url) — falling back to apt clang."
        rm -rf "$tmp"; return 0
    fi
    if [ -n "$LLVM_HOST_SHA256" ]; then
        echo "$LLVM_HOST_SHA256  $tmp/$asset" | sha256sum -c - \
            || die "sha256 mismatch for $asset"
    else
        warn "LLVM_HOST_SHA256 empty — skipping integrity check (set it to pin)."
    fi
    log "Extracting $asset…"
    tar -C "$tmp" -xf "$tmp/$asset"
    local top; top="$(find "$tmp" -maxdepth 1 -type d -name 'LLVM-*' | head -1)"
    [ -n "$top" ] && [ -x "$top/bin/clang" ] || { warn "unexpected archive layout — falling back to apt clang."; rm -rf "$tmp"; return 0; }
    rm -rf "$LLVM_HOST_DIR"; mv "$top" "$LLVM_HOST_DIR"
    rm -rf "$tmp"
    log "host LLVM ready: $("$LLVM_HOST_DIR/bin/clang" --version | head -1)"
    for t in clang clang++ wasm-ld llvm-ar llvm-nm llvm-ranlib; do
        [ -x "$LLVM_HOST_DIR/bin/$t" ] || warn "host LLVM missing bin/$t"
    done
}

install_src() {
    mkdir -p "$SRC_DIR"
    resolve_llvm_tag
    fetch_pinned "llvm-project" "$LLVM_REPO" "$LLVM_TAG" "$SRC_DIR/llvm-project" "$LLVM_COMMIT"
    fetch_pinned "wasi-libc"    "$WASI_LIBC_REPO" "$WASI_LIBC_TAG" "$SRC_DIR/wasi-libc"
    fetch_host_llvm
}

# ── Run ───────────────────────────────────────────────────────────────────
[ "$DO_APT" -eq 1 ] && install_apt
[ "$DO_SRC" -eq 1 ] && install_src

log "Dependencies ready. Next: ./scripts/build-toolchain.sh"
