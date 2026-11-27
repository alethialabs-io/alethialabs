// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Command gendocs writes what the CLI's docs and packages say about its commands, from the command
// registry (pkg/cmdmeta) and the error registry (pkg/clierr), so none of it is typed twice.
//
// It is a separate program and not a cobra command, so it adds nothing to the CLI's own surface.
// Run it from apps/cli.
//
//	go run ./tools/gendocs                 # rewrite the generated blocks of the docs pages
//	go run ./tools/gendocs -check          # exit 1, naming each page, when a block is stale
//	go run ./tools/gendocs -man DIR -completions DIR   # the release files (.goreleaser.yml)
//
// A generated block sits between two MDX comments, `{/* gendocs: <block> */}` and
// `{/* /gendocs */}`, and everything outside them is hand-written prose that this never touches.
// The blocks are listed in render.go. The test beside this file fails when a committed page is not
// what this writes, so CI is the -check.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/alethialabs-io/alethialabs/apps/cli/cmd"
)

// defaultDocs is the docs content directory, relative to apps/cli.
const defaultDocs = "../docs/content/docs"

// run parses the arguments and does what they ask, reporting on stdout.
func run(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("gendocs", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	docs := flags.String("docs", defaultDocs, "docs content directory whose generated blocks are rewritten")
	check := flags.Bool("check", false, "report stale blocks instead of rewriting them")
	man := flags.String("man", "", "write one man page per listed command into this directory")
	completions := flags.String("completions", "", "write the shell completion scripts into this directory")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", flags.Arg(0))
	}

	root, doc := cmd.DocTree()

	if *man != "" || *completions != "" {
		if *check {
			return fmt.Errorf("-check reads the docs pages; it does not combine with -man or -completions")
		}
		if *man != "" {
			if err := writeMan(root, *man); err != nil {
				return err
			}
			fmt.Fprintf(stdout, "man pages: %s\n", *man)
		}
		if *completions != "" {
			if err := writeCompletions(root, *completions); err != nil {
				return err
			}
			fmt.Fprintf(stdout, "completions: %s\n", *completions)
		}
		return nil
	}

	pages, err := generatePages(os.DirFS(*docs), *docs, newSource(doc))
	if err != nil {
		return err
	}
	var stale []string
	for _, p := range pages {
		if p.Generated == p.Committed {
			continue
		}
		stale = append(stale, p.Path)
		if !*check {
			if err := os.WriteFile(p.Path, []byte(p.Generated), 0o644); err != nil {
				return err
			}
		}
	}
	if *check && len(stale) > 0 {
		return fmt.Errorf("generated blocks are stale in:\n  %s\nrun `go run ./tools/gendocs` from apps/cli",
			strings.Join(stale, "\n  "))
	}
	fmt.Fprintf(stdout, "%d pages carry generated blocks; %d were stale\n", len(pages), len(stale))
	return nil
}

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "gendocs:", err)
		os.Exit(1)
	}
}
