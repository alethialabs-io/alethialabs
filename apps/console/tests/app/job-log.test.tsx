// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6818 — the job's log pane. Four things a reader of a running deploy depends on:
//
//   · what it says while the job has written nothing is true of the job's STATUS (D-07): queued is
//     a wait for a runner, claimed and running are not;
//   · the strip above the log says where the stream stands — connecting, live, disconnected with a
//     way back — and says nothing for a log that is simply complete (D-05, D-15);
//   · it follows the end only while the reader is at the end (D-06);
//   · it draws a window of a long log, not all of it (D-14).
//
// jsdom has no layout, so scrolling is driven by setting the scroller's three measurements and
// firing the event; what is pinned is the decision the pane takes from them.

import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobLog, type JobLogProps, LOG_WINDOW, RUNNER_WAIT_NOTICE_MS } from "@/app/(private)/[org]/~/jobs/[id]/job-log";
import type { JobLogEntry } from "@/hooks/use-job-log-stream";

const T0 = new Date("2026-10-20T10:00:00.000Z");

/** `n` log lines, ids from 1. */
const lines = (n: number): JobLogEntry[] =>
	Array.from({ length: n }, (_, i) => ({
		id: i + 1,
		log_chunk: `output ${i + 1}`,
		stream_type: "STDOUT",
		created_at: T0.toISOString(),
	}));

/** Renders the pane for a running job with a live stream, unless told otherwise. */
function renderLog(props: Partial<JobLogProps> = {}) {
	const onReconnect = vi.fn();
	const view = render(
		<JobLog
			logs={[]}
			status="PROCESSING"
			active
			createdAt={T0}
			org="acme"
			stream="open"
			onReconnect={onReconnect}
			{...props}
		/>,
	);
	return { ...view, onReconnect };
}

/** The scrollable log region. */
const scroller = (): HTMLElement => screen.getByRole("region", { name: "Job log" });

/** Puts the scroller at `top` of a `height`-tall content in a 400px pane, and fires the scroll. */
function scrollTo(top: number, height = 4_000): void {
	const el = scroller();
	Object.defineProperty(el, "scrollHeight", { configurable: true, value: height });
	Object.defineProperty(el, "clientHeight", { configurable: true, value: 400 });
	el.scrollTop = top;
	fireEvent.scroll(el);
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(T0);
});
afterEach(() => {
	vi.useRealTimers();
});

describe("a job that has written nothing says what its status means", () => {
	it("queued: waiting for a runner", () => {
		renderLog({ status: "QUEUED" });
		expect(screen.getByText("Waiting for a runner")).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: "View runners" })).toBeNull();
	});

	it("queued for longer than the threshold: says how long, and points at the runners", () => {
		vi.setSystemTime(new Date(T0.getTime() + RUNNER_WAIT_NOTICE_MS + 60_000));
		renderLog({ status: "QUEUED" });
		expect(screen.getByText("Still waiting for a runner")).toBeInTheDocument();
		expect(screen.getByText(/No runner has claimed this job in 3 min\./)).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "View runners" })).toHaveAttribute("href", "/acme/~/runners");
	});

	it("claimed: a runner has it — never 'waiting for a runner'", () => {
		renderLog({ status: "CLAIMED" });
		expect(screen.getByText("A runner has claimed this job")).toBeInTheDocument();
		expect(screen.queryByText(/waiting for a runner/i)).toBeNull();
	});

	it("running: started, no output yet — never 'waiting for a runner'", () => {
		renderLog({ status: "PROCESSING" });
		expect(screen.getByText("Running — no output yet")).toBeInTheDocument();
		expect(screen.queryByText(/waiting for a runner/i)).toBeNull();
	});

	it("finished with no output: no logs were recorded", () => {
		renderLog({ status: "SUCCESS", active: false, stream: null });
		expect(screen.getByText("No logs recorded for this job.")).toBeInTheDocument();
	});
});

describe("the strip says where the stream stands", () => {
	const strip = (container: HTMLElement): HTMLElement => {
		const el = container.querySelector<HTMLElement>('[data-slot="job-log-strip"]');
		if (!el) throw new Error("the log strip is not drawn");
		return el;
	};

	it("counts the lines, whatever the stream is doing", () => {
		expect(strip(renderLog({ logs: lines(1) }).container)).toHaveTextContent("1 line");
		expect(strip(renderLog({ logs: lines(12), stream: null, active: false }).container)).toHaveTextContent("12 lines");
	});

	it("connecting", () => {
		renderLog({ stream: "connecting" });
		expect(screen.getByRole("status")).toHaveTextContent("Connecting to the live log…");
	});

	it("live", () => {
		renderLog({ stream: "open" });
		expect(screen.getByRole("status")).toHaveTextContent("Live");
	});

	it("disconnected: says so, and Reconnect asks the stream to open again", () => {
		const { onReconnect } = renderLog({ stream: "closed", logs: lines(3) });
		const status = screen.getByRole("status");
		expect(status).toHaveTextContent("Live log disconnected");
		fireEvent.click(within(status).getByRole("button", { name: "Reconnect" }));
		expect(onReconnect).toHaveBeenCalledTimes(1);
	});

	it("a finished job whose remaining lines are on their way says that, not 'Live'", () => {
		renderLog({ status: "SUCCESS", active: false, stream: "open", logs: lines(3) });
		expect(screen.getByRole("status")).toHaveTextContent("Loading the rest of the log…");
		expect(screen.getByRole("status")).not.toHaveTextContent("Live");
	});

	it("a finished job whose remaining lines did not load offers a retry", () => {
		const { onReconnect } = renderLog({ status: "FAILED", active: false, stream: "closed", logs: lines(3) });
		expect(screen.getByRole("status")).toHaveTextContent("The rest of this log didn't load");
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(onReconnect).toHaveBeenCalledTimes(1);
	});

	it("a complete log has no stream to describe: nothing reads live, connecting or disconnected", () => {
		renderLog({ status: "SUCCESS", active: false, stream: null, logs: lines(3) });
		const status = screen.getByRole("status");
		expect(status.textContent).toBe("");
		expect(status).toHaveAttribute("data-stream", "none");
		expect(screen.queryByRole("button", { name: /reconnect|retry/i })).toBeNull();
	});

	it("a session that ended shows nothing here: the shell owns that", () => {
		renderLog({ stream: "signed-out", logs: lines(3) });
		expect(screen.getByRole("status").textContent).toBe("");
		expect(screen.queryByRole("button", { name: /reconnect|retry/i })).toBeNull();
	});

	it("is drawn at the same place in every state, so the log under it does not move", () => {
		const heights = (["connecting", "open", "closed", "signed-out", null] as const).map((stream) => {
			const view = renderLog({ stream, logs: lines(2) });
			const classes = strip(view.container).className;
			view.unmount();
			return classes.split(" ").filter((c) => c.startsWith("h-")).join(" ");
		});
		expect(new Set(heights)).toEqual(new Set(["h-9"]));
	});
});

describe("the pane follows the end only while the reader is at the end", () => {
	it("offers no way back while it is following", () => {
		renderLog({ logs: lines(50) });
		expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
	});

	it("stays at the end as lines arrive", () => {
		const view = renderLog({ logs: lines(50) });
		const el = scroller();
		Object.defineProperty(el, "scrollHeight", { configurable: true, value: 9_000 });
		view.rerender(
			<JobLog logs={lines(51)} status="PROCESSING" active createdAt={T0} org="acme" stream="open" onReconnect={vi.fn()} />,
		);
		expect(el.scrollTop).toBe(9_000);
	});

	it("stops following when the reader scrolls away, and does not pull them back when a line arrives", () => {
		const view = renderLog({ logs: lines(50) });
		scrollTo(1_000);
		expect(screen.getByRole("button", { name: "Jump to latest" })).toBeInTheDocument();

		view.rerender(
			<JobLog logs={lines(51)} status="PROCESSING" active createdAt={T0} org="acme" stream="open" onReconnect={vi.fn()} />,
		);
		expect(scroller().scrollTop).toBe(1_000);
	});

	it("Jump to latest goes back to the end and follows again", () => {
		renderLog({ logs: lines(50) });
		scrollTo(1_000);
		fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
		expect(scroller().scrollTop).toBe(4_000);
		expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
	});

	it("scrolling back to the end by hand follows again too", () => {
		renderLog({ logs: lines(50) });
		scrollTo(1_000);
		expect(screen.getByRole("button", { name: "Jump to latest" })).toBeInTheDocument();
		// 4000 tall, 400 visible: 3600 is the end.
		scrollTo(3_600);
		expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
	});

	it("the scroller can be reached and scrolled from the keyboard, and says what it is", () => {
		renderLog({ logs: lines(5) });
		expect(scroller()).toHaveAttribute("tabindex", "0");
	});
});

describe("a long log is drawn as a window", () => {
	it("draws the newest lines and says how many earlier ones it left out", () => {
		renderLog({ logs: lines(LOG_WINDOW + 500), status: "SUCCESS", active: false, stream: null });
		expect(screen.queryByText("output 500")).toBeNull();
		expect(screen.getByText("output 501")).toBeInTheDocument();
		expect(screen.getByText(`output ${LOG_WINDOW + 500}`)).toBeInTheDocument();
		expect(screen.getByText("500 earlier lines are not drawn")).toBeInTheDocument();
	});

	it("numbers a line by its place in the whole log, not in the window", () => {
		renderLog({ logs: lines(LOG_WINDOW + 500), status: "SUCCESS", active: false, stream: null });
		const row = screen.getByText("output 501").parentElement;
		expect(row).toHaveTextContent(/^501/);
	});

	it("Show earlier lines draws the window before it, and stops following so they can be read", () => {
		renderLog({ logs: lines(LOG_WINDOW + 500), status: "SUCCESS", active: false, stream: null });
		fireEvent.click(screen.getByRole("button", { name: "Show earlier lines" }));
		expect(screen.getByText("output 1")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Show earlier lines" })).toBeNull();
		expect(screen.getByRole("button", { name: "Jump to latest" })).toBeInTheDocument();
	});

	it("a short log is drawn whole, with nothing to show earlier", () => {
		renderLog({ logs: lines(40), status: "SUCCESS", active: false, stream: null });
		expect(screen.getByText("output 1")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Show earlier lines" })).toBeNull();
	});

	it("while the reader is away from the end the window's first line is pinned: new output does not take it away", () => {
		const view = renderLog({ logs: lines(LOG_WINDOW + 10) });
		expect(screen.getByText("output 11")).toBeInTheDocument();
		scrollTo(1_000);
		view.rerender(
			<JobLog
				logs={lines(LOG_WINDOW + 400)}
				status="PROCESSING"
				active
				createdAt={T0}
				org="acme"
				stream="open"
				onReconnect={vi.fn()}
			/>,
		);
		// Following, the window would have slid to start at line 401.
		expect(screen.getByText("output 11")).toBeInTheDocument();
		expect(screen.getByText(`output ${LOG_WINDOW + 400}`)).toBeInTheDocument();
	});
});
