[← Documentation](README.md)

# Linux and Docker machines

## Linux machines

Pick **Learn the Linux terminal** on the start screen to get a real Linux computer: Alpine Linux 3.24 with the Linux 6.18 kernel, running on the [v86](https://github.com/copy/v86) x86 emulator in your browser. It's made for learning the command line:

- **Real processes, users and permissions**: `ps`, `htop`, `kill`, signals and job control, `sudo`, `chmod`, `/proc`, `dmesg`
- **Familiar tools**: bash with tab completion, GNU coreutils, `grep`, `sed`, `awk`, `find`, `less`, `nano`, `vim`, `tmux`, `git`, `tar`, and man pages (`man ls`)
- **A built-in tutorial**: type `tutorial` for 12 hands-on lessons (navigation, hidden files, editing, permissions, pipes, processes, sudo, man pages). Each exercise is checked automatically.
- **Lessons panel**: a cheat sheet beside the terminal; click any command to type it
- **Starts in about 2 seconds**: the app ships a snapshot of the booted machine (~42 MB, downloaded once and cached)
- **Web preview**: a web server started in the machine (`python3 -m http.server` after `sudo apk add python3`, say) opens in the preview, as in other projects
- **Saved automatically**: the whole machine (files, history, even running programs) is stored in your browser and resumes where you left off. *Reset machine* starts fresh. Because the system runs from memory, `sudo reboot` also starts a fresh machine, as it would on a live USB stick.
- **Download and share machines**: *Download* saves the machine to an `.opcode-linux` file (a copy to keep, hand in, or share). *Open a file* (on the start screen, or in the *More* menu) opens one as a new project. A teacher can prepare a machine, put the file online, and share a link: `https://your-opcode-site/?machine=https://…/lab-1.opcode-linux` opens it for each student (the file's server must allow cross-origin requests; a file next to the app works with a relative path, `?machine=labs/lab-1.opcode-linux`). Files open in the same Opcode version's emulator they were saved with.

You log in as `student` (password `student`). With a relay set up (see [Deploying](deploying.md#internet-relay)) the machine is online: `curl`, `git clone`, `ssh`, and `sudo apk add` for anything in Alpine's repositories. `ping` doesn't work (the relay carries TCP and UDP, not ICMP). The tutorial asks Opcode to save the machine after each lesson, and `opcode-save` does so from the command line.

## Docker

![A Docker machine: nginx runs in a container, and its page opens in the preview](images/docker.png)

Pick **Learn Docker** on the start screen for a Linux machine with real Docker: Docker Engine 29 with its command line tools and Compose, on the same Alpine Linux system (with 1 GB of memory). It works like Docker on any Linux computer:

- **Containers and images**: `docker run`, `ps`, `logs`, `exec`, `stop`, `rm`, `images`, `pull`, `rmi`, volumes and networks. `hello-world`, `alpine`, `busybox` and `nginx:alpine-slim` come with the machine; online, `docker pull` gets more (32-bit x86, `linux/386`, images: most official images have them, Node.js's don't).
- **Building**: `docker build` with a Dockerfile (`~/hello-web` is an example), using Docker's classic builder. `sudo apk add docker-cli-buildx` adds BuildKit when online.
- **Networking**: containers get their own addresses on a bridge network, `-p 8080:80` publishes a port (`curl localhost:8080` reaches it), and containers reach the internet when the machine is online. The preview shows web servers in the machine, so `docker run -d -p 8080:80 nginx:alpine-slim` opens nginx's page next to the terminal.
- **Compose**: `docker compose up` (`~/compose-demo` has a two-service example).
- **A built-in tutorial**: `tutorial` teaches Docker in 11 checked lessons (running containers, images, ports, `exec`, building an image, volumes, Compose, cleaning up), and the lessons panel is a clickable cheat sheet.

The machine is saved, downloaded and shared like a Linux machine. Expect emulator speeds: starting a container takes about 10 seconds, and a Docker or Compose command a few. The first visit downloads about 140 MB (once, then cached).
