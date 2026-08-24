// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package tfaddr normalises OpenTofu/Terraform resource addresses. It exists as a leaf so the
// engines that look a planned resource up in the plan's CONFIGURATION — `verify` (the elench
// control set) and `drift` (the classifier) — share one implementation. They diverged once:
// `drift` was depth-aware while `verify` truncated at the first bracket, so every resource inside
// a count-ed module was invisible to `verify`'s config-aware controls (#2361).
package tfaddr

import "strings"

// ConfigAddress strips EVERY instance key from a resource address so it matches a configuration
// address, which is never instance-keyed:
//
//	module.vnet[0].azurerm_subnet.private -> module.vnet.azurerm_subnet.private
//	aws_instance.x["a.b"]                 -> aws_instance.x
//
// Truncating at the FIRST '[' is the wrong shape and was the bug behind #2361: in a module-nested
// address the first bracket is the MODULE's instance key, so `module.vnet[0].azurerm_subnet.private`
// collapsed to "module.vnet" and matched no configuration — and every module in
// infra/templates/project/{azure,gcp} uses count. Splitting on '.' is wrong for the same class of
// reason: a for_each key may contain '.', '[' or ']'. So this is bracket-depth and quote aware,
// which also means a malformed address degrades to the right prefix instead of leaking a stray ']'.
func ConfigAddress(addr string) string {
	var sb strings.Builder
	depth, inQuote, escaped := 0, false, false
	for i := 0; i < len(addr); i++ {
		c := addr[i]
		if depth == 0 {
			if c == '[' {
				depth++
				continue
			}
			sb.WriteByte(c)
			continue
		}
		switch {
		case escaped:
			escaped = false
		case c == '\\':
			escaped = true
		case c == '"':
			inQuote = !inQuote
		case inQuote:
			// A bracket inside a quoted for_each key is literal, not structural.
		case c == '[':
			depth++
		case c == ']':
			depth--
		}
	}
	return sb.String()
}
