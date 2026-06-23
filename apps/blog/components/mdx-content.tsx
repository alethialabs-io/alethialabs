// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import * as runtime from "react/jsx-runtime";
import { mdxComponents } from "@/components/mdx-components";

// velite's `s.mdx()` compiles each post body to a function-body string. We run it
// with the React jsx-runtime to get the component, then render with our components.
export function MDXContent({ code }: { code: string }) {
	const fn = new Function(code);
	const Component = fn({ ...runtime }).default;
	return <Component components={mdxComponents} />;
}
