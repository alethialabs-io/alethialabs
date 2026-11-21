// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Command genschema writes the JSON Schema of alethia.yaml.
//
// The schema is generated from the types that read the file, and committed where the docs site
// serves it, at the URL `alethia export` writes into the first line of every file. Run it from
// apps/cli after changing a key of the file:
//
//	go run ./tools/genschema
//
// The test beside it fails when the committed file is not what this writes.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// defaultOut is the committed schema, relative to apps/cli. The docs site serves its `public`
// directory under /docs, which makes this file designfile.SchemaURL.
const defaultOut = "../docs/public/schemas/alethia-yaml/v1.json"

// run generates the schema and writes it to the path the arguments name, or to stdout for `-`.
func run(args []string, stdout io.Writer) error {
	flags := flag.NewFlagSet("genschema", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	out := flags.String("out", defaultOut, "file to write, or - for stdout")
	if err := flags.Parse(args); err != nil {
		return err
	}
	data, err := Generate()
	if err != nil {
		return err
	}
	if *out == "-" {
		_, err = stdout.Write(data)
		return err
	}
	if err := os.MkdirAll(filepath.Dir(*out), 0o755); err != nil {
		return err
	}
	return os.WriteFile(*out, data, 0o644)
}

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "genschema:", err)
		os.Exit(1)
	}
}
