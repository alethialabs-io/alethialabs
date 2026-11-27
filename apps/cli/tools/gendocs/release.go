// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"io"
	"os"
	"path/filepath"

	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/cmdmeta"
	"github.com/spf13/cobra"
)

// The release files. .goreleaser.yml runs this before it builds, packs both directories into every
// archive, installs them from the Homebrew formula and places them in the Linux packages; the test
// beside this file holds the names there and here together.

// completionFile names the completion script of each shell, as the shell's own loader looks for it
// once a package manager has put it in place.
var completionFile = map[string]string{
	"bash":       "alethia.bash",
	"zsh":        "_alethia",
	"fish":       "alethia.fish",
	"powershell": "alethia.ps1",
}

// writeMan writes one man page per listed command into dir, creating it.
func writeMan(root *cobra.Command, dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return cmdmeta.WriteManPages(root, dir)
}

// writeCompletions writes the completion script of every shell cobra supports into dir, creating
// it. Each script describes the commands it completes, as `alethia completion <shell>` does.
func writeCompletions(root *cobra.Command, dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	gen := map[string]func(io.Writer) error{
		"bash":       func(w io.Writer) error { return root.GenBashCompletionV2(w, true) },
		"zsh":        root.GenZshCompletion,
		"fish":       func(w io.Writer) error { return root.GenFishCompletion(w, true) },
		"powershell": root.GenPowerShellCompletionWithDesc,
	}
	for shell, name := range completionFile {
		f, err := os.Create(filepath.Join(dir, name))
		if err != nil {
			return err
		}
		werr := gen[shell](f)
		cerr := f.Close()
		if werr != nil {
			return werr
		}
		if cerr != nil {
			return cerr
		}
	}
	return nil
}
