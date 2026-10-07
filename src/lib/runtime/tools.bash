# Opcode's terminal tools, run as `bash ~/.opcode/tools.sh <tool> [args]`:
#
#   rustc, cargo   Rust (see TOOLCHAINS.rust in languages.js)
#   rust-tests     cargo test's runner (started by Opcode, see below)
#   rm-tree        finishes a recursive rm (see rm in shell.js)
#   pager          less and more (see less in shell.js)
#
# They run in a bash of their own rather than as functions of the
# interactive shell: under WASIX, bash running this much shell code
# sometimes dies (the runtime's "unknown error"), and then it is only this
# process, not the terminal's shell. (Generated from tools.bash.)

__opcode_dir=@OPCODE_DIR@
__opcode_id=${OPCODE_SHELL:-1}

# Ask Opcode to run a compiler (rustc runs in this sandbox, see
# ProjectSandbox#runRustc), wait, then print what it printed.
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

# Under WASIX, rm -r skips some of the entries of each directory it empties,
# the same ones on every try, so whatever it leaves is removed one by one.
__opcode_rm_tree() {
  local dir=$1 entry
  shift
  for entry in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    if [ -d "$entry" ] && [ ! -L "$entry" ]; then __opcode_rm_tree "$entry" || return; else set -- "$@" "$entry"; fi
  done
  [ $# -eq 0 ] || command rm -f -- "$@" || return
  command rmdir -- "$dir"
}
__opcode_remove() {
  command rm -rf "$1" 2> /dev/null
  [ ! -e "$1" ] || __opcode_rm_tree "$1"
}
# rm-tree [rm options] path...: what rm -r left behind.
__opcode_rm_finish() {
  local arg force='' options=1 status=0
  for arg; do
    if [ -n "$options" ]; then
      case $arg in
        --) options=''; continue ;;
        --force) force=1; continue ;;
        --*) continue ;;
        -?*) case $arg in *f*) force=1 ;; esac; continue ;;
      esac
    fi
    if [ -d "$arg" ] && [ ! -L "$arg" ]; then
      __opcode_rm_tree "$arg" || status=1
    elif [ -e "$arg" ] || [ -L "$arg" ]; then
      command rm -f -- "$arg" || status=1
    elif [ -z "$force" ]; then
      printf "rm: cannot remove '%s': No such file or directory\n" "$arg" >&2
      status=1
    fi
  done
  return "$status"
}

# ---------------------------------------------------------------------
# Rust. Opcode starts rustc in this sandbox when asked, installing it first
# if needed: bash starting it itself (fork, then exec of this large
# multi-threaded program) sometimes ends the shell under WASIX. rustc is a
# WASI program, which resolves relative paths from / rather than the
# current directory, so it gets absolute paths. These also pick the
# defaults students expect: the 2021 edition, and programs named after
# their source file (rustc main.rs makes ./main).

rustc() {
  local args=() sources=() arg next='' out='' edition='' target='' color='' crate_type='' status
  local tmp=/tmp/opcode-rustc-$$-$RANDOM
  for arg in "$@"; do
    case $next in
      path) case $arg in /*) ;; *) arg=$PWD/$arg ;; esac ;;
      keypath) case $arg in /* | *=/*) ;; *=*) arg=${arg%%=*}=$PWD/${arg#*=} ;; *) arg=$PWD/$arg ;; esac ;;
      value) ;;
      *)
        case $arg in
          -o | --out-dir) out=1 next=path ;;
          -o/* | --out-dir=/*) out=1 ;;
          -o*) out=1 arg=-o$PWD/${arg#-o} ;;
          --out-dir=*) out=1 arg=--out-dir=$PWD/${arg#*=} ;;
          -L | --extern) next=keypath ;;
          --edition) edition=1 next=value ;;
          --edition=*) edition=1 ;;
          --target) target=1 next=value ;;
          --target=*) target=1 ;;
          --color) color=1 next=value ;;
          --color=*) color=1 ;;
          --crate-type) crate_type=1 next=value ;;
          --crate-type=*) crate_type=1 ;;
          --crate-name | --emit | --print | --explain | --cfg | --cap-lints | --error-format | --json | -C | -Z | -W | -A | -D | -F | -l) next=value ;;
          -*) ;;
          *)
            if [ -e "$arg" ]; then
              case $arg in /*) ;; *) arg=$PWD/$arg ;; esac
              sources+=("$arg")
            fi
            ;;
        esac
        args+=("$arg")
        continue
        ;;
    esac
    next=''
    args+=("$arg")
  done
  [ -n "$edition" ] || args+=(--edition 2021)
  [ -n "$target" ] || args+=(--target @RUST_TARGET@)
  if [ -z "$color" ] && [ -t 2 ]; then args+=(--color always); fi
  if [ -z "$out" ]; then
    if [ -z "$crate_type" ] && [ ${#sources[@]} -eq 1 ] && [[ ${sources[0]} == *.rs ]]; then
      arg=${sources[0]##*/}
      args+=(-o "$PWD/${arg%.rs}")
    else
      args+=(--out-dir "$PWD")
    fi
  fi
  mkdir -p "$tmp"
  __opcode_cc rustc --sysroot @RUST_SYSROOT@ -Z temps-dir="$tmp" "${args[@]}"
  status=$?
  __opcode_remove "$tmp"
  return "$status"
}

# A small Cargo for packages that use only the standard library: new, init,
# build, run, check, test and clean, with Cargo's layout (src/main.rs,
# src/lib.rs, src/bin/*.rs, target/debug) and messages. Crates can't be
# downloaded: there's no real Cargo to resolve and build them.
__opcode_cargo_status() {
  if [ -t 2 ]; then printf '\e[1;32m%12s\e[0m %s\n' "$1" "$2" >&2; else printf '%12s %s\n' "$1" "$2" >&2; fi
}
__opcode_cargo_error() {
  if [ -t 2 ]; then printf '\e[1;31merror\e[0m: %s\n' "$1" >&2; else printf 'error: %s\n' "$1" >&2; fi
}
__opcode_cargo_help() {
  cat << 'EOF'
Rust's package manager (Opcode's built-in subset)

Usage: cargo <COMMAND> [OPTIONS]

Commands:
    new <path>   Create a new package (--lib for a library)
    init         Create a package in the current directory
    build, b     Compile the current package (--release for optimized)
    run, r       Build and run the program (cargo run -- <args>)
    check, c     Check the package for errors without building it
    test, t      Build and run the tests (cargo test <filter>)
    clean        Remove the target directory

Packages can use only the standard library: crates can't be downloaded here.
EOF
}

__opcode_cargo_new() {
  local mode=$1 path='' name='' lib='' edition=2021 dir kind='binary (application)'
  shift
  while [ $# -gt 0 ]; do
    case $1 in
      --lib) lib=1 kind=library ;;
      --bin) lib='' kind='binary (application)' ;;
      --name) name=$2; shift ;;
      --name=*) name=${1#*=} ;;
      --edition) edition=$2; shift ;;
      --edition=*) edition=${1#*=} ;;
      --vcs) shift ;;
      --vcs=* | -q | --quiet) ;;
      -*) __opcode_cargo_error "unexpected argument '$1' found"; return 1 ;;
      *) path=$1 ;;
    esac
    shift
  done
  if [ "$mode" = new ]; then
    if [ -z "$path" ]; then __opcode_cargo_error 'the following required arguments were not provided: <PATH>'; return 1; fi
    if [ -e "$path" ]; then __opcode_cargo_error "destination \`$path\` already exists"; return 101; fi
  fi
  dir=${path:-.}
  if [ -z "$name" ]; then
    if [ "$dir" = . ]; then name=${PWD##*/}; else name=${dir%/}; name=${name##*/}; fi
  fi
  if [ -e "$dir/Cargo.toml" ]; then __opcode_cargo_error '`cargo init` cannot be run on existing Cargo packages'; return 101; fi
  mkdir -p "$dir/src" || return 101
  printf '[package]\nname = "%s"\nversion = "0.1.0"\nedition = "%s"\n\n[dependencies]\n' "$name" "$edition" > "$dir/Cargo.toml"
  if [ -n "$lib" ]; then
    [ -e "$dir/src/lib.rs" ] || printf '%s\n' 'pub fn add(left: u64, right: u64) -> u64 {' '    left + right' '}' '' '#[cfg(test)]' 'mod tests {' '    use super::*;' '' '    #[test]' '    fn it_works() {' '        let result = add(2, 2);' '        assert_eq!(result, 4);' '    }' '}' > "$dir/src/lib.rs"
  else
    [ -e "$dir/src/main.rs" ] || printf '%s\n' 'fn main() {' '    println!("Hello, world!");' '}' > "$dir/src/main.rs"
  fi
  [ -e "$dir/.gitignore" ] || printf '/target\n' > "$dir/.gitignore"
  if [ "$mode" = new ]; then __opcode_cargo_status Creating "$kind \`$name\` package"; else __opcode_cargo_status Creating "$kind package"; fi
}

cargo() {
  local sub=$1
  case $sub in
    '' | -h | --help | help) __opcode_cargo_help; return ;;
    -V | --version | version) echo 'cargo 1.83.0 (Opcode built-in: new, init, build, run, check, test, clean)'; return ;;
    new | init) shift; __opcode_cargo_new "$sub" "$@"; return ;;
    build | b | run | r | check | c | test | t | clean) shift ;;
    *) __opcode_cargo_error "\`cargo $sub\` isn't available. Opcode has a small built-in Cargo: new, init, build, run, check, test and clean."; return 101 ;;
  esac
  case $sub in b) sub=build ;; r) sub=run ;; c) sub=check ;; t) sub=test ;; esac

  local release='' bin='' manifest='' root show='' rest=() run_args=()
  while [ $# -gt 0 ]; do
    case $1 in
      -r | --release) release=1 ;;
      -q | --quiet | -v | --verbose) ;;
      --bin) bin=$2; shift ;;
      --bin=*) bin=${1#*=} ;;
      --manifest-path) manifest=$2; shift ;;
      --manifest-path=*) manifest=${1#*=} ;;
      --) shift; run_args=("$@"); break ;;
      -*) __opcode_cargo_error "unexpected argument '$1' found"; return 1 ;;
      *) rest+=("$1") ;;
    esac
    shift
  done

  # The package: the nearest Cargo.toml.
  if [ -n "$manifest" ]; then
    case $manifest in /*) root=${manifest%/*} ;; */*) root=$PWD/${manifest%/*} ;; *) root=$PWD ;; esac
    if [ ! -e "$root/Cargo.toml" ]; then __opcode_cargo_error "manifest path \`$manifest\` does not exist"; return 101; fi
  else
    root=$PWD
    while [ ! -e "$root/Cargo.toml" ]; do
      if [ -z "$root" ]; then __opcode_cargo_error "could not find \`Cargo.toml\` in \`$PWD\` or any parent directory"; return 101; fi
      root=${root%/*}
    done
  fi
  if [ "$sub" = clean ]; then
    __opcode_remove "$root/target"
    __opcode_cargo_status Removed "the target directory"
    return
  fi

  local line section='' key value name='' version=0.1.0 edition=2015 deps=''
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%%#*}
    line=${line#"${line%%[![:space:]]*}"}
    case $line in
      '['*)
        section=${line#[}
        section=${section%%]*}
        case $section in dependencies.* | dev-dependencies.* | build-dependencies.*) deps+=" ${section#*.}" ;; esac
        ;;
      *=*)
        key=${line%%=*}
        key=${key%"${key##*[![:space:]]}"}
        value=${line#*=}
        value=${value#"${value%%[![:space:]]*}"}
        value=${value%"${value##*[![:space:]]}"}
        value=${value#\"}
        value=${value%\"}
        case $section in
          package) case $key in name) name=$value ;; version) version=$value ;; edition) edition=$value ;; esac ;;
          dependencies | dev-dependencies | build-dependencies) deps+=" $key" ;;
        esac
        ;;
    esac
  done < "$root/Cargo.toml"
  if [ -z "$name" ]; then __opcode_cargo_error "failed to parse manifest at \`$root/Cargo.toml\`: missing field \`name\`"; return 101; fi
  if [ -n "$deps" ]; then
    __opcode_cargo_error "this package depends on crates (${deps# }), and Opcode's built-in Cargo can't download crates. It builds packages that use only the standard library."
    return 101
  fi

  local crate=${name//-/_} profile=debug profile_name='`dev` profile [unoptimized + debuginfo]' opt=()
  if [ -n "$release" ]; then profile=release profile_name='`release` profile [optimized]' opt=(-C opt-level=3); fi
  local out=$root/target/$profile deps_dir=$root/target/$profile/deps lib_src='' bin_src='' bin_name=$name f bins=()
  [ -e "$root/src/lib.rs" ] && lib_src=$root/src/lib.rs
  for f in "$root"/src/bin/*.rs "$root"/src/bin/*/main.rs; do
    [ -e "$f" ] || continue
    case $f in */main.rs) f=${f%/main.rs} ;; *) f=${f%.rs} ;; esac
    bins+=("${f##*/}")
  done
  if [ -n "$bin" ] && [ "$bin" != "$name" ]; then
    bin_name=$bin
    if [ -e "$root/src/bin/$bin.rs" ]; then bin_src=$root/src/bin/$bin.rs
    elif [ -e "$root/src/bin/$bin/main.rs" ]; then bin_src=$root/src/bin/$bin/main.rs
    else __opcode_cargo_error "no bin target named \`$bin\`"; return 101
    fi
  elif [ -e "$root/src/main.rs" ]; then
    bin_src=$root/src/main.rs
  elif [ ${#bins[@]} -eq 1 ]; then
    bin_name=${bins[0]}
    bin_src=$root/src/bin/$bin_name.rs
    [ -e "$bin_src" ] || bin_src=$root/src/bin/$bin_name/main.rs
  elif [ "$sub" = run ] && [ ${#bins[@]} -gt 1 ]; then
    __opcode_cargo_error "\`cargo run\` could not determine which binary to run. Use the \`--bin\` option to specify a binary.
available binaries: ${bins[*]}"
    return 101
  fi
  if [ -z "$lib_src" ] && [ -z "$bin_src" ]; then
    __opcode_cargo_error "no targets specified in the manifest: either src/lib.rs, src/main.rs or src/bin/*.rs must be present"
    return 101
  fi
  if [ "$sub" = run ] && [ -z "$bin_src" ]; then
    __opcode_cargo_error 'a bin target must be available for `cargo run`'
    return 101
  fi
  [ "$sub" = run ] && run_args=("${rest[@]}" "${run_args[@]}")
  if [ "$sub" = test ] && [[ " ${run_args[*]} " == *' --nocapture '* || " ${run_args[*]} " == *' --show-output '* ]]; then show=1; fi

  # Rebuild when the sources or the build changed since an output was made.
  # (A checksum rather than file times: appending with >> doesn't update a
  # file's time under WASIX.)
  local t0=${EPOCHREALTIME/./} compiled='' extern=() globstar='' fingerprint='' stamp_tmp=/tmp/opcode-cargo-$$-$RANDOM
  shopt -q globstar && globstar=1
  shopt -s globstar
  { printf '%s\n' "$root"/src/**/*.rs; cat "$root/Cargo.toml" "$root"/src/**/*.rs 2> /dev/null; } | cksum > "$stamp_tmp"
  read -r fingerprint < "$stamp_tmp"
  command rm -f "$stamp_tmp"
  __opcode_cargo_compile() { # <output> <description> rustc-args...
    local output=$1 what=$2 stamp line='' record
    shift 2
    stamp="$fingerprint $*"
    # Kept in target/.opcode, which the editor leaves out.
    record=${output#"$root/target/"}
    record=$root/target/.opcode/${record//\//_}
    [ -e "$output" ] && [ -e "$record" ] && read -r line < "$record"
    [ "$line" = "$stamp" ] && return 0
    [ -n "$compiled" ] || __opcode_cargo_status Compiling "$name v$version ($root)"
    compiled=1
    mkdir -p "$deps_dir" "$root/target/.opcode"
    if rustc --edition "$edition" "${opt[@]}" "$@"; then
      printf '%s\n' "$stamp" > "$record"
      return 0
    fi
    __opcode_cargo_error "could not compile \`$name\` ($what) due to the errors above"
    return 101
  }
  local ok=0 tests=()
  if [ "$sub" = check ]; then
    [ -n "$lib_src" ] && { __opcode_cargo_compile "$deps_dir/lib$crate.rmeta" lib --crate-type lib --crate-name "$crate" --emit=metadata "$lib_src" --out-dir "$deps_dir" || ok=101; }
    [ -n "$lib_src" ] && extern=(--extern "$crate=$deps_dir/lib$crate.rmeta")
    [ "$ok" -eq 0 ] && [ -n "$bin_src" ] && { __opcode_cargo_compile "$deps_dir/$bin_name.rmeta" "bin \"$bin_name\"" --crate-type bin --crate-name "${bin_name//-/_}" --emit=metadata "$bin_src" -o "$deps_dir/$bin_name.rmeta" "${extern[@]}" || ok=101; }
  else
    [ -n "$lib_src" ] && { __opcode_cargo_compile "$deps_dir/lib$crate.rlib" lib --crate-type lib --crate-name "$crate" "$lib_src" --out-dir "$deps_dir" || ok=101; }
    [ -n "$lib_src" ] && extern=(--extern "$crate=$deps_dir/lib$crate.rlib")
    if [ "$sub" = test ]; then
      [ "$ok" -eq 0 ] && [ -n "$lib_src" ] && { __opcode_cargo_compile "$deps_dir/$crate-lib-test" 'lib test' --test --crate-name "$crate" "$lib_src" -o "$deps_dir/$crate-lib-test" && tests+=("src/lib.rs:$deps_dir/$crate-lib-test") || ok=101; }
      [ "$ok" -eq 0 ] && [ -n "$bin_src" ] && { __opcode_cargo_compile "$deps_dir/$bin_name-bin-test" "bin \"$bin_name\" test" --test --crate-name "${bin_name//-/_}" "$bin_src" -o "$deps_dir/$bin_name-bin-test" "${extern[@]}" && tests+=("${bin_src#"$root"/}:$deps_dir/$bin_name-bin-test") || ok=101; }
    else
      [ "$ok" -eq 0 ] && [ -n "$bin_src" ] && { __opcode_cargo_compile "$out/$bin_name" "bin \"$bin_name\"" --crate-type bin --crate-name "${bin_name//-/_}" "$bin_src" -o "$out/$bin_name" "${extern[@]}" || ok=101; }
    fi
  fi
  [ -n "$globstar" ] || shopt -u globstar
  unset -f __opcode_cargo_compile
  [ "$ok" -eq 0 ] || return 101
  t0=$(( (${EPOCHREALTIME/./} - t0) / 10000 ))
  local cs=$((t0 % 100))
  [ "$cs" -lt 10 ] && cs=0$cs
  __opcode_cargo_status Finished "$profile_name target(s) in $((t0 / 100)).${cs}s"

  case $sub in
    run)
      __opcode_cargo_status Running "\`target/$profile/$bin_name${run_args[*]:+ ${run_args[*]}}\`"
      "$out/$bin_name" "${run_args[@]}"
      ;;
    test)
      local test failed=''
      for test in "${tests[@]}"; do
        __opcode_cargo_status Running "unittests ${test%%:*} (${test#*:"$root"/})"
        # Opcode runs them (tools.sh rust-tests) in a shell of its own: a
        # failing test aborts its program, which under WASIX can take down
        # the shell that started it.
        __opcode_cc rust-tests "${test#*:}" "$show" "${rest[@]}" || failed=1
      done
      if [ -n "$failed" ]; then __opcode_cargo_error 'test failed'; return 101; fi
      ;;
  esac
}

# Runs a Rust test program one test at a time, like libtest's own output:
#   rust-tests <program> <show-output: '' or 1> [filter...]
# These programs abort on panic, so a failing test would otherwise end the
# whole run (and lose its message).
__opcode_rust_tests() {
  local exe=$1 tmp=/tmp/opcode-tests-$$-$RANDOM show=$2 line name status i=0 passed=0 failed=0 ignored=0 count=0 skip=0 s=s t0=${EPOCHREALTIME/./} result
  local ignored_list=$'\n' failures=()
  shift 2
  mkdir -p "$tmp"
  "$exe" --list --format=terse "$@" > "$tmp/all" 2> /dev/null
  "$exe" --list --format=terse --ignored "$@" > "$tmp/ignored" 2> /dev/null
  while IFS= read -r line; do ignored_list+="$line"$'\n'; done < "$tmp/ignored"
  while IFS= read -r line; do [[ $line == *': test' ]] && count=$((count + 1)); done < "$tmp/all"
  if [ $# -gt 0 ]; then
    "$exe" --list --format=terse > "$tmp/unfiltered" 2> /dev/null
    while IFS= read -r line; do [[ $line == *': test' ]] && skip=$((skip + 1)); done < "$tmp/unfiltered"
    skip=$((skip - count))
  fi
  [ "$count" -eq 1 ] && s=''
  printf '\nrunning %d test%s\n' "$count" "$s"
  while IFS= read -r line; do
    [[ $line == *': test' ]] || continue
    name=${line%: test}
    if [[ $ignored_list == *$'\n'"$line"$'\n'* ]]; then
      printf 'test %s ... \e[33mignored\e[0m\n' "$name"
      ignored=$((ignored + 1))
      continue
    fi
    i=$((i + 1))
    printf 'test %s ... ' "$name"
    "$exe" --exact "$name" --nocapture --test-threads=1 < /dev/null > "$tmp/out-$i" 2>&1
    status=$?
    if [ "$status" -eq 0 ]; then
      printf '\e[32mok\e[0m\n'
      passed=$((passed + 1))
      [ -n "$show" ] && __opcode_rust_test_output "$tmp/out-$i" "$name"
    else
      printf '\e[31mFAILED\e[0m\n'
      failed=$((failed + 1))
      failures+=("$i:$name")
    fi
  done < "$tmp/all"
  if [ "$failed" -gt 0 ]; then
    printf '\nfailures:\n'
    for line in "${failures[@]}"; do
      printf '\n---- %s stdout ----\n' "${line#*:}"
      __opcode_rust_test_output "$tmp/out-${line%%:*}" "${line#*:}"
    done
    printf '\nfailures:\n'
    for line in "${failures[@]}"; do printf '    %s\n' "${line#*:}"; done
    result='\e[31mFAILED\e[0m'
  else
    result='\e[32mok\e[0m'
  fi
  t0=$(( (${EPOCHREALTIME/./} - t0) / 10000 ))
  printf "\ntest result: $result. %d passed; %d failed; %d ignored; 0 measured; %d filtered out; finished in %d.%02ds\n\n" "$passed" "$failed" "$ignored" "$skip" $((t0 / 100)) $((t0 % 100))
  __opcode_remove "$tmp"
  [ "$failed" -eq 0 ]
}
# A test's own output, without the test harness's lines.
__opcode_rust_test_output() {
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      'running 1 test' | 'test result: '* | '') continue ;;
      "test $2 ... "*) line=${line#"test $2 ... "} ;;
    esac
    case $line in '' | ok | FAILED) ;; *) printf '%s\n' "$line" ;; esac
  done < "$1"
}

# less and more (see shell.js). They read keys from /dev/tty, which WASIX
# doesn't connect to the terminal, so they could never be quit. This pager
# reads keys from the terminal itself. Piped input (`seq 100 | less`) can't
# be paged, the keyboard being on the pipe's side, so it is shown whole.
#   Space f PgDn: next page     b PgUp: previous page
#   Enter j Down: next line     k Up: previous line
#   d u: half a page            g G: start and end
#   /text: find   n N: next and previous match   q: quit
__opcode_pager() {
  local -a files=() rows=()
  local arg
  for arg in "$@"; do
    case $arg in -?* | +*) ;; *) files+=("$arg") ;; esac # less's options
  done
  if [ ${#files[@]} -eq 0 ] || [ ! -t 0 ] || [ ! -t 1 ]; then
    cat -- "${files[@]}"
    return
  fi

  local height=24 cols=80 size
  size=$(stty size 2> /dev/null) && read -r height cols <<< "$size"
  ((height < 2)) && height=24
  ((cols < 10)) && cols=80
  local page=$((height - 1)) status=0 file line tab='        '

  for file in "${files[@]}"; do
    if [ -d "$file" ]; then
      printf '%s is a directory\n' "$file" >&2
      status=1
      continue
    elif [ ! -r "$file" ]; then
      printf '%s: No such file or directory\n' "$file" >&2
      status=1
      continue
    fi
    ((${#files[@]} > 1)) && rows+=("==> $file <==")
    while IFS= read -r line || [ -n "$line" ]; do
      line=${line%$'\r'}
      line=${line//$'\t'/$tab}
      while ((${#line} > cols)); do
        rows+=("${line:0:cols}")
        line=${line:cols}
      done
      rows+=("$line")
    done < "$file"
  done
  ((${#rows[@]} == 0)) && return "$status"

  local total=${#rows[@]} top=0 last key rest pattern='' message='' i out name
  name=${files[0]}
  ((${#files[@]} > 1)) && name="${#files[@]} files"
  trap 'printf "\e[?1049l\e[?25h"' EXIT
  printf '\e[?1049h\e[?25l'
  while :; do
    last=$((total > page ? total - page : 0))
    ((top > last)) && top=$last
    ((top < 0)) && top=0
    out=$'\e[H\e[2J'
    for ((i = top; i < top + page && i < total; i++)); do
      out+="${rows[i]}"$'\e[K\r\n'
    done
    for (( ; i < top + page; i++)); do out+=$'~\r\n'; done
    if [ -n "$message" ]; then
      out+=$'\e[7m '"$message"$' \e[0m'
    elif ((top >= last)); then
      out+=$'\e[7m '"$name (END)  q quits"$' \e[0m'
    else
      out+=$'\e[7m '"$name  $((top * 100 / last))%  Space: next page, q: quit"$' \e[0m'
    fi
    printf '%s' "$out"
    message=''
    IFS= read -rsn1 key || break
    if [ "$key" = $'\e' ]; then
      IFS= read -rsn2 -t 0.05 rest
      case $rest in '[5' | '[6') IFS= read -rsn1 -t 0.05 _ ;; esac
      key="ESC$rest"
    fi
    case $key in
      q | Q) break ;;
      ' ' | f | $'\x06' | $'\x16' | 'ESC[6') ((top += page)) ;;
      b | $'\x02' | 'ESC[5') ((top -= page)) ;;
      '' | j | e | $'\x0e' | 'ESC[B') ((top += 1)) ;;
      k | y | $'\x10' | 'ESC[A') ((top -= 1)) ;;
      d) ((top += page / 2)) ;;
      u) ((top -= page / 2)) ;;
      g | '<' | 'ESC[H') top=0 ;;
      G | '>' | 'ESC[F') top=$last ;;
      / | n | N)
        if [ "$key" = / ]; then
          printf '\r\e[K/\e[?25h'
          IFS= read -r pattern
          printf '\e[?25l'
        fi
        if [ -z "$pattern" ]; then
          continue
        fi
        if [ "$key" = N ]; then
          for ((i = top - 1; i >= 0; i--)); do [[ ${rows[i]} == *"$pattern"* ]] && break; done
        else
          for ((i = top + 1; i < total; i++)); do [[ ${rows[i]} == *"$pattern"* ]] && break; done
          ((i >= total)) && i=-1
        fi
        if ((i >= 0)); then top=$i; else message="Pattern not found: $pattern"; fi
        ;;
      h | H) message='Space f: next page  b: back  j k: line  g G: start/end  /: find  q: quit' ;;
    esac
  done
  return "$status"
}

case $1 in
  rustc | cargo) "$@" ;;
  rust-tests) shift; __opcode_rust_tests "$@" ;;
  rm-tree) shift; __opcode_rm_finish "$@" ;;
  pager) shift; __opcode_pager "$@" ;;
  *) echo "usage: tools.sh rustc|cargo|rust-tests|rm-tree|pager [args]" >&2; (exit 2) ;;
esac
# WASIX reports exit statuses above 78 as 79: leave the real one for the
# shell (see __opcode_tool in shell.js).
__opcode_status=$?
if [ -n "$OPCODE_STATUS_FILE" ]; then printf '%s\n' "$__opcode_status" > "$OPCODE_STATUS_FILE"; fi
exit "$__opcode_status"
