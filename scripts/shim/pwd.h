/* ──────────────────────────────────────────────────────────────────────────
 * pwd.h — shim header. wasi-libc has no <pwd.h> (no users/password database),
 * but llvm/lib/Support/Unix/Path.inc includes it. Provided via the shim include
 * dir (scripts/shim on the build's -I path). getpwuid/getpwuid_r are satisfied
 * by the weak stubs in wasi-posix-shim.c (they return "no such user").
 * ────────────────────────────────────────────────────────────────────────── */
#ifndef CWASM_SHIM_PWD_H
#define CWASM_SHIM_PWD_H
#if defined(__wasi__)

#include <stddef.h>
#include <sys/types.h>

#ifdef __cplusplus
extern "C" {
#endif

struct passwd {
  char  *pw_name;
  char  *pw_passwd;
  uid_t  pw_uid;
  gid_t  pw_gid;
  char  *pw_gecos;
  char  *pw_dir;
  char  *pw_shell;
};

struct passwd *getpwuid(uid_t);
struct passwd *getpwnam(const char *);
int getpwuid_r(uid_t, struct passwd *, char *, size_t, struct passwd **);
int getpwnam_r(const char *, struct passwd *, char *, size_t, struct passwd **);

#ifdef __cplusplus
}
#endif

#endif /* __wasi__ */
#endif /* CWASM_SHIM_PWD_H */
