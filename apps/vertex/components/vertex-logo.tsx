import type { SVGProps } from "react";

interface VertexLogoProps extends SVGProps<SVGSVGElement> {
	withText?: boolean;
}

/** Green sprout logo — icon-only or with "Vertex" wordmark. */
export function VertexLogo({ withText, ...props }: VertexLogoProps) {
	if (withText) {
		return (
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 100 24"
				fill="none"
				stroke="none"
				{...props}
			>
				{/* Sprout icon */}
				<rect x="11" y="11" width="2" height="11" rx="1" fill="#22c55e" />
				<path d="M13 13C13 7 17 3 22 2C21 7 17 11 13 13Z" fill="#22c55e" />
				<path d="M11 15C11 10 7 6 2 5C3 10 7 14 11 15Z" fill="#22c55e" />
				{/* Wordmark */}
				<text
					x="28"
					y="17.5"
					fill="currentColor"
					fontFamily="ui-sans-serif, system-ui, -apple-system, sans-serif"
					fontSize="15"
					fontWeight="600"
					letterSpacing="-0.02em"
				>
					Vertex
				</text>
			</svg>
		);
	}

	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="none"
			{...props}
		>
			<rect x="11" y="11" width="2" height="11" rx="1" fill="#22c55e" />
			<path d="M13 13C13 7 17 3 22 2C21 7 17 11 13 13Z" fill="#22c55e" />
			<path d="M11 15C11 10 7 6 2 5C3 10 7 14 11 15Z" fill="#22c55e" />
		</svg>
	);
}
