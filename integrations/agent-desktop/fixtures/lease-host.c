#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  int fd = open(argv[1], O_RDWR | O_CREAT | O_EXCL, 0600);
  if (fd < 0 || flock(fd, LOCK_EX | LOCK_NB) != 0) return 3;
  char value[32];
  snprintf(value, sizeof(value), "%d", fd);
  if (setenv("COGNIA_AUTOMATION_LEASE_FD", value, 1) != 0) return 4;
  int input[2];
  if (pipe(input) != 0) return 6;
  pid_t child = fork();
  if (child < 0) return 5;
  if (child == 0) {
    if (dup2(input[0], STDIN_FILENO) < 0) _exit(126);
    close(input[0]);
    execl(argv[2], argv[2], "set-value", "@missing", "--stdin", (char *)NULL);
    _exit(127);
  }
  printf("%d\n", child);
  fflush(stdout);
  for (;;) pause();
}
