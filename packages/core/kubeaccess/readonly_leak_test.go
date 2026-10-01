// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package kubeaccess

import (
	"context"
	"encoding/base64"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// canary is a token value that must never appear in an error or a log line.
const canary = "CANARY-eyJhbGciOiJSUzI1NiJ9-do-not-print"

// assertNoCanary fails if err (in any rendering) carries the canary.
func assertNoCanary(t *testing.T, what string, err error) {
	t.Helper()
	if err == nil {
		t.Errorf("%s: expected an error", what)
		return
	}
	for _, s := range []string{err.Error(), fmt.Sprintf("%+v", err), fmt.Sprintf("%#v", err)} {
		if strings.Contains(s, canary) || strings.Contains(s, "CANARY") {
			t.Errorf("%s: the error carries the token: %s", what, s)
		}
	}
}

// TestNoTokenInErrors drives every error path that holds a token at the moment it fails — in the
// mint (the server's answer carries one), the client (the bearer is configured) and the renderer
// (the credential is the input) — and requires that no error renders it.
func TestNoTokenInErrors(t *testing.T) {
	ctx := context.Background()
	answers := map[string]func(int64) map[string]any{
		"expired": func(int64) map[string]any {
			return map[string]any{"token": canary, "expirationTimestamp": time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)}
		},
		"extended": func(int64) map[string]any {
			return map[string]any{"token": canary, "expirationTimestamp": time.Now().Add(9 * time.Hour).UTC().Format(time.RFC3339)}
		},
		"unparsable expiry": func(int64) map[string]any {
			return map[string]any{"token": canary, "expirationTimestamp": "tomorrow " + canary}
		},
	}
	for name, answer := range answers {
		srv := newFakeAPIServer()
		mustEnsure(t, fakeKube{srv}, defaultOpts)
		srv.tokenResponse = answer
		_, err := MintReadOnlyToken(ctx, fakeKube{srv}, defaultOpts, time.Hour)
		assertNoCanary(t, "mint/"+name, err)
	}
	// A body that is not JSON but contains the token (a truncated answer, a proxy's page).
	for _, raw := range []string{`{"status":{"token":"` + canary + `"`, `{"status":{"token":` + canary + `}}`, `{"status":{"token":"` + canary + `","expirationTimestamp":5}}`} {
		srv := newFakeAPIServer()
		mustEnsure(t, fakeKube{srv}, defaultOpts)
		srv.rawTokenBody = raw
		_, err := MintReadOnlyToken(ctx, fakeKube{srv}, defaultOpts, time.Hour)
		assertNoCanary(t, "mint/raw "+raw[:20], err)
	}

	// The client: every refusal and a transport failure, with the bearer set.
	for name, conn := range map[string]Conn{
		"bad server":       {Server: "http://x", CAData: testCAData, Token: canary},
		"no CA":            {Server: "https://x", Token: canary},
		"cert as canary":   {Server: "https://x", CAData: testCAData, ClientCertData: canary, ClientKeyData: canary},
		"cert+key b64 bad": {Server: "https://x", CAData: testCAData, ClientCertData: base64.StdEncoding.EncodeToString([]byte(canary)), ClientKeyData: base64.StdEncoding.EncodeToString([]byte(canary))},
		"both":             {Server: "https://x", CAData: testCAData, Token: canary, ClientCertData: canary},
	} {
		_, err := NewClient(conn)
		assertNoCanary(t, "client/"+name, err)
	}
	c, err := NewClient(Conn{Server: "https://127.0.0.1:1", CAData: testCAData, Token: canary, Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	err = EnsureReadOnlyAccess(ctx, c, defaultOpts)
	assertNoCanary(t, "client/unreachable ensure", err)
	_, err = MintReadOnlyToken(ctx, c, defaultOpts, time.Hour)
	assertNoCanary(t, "client/unreachable mint", err)

	// The renderer: every refusal with the credential as input.
	bad := testTarget
	bad.CAData = ""
	for name, f := range map[string]func() error{
		"static no CA": func() error { _, e := RenderStaticKubeconfig(bad, StaticCredential{Token: canary}); return e },
		"static whitespace": func() error {
			_, e := RenderStaticKubeconfig(testTarget, StaticCredential{Token: canary + " x"})
			return e
		},
		"static two": func() error {
			_, e := RenderStaticKubeconfig(testTarget, StaticCredential{Token: canary, ClientKeyData: canary})
			return e
		},
		"static bad cert": func() error {
			_, e := RenderStaticKubeconfig(testTarget, StaticCredential{ClientCertData: canary, ClientKeyData: canary})
			return e
		},
		"exec credential zero": func() error { _, e := RenderExecCredential(canary, time.Time{}); return e },
	} {
		assertNoCanary(t, "render/"+name, f())
	}
}

// TestNoLoggingInThePackage: the package's non-test source imports no logger and calls no fmt
// printer, so there is no log line for a token to reach. Errors are its only output.
func TestNoLoggingInThePackage(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	checked := 0
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		parsed, err := parser.ParseFile(token.NewFileSet(), f, src, parser.ImportsOnly|parser.SkipObjectResolution)
		if err != nil {
			t.Fatal(err)
		}
		for _, imp := range parsed.Imports {
			p, _ := strconv.Unquote(imp.Path.Value)
			if p == "log" || p == "log/slog" || strings.Contains(p, "zap") || strings.Contains(p, "logrus") {
				t.Errorf("%s imports the logger %s", f, p)
			}
		}
		full, err := parser.ParseFile(token.NewFileSet(), f, src, parser.SkipObjectResolution)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(full, func(n ast.Node) bool {
			sel, ok := n.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			if id, ok := sel.X.(*ast.Ident); ok && id.Name == "fmt" && (strings.HasPrefix(sel.Sel.Name, "Print") ||
				(strings.HasPrefix(sel.Sel.Name, "Fprint") && !inFormatMethod(full, sel))) {
				t.Errorf("%s calls fmt.%s", f, sel.Sel.Name)
			}
			return true
		})
		checked++
	}
	if checked < 4 {
		t.Fatalf("scanned %d source files; the glob is not seeing the package", checked)
	}
}

// inFormatMethod reports whether n sits inside a method named Format (a fmt.Formatter writing to
// the fmt.State it was handed, which is the redaction itself).
func inFormatMethod(file *ast.File, n ast.Node) bool {
	for _, d := range file.Decls {
		fd, ok := d.(*ast.FuncDecl)
		if ok && fd.Recv != nil && fd.Name.Name == "Format" && fd.Pos() <= n.Pos() && n.End() <= fd.End() {
			return true
		}
	}
	return false
}
