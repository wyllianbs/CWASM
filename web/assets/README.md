# web/assets/

This folder is **populated by the build** — the binaries are not tracked in git
(see `.gitignore` at the root). To fill it, pick **one** of the options:

### Option A — build from source
```bash
./scripts/install-deps.sh      # resolve and download LLVM (latest stable) + wasi-libc
./scripts/build-toolchain.sh   # produce the binaries below (long: hours, tens of GB)
```

### Option B — use prebuilt binaries
Place prebuilt `clang.wasm`, `lld.wasm`, `sysroot.tar` (and their `.br`/`.gz`) here.

## Expected files
| file | what it is |
|---|---|
| `clang.wasm` | the C compiler (clang/cc1) running as WebAssembly |
| `lld.wasm` | the linker (`wasm-ld`) |
| `sysroot.tar` | target headers + libs (wasi-libc, compiler-rt, long double) |
| `*.br` / `*.gz` | precompressed variants (brotli / gzip) for static serving |
| `manifest.json` | **tracked** — pins the target, LLVM version, `defaultStd`, and expected sha256 |

`manifest.json` stays in the repository as a reference to the tested version;
`worker.js` reads it at runtime (compile target and default C standard).
