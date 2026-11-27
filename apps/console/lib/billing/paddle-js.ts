"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Paddle.js in the browser: load it once from Paddle's CDN (Paddle requires it be served from
// cdn.paddle.com, never bundled), initialise it with the PUBLIC client token, and open the overlay
// checkout for a transaction the SERVER created (`startCheckout`). The browser never names a price or
// an org: it only knows the transaction id.
//
// The console's Content-Security-Policy carries only `frame-ancestors` today (next.config.ts), which
// governs who may frame the console, not what the console loads. If fetch directives are added,
// Paddle.js needs script-src/style-src/img-src https://cdn.paddle.com, frame-src
// https://buy.paddle.com and https://sandbox-buy.paddle.com, and connect-src for Paddle's checkout
// service.

/** The CDN script Paddle.js v2 is served from. */
const PADDLE_JS_URL = "https://cdn.paddle.com/paddle/v2/paddle.js";

/** One event Paddle.js reports to `eventCallback`. */
interface PaddleJsEvent {
	name?: string;
}

/** The part of the Paddle.js global this module drives. */
interface PaddleJs {
	Environment: { set(environment: "sandbox"): void };
	Initialize(options: { token: string; eventCallback?: (event: PaddleJsEvent) => void }): void;
	Update?(options: { eventCallback?: (event: PaddleJsEvent) => void }): void;
	Checkout: {
		open(options: { transactionId: string; settings?: { displayMode?: "overlay"; theme?: "light" | "dark" } }): void;
		close?(): void;
	};
}

declare global {
	interface Window {
		Paddle?: PaddleJs;
	}
}

/** What opening a checkout needs: the server's start, and what to do when it ends. */
export interface PaddleCheckoutOptions {
	transactionId: string;
	clientToken: string;
	environment: "sandbox" | "live";
	/** The payment went through (`checkout.completed`). The webhook activates the purchase. */
	onCompleted: () => void;
	/** The overlay was closed without a completed payment. */
	onClosed: () => void;
}

let loading: Promise<PaddleJs> | null = null;
let initialisedWith: string | null = null;
/** The callbacks of the checkout currently open; Paddle.js takes one global event callback. */
let current: Pick<PaddleCheckoutOptions, "onCompleted" | "onClosed"> | null = null;
let completed = false;

/** Loads the Paddle.js script once per page. */
function loadPaddleJs(): Promise<PaddleJs> {
	if (window.Paddle) return Promise.resolve(window.Paddle);
	if (loading) return loading;
	loading = new Promise<PaddleJs>((resolve, reject) => {
		const script = document.createElement("script");
		script.src = PADDLE_JS_URL;
		script.async = true;
		script.onload = () => {
			if (window.Paddle) resolve(window.Paddle);
			else reject(new Error("Paddle.js loaded without defining Paddle"));
		};
		script.onerror = () => {
			loading = null;
			reject(new Error("Paddle.js could not be loaded"));
		};
		document.head.appendChild(script);
	});
	return loading;
}

/** Routes Paddle.js's events to the open checkout's callbacks. */
function onPaddleEvent(event: PaddleJsEvent): void {
	if (!current) return;
	if (event.name === "checkout.completed") {
		completed = true;
		current.onCompleted();
	} else if (event.name === "checkout.closed") {
		const closing = current;
		current = null;
		if (!completed) closing.onClosed();
	}
}

/**
 * Opens the overlay checkout for a server-created transaction. Rejects when Paddle.js cannot be
 * loaded (a blocker, the network); the caller shows its own error.
 */
export async function openPaddleCheckout(options: PaddleCheckoutOptions): Promise<void> {
	const paddle = await loadPaddleJs();
	if (initialisedWith !== options.clientToken) {
		if (options.environment === "sandbox") paddle.Environment.set("sandbox");
		paddle.Initialize({ token: options.clientToken, eventCallback: onPaddleEvent });
		initialisedWith = options.clientToken;
	}
	current = { onCompleted: options.onCompleted, onClosed: options.onClosed };
	completed = false;
	paddle.Checkout.open({ transactionId: options.transactionId, settings: { displayMode: "overlay" } });
}
