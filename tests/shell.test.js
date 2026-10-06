import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BASHRC, SANDBOX_ENV, SHELL_ARGS, TOOLS_SCRIPT } from '../src/lib/runtime/shell.js'

const bash = (script, options = {}) => execFileSync('bash', ['-c', script], { encoding: 'utf8', ...options })

// The functions of BASHRC named here, to try them in a native bash.
function functions(...names) {
  return names
    .map((name) => {
      const match = new RegExp(`^${name.replace(/[+]/g, '\\$&')}\\(\\) \\{[\\s\\S]*?^\\}$`, 'm').exec(BASHRC)
      if (!match) throw new Error(`no function ${name}`)
      return match[0]
    })
    .join('\n')
}

describe('shell configuration', () => {
  it('wires up shell integration, Ctrl+C support and the compiler commands', () => {
    expect(BASHRC).toContain("PS0='$(__opcode_preexec)'")
    expect(BASHRC).toContain("printf '\\e]133;C\\a'")
    // A DEBUG trap slows every command down and can crash bash under WASIX.
    expect(BASHRC).not.toMatch(/trap .* DEBUG/)
    expect(BASHRC).toMatch(/__opcode_watchdog\(\)/)
    for (const name of ['clang', 'clang\\+\\+', 'gcc', 'g\\+\\+', 'code']) {
      expect(BASHRC).toMatch(new RegExp(`^${name}\\(\\) \\{`, 'm'))
    }
    expect(SHELL_ARGS).toContain('--rcfile')
  })

  it('stops loops on Ctrl+C from the ERR trap and resets the terminal', () => {
    expect(BASHRC).toContain('trap __opcode_on_error ERR')
    expect(BASHRC).toMatch(/^set -E$/m)
    expect(BASHRC).toContain('kill -INT $$')
    expect(BASHRC).toContain('stty sane')
    // The watchdog must not end itself through the inherited ERR trap.
    expect(BASHRC).toMatch(/__opcode_watchdog\(\) \{[^}]*trap - ERR/)
  })

  it('installs toolchains when their commands are first used', () => {
    expect(BASHRC).toMatch(/^command_not_found_handle\(\) \{/m)
    expect(BASHRC).toContain('python | python3) toolchain=python ;;')
    expect(BASHRC).toContain('node | npm | npx) toolchain=node ;;')
  })

  it('is valid bash', () => {
    bash('bash -n', { input: BASHRC })
    bash('bash -n', { input: TOOLS_SCRIPT })
  })

  it('has rustc and cargo, run as tools.sh, which hands compiles to Opcode', () => {
    expect(BASHRC).toContain('rustc() { __opcode_tool rustc "$@"; }')
    expect(BASHRC).toContain('cargo() { __opcode_tool cargo "$@"; }')
    expect(BASHRC).toContain('bash "$__opcode_dir/tools.sh" "$@"')
    expect(TOOLS_SCRIPT).toContain('__opcode_cc rustc --sysroot /opt/rust')
    expect(TOOLS_SCRIPT).toContain('--target wasm32-wasip1')
    expect(TOOLS_SCRIPT).toContain('__opcode_dir=/workspace/.opcode')
    expect(TOOLS_SCRIPT).not.toMatch(/@(RUST_SYSROOT|RUST_TARGET|OPCODE_DIR)@/)
  })

  it('removes whole directory trees with rm -r even when rm leaves entries behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opcode-rm-'))
    try {
      mkdirSync(join(dir, '.opcode'))
      writeFileSync(join(dir, '.opcode/tools.sh'), TOOLS_SCRIPT)
      mkdirSync(join(dir, 'tree/sub/.hidden'), { recursive: true })
      for (const file of ['a', 'b', 'sub/c', 'sub/.d', 'sub/.hidden/e']) writeFileSync(join(dir, 'tree', file), file)
      // A real rm that gives up after the first pass, as WASIX's does.
      const flaky = 'rm_calls=0; command() { if [ "$1" = rm ] && [ "$rm_calls" -eq 0 ]; then rm_calls=1; return 1; fi; builtin command "$@"; }'
      const setup = `__opcode_dir=${dir}/.opcode\n${functions('rm')}`
      bash(`${flaky}\n${setup}\nrm -rf tree`, { cwd: dir })
      expect(existsSync(join(dir, 'tree'))).toBe(false)
      expect(() => bash(`${setup}\nrm -r missing`, { cwd: dir, stdio: 'pipe' })).toThrow()
      bash(`${setup}\nrm -rf missing`, { cwd: dir })
      bash(`${setup}\nrm -f nothing-here`, { cwd: dir })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("passes on tools' real exit status, which WASIX reports as 79 when above 78", () => {
    const dir = mkdtempSync(join(tmpdir(), 'opcode-status-'))
    try {
      writeFileSync(join(dir, 'tools.sh'), 'printf "101\\n" > "$OPCODE_STATUS_FILE"; exit 79\n')
      expect(bash(`__opcode_dir=${dir}\n${functions('__opcode_tool', 'cargo')}\ncargo test; echo "status=$?"`)).toContain('status=101')
      // And the status file is gone.
      expect(bash(`ls ${dir}`).trim()).toBe('tools.sh')
      // tools.sh itself leaves its status for the shell.
      writeFileSync(join(dir, 'real.sh'), TOOLS_SCRIPT)
      bash(`OPCODE_STATUS_FILE=${dir}/s bash ${dir}/real.sh rm-tree ${dir}/missing 2> /dev/null; echo "$?" > ${dir}/code`)
      expect(bash(`cat ${dir}/s ${dir}/code`)).toBe('1\n1\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never exports functions or invalid environment names (WASIX rejects them)', () => {
    expect(BASHRC).not.toMatch(/export -f/)
    for (const key of Object.keys(SANDBOX_ENV)) expect(key).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
  })
})
