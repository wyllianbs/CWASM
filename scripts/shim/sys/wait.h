/* ──────────────────────────────────────────────────────────────────────────
 * sys/wait.h — shim header. wasi-libc has no <sys/wait.h> (no processes), but
 * LLVM's llvm/lib/Support/Unix/Unix.h includes it unconditionally. Provided via
 * the shim include dir (scripts/shim is on the build's -I path) so that include
 * resolves. The declared functions are reaped by the weak stubs in
 * wasi-posix-shim.c; the W* macros let process-status code compile.
 * ────────────────────────────────────────────────────────────────────────── */
#ifndef CWASM_SHIM_SYS_WAIT_H
#define CWASM_SHIM_SYS_WAIT_H
#if defined(__wasi__)

#include <sys/types.h>

#ifdef __cplusplus
extern "C" {
#endif

pid_t wait(int *);
pid_t waitpid(pid_t, int *, int);
pid_t wait4(pid_t, int *, int, void *);   /* 4th arg struct rusage*, opaque here */

#ifndef WNOHANG
#define WNOHANG   1
#define WUNTRACED 2
#endif
#ifndef WIFEXITED
#define WIFEXITED(s)   (((s) & 0x7f) == 0)
#define WEXITSTATUS(s) (((s) >> 8) & 0xff)
#define WTERMSIG(s)    ((s) & 0x7f)
#define WIFSIGNALED(s) ((((signed char)(((s) & 0x7f) + 1)) >> 1) > 0)
#define WIFSTOPPED(s)  (((s) & 0xff) == 0x7f)
#define WSTOPSIG(s)    WEXITSTATUS(s)
#endif

#ifdef __cplusplus
}
#endif

#endif /* __wasi__ */
#endif /* CWASM_SHIM_SYS_WAIT_H */
