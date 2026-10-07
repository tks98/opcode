// Bash configuration for Opcode terminals, written to /workspace/.opcode
// when a sandbox starts.
//
// - Shell integration: the prompt emits OSC 133 (command started/finished,
//   with exit status) and OSC 7 (current directory), the conventions VS Code
//   and other terminals use. Terminal.svelte intercepts them.
// - Ctrl+C: the terminal's SIGINT stops only some programs under WASIX,
//   and only a process's own tree can kill it, so a short-lived watchdog
//   runs beside each command. When the UI writes .opcode/interrupt-<shell>
//   it kills the command's processes (see Shell.svelte.js#interrupt).
// - Commands are tracked from PS0, which bash expands once per command line,
//   not with a DEBUG trap: under WASIX a trap costs about 1 ms per command
//   (loops run ten times slower) and can crash bash inside for loops.
// - C/C++: clang, gcc and friends forward to the browser-hosted Clang via
//   request files in .opcode/host (see ProjectSandbox#serveHostRequests).
// - Rust: rustc and cargo run tools.sh (tools.bash), which asks Opcode to
//   run rustc in the sandbox the same way.

import { INTERNAL_DIR, WORKSPACE_ROOT } from '../paths.js'
import { JAVA_HOME, RUST_SYSROOT, RUST_TARGET, TOOLCHAINS, WEB_PORT } from '../languages.js'
import TOOLS from './tools.bash?raw'

export const OPCODE_DIR = `${WORKSPACE_ROOT}/${INTERNAL_DIR}`
export const RC_FILE = `${OPCODE_DIR}/bashrc`
// Each terminal tab's shell has its own id (OPCODE_SHELL) and watchdog files.
export const stateFile = (shellId) => `${OPCODE_DIR}/state-${shellId}`
export const interruptFile = (shellId) => `${OPCODE_DIR}/interrupt-${shellId}`
export const sigintFile = (shellId) => `${OPCODE_DIR}/sigint-${shellId}`
export const HOST_DIR = `${OPCODE_DIR}/host`
// rustc, cargo and other tools that run as a bash process of their own.
export const TOOLS_PATH = `${INTERNAL_DIR}/tools.sh`
export const TOOLS_SCRIPT = TOOLS.replaceAll('@OPCODE_DIR@', OPCODE_DIR).replaceAll('@RUST_SYSROOT@', RUST_SYSROOT).replaceAll('@RUST_TARGET@', RUST_TARGET)
// A description of xterm.js for programs that read termcap. The sandbox has
// no termcap or terminfo files, so without it Bash's line editor can't move
// the cursor up: a command wider than the terminal scrolled sideways instead
// of wrapping (`<ustc main.rs -o main`), which phones' narrow terminals hit
// all the time. From xterm's termcap entry; the size comes from the terminal.
export const TERMCAP = String.raw`xterm-256color|xterm|xterm with 256 colors:am:bs:km:mi:ms:xn:co#80:it#8:li#24:Co#256:AL=\E[%dL:DC=\E[%dP:DL=\E[%dM:DO=\E[%dB:IC=\E[%d@:LE=\E[%dD:RI=\E[%dC:UP=\E[%dA:al=\E[L:bl=^G:cd=\E[J:ce=\E[K:cl=\E[H\E[2J:cm=\E[%i%d;%dH:cr=^M:cs=\E[%i%d;%dr:dc=\E[P:dl=\E[M:do=^J:ho=\E[H:ic=\E[@:kD=\E[3~:kb=^?:kd=\EOB:ke=\E[?1l\E>:kh=\EOH:@7=\EOF:kl=\EOD:kr=\EOC:ks=\E[?1h\E=:ku=\EOA:le=^H:md=\E[1m:me=\E[m:mr=\E[7m:nd=\E[C:se=\E[27m:sf=^J:so=\E[7m:sr=\EM:ta=^I:ue=\E[24m:up=\E[A:us=\E[4m:`
export const HISTORY_PATH = `${INTERNAL_DIR}/bash_history`
export const HISTORY_FILE = `${WORKSPACE_ROOT}/${HISTORY_PATH}`

// The shell's id as bash expands it. Defined outside BASHRC, where ${...}
// would be read as JavaScript interpolation.
const SHELL_ID_EXPANSION = '${OPCODE_SHELL:-1}'

// command_not_found_handle cases: toolchain commands -> toolchain id.
const TOOLCHAIN_CASES = Object.entries(TOOLCHAINS)
  .filter(([, toolchain]) => toolchain.commands)
  .map(([id, toolchain]) => `    ${toolchain.commands.join(' | ')}) toolchain=${id} ;;`)
  .join('\n')

export const OSC_SHELL_INTEGRATION = 133
export const OSC_CWD = 7

export const BASHRC = String.raw`# Opcode terminal setup. Regenerated for every session; edits are not kept.
export HOME=${WORKSPACE_ROOT} USER=student TERM=xterm-256color LANG=C.UTF-8 EDITOR=nano PAGER=cat
export TERMCAP='${TERMCAP}'
export PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
export JAVA_HOME=${JAVA_HOME} RISTRETTO_JDK_HOME=${JAVA_HOME}
export HISTFILE=${HISTORY_FILE} HISTSIZE=5000 HISTCONTROL=ignoredups
shopt -s histappend checkwinsize 2>/dev/null
# With TERMCAP, readline would bracket pastes, and a pasted block would sit
# at the prompt as one edited line. Opcode runs each pasted line in turn.
bind 'set enable-bracketed-paste off' 2>/dev/null
history -r 2>/dev/null
alias ll='ls -la' la='ls -A'
# Serve a folder as a website, as Run does for web pages: serve [folder] [port]
serve() {
  local root=. port=${WEB_PORT}
  case $1 in '' | *[!0-9]*) [ -n "$1" ] && root=$1 ;; *) port=$1 ;; esac
  [ -n "$2" ] && port=$2
  printf 'Serving %s at http://localhost:%s/ (Ctrl+C stops)\n' "$root" "$port"
  static-web-server --host 0.0.0.0 --port "$port" --root "$root" --directory-listing=true --cache-control-headers=false --compression=false --log-level=error
}
clear() { printf '\e[H\e[2J\e[3J'; }
# Under WASIX, rm -r skips some of the entries of each directory it empties,
# the same ones on every try; tools.sh removes what it leaves one by one.
rm() {
  local arg recursive='' options=1
  for arg; do
    [ -n "$options" ] || break
    case $arg in
      --) options='' ;;
      -i | -I | --interactive*) command rm "$@"; return ;;
      --recursive) recursive=1 ;;
      --*) ;;
      -*[rR]*) recursive=1 ;;
    esac
  done
  [ -n "$recursive" ] || { command rm "$@"; return; }
  # rm refuses these on purpose; the fallback must not empty them anyway.
  for arg; do
    case $arg in . | .. | ./ | ../ | */. | */.. | */./ | */../ | /) command rm "$@"; return ;; esac
  done
  command rm "$@" 2> /dev/null && return 0
  bash "$__opcode_dir/tools.sh" rm-tree "$@"
}
# less reads keys from /dev/tty, which WASIX doesn't connect to the terminal,
# so it could never be quit. tools.sh has a pager that reads the terminal.
less() { bash "$__opcode_dir/tools.sh" pager "$@"; }
more() { less "$@"; }

__opcode_dir=${OPCODE_DIR}
__opcode_id=${SHELL_ID_EXPANSION}

# Compilers Opcode runs for the shell (C/C++: Clang in the browser; rustc
# in this sandbox): pass the request on, wait, then print what it printed.
__opcode_cc() {
  local id="$$-$RANDOM$RANDOM" dir="$__opcode_dir/host" code=1 line
  printf '%s\0' "$__opcode_id" "$PWD" "$@" > "$dir/$id.args"
  : > "$dir/$id.ready"
  opcode-wait "$dir/$id.done"
  if [ -s "$dir/$id.stdout" ]; then
    while IFS= read -r line || [ -n "$line" ]; do printf '%s\n' "$line"; done < "$dir/$id.stdout"
  fi
  if [ -s "$dir/$id.out" ]; then
    while IFS= read -r line || [ -n "$line" ]; do printf '%s\n' "$line"; done < "$dir/$id.out" >&2
  fi
  read -r code < "$dir/$id.done"
  return "$code"
}
clang() { __opcode_cc clang "$@"; }
clang++() { __opcode_cc clang++ "$@"; }
gcc() { __opcode_cc clang "$@"; }
cc() { __opcode_cc clang "$@"; }
g++() { __opcode_cc clang++ "$@"; }
c++() { __opcode_cc clang++ "$@"; }
# javac also runs in the browser (runtime/javac.js) and writes .class files here.
javac() { __opcode_cc javac "$@"; }
# And tsc (runtime/tsc.js), which writes .js files here.
tsc() { __opcode_cc tsc "$@"; }
# R runs in the browser too (runtime/rlang.js): Rscript, and R's console,
# which reads lines here (with bash's line editing, and a history of its own)
# and has Opcode's R evaluate them.
Rscript() { __opcode_cc Rscript "$@"; }
R() {
  if [ $# -gt 0 ]; then
    case $1 in -q | --quiet | --no-save | --vanilla | --interactive) ;; *) __opcode_cc R "$@"; return ;; esac
  fi
  local line buffer='' prompt='> ' status saved="$__opcode_dir/history-$$"
  __opcode_cc R --console-start || return
  history -w "$saved"
  history -c
  history -r "$__opcode_dir/R-history" 2> /dev/null
  while IFS= read -e -r -p "$prompt" line; do
    [ -n "$line" ] && history -s -- "$line"
    buffer+="$line"$'\n'
    __opcode_cc R --console-eval "$buffer"
    status=$?
    [ "$status" -eq 3 ] && prompt='+ ' && continue # R wants more lines
    buffer='' prompt='> '
    [ "$status" -eq 4 ] && break # q()
  done
  history -w "$__opcode_dir/R-history"
  history -c
  history -r "$saved"
  command rm -f "$saved"
  __opcode_cc R --console-end
}
# C# (toolchains/csharp): dotnet run compiles the folder's .cs files with
# Roslyn and runs the program, on .NET 8's runtime for WASI (dotnet-wasm).
dotnet() {
  case $1 in
    run | build) DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 command dotnet-wasm csharp "$@" ;;
    new)
      local dir=. name
      [ "$2" = console ] || { echo 'In Opcode, dotnet new makes console apps: dotnet new console [-o folder]' >&2; return 1; }
      case $3 in -o | --output | -n | --name) dir=$4 ;; esac
      mkdir -p "$dir" || return
      name=$(basename "$(cd "$dir" && pwd)")
      [ -e "$dir/Program.cs" ] || printf '// See https://aka.ms/new-console-template for more information\nConsole.WriteLine("Hello, World!");\n' > "$dir/Program.cs"
      [ -e "$dir/$name.csproj" ] || printf '<Project Sdk="Microsoft.NET.Sdk">\n\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <TargetFramework>net8.0</TargetFramework>\n    <ImplicitUsings>enable</ImplicitUsings>\n    <Nullable>enable</Nullable>\n  </PropertyGroup>\n\n</Project>\n' > "$dir/$name.csproj"
      echo 'The template "Console App" was created successfully.'
      ;;
    --version) echo '8.0.31 (C# 13 with Roslyn 4.14, on .NET 8 for WASI)' ;;
    '' | -h | --help | --info) printf 'Usage: dotnet run [-- arguments]   compile the .cs files in this folder, then run the program\n       dotnet build                 compile them only\n       dotnet new console [-o dir]  make a new console app\n' ;;
    *) printf 'dotnet %s is not available in Opcode (try dotnet run, build or new).\n' "$1" >&2; return 1 ;;
  esac
}
# WASIX starts programs in /; ruby -C goes to the shell's directory first.
ruby() { command ruby -C "$PWD" "$@"; }
# (Not exported: WASIX rejects environment names like BASH_FUNC_g++%%.)

# Open files in Opcode's editor, like VS Code's code command.
code() {
  local f path
  if [ $# -eq 0 ]; then echo "usage: code <file>..." >&2; return 2; fi
  for f in "$@"; do
    [ -e "$f" ] || : > "$f"
    case "$f" in /*) path=$f ;; *) path=$PWD/$f ;; esac
    printf '%s\0%s' "$__opcode_id" "$path" > "$__opcode_dir/host/$$-$RANDOM$RANDOM.open"
  done
}
alias edit=code open=code

# Rust, as a bash process of its own (see tools.bash). WASIX reports any
# exit status above 78 as 79, so tools.sh also leaves its real one (cargo's
# 101) in a file.
__opcode_tool() {
  local file="$__opcode_dir/status-$$-$RANDOM" status
  OPCODE_STATUS_FILE=$file bash "$__opcode_dir/tools.sh" "$@"
  status=$?
  if [ -s "$file" ]; then read -r status < "$file"; fi
  command rm -f "$file"
  return "$status"
}
rustc() { __opcode_tool rustc "$@"; }
cargo() { __opcode_tool cargo "$@"; }

# A toolchain command used before its toolchain is installed (e.g. node in a
# Python project): Opcode installs it, then runs the command again in a
# fresh shell (see ProjectSandbox#handleInstallRequest).
command_not_found_handle() {
  local toolchain id="$$-$RANDOM$RANDOM" dir="$__opcode_dir/host"
  # Run again as typed, without what ruby() adds.
  if [ "$1" = ruby ] && [ "$2" = -C ] && [ "$3" = "$PWD" ]; then shift 3 && set -- ruby "$@"; fi
  case $1 in
${TOOLCHAIN_CASES}
    vim | vi | view | vimtutor | emacs)
      printf '%s is not available in this terminal (there is no WebAssembly build of it yet).\n' "$1" >&2
      printf 'Edit with nano (Ctrl+O saves, Ctrl+X quits) or in the editor above.\nThe Linux machines (Learn the Linux terminal) have vim.\n' >&2
      return 127
      ;;
    *)
      printf 'bash: %s: command not found\n' "$1" >&2
      return 127
      ;;
  esac
  # (dotnet() runs dotnet-wasm csharp …: run again as dotnet …)
  if [ "$1" = dotnet-wasm ] && [ "$2" = csharp ]; then shift 2 && set -- dotnet "$@"; fi
  printf '%s\0' "$__opcode_id" "$toolchain" "$@" > "$dir/$id.install"
  opcode-wait "$dir/$id.done"
  [ -s "$dir/$id.out" ] && cat "$dir/$id.out" >&2
  return 127
}

# Ctrl+C support (see the comment in shell.js).
printf idle > "$__opcode_dir/state-$__opcode_id"
# The watchdog waits in opcode-wait (one process) rather than a loop around
# sleep: under WASIX each process has its own WebAssembly memory, and the
# browser can run out of room for them (see toolchains/opcode-wait).
__opcode_watchdog() {
  local shell=$$ self=$BASHPID pid last
  trap '' INT
  trap - ERR # see __opcode_on_error; failed kills are expected here
  # Until the prompt returns: on Ctrl+C, stop the command's processes, and
  # stay in case the terminal asks again (see Shell.svelte.js#forceStop).
  while opcode-wait --command "$__opcode_dir/state-$__opcode_id" "$__opcode_dir/interrupt-$__opcode_id"; do
    command rm -f "$__opcode_dir/interrupt-$__opcode_id"
    printf interrupted > "$__opcode_dir/state-$__opcode_id"
    # Only processes that exist now: the prompt's own commands (stty) may
    # start while this runs. Loops starting new ones end via the ERR trap.
    sleep 0 & last=$!
    for ((pid = 1; pid < last; pid++)); do
      [ "$pid" = "$shell" ] || [ "$pid" = "$self" ] || kill -9 "$pid" 2>/dev/null
    done
  done
}
# Runs (in a subshell, from PS0) when a command line starts.
__opcode_preexec() {
  printf busy > "$__opcode_dir/state-$__opcode_id"
  __opcode_watchdog > /dev/null 2>&1 &
  printf '\e]133;C\a'
}
__opcode_prompt() {
  local status=$? state
  read -r state 2>/dev/null < "$__opcode_dir/state-$__opcode_id"
  printf idle > "$__opcode_dir/state-$__opcode_id"
  if [ "$state" = interrupted ] || [ -e "$__opcode_dir/interrupt-$__opcode_id" ] || [ -e "$__opcode_dir/sigint-$__opcode_id" ]; then
    status=130
    echo
    # A stopped program may have left the terminal without echo.
    stty sane 2>/dev/null
  fi
  history -a 2>/dev/null
  printf '\e]133;D;%s\a\e]7;%s\a' "$status" "$PWD"
  local mark=''
  [ "$status" -eq 0 ] || mark='\[\e[31m\]['"$status"']\[\e[0m\] '
  PS1="$mark"'\[\e[1;32m\]student@opcode\[\e[0m\]:\[\e[1;34m\]\w\[\e[0m\]$ '
}
# Ctrl+C in a loop (for f in *; do python3 "$f"; done): the program the
# loop runs gets stopped and fails. Signal this shell then, while it isn't
# waiting for a process (under WASIX a signal during that wait kills bash):
# bash abandons the rest of the command line, as it does natively.
__opcode_on_error() {
  local state
  if [ ! -e "$__opcode_dir/sigint-$__opcode_id" ]; then
    read -r state 2>/dev/null < "$__opcode_dir/state-$__opcode_id"
    [ "$state" = interrupted ] || return 0
  fi
  [ "$BASHPID" = "$$" ] || exit 130 # in a subshell: just end it
  kill -INT $$
}
set -E
trap __opcode_on_error ERR
PROMPT_COMMAND=__opcode_prompt
PS0='$(__opcode_preexec)'
`

export const SANDBOX_ENV = {
  HOME: WORKSPACE_ROOT,
  USER: 'student',
  TERM: 'xterm-256color',
  TERMCAP,
  LANG: 'C.UTF-8',
  EDITOR: 'nano',
  // A program's pager reads keys from /dev/tty, which WASIX doesn't have
  // (see less below), so programs that page (python's help()) print instead.
  PAGER: 'cat',
  PYTHONUNBUFFERED: '1',
  PYTHONDONTWRITEBYTECODE: '1',
}

export const SHELL_ARGS = ['--rcfile', RC_FILE, '-i']
