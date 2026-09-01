// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The helpers this lane hoisted were never wrong — their ADDRESSES were. `orDash` lived in
// config.go and eight other files used it; `yesNo` lived in channels.go and five did. That is why
// the command files could not be worked on in parallel: any lane touching a render had to edit a
// command file another lane owned.
//
// Hoisting them fixes it once. This stops it happening again, because the pressure that put them
// there is still present — the next person needing a dash in a new command will write one locally
// unless something objects.
var renderHelperInCmd = regexp.MustCompile(
	`(?m)^func (orDash|strOrDash|intOrDash|floatOrDash|stampOrDash|stampOrNever|yesNo|gateGlyph|formatCreatedAt|truncID|relativeTime)\(`)

func TestHygCliRender_NoRenderHelperIsDefinedInACommandFile(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	scanned := 0
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		scanned++
		body, err := os.ReadFile(filepath.Join(".", name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		for _, m := range renderHelperInCmd.FindAllStringSubmatch(string(body), -1) {
			t.Errorf("%s defines the render helper %q.\n"+
				"      These live in apps/cli/pkg/utils/ui/render.go, exported, so every command shares one\n"+
				"      definition. A local copy is how the empty-value sentinel ended up with THREE spellings.",
				name, m[1])
		}
	}
	// Vacuity: a walk that reads no files would pass having checked nothing, and this guard's whole
	// value is that it keeps checking as the CLI grows.
	if scanned < 60 {
		t.Fatalf("scanned only %d command files — apps/cli/cmd has over ninety, so this guard is not "+
			"seeing the directory and every assertion above is vacuous", scanned)
	}
}
