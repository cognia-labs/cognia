#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  int fd = open(argv[1], O_RDWR);
  if (fd < 0) return 3;
  int result = flock(fd, LOCK_EX | LOCK_NB);
  close(fd);
  return result == 0 ? 0 : 1;
}
