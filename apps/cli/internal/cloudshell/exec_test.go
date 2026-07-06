// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cloudshell

import "testing"

func TestExtractBetweenMarkers(t *testing.T) {
	gcpOutput := `Setting up project...
==> Generating credential configuration...

--- START CONFIG (copy everything below until END CONFIG) ---
{"type":"external_account","audience":"//iam.googleapis.com/..."}
--- END CONFIG ---
`
	azureOutput := `Setup complete!

--- START CONFIG (machine-readable, parsed by the Alethia CLI) ---
tenant_id=11111111-1111-1111-1111-111111111111
client_id=22222222-2222-2222-2222-222222222222
subscription_id=33333333-3333-3333-3333-333333333333
--- END CONFIG ---`

	tests := []struct {
		name  string
		input string
		want  string
		found bool
	}{
		{
			name:  "gcp wif block",
			input: gcpOutput,
			want:  `{"type":"external_account","audience":"//iam.googleapis.com/..."}`,
			found: true,
		},
		{
			name:  "azure key value block",
			input: azureOutput,
			want: "tenant_id=11111111-1111-1111-1111-111111111111\n" +
				"client_id=22222222-2222-2222-2222-222222222222\n" +
				"subscription_id=33333333-3333-3333-3333-333333333333",
			found: true,
		},
		{
			name:  "missing start marker",
			input: "some output\n--- END CONFIG ---",
			want:  "",
			found: false,
		},
		{
			name:  "missing end marker",
			input: "--- START CONFIG ---\npayload without terminator",
			want:  "",
			found: false,
		},
		{
			name:  "start marker has no newline",
			input: "--- START CONFIG ---",
			want:  "",
			found: false,
		},
		{
			name:  "empty input",
			input: "",
			want:  "",
			found: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, found := extractBetweenMarkers(tt.input)
			if found != tt.found {
				t.Errorf("found = %v, want %v", found, tt.found)
			}
			if got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestShellQuote(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{name: "plain", input: "my-project", want: "'my-project'"},
		{name: "empty", input: "", want: "''"},
		{name: "embedded single quote", input: "it's", want: `'it'\''s'`},
		{name: "multiple quotes", input: "a'b'c", want: `'a'\''b'\''c'`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := shellQuote(tt.input); got != tt.want {
				t.Errorf("shellQuote(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestParseKeyValues(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  map[string]string
	}{
		{
			name:  "basic pairs",
			input: "tenant_id=abc\nclient_id=xyz",
			want:  map[string]string{"tenant_id": "abc", "client_id": "xyz"},
		},
		{
			name:  "surrounding spaces and blank lines",
			input: "  tenant_id = abc  \n\n  client_id =xyz\n",
			want:  map[string]string{"tenant_id": "abc", "client_id": "xyz"},
		},
		{
			name:  "line without equals is ignored",
			input: "tenant_id=abc\nnot a pair\nclient_id=xyz",
			want:  map[string]string{"tenant_id": "abc", "client_id": "xyz"},
		},
		{
			name:  "value containing equals keeps remainder",
			input: "token=a=b=c",
			want:  map[string]string{"token": "a=b=c"},
		},
		{
			name:  "empty input",
			input: "",
			want:  map[string]string{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseKeyValues(tt.input)
			if len(got) != len(tt.want) {
				t.Fatalf("got %d entries, want %d (%v)", len(got), len(tt.want), got)
			}
			for k, v := range tt.want {
				if got[k] != v {
					t.Errorf("got[%q] = %q, want %q", k, got[k], v)
				}
			}
		})
	}
}
