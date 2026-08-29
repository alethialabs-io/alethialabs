// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The `cli-demo` dimension must not be able to produce a green run until its beats are DRIVEN.
//
// #3303 landed the vehicle — the dimension resolves, exports its knob, takes a budget term, and its
// beat table is cross-checked against CLIDemoSteps. What it does not have is a caller. A dispatch
// today would provision a floor, assert the floor, and be recorded as a CLI-driven proof: the
// assertion would be TRUE and about the wrong thing, which is the one shape `commit-proof.sh`
// cannot catch, because the ArgoCD convergence in that bundle is real and measured.
//
// t2_provision_test.go therefore refuses the dimension outright. This test pins the refusal to the
// FACT that makes it necessary, so the two cannot drift: the day something drives the beats, the
// refusal must go, and this test is what says so.
package e2e

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"strings"
	"testing"
)

func TestCLIDemoDimensionCannotSilentlyProveNothing(t *testing.T) {
	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, ".", func(fi fs.FileInfo) bool {
		return strings.HasSuffix(fi.Name(), ".go")
	}, parser.ParseComments)
	if err != nil {
		t.Fatalf("parse test/e2e: %v", err)
	}
	if len(pkgs) == 0 {
		t.Fatal("parsed no packages — this guard would report green having read nothing")
	}

	// Read with go/parser rather than grepped: a text match cannot tell a call from the several
	// mentions of CLIDemoBeats in comments, and this file is itself one of them.
	var driven []string
	var refusedIn string
	for _, pkg := range pkgs {
		for name, f := range pkg.Files {
			base := name[strings.LastIndex(name, "/")+1:]
			for _, decl := range f.Decls {
				fn, ok := decl.(*ast.FuncDecl)
				if !ok || fn.Body == nil {
					continue
				}
				// DRIVEN means executed on a REAL RUN, which is a narrower thing than "iterated".
				// `ValidateCLIDemoBeats` walks the same slice to cross-check the two tables, and the
				// pure tests walk it to assert the table's own shape — neither performs a beat
				// against a cluster. So the only places that count are the tier's own test file and
				// any non-test helper it could call.
				isPure := strings.HasSuffix(base, "_pure_test.go")
				isRealRun := base == "t2_provision_test.go" || !strings.HasSuffix(base, "_test.go")
				if isPure || !isRealRun || fn.Name.Name == "ValidateCLIDemoBeats" {
					continue
				}
				ast.Inspect(fn.Body, func(n ast.Node) bool {
					rng, ok := n.(*ast.RangeStmt)
					if !ok {
						return true
					}
					if id, ok := rng.X.(*ast.Ident); ok && id.Name == "CLIDemoBeats" {
						driven = append(driven, base+":"+fn.Name.Name)
					}
					return true
				})
				ast.Inspect(fn.Body, func(n ast.Node) bool {
					call, ok := n.(*ast.CallExpr)
					if !ok {
						return true
					}
					id, ok := call.Fun.(*ast.Ident)
					if ok && id.Name == "CLIDemoProvisionEnabled" && base == "t2_provision_test.go" {
						refusedIn = base
					}
					return true
				})
			}
		}
	}

	if len(driven) == 0 && refusedIn == "" {
		t.Fatal("nothing drives CLIDemoBeats AND t2_provision_test.go does not refuse the dimension — " +
			"a `cli-demo` dispatch would provision a floor, assert the floor, and be recorded as a " +
			"CLI-driven proof. Either drive the beats or restore the refusal.")
	}
	if len(driven) > 0 && refusedIn != "" {
		t.Fatalf("the beats are now driven (%v) AND t2_provision_test.go still refuses the dimension — "+
			"remove the refusal, or the dimension can never run the thing it now has.", driven)
	}
}
