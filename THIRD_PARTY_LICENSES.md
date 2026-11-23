# Third-party licenses

The code in this repository is MIT (see `LICENSE`). The **binaries** produced by
the build and distributed via GitHub Releases (`clang.wasm`, `lld.wasm`,
`sysroot.tar`) are derivative works of third-party projects and remain under
their original licenses. When redistributing those binaries, include the notices
below.

## LLVM / Clang / LLD
- `clang.wasm` and `lld.wasm` are compiled from the **LLVM Project** source
  (clang + lld).
- License: **Apache License v2.0 with LLVM Exceptions**.
- Text: https://github.com/llvm/llvm-project/blob/main/LICENSE.TXT

## wasi-libc
- `sysroot.tar` packages **wasi-libc** (pinned at `wasi-sdk-34`).
- wasi-libc aggregates code under **Apache-2.0 WITH LLVM-exception**, **Apache-2.0**,
  and permissive third-party licenses (musl/BSD/MIT for derived parts).
- Texts: https://github.com/WebAssembly/wasi-libc/tree/main/LICENSE

## compiler-rt (builtins)
- `sysroot.tar` also includes the **compiler-rt builtins** (e.g. binary128
  softfloat for `long double`), part of the LLVM Project.
- License: **Apache License v2.0 with LLVM Exceptions** (same as LLVM above).

---
None of the components above belong to this repository's author; the credits and
licenses are those of the respective projects. This file documents provenance
for compliance when redistributing the binaries.
