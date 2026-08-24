// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package tfaddr

import "testing"

// TestConfigAddress pins the address normaliser. The module-nested rows are the ones that matter:
// they are what a first-bracket truncation gets wrong, and their ABSENCE from verify's own table
// (coverage_gaps_test.go, which only ever covered root-module addresses) is why #2361 stayed
// invisible. The root-module and malformed rows come from verify's table so nothing it used to
// assert is lost in the merge.
func TestConfigAddress(t *testing.T) {
	cases := map[string]string{
		// ── root module: an instance key is stripped, a bare address is untouched ──
		"azurerm_subnet.private":       "azurerm_subnet.private",
		"aws_instance.web[0]":          "aws_instance.web",
		`hcloud_server.workers["w-1"]`: "hcloud_server.workers",
		"hcloud_server.workers[0]":     "hcloud_server.workers",
		"hcloud_server.single":         "hcloud_server.single",

		// ── module-nested: the #2361 cases. A first-bracket truncation yields
		//    "module.vnet" / "module.m" / "module.a" and matches no configuration.
		"module.vnet[0].azurerm_subnet.private":     "module.vnet.azurerm_subnet.private",
		`module.m["k"].aws_instance.y["j"]`:         "module.m.aws_instance.y",
		"module.a[0].module.b[1].aws_instance.c[2]": "module.a.module.b.aws_instance.c",

		// ── keys containing the delimiters, which is why neither strings.Split(".")
		//    nor a bracket scan without quote tracking is safe ──
		`aws_instance.x["a.b"]`:  "aws_instance.x",
		`aws_instance.x["a[b]"]`: "aws_instance.x",
		`aws_instance.x["a\"b"]`: "aws_instance.x",

		// ── malformed input degrades to a prefix rather than leaking a stray bracket.
		//    Unquoted nested brackets are not a shape OpenTofu emits; depth tracking is
		//    why a single-level parser's "aws_instance.x]" does not happen here.
		"aws_instance.x[a[0]]": "aws_instance.x",
		// An unterminated key consumes the rest: there is no address to recover.
		"[weird": "",
	}
	for in, want := range cases {
		if got := ConfigAddress(in); got != want {
			t.Errorf("ConfigAddress(%q) = %q, want %q", in, got, want)
		}
	}
}
