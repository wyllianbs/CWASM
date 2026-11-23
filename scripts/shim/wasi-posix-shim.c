/* ──────────────────────────────────────────────────────────────────────────
 * wasi-posix-shim.c — weak stub DEFINITIONS of the POSIX functions LLVM's Unix
 * code references but wasi-libc does not implement. Linked into clang.wasm.
 *
 * Every stub is WEAK: if wasi-libc provides the real symbol, the real (strong)
 * one wins and the stub is ignored — so this object is always safe to link.
 * Stubs are no-ops / error returns; clang's `-c` (cc1 in-process) never forks,
 * signals, mmap-protects, reaps processes, or reads the password DB.
 *
 * This file is intentionally SELF-CONTAINED: it includes only <errno.h>,
 * <stddef.h> and <sys/types.h>, NOT the real POSIX headers nor the shim header.
 * All pointer parameters are `void *`. C has no name mangling, so the linker
 * resolves LLVM's calls by symbol name regardless of these signatures, and
 * because we never include signal.h/fcntl.h/pwd.h here, nothing can clash.
 * ────────────────────────────────────────────────────────────────────────── */
#if defined(__wasi__)

#include <errno.h>
#include <stddef.h>
#include <sys/types.h>

#define WEAK __attribute__((weak))

/* process control (no processes on WASI) */
WEAK pid_t fork(void)                              { errno = ENOSYS; return -1; }
WEAK pid_t vfork(void)                             { errno = ENOSYS; return -1; }
WEAK int   execv(const char *p, char *const a[])   { (void)p;(void)a; errno = ENOSYS; return -1; }
WEAK int   execve(const char *p, char *const a[], char *const e[]) { (void)p;(void)a;(void)e; errno = ENOSYS; return -1; }
WEAK int   execvp(const char *p, char *const a[])  { (void)p;(void)a; errno = ENOSYS; return -1; }
WEAK pid_t wait(int *s)                            { (void)s; errno = ENOSYS; return -1; }
WEAK pid_t wait4(pid_t pid, int *s, int o, void *r){ (void)pid;(void)s;(void)o;(void)r; errno = ENOSYS; return -1; }
WEAK pid_t waitpid(pid_t pid, int *s, int o)       { (void)pid;(void)s;(void)o; errno = ENOSYS; return -1; }
/* libc++abi here has no __cxa_thread_atexit (only …_impl, which the build
   stubs separately). Thread-local dtors never run before proc_exit on wasi. */
WEAK int __cxa_thread_atexit(void (*f)(void *), void *o, void *d) { (void)f;(void)o;(void)d; return 0; }
WEAK int   pipe(int fds[2])                        { (void)fds; errno = ENOSYS; return -1; }
WEAK int   dup2(int a, int b)                      { (void)a;(void)b; errno = ENOSYS; return -1; }
WEAK unsigned int alarm(unsigned int s)            { (void)s; return 0; }
WEAK int   kill(pid_t p, int s)                    { (void)p;(void)s; errno = ENOSYS; return -1; }
WEAK int   killpg(pid_t g, int s)                  { (void)g;(void)s; errno = ENOSYS; return -1; }
WEAK pid_t getsid(pid_t p)                         { (void)p; return 0; }
WEAK pid_t setsid(void)                            { errno = ENOSYS; return -1; }
WEAK int   dladdr(const void *a, void *info)       { (void)a;(void)info; return 0; }
WEAK uid_t getuid(void)                            { return 0; }
WEAK uid_t geteuid(void)                           { return 0; }
WEAK gid_t getgid(void)                            { return 0; }
WEAK gid_t getegid(void)                           { return 0; }

/* signals — no-op (WASI has no signal delivery). void* avoids header deps */
WEAK int sigaction(int n, const void *a, void *o)  { (void)n;(void)a;(void)o; return 0; }
WEAK int sigaltstack(const void *ss, void *old)    { (void)ss;(void)old; return 0; }
WEAK int sigemptyset(void *s)                      { (void)s; return 0; }
WEAK int sigfillset(void *s)                       { (void)s; return 0; }
WEAK int sigaddset(void *s, int n)                 { (void)s;(void)n; return 0; }
WEAK int sigdelset(void *s, int n)                 { (void)s;(void)n; return 0; }
WEAK int sigismember(const void *s, int n)         { (void)s;(void)n; return 0; }
WEAK int sigprocmask(int h, const void *s, void *o){ (void)h;(void)s;(void)o; return 0; }
WEAK char *strsignal(int s)                        { (void)s; return (char *)"unknown signal"; }

/* memory protection — wasm memory is always rw; report unsupported */
WEAK int mprotect(void *a, size_t l, int p)        { (void)a;(void)l;(void)p; errno = ENOSYS; return -1; }
WEAK int madvise(void *a, size_t l, int adv)       { (void)a;(void)l;(void)adv; return 0; }
WEAK int posix_madvise(void *a, size_t l, int adv) { (void)a;(void)l;(void)adv; return 0; }

/* resource limits / usage */
WEAK int getrusage(int who, void *ru)              { (void)who;(void)ru; return 0; }
WEAK int getrlimit(int res, void *rlim)            { (void)res;(void)rlim; return 0; }
WEAK int setrlimit(int res, const void *rlim)      { (void)res;(void)rlim; return 0; }

/* misc file ops */
WEAK int fchown(int fd, uid_t u, gid_t g)          { (void)fd;(void)u;(void)g; errno = ENOTSUP; return -1; }
WEAK mode_t umask(mode_t m)                        { (void)m; return 0022; }

/* password database — none on WASI */
WEAK void *getpwuid(uid_t u)                        { (void)u; return NULL; }
WEAK void *getpwnam(const char *n)                  { (void)n; return NULL; }
WEAK int   getpwuid_r(uid_t u, void *p, char *b, size_t n, void **r) {
    (void)u;(void)p;(void)b;(void)n; if (r) *r = NULL; return 0;
}
WEAK int   getpwnam_r(const char *nm, void *p, char *b, size_t n, void **r) {
    (void)nm;(void)p;(void)b;(void)n; if (r) *r = NULL; return 0;
}

#endif /* __wasi__ */
