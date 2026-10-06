// A small stty for Opcode's terminals. WASIX keeps a terminal's settings in
// its runtime (tty_get/tty_set) rather than in termios, and the shell
// packages don't include stty. Opcode runs `stty sane` after Ctrl+C stops a
// program that left the terminal without echo (a REPL, an editor, bash).
//
// Supported: stty [-a] | sane | echo | -echo | raw | -raw | cooked | size
#include <stdint.h>
#include <stdio.h>
#include <string.h>

// __wasi_tty_t, with room for fields newer runtimes add.
typedef struct {
  uint32_t cols, rows, width, height;
  uint8_t stdin_tty, stdout_tty, stderr_tty, echo, line_buffered, line_feeds;
  uint8_t reserved[26];
} tty_t;

__attribute__((import_module("wasix_32v1"), import_name("tty_get"))) uint16_t wasix_tty_get(tty_t *tty);
__attribute__((import_module("wasix_32v1"), import_name("tty_set"))) uint16_t wasix_tty_set(tty_t *tty);

static int usage(const char *arg) {
  fprintf(stderr, "stty: invalid argument '%s'\nUsage: stty [-a] [sane|echo|-echo|raw|-raw|cooked|size]\n", arg);
  return 1;
}

int main(int argc, char **argv) {
  tty_t tty;
  memset(&tty, 0, sizeof tty);
  if (wasix_tty_get(&tty) != 0) {
    fputs("stty: standard input is not a terminal\n", stderr);
    return 1;
  }
  if (argc == 1 || (argc == 2 && strcmp(argv[1], "-a") == 0)) {
    printf("rows %u; columns %u; %secho %sicanon\n", tty.rows, tty.cols, tty.echo ? "" : "-", tty.line_buffered ? "" : "-");
    return 0;
  }
  for (int i = 1; i < argc; i++) {
    const char *arg = argv[i];
    if (strcmp(arg, "size") == 0) {
      printf("%u %u\n", tty.rows, tty.cols);
      return 0;
    } else if (strcmp(arg, "sane") == 0 || strcmp(arg, "cooked") == 0 || strcmp(arg, "-raw") == 0) {
      tty.echo = 1;
      tty.line_buffered = 1;
      tty.line_feeds = 1;
    } else if (strcmp(arg, "raw") == 0) {
      tty.echo = 0;
      tty.line_buffered = 0;
    } else if (strcmp(arg, "echo") == 0) {
      tty.echo = 1;
    } else if (strcmp(arg, "-echo") == 0) {
      tty.echo = 0;
    } else {
      return usage(arg);
    }
  }
  if (wasix_tty_set(&tty) != 0) {
    fputs("stty: could not change the terminal\n", stderr);
    return 1;
  }
  return 0;
}
