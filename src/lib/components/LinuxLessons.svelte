<!--
  LinuxLessons.svelte - getting-started guide and cheat sheet for Linux
  (and Docker) projects. Clicking a command types it into the machine's
  terminal.
-->

<script>
  import Icon from './Icon.svelte'

  let { kind = 'linux', onType = () => {}, online = false, onClose = () => {} } = $props()

  // `run: false` commands need you to finish them (a name, a PID…), so they
  // are typed without pressing Enter.
  const linuxSections = [
    {
      title: 'Find your way around',
      commands: [
        { cmd: 'pwd', desc: 'print the working directory (where you are)' },
        { cmd: 'ls', desc: 'list files' },
        { cmd: 'ls -la', desc: 'list all files, with details' },
        { cmd: 'cd tutorial', desc: 'go into a directory' },
        { cmd: 'cd ..', desc: 'go up one level' },
        { cmd: 'cd ~', desc: 'go to your home directory' },
        { cmd: 'tree -L 2', desc: 'show directories as a tree' },
      ],
    },
    {
      title: 'Work with files',
      commands: [
        { cmd: 'cat README.txt', desc: 'print a file' },
        { cmd: 'less README.txt', desc: 'page through a file (q quits)' },
        { cmd: 'mkdir ', run: false, desc: 'make a directory' },
        { cmd: 'touch ', run: false, desc: 'create an empty file' },
        { cmd: 'cp ', run: false, desc: 'copy: cp source destination' },
        { cmd: 'mv ', run: false, desc: 'move or rename' },
        { cmd: 'rm ', run: false, desc: 'delete (no undo!)' },
        { cmd: 'nano notes.txt', desc: 'edit a file (Ctrl+O save, Ctrl+X exit)' },
      ],
    },
    {
      title: 'Search and combine',
      commands: [
        { cmd: 'grep -rn needle tutorial', desc: 'find text inside files' },
        { cmd: 'find . -name "*.txt"', desc: 'find files by name' },
        { cmd: 'wc -l /etc/passwd', desc: 'count lines' },
        { cmd: 'ls /bin | sort | head', desc: 'pipes: send output to the next command' },
        { cmd: 'echo "hi" > hi.txt', desc: 'write output into a file' },
      ],
    },
    {
      title: 'Users and permissions',
      commands: [
        { cmd: 'whoami', desc: 'your user name' },
        { cmd: 'id', desc: 'your user and groups' },
        { cmd: 'ls -l /etc/shadow', desc: 'see who may read a file' },
        { cmd: 'chmod +x ', run: false, desc: 'make a file executable' },
        { cmd: 'sudo whoami', desc: 'run a command as root (password: student)' },
      ],
    },
    {
      title: 'Processes',
      commands: [
        { cmd: 'ps aux', desc: 'everything that is running' },
        { cmd: 'htop', desc: 'live process viewer (q quits)' },
        { cmd: 'sleep 300 &', desc: 'run something in the background' },
        { cmd: 'jobs', desc: 'list background jobs' },
        { cmd: 'kill ', run: false, desc: 'stop a process by PID' },
      ],
    },
    {
      title: 'The system',
      commands: [
        { cmd: 'uname -a', desc: 'the kernel you are running' },
        { cmd: 'cat /etc/os-release', desc: 'which Linux distribution this is' },
        { cmd: 'df -h', desc: 'disk usage' },
        { cmd: 'free -h', desc: 'memory usage' },
        { cmd: 'uptime', desc: 'how long the machine has been up' },
        { cmd: 'dmesg | less', desc: 'kernel messages from boot' },
      ],
    },
    {
      title: 'The internet',
      online: true,
      commands: [
        { cmd: 'ip addr', desc: 'network interfaces and addresses' },
        { cmd: 'curl -I https://example.com', desc: 'fetch a web page\'s headers' },
        { cmd: 'nslookup example.com', desc: 'look up a name in DNS' },
        { cmd: 'sudo apk add python3', desc: 'install software (apk search finds it)' },
        { cmd: 'git clone ', run: false, desc: 'copy a repository: git clone <url>' },
      ],
    },
    {
      title: 'Getting help',
      commands: [
        { cmd: 'man ls', desc: 'the manual for a command (q quits)' },
        { cmd: 'ls --help', desc: 'a quick summary of options' },
        { cmd: 'type cd', desc: 'what kind of command something is' },
      ],
    },
  ]

  const dockerSections = [
    {
      title: 'Run containers',
      commands: [
        { cmd: 'docker run hello-world', desc: 'run your first container' },
        { cmd: 'docker run -it alpine sh', desc: 'a shell inside a container (exit leaves)' },
        { cmd: 'docker run --rm alpine cat /etc/os-release', desc: 'run one command, then remove the container' },
        { cmd: 'docker ps', desc: 'containers that are running' },
        { cmd: 'docker ps -a', desc: 'all containers, stopped ones too' },
      ],
    },
    {
      title: 'Images',
      commands: [
        { cmd: 'docker images', desc: 'the images on this machine' },
        { cmd: 'docker history nginx:alpine-slim', desc: 'the layers an image is made of' },
        { cmd: 'docker image inspect alpine', desc: 'everything about an image' },
        { cmd: 'docker rmi ', run: false, desc: 'remove an image' },
      ],
    },
    {
      title: 'Run a web server',
      commands: [
        { cmd: 'docker run -d --name web -p 8080:80 nginx:alpine-slim', desc: 'start nginx in the background, on port 8080' },
        { cmd: 'curl localhost:8080', desc: 'ask it for its page' },
        { cmd: 'docker logs web', desc: 'what the container printed' },
        { cmd: 'docker exec -it web sh', desc: 'a shell inside the running container' },
        { cmd: 'docker stop web', desc: 'stop it' },
        { cmd: 'docker rm web', desc: 'remove it' },
      ],
    },
    {
      title: 'Build your own image',
      commands: [
        { cmd: 'cd ~/hello-web', desc: 'an example: a page and a Dockerfile' },
        { cmd: 'cat Dockerfile', desc: 'the recipe for the image' },
        { cmd: 'nano index.html', desc: 'change the page (Ctrl+O save, Ctrl+X exit)' },
        { cmd: 'docker build -t hello-web .', desc: 'build an image from the Dockerfile' },
        { cmd: 'docker run -d --name site -p 8081:80 hello-web', desc: 'run your image' },
        { cmd: 'curl localhost:8081', desc: 'see your page' },
      ],
    },
    {
      title: 'Keep data in volumes',
      commands: [
        { cmd: 'docker volume create notes', desc: 'make a volume' },
        { cmd: "docker run --rm -v notes:/data alpine sh -c 'date >> /data/log'", desc: 'write to it from a container' },
        { cmd: 'docker run --rm -v notes:/data alpine cat /data/log', desc: 'read it from another one' },
        { cmd: 'docker volume ls', desc: 'list volumes' },
      ],
    },
    {
      title: 'Compose',
      commands: [
        { cmd: 'cd ~/compose-demo', desc: 'an example with two containers' },
        { cmd: 'cat compose.yaml', desc: 'the services it describes' },
        { cmd: 'docker compose up -d', desc: 'start them all' },
        { cmd: 'docker compose ps', desc: 'see how they are doing' },
        { cmd: 'docker compose logs checker', desc: 'one service\'s output' },
        { cmd: 'docker compose down', desc: 'stop and remove them' },
      ],
    },
    {
      title: 'Clean up',
      commands: [
        { cmd: 'docker stop $(docker ps -q)', desc: 'stop every running container' },
        { cmd: 'docker container prune', desc: 'remove stopped containers' },
        { cmd: 'docker system df', desc: 'how much space Docker uses' },
      ],
    },
    {
      title: 'From the internet',
      online: true,
      commands: [
        { cmd: 'docker pull python:3-alpine', desc: 'download an image (32-bit x86 ones run here)' },
        { cmd: 'docker run -it --rm python:3-alpine', desc: 'Python, in a container' },
        { cmd: 'docker run --rm alpine wget -qO- example.com', desc: 'containers can go online too' },
      ],
    },
    {
      title: 'Getting help',
      commands: [
        { cmd: 'docker --help', desc: 'every docker command' },
        { cmd: 'docker run --help', desc: 'the options of one command' },
        { cmd: 'docker info', desc: 'how this Docker is set up' },
      ],
    },
  ]

  const guides = {
    linux: {
      title: 'Learn Linux',
      intro: 'This is a real Linux computer (Alpine Linux) running inside your browser. Nothing you do here can harm your own computer.',
      sections: linuxSections,
    },
    docker: {
      title: 'Learn Docker',
      intro: 'This is a Linux computer with real Docker, running inside your browser. Containers you run here stay in this machine.',
      sections: dockerSections,
    },
  }
  let guide = $derived(guides[kind] ?? guides.linux)

  const keys = [
    ['Tab', 'complete a command or file name'],
    ['↑ / ↓', 'previous / next command'],
    ['Ctrl+C', 'stop the running program'],
    ['Ctrl+L', 'clear the screen'],
    ['Ctrl+R', 'search your command history'],
    ['Ctrl+D', 'end input (or log out)'],
  ]
</script>

<aside class="lessons" aria-label="{kind === 'docker' ? 'Docker' : 'Linux'} lessons">
  <section class="intro">
    <div class="intro-head">
      <h2>{guide.title}</h2>
      <button class="btn btn-quiet btn-small btn-icon" onclick={onClose} aria-label="Hide the lessons" title="Hide the lessons"><Icon name="close" size={16} /></button>
    </div>
    <p>{guide.intro}</p>
    <button class="btn btn-primary start" onclick={() => onType('tutorial')}><Icon name="play" size={16} /><span>Start the guided tutorial</span></button>
    <p class="hint">Click any command below to type it into the terminal.</p>
  </section>

  {#each guide.sections.filter((section) => !section.online || online) as section (section.title)}
    <section>
      <h3>{section.title}</h3>
      <ul>
        {#each section.commands as item (item.cmd)}
          <li>
            <button class="command" onclick={() => onType(item.cmd, item.run !== false)} title={item.run === false ? 'Types the command; finish it and press Enter' : 'Run this command'}>
              <code>{item.cmd.trim()}{item.run === false ? ' …' : ''}</code>
            </button>
            <span class="desc">{item.desc}</span>
          </li>
        {/each}
      </ul>
    </section>
  {/each}

  <section>
    <h3>Keyboard shortcuts</h3>
    <dl>
      {#each keys as [key, desc] (key)}
        <dt><kbd>{key}</kbd></dt>
        <dd>{desc}</dd>
      {/each}
    </dl>
  </section>
</aside>

<style>
  .lessons {
    width: 340px;
    flex-shrink: 0;
    overflow-y: auto;
    padding: 14px 18px 28px;
    border-left: 2px solid var(--line);
    background: var(--bar);
    font-size: 14px;
  }

  .intro-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 6px;
  }

  h2 {
    margin: 0;
    font-size: 22px;
    font-weight: 780;
    font-variation-settings: var(--casual);
  }

  h3 {
    margin: 22px 0 8px;
    font-size: 16px;
    font-weight: 750;
    font-variation-settings: var(--casual);
  }

  p {
    margin: 0 0 10px;
    line-height: 1.5;
  }

  .hint {
    color: var(--muted);
  }

  .start {
    width: 100%;
    margin: 4px 0 12px;
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin-bottom: 10px;
  }

  .command {
    align-self: flex-start;
    padding: 3px 8px;
    border: 2px solid var(--line);
    border-radius: 7px;
    background: var(--surface);
    color: var(--ink);
  }

  .command:hover {
    border-color: var(--focus);
    background: var(--hover);
  }

  code {
    font-size: 13px;
  }

  .desc {
    color: var(--muted);
    font-size: 13px;
  }

  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 8px 10px;
    margin: 0;
  }

  dd {
    margin: 0;
    color: var(--muted);
  }

  kbd {
    padding: 1px 6px;
    border: 2px solid var(--line);
    border-bottom-width: 3px;
    border-radius: 6px;
    background: var(--surface);
    font-size: 12px;
    white-space: nowrap;
  }

  /* Phones: the lessons cover the terminal. */
  @media (max-width: 760px) {
    .lessons {
      position: absolute;
      inset: 0;
      z-index: 5;
      width: auto;
      border-left: 0;
    }
  }
</style>
