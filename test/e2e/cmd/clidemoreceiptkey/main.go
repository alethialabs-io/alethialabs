// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// clidemoreceiptkey makes the ONE throwaway receipt-signing key a cli-demo run shares between its
// runner and its CI console (#5098). The whole argument is on test/e2e/t2_cli_demo_receipt_key.go,
// and all the logic is e2e.EmitCLIDemoReceiptKey, which the pure test runs directly.
//
// It writes the key to a new 0600 file in --dir and appends only the file's PATH to --github-env
// as ALETHIA_E2E_CLI_DEMO_RECEIPT_KEY_FILE. Its stdout is exactly one `::add-mask::` workflow
// command, so the key is redacted from every later line of the job log, even though nothing is
// meant to print it. Never redirect stdout into $GITHUB_ENV: the key would land in the env file.
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/alethialabs-io/alethialabs/test/e2e"
)

// main parses the two flags and runs EmitCLIDemoReceiptKey.
func main() {
	dir := flag.String("dir", "", "directory to write the key file into (the job's $RUNNER_TEMP)")
	githubEnv := flag.String("github-env", "", "the $GITHUB_ENV file to append the key file's PATH to")
	flag.Parse()
	if *dir == "" || *githubEnv == "" {
		fmt.Fprintln(os.Stderr, "clidemoreceiptkey: --dir and --github-env are both required")
		os.Exit(2)
	}
	path, err := e2e.EmitCLIDemoReceiptKey(*dir, *githubEnv, os.Stdout)
	if err != nil {
		fmt.Fprintf(os.Stderr, "clidemoreceiptkey: %v\n", err)
		os.Exit(1)
	}
	fmt.Fprintf(os.Stderr, "clidemoreceiptkey: wrote this run's receipt key to %s (0600); %s names it\n",
		path, e2e.CLIDemoReceiptKeyFileEnv)
}
