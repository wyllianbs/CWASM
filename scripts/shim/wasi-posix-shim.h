/* ──────────────────────────────────────────────────────────────────────────
 * wasi-posix-shim.h — force-included (-include) into the clang+lld→wasm build.
 *
 * Replaces the old LLVM source patch. wasi-libc hides the POSIX surface it does
 * not support behind `#ifdef __wasilibc_unmodified_upstream` (a macro it never
 * defines) — so struct sigaction/siginfo_t, struct rlimit/RLIMIT_*, getsid,
 * sigemptyset/… are present in its headers but permanently INACTIVE. We declare
 * them here so LLVM's generic Unix code compiles; the weak stubs in
 * wasi-posix-shim.c make it link (no-ops at runtime). Because those symbols are
 * never active in wasi-libc, declaring them causes no "redefinition".
 *
 * (Do NOT declare things wasi-libc provides UNCONDITIONALLY — struct flock,
 * F_SETLK, sigset_t, mmap, dup2… — that WOULD redefine. Verified per-symbol
 * against the installed wasi-libc headers.)  <pwd.h> and <sys/wait.h> are
 * provided as separate shim headers (scripts/shim/).
 * ────────────────────────────────────────────────────────────────────────── */
#ifndef CWASM_WASI_POSIX_SHIM_H
#define CWASM_WASI_POSIX_SHIM_H
#if defined(__wasi__)

#include <stddef.h>
#include <sys/types.h>
#include <signal.h>     /* sigset_t (complete) + wasi's inactive signal decls */

#ifdef __cplusplus
extern "C" {
#endif

/* ── signals (WASI has none; wasi-libc keeps them #if'd out) ──────────────── */
typedef struct {
  int   si_signo;
  int   si_errno;
  int   si_code;
  pid_t si_pid;
  uid_t si_uid;
  int   si_status;
  void *si_addr;
  int   si_value;
} siginfo_t;

struct sigaction {
  union {
    void (*sa_handler)(int);
    void (*sa_sigaction)(int, siginfo_t *, void *);
  };
  sigset_t sa_mask;
  int sa_flags;
  void (*sa_restorer)(void);
};
int sigaction(int, const struct sigaction *, struct sigaction *);
int sigemptyset(sigset_t *);
int sigfillset(sigset_t *);
int sigaddset(sigset_t *, int);
int sigdelset(sigset_t *, int);
int sigismember(const sigset_t *, int);
int sigprocmask(int, const sigset_t *, sigset_t *);

#ifndef SIG_BLOCK
#define SIG_BLOCK   0
#endif
#ifndef SIG_UNBLOCK
#define SIG_UNBLOCK 1
#endif
#ifndef SIG_SETMASK
#define SIG_SETMASK 2
#endif
#ifndef SA_NOCLDSTOP
#define SA_NOCLDSTOP 1
#define SA_NOCLDWAIT 2
#define SA_SIGINFO   4
#define SA_ONSTACK   0x08000000
#define SA_RESTART   0x10000000
#define SA_NODEFER   0x40000000
#define SA_RESETHAND 0x80000000
#endif

/* ── resource limits (wasi-libc keeps these #if'd out) ────────────────────── */
#ifndef RLIM_INFINITY
typedef unsigned long long rlim_t;
struct rlimit { rlim_t rlim_cur; rlim_t rlim_max; };
#define RLIMIT_CPU    0
#define RLIMIT_FSIZE  1
#define RLIMIT_DATA   2
#define RLIMIT_STACK  3
#define RLIMIT_CORE   4
#define RLIMIT_NOFILE 7
#define RLIMIT_AS     9
#define RLIM_INFINITY (~0ULL)
int getrlimit(int, struct rlimit *);
int setrlimit(int, const struct rlimit *);
#endif

/* ── processes / sessions (wasi-libc keeps these #if'd out) ───────────────── */
pid_t fork(void);
pid_t setsid(void);
pid_t getsid(pid_t);
int   execv(const char *, char *const[]);
int   execve(const char *, char *const[], char *const[]);
int   execvp(const char *, char *const[]);
int   kill(pid_t, int);
uid_t getuid(void);
uid_t geteuid(void);
gid_t getgid(void);
gid_t getegid(void);

/* ── terminal window size (Process.inc getTerminalWidth) ──────────────────── */
#ifndef TIOCGWINSZ
struct winsize { unsigned short ws_row, ws_col, ws_xpixel, ws_ypixel; };
#define TIOCGWINSZ 0x5413
#endif

/* ── dladdr / Dl_info (Path.inc getMainExecutable) — wasi has no dlfcn ─────── */
#ifndef CWASM_HAVE_DLADDR
typedef struct {
  const char *dli_fname;
  void       *dli_fbase;
  const char *dli_sname;
  void       *dli_saddr;
} Dl_info;
int dladdr(const void *, Dl_info *);
#endif

/* alarm() — wasi-libc only declares it under a feature macro Watchdog.inc
   doesn't set; a (compatible) redeclaration here makes it always visible. */
unsigned int alarm(unsigned int);

/* file-mode / ownership helpers Path.inc uses but wasi-libc keeps #if'd out */
mode_t umask(mode_t);
int    fchown(int, uid_t, gid_t);

/* ── mmap protection flags — wasi-libc's emulated <sys/mman.h> omits PROT_* ── */
#ifndef PROT_NONE
#define PROT_NONE  0
#define PROT_READ  1
#define PROT_WRITE 2
#define PROT_EXEC  4
#endif

/* sysconf key used by Path.inc home_directory (sysconf() itself exists) */
#ifndef _SC_GETPW_R_SIZE_MAX
#define _SC_GETPW_R_SIZE_MAX 70
#endif

#ifdef __cplusplus
}
#endif

#endif /* __wasi__ */
#endif /* CWASM_WASI_POSIX_SHIM_H */
