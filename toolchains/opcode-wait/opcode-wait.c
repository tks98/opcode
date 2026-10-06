// Waits for Opcode's terminal bookkeeping files without starting a process
// per check. Under WASIX every process gets its own WebAssembly memory, and
// shell loops around `sleep` started several a second (for each running
// command, and while a toolchain installs); browsers can run out of memory
// reservations for them faster than they reclaim old ones.
//
//   opcode-wait FILE                    until FILE exists (exit 0)
//   opcode-wait --command STATE STOP    while a command runs: exit 0 when
//                                       STOP exists (Ctrl+C), 1 once STATE
//                                       no longer says busy/interrupted
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static void nap(long ms) {
  struct timespec ts = {ms / 1000, (ms % 1000) * 1000000L};
  nanosleep(&ts, NULL);
}

static int running(const char *state) {
  char text[32] = {0};
  FILE *file = fopen(state, "r");
  if (!file) return 0;
  size_t n = fread(text, 1, sizeof text - 1, file);
  fclose(file);
  text[n] = 0;
  return strncmp(text, "busy", 4) == 0 || strncmp(text, "interrupted", 11) == 0;
}

int main(int argc, char **argv) {
  if (argc == 2) {
    while (access(argv[1], F_OK) != 0) nap(100);
    return 0;
  }
  if (argc == 4 && strcmp(argv[1], "--command") == 0) {
    for (;;) {
      if (access(argv[3], F_OK) == 0) return 0;
      if (!running(argv[2])) return 1;
      nap(100);
    }
  }
  fputs("usage: opcode-wait FILE | opcode-wait --command STATE STOP\n", stderr);
  return 2;
}
