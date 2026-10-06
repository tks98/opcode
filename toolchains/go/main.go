// Command go is the `go` tool available in Opcode's terminal.
//
// The browser has no native Go toolchain, so this program is compiled to
// WASI (GOOS=wasip1) and interprets Go source with Yaegi. It implements the
// subset of the real CLI that learners use day to day: `go run` and
// `go version`.
package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/traefik/yaegi/interp"
	"github.com/traefik/yaegi/stdlib"
)

const usage = `Go is a tool for running Go source code in Opcode.

Usage:

	go run <file.go | directory> [arguments]
	go version

Programs are interpreted with Yaegi, so most of the standard library is
available but third-party modules are not.
`

func main() {
	args := os.Args[1:]
	if len(args) == 0 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}

	switch args[0] {
	case "help", "-h", "--help":
		fmt.Print(usage)
	case "version":
		fmt.Printf("go version yaegi-%s (interpreter) wasip1/wasm\n", runtime.Version())
	case "run":
		os.Exit(run(args[1:]))
	default:
		fmt.Fprintf(os.Stderr, "go %s: unknown command\nRun 'go help' for usage.\n", args[0])
		os.Exit(2)
	}
}

// run interprets the program named by args and returns its exit status.
func run(args []string) int {
	target, programArgs, err := resolveTarget(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, "go run:", err)
		return 1
	}

	os.Args = append([]string{target}, programArgs...)
	in := interp.New(interp.Options{
		GoPath:       "/nonexistent",
		Args:         os.Args,
		Stdin:        os.Stdin,
		Stdout:       os.Stdout,
		Stderr:       os.Stderr,
		Unrestricted: true, // let os.Exit and os.Args behave like a compiled program
	})
	if err := in.Use(stdlib.Symbols); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}

	if _, err := in.EvalPath(target); err != nil {
		var p interp.Panic
		if errors.As(err, &p) {
			fmt.Fprintf(os.Stderr, "panic: %v\n\n%s", p.Value, p.Stack)
			return 2
		}
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

// resolveTarget mirrors `go run`: leading .go files (or a single directory)
// name the program and everything after them is passed to it.
func resolveTarget(args []string) (string, []string, error) {
	if len(args) == 0 {
		args = []string{"."}
	}

	var files []string
	rest := args
	for len(rest) > 0 && strings.HasSuffix(rest[0], ".go") {
		files = append(files, rest[0])
		rest = rest[1:]
	}

	switch {
	case len(files) == 1:
		return files[0], rest, nil
	case len(files) > 1:
		dir := filepath.Dir(files[0])
		for _, f := range files[1:] {
			if filepath.Dir(f) != dir {
				return "", nil, errors.New("named files must all be in one directory")
			}
		}
		return relativeDir(dir), rest, nil
	}

	st, err := os.Stat(rest[0])
	if err != nil || !st.IsDir() {
		return "", nil, fmt.Errorf("no Go files listed (try: go run main.go)")
	}
	return relativeDir(rest[0]), rest[1:], nil
}

// relativeDir formats a directory the way Yaegi expects for a package of
// source files on disk ("./dir").
func relativeDir(dir string) string {
	dir = filepath.Clean(dir)
	if filepath.IsAbs(dir) {
		if wd, err := os.Getwd(); err == nil {
			if rel, err := filepath.Rel(wd, dir); err == nil {
				dir = rel
			}
		}
	}
	if dir == "." {
		return "./"
	}
	if strings.HasPrefix(dir, "../") {
		return dir
	}
	return "./" + dir
}
