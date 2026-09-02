// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package core_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The core packages have one human-facing render that is deliberately held until #3768 moves
// Infracost output to the shared formatter. Exemptions are issue-backed decisions, not a mute list.
var renderExemptions = map[string]string{
	"infracost/infracost.go": "#3768: Infracost's external summary remains a documented migration exception",
}

var moneyLiteral = regexp.MustCompile(`[$€£¥]%[-+ #0-9.*']*[a-zA-Z]`)

type renderFinding struct {
	kind string
	text string
}

// scanCoreSource finds human-facing duration and currency renders in one Go source file.
func scanCoreSource(filename, source string) []renderFinding {
	file, err := parser.ParseFile(token.NewFileSet(), filename, source, 0)
	if err != nil {
		return []renderFinding{{kind: "parse", text: err.Error()}}
	}
	findings := make([]renderFinding, 0)
	ast.Inspect(file, func(node ast.Node) bool {
		switch n := node.(type) {
		case *ast.BasicLit:
			if n.Kind == token.STRING && moneyLiteral.MatchString(strings.Trim(n.Value, "`\"")) {
				findings = append(findings, renderFinding{kind: "money", text: n.Value})
			}
		case *ast.CallExpr:
			if !isPrintfCall(n) || len(n.Args) < 1 {
				return true
			}
			format, ok := n.Args[0].(*ast.BasicLit)
			if !ok || format.Kind != token.STRING || !strings.Contains(format.Value, "%") {
				return true
			}
			for _, arg := range n.Args[1:] {
				if containsDuration(arg) {
					findings = append(findings, renderFinding{kind: "duration", text: format.Value})
					break
				}
			}
		}
		return true
	})
	return findings
}

// isPrintfCall identifies the standard-library calls whose first string argument is a human render.
func isPrintfCall(call *ast.CallExpr) bool {
	selector, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	return selector.Sel.Name == "Printf" || selector.Sel.Name == "Sprintf"
}

// containsDuration reports whether an expression exposes a duration to a human formatter.
func containsDuration(node ast.Expr) bool {
	var found bool
	ast.Inspect(node, func(child ast.Node) bool {
		call, ok := child.(*ast.CallExpr)
		if !ok {
			return true
		}
		if selector, ok := call.Fun.(*ast.SelectorExpr); ok {
			if selector.Sel.Name == "Duration" {
				if ident, ok := selector.X.(*ast.Ident); ok && ident.Name == "format" {
					return false
				}
			}
			if selector.Sel.Name == "Since" {
				if ident, ok := selector.X.(*ast.Ident); ok && ident.Name == "time" {
					found = true
				}
			}
			if selector.Sel.Name == "String" && durationReceiver(selector.X) {
				found = true
			}
		}
		return !found
	})
	return found
}

// durationReceiver identifies the direct duration-producing expressions this guard can prove safely.
func durationReceiver(node ast.Expr) bool {
	call, ok := node.(*ast.CallExpr)
	if !ok {
		return false
	}
	selector, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	if selector.Sel.Name == "Since" {
		ident, ok := selector.X.(*ast.Ident)
		return ok && ident.Name == "time"
	}
	if selector.Sel.Name == "Duration" {
		ident, ok := selector.X.(*ast.Ident)
		return ok && ident.Name == "time"
	}
	return false
}

func TestHygCoreRender_NoUnsharedHumanRenders(t *testing.T) {
	findings := map[string][]renderFinding{}
	scanned := 0
	err := filepath.Walk(".", func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			if path == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") || path == "hyg_core_render_test.go" {
			return nil
		}
		source, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		scanned++
		if matches := scanCoreSource(path, string(source)); len(matches) > 0 {
			findings[path] = matches
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if scanned < 100 {
		t.Fatalf("scanned only %d core files — the guard is not seeing packages/core, so its census is vacuous", scanned)
	}
	for file, matches := range findings {
		if reason, exempt := renderExemptions[file]; exempt {
			if strings.TrimSpace(reason) == "" {
				t.Errorf("%s is exempted with no issue-backed reason", file)
			}
			continue
		}
		t.Errorf("%s contains unshared human render(s): %v — use packages/core/format", file, matches)
	}
}

func TestHygCoreRender_DetectorSpeaksAndRespectsMachineBoundaries(t *testing.T) {
	cases := map[string]bool{
		`package p; import ("fmt"; "time"); func f(){ fmt.Printf("elapsed: %s", time.Since(time.Now())) }`:                  true,
		`package p; import ("fmt"; "time"); func f(){ fmt.Printf("elapsed: %s", format.Duration(time.Since(time.Now()))) }`: false,
		`package p; import ("fmt"; "time"); func f(){ fmt.Printf("cost: $%.2f", 1.25) }`:                                    true,
		"package p; func f(){ _ = \"cost: $12.50\" }":                                                                       false,
		`package p; import ("os/exec"; "time"); func f(){ exec.Command("tool", time.Since(time.Now()).String()) }`:          false,
	}
	for source, want := range cases {
		got := len(scanCoreSource("fixture.go", source)) > 0
		if got != want {
			t.Errorf("scanCoreSource() = %v for %q, want %v", got, source, want)
		}
	}
}
