// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmdmeta

import (
	"github.com/spf13/cobra"
	"github.com/spf13/cobra/doc"
)

// ManSection is the manual section the CLI's pages are written for: user commands.
const ManSection = "1"

// WriteManPages writes one man page per listed command under root into dir, which must exist. A
// page is named after its command path with dashes, alethia-project-list.1, and titled the same
// way.
//
// The page generator is imported in this file and nowhere else. It reads the tree as it stands, so
// call Apply first: a hidden command gets no page, and a command's examples are the registry's.
func WriteManPages(root *cobra.Command, dir string) error {
	return doc.GenManTree(root, &doc.GenManHeader{
		Section: ManSection,
		Source:  root.Name() + " " + root.Version,
		Manual:  root.Name() + " manual",
	}, dir)
}
