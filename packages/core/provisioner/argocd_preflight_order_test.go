// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A guard that runs after its own side effects cannot tell a fresh cluster from one it just
// touched.
//
// THE DEFECT THIS PINS. `installArgoCD` seeds the argocd-redis secret via `ensureArgoRedisSecret`,
// and that function's FIRST act is `kubectl create namespace argocd … | kubectl apply -f -`. It
// creates the namespace and writes a Secret into it. If the live-ArgoCD version preflight
// (#3126 item 2) were placed after it, the probe would still answer honestly — but the operator's
// cluster would already have been written to by the very deploy the check exists to stop, and the
// refusal would then be a refusal AFTER the first mutation rather than before it.
//
// It is an ORDERING property, which no unit test of either function can see and which no reviewer
// reliably notices in a 200-line function: moving one statement down compiles, lints, gofmts and
// keeps every other test green. So the order is asserted structurally, on the source itself.
package provisioner

import (
	"go/ast"
	"go/parser"
	"go/token"
	"strconv"
	"strings"
	"testing"
)

// TestArgoVersionPreflightRunsBeforeAnyClusterWrite asserts the preflight is the first thing
// installArgoCD does, ahead of `helm repo add` and — the one that matters — ahead of
// ensureArgoRedisSecret, which creates the namespace.
func TestArgoVersionPreflightRunsBeforeAnyClusterWrite(t *testing.T) {
	const file = "deploy.go"
	fset := token.NewFileSet()
	parsed, err := parser.ParseFile(fset, file, nil, 0)
	if err != nil {
		// A guard that cannot read its subject has found NOTHING, not "nothing wrong".
		t.Fatalf("could not parse %s, so this guard proved nothing: %v", file, err)
	}

	var fn *ast.FuncDecl
	for _, decl := range parsed.Decls {
		if d, ok := decl.(*ast.FuncDecl); ok && d.Name.Name == "installArgoCD" && d.Recv == nil {
			fn = d
			break
		}
	}
	if fn == nil || fn.Body == nil {
		t.Fatalf("installArgoCD was not found in %s — this guard proved nothing", file)
	}

	// Positions are collected by walking the whole body, so a call nested inside an `if` or a
	// helper closure is still located rather than silently skipped.
	const notFound = -1
	preflight, redisSecret, repoAdd := notFound, notFound, notFound
	note := func(slot *int, pos token.Pos) {
		if *slot == notFound || int(pos) < *slot {
			*slot = int(pos)
		}
	}
	ast.Inspect(fn.Body, func(n ast.Node) bool {
		switch node := n.(type) {
		case *ast.SelectorExpr:
			// argocd.PreflightLiveArgoVersion(...)
			if pkg, ok := node.X.(*ast.Ident); ok && pkg.Name == "argocd" && node.Sel.Name == "PreflightLiveArgoVersion" {
				note(&preflight, node.Pos())
			}
		case *ast.Ident:
			if node.Name == "ensureArgoRedisSecret" {
				note(&redisSecret, node.Pos())
			}
		case *ast.BasicLit:
			if node.Kind != token.STRING {
				return true
			}
			v, uerr := strconv.Unquote(node.Value)
			if uerr != nil {
				v = node.Value
			}
			if strings.Contains(v, "helm repo add") {
				note(&repoAdd, node.Pos())
			}
		}
		return true
	})

	// Each landmark must be FOUND. "Nothing to compare" and "the order is right" print the same
	// result otherwise, and a renamed helper would silently retire the guard.
	for _, landmark := range []struct {
		name string
		at   int
	}{
		{"argocd.PreflightLiveArgoVersion", preflight},
		{"ensureArgoRedisSecret", redisSecret},
		{"the `helm repo add` command", repoAdd},
	} {
		if landmark.at == notFound {
			t.Fatalf("%s was not found inside installArgoCD — this guard proved nothing. "+
				"If it was renamed, update this test; if it was REMOVED, that is the defect.", landmark.name)
		}
	}

	if preflight > redisSecret {
		t.Errorf("the live-ArgoCD version preflight (%s) runs AFTER ensureArgoRedisSecret (%s).\n"+
			"ensureArgoRedisSecret CREATES the argocd namespace and writes a Secret into it, so a check placed "+
			"after it can no longer refuse before the deploy has mutated the operator's cluster. Move the "+
			"preflight to the first statement of installArgoCD.",
			fset.Position(token.Pos(preflight)), fset.Position(token.Pos(redisSecret)))
	}
	if preflight > repoAdd {
		t.Errorf("the live-ArgoCD version preflight (%s) runs AFTER `helm repo add` (%s) — it must be the first "+
			"thing installArgoCD does, so a refusal costs neither a network round trip nor a mutation.",
			fset.Position(token.Pos(preflight)), fset.Position(token.Pos(repoAdd)))
	}
}
