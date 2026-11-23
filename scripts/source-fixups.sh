# ──────────────────────────────────────────────────────────────────────────
# source-fixups.sh — the registry of surgical, anchor-based source edits
# applied to the freshly-cloned upstream trees under .src/ (LLVM, wasi-libc).
#
# This is the "memory" of per-upstream tweaks. We do NOT patch the LLVM source
# for the WASI POSIX gaps (that's the shim in scripts/shim/). A handful of
# genuine source-dispatch points can't be shimmed — those live here. Each entry:
#   • targets ONE exact line (literal, not a context diff), so it survives
#     version bumps as long as that stable line exists;
#   • is idempotent — re-applies cleanly after `rm -rf .src && install-deps.sh`,
#     no-ops if already applied, and WARNs (never silently) if the anchor is gone;
#   • documents the upstream version it was needed for and why.
#
# `fixup_line` is defined in build-toolchain.sh:
#   fixup_line <relpath-under-.src> <exact-old-line> <exact-new-line> <why>
# ──────────────────────────────────────────────────────────────────────────

source_fixups() {

    # [libc++ locale backend] — needed since: LLVM 23.1.x  ·  wasi-libc: wasi-sdk-34
    # LLVM's libc++ has no WASI locale backend, so wasi falls to the legacy
    # `ibm.h` bridge, which re-declares strtod_l/strtof_l/strtold_l/vasprintf —
    # the same functions wasi-libc (sdk-34) declares under _GNU_SOURCE → build
    # fails with "cannot add 'abi_tag' attribute in a redeclaration". wasi-libc
    # is musl-derived, so route wasi to the modern `support/linux.h` backend.
    fixup_line "llvm-project/libcxx/include/__locale_dir/locale_base_api.h" \
        '#  elif defined(__linux__)' \
        '#  elif defined(__linux__) || defined(__wasi__)' \
        "libc++: route WASI locale backend to support/linux.h"

    # [raw_socket_stream] — needed since: LLVM 23.1.x
    # AF_UNIX sockets (socket/bind/listen/connect, sockaddr_un.sun_path) don't
    # exist on WASI and can't be shimmed (struct member + many syscalls). The
    # whole file is networking LLVM doesn't use in clang/lld on wasi, so wrap it
    # out from `using namespace llvm;` to EOF — same as the old patch did.
    fixup_wrap_eof "llvm-project/llvm/lib/Support/raw_socket_stream.cpp" \
        'using namespace llvm;' \
        "raw_socket_stream: AF_UNIX unsupported on WASI"

    # [Path.inc is_local] — needed since: LLVM 23.1.x
    # is_local_impl() reads `struct statvfs`.f_flags, which wasi-libc's statvfs
    # lacks. Add a WASI branch that returns early (no remote mounts on WASI),
    # before the f_flags access — mirrors the __EMSCRIPTEN__ branch just below.
    fixup_line "llvm-project/llvm/lib/Support/Unix/Path.inc" \
        '#elif defined(__EMSCRIPTEN__)' \
        '#elif defined(__wasi__)
  return true;
#elif defined(__EMSCRIPTEN__)' \
        "Path.inc is_local: WASI has no statvfs.f_flags / remote mounts"

    # [Program.inc ru_maxrss] — needed since: LLVM 23.1.x
    # Wait()'s ProcessStatistics reads rusage.ru_maxrss, which wasi-libc's rusage
    # lacks. Exclude that one line on WASI (PeakMemory stays 0); mirrors the
    # existing __HAIKU__/__MVS__ exclusion right there.
    fixup_line "llvm-project/llvm/lib/Support/Unix/Program.inc" \
        '#if !defined(__HAIKU__) && !defined(__MVS__)' \
        '#if !defined(__HAIKU__) && !defined(__MVS__) && !defined(__wasi__)' \
        "Program.inc: WASI rusage has no ru_maxrss"

    # Add further fixups here as new upstream versions surface them. Keep each to
    # ONE exact line and note the version it was first needed for.

}
