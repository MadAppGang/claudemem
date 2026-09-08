/**
 * Black-box tests for `probeTerminalBackground(io, timeoutMs)` written from
 * the NFRs ("bounded 100–250 ms", "restore raw-mode/stdin state on every
 * path, including timeout", "leave stdin in a state OpenTUI can take over")
 * and the §4 contract ("must never throw").
 *
 * Complements `theme-probe.test.ts` with: the default timeout on a fake tty,
 * the restore call itself throwing, a synchronous EPIPE, Ctrl-C forwarding,
 * a reply arriving after the deadline, back-to-back independence, the upper
 * bound on the timeout path, and the OpenTUI hand-off post-conditions.
 */

import { describe, expect, it, mock, spyOn } from "bun:test";
import { PassThrough } from "node:stream";
import {
	OSC11_PROBE_TIMEOUT_MS,
	type ProbeIo,
	probeTerminalBackground,
} from "../../../src/ui/theme-detect.js";

const ESC = "\x1b";
const BEL = "\x07";
const QUERY = `${ESC}]11;?${BEL}`;
const WHITE_REPLY = `${ESC}]11;rgb:ffff/ffff/ffff${BEL}`;
const BLACK_REPLY = `${ESC}]11;rgb:0000/0000/0000${BEL}`;

type FakeStdin = PassThrough & {
	isTTY?: boolean;
	isRaw?: boolean;
	setRawMode?: (raw: boolean) => void;
};

interface FakeTerminal {
	io: ProbeIo;
	stdin: FakeStdin;
	setRawMode: ReturnType<typeof mock<(raw: boolean) => void>>;
	pause: ReturnType<typeof mock<() => PassThrough>>;
	written: () => string;
	reply: (text: string) => void;
}

function makeTerminal(
	opts: {
		isRaw?: boolean;
		/** Throw on the Nth setRawMode call (1-based). */
		throwOnCall?: number;
	} = {},
): FakeTerminal {
	const stdin = new PassThrough() as FakeStdin;
	stdin.isTTY = true;
	stdin.isRaw = opts.isRaw ?? false;

	let calls = 0;
	const setRawMode = mock((raw: boolean): void => {
		calls += 1;
		if (opts.throwOnCall === calls) throw new Error("EIO");
		stdin.isRaw = raw;
	});
	stdin.setRawMode = setRawMode;

	const originalPause = stdin.pause.bind(stdin);
	const pause = mock((): PassThrough => originalPause());
	stdin.pause = pause;

	const stdout = new PassThrough() as PassThrough & { isTTY?: boolean };
	stdout.isTTY = true;
	const chunks: string[] = [];
	stdout.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));

	return {
		io: { stdin, stdout } as unknown as ProbeIo,
		stdin,
		setRawMode,
		pause,
		written: () => chunks.join(""),
		reply: (text) => {
			stdin.write(text);
		},
	};
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** The OpenTUI hand-off contract: cooked, paused, no listener of ours. */
function expectHandoffReady(t: FakeTerminal, expectRaw = false): void {
	expect(t.stdin.isRaw).toBe(expectRaw);
	expect(t.stdin.listenerCount("data")).toBe(0);
	expect(t.stdin.readableFlowing).not.toBe(true);
	expect(t.pause).toHaveBeenCalled();
}

describe("probeTerminalBackground (black box)", () => {
	it("PR-01: the query bytes start with ESC ] 11 ; ? BEL", async () => {
		const t = makeTerminal();
		const p = probeTerminalBackground(t.io, 500);
		await tick();
		t.reply(WHITE_REPLY);
		await expect(p).resolves.toBe("light");
		expect(t.written().startsWith(QUERY)).toBe(true);
		expectHandoffReady(t);
	});

	it("PR-05: the timeout path resolves within a tight upper bound and restores", async () => {
		const t = makeTerminal();
		const started = performance.now();
		await expect(probeTerminalBackground(t.io, 20)).resolves.toBeNull();
		const elapsed = performance.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(15);
		expect(elapsed).toBeLessThanOrEqual(150);
		expect(t.setRawMode.mock.calls.map((c) => c[0])).toEqual([true, false]);
		expectHandoffReady(t);
	});

	it("PR-07: with no timeout argument a mute tty resolves null within the default bound", async () => {
		const t = makeTerminal();
		const started = performance.now();
		await expect(probeTerminalBackground(t.io)).resolves.toBeNull();
		const elapsed = performance.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(OSC11_PROBE_TIMEOUT_MS - 10);
		expect(elapsed).toBeLessThanOrEqual(OSC11_PROBE_TIMEOUT_MS + 150);
		expectHandoffReady(t);
	});

	it("PR-12: setRawMode(false) throwing on restore still resolves the reply and cleans up", async () => {
		const t = makeTerminal({ throwOnCall: 2 });
		const p = probeTerminalBackground(t.io, 500);
		await tick();
		t.reply(BLACK_REPLY);
		await expect(p).resolves.toBe("dark");
		expect(t.setRawMode.mock.calls.map((c) => c[0])).toEqual([true, false]);
		expect(t.stdin.listenerCount("data")).toBe(0);
		expect(t.pause).toHaveBeenCalled();
	});

	it("PR-13: a synchronous EPIPE from stdout.write yields null, never rejects, and restores", async () => {
		const t = makeTerminal();
		const stdout = t.io.stdout as unknown as PassThrough;
		stdout.write = ((): boolean => {
			throw Object.assign(new Error("EPIPE"), { code: "EPIPE" });
		}) as typeof stdout.write;

		await expect(probeTerminalBackground(t.io, 500)).resolves.toBeNull();
		const rawCalls = t.setRawMode.mock.calls.map((c) => c[0]);
		if (rawCalls.length > 0) {
			expect(rawCalls[0]).toBe(true);
			expect(rawCalls[rawCalls.length - 1]).toBe(false);
		}
		expect(t.stdin.isRaw).toBe(false);
		expect(t.stdin.listenerCount("data")).toBe(0);
	});

	it("PR-14: a previously raw stdin is restored to raw, not blindly to cooked", async () => {
		const t = makeTerminal({ isRaw: true });
		const p = probeTerminalBackground(t.io, 500);
		await tick();
		t.reply(WHITE_REPLY);
		await expect(p).resolves.toBe("light");
		expectHandoffReady(t, true);
	});

	it("PR-15: Ctrl-C during the probe restores stdin, resolves null, and re-raises SIGINT", async () => {
		const kill = spyOn(process, "kill").mockImplementation(() => true);
		try {
			const t = makeTerminal();
			const p = probeTerminalBackground(t.io, 500);
			await tick();
			t.reply("\x03");
			await expect(p).resolves.toBeNull();

			expectHandoffReady(t);
			expect(t.setRawMode.mock.calls.map((c) => c[0])).toEqual([true, false]);
			expect(kill.mock.calls.length).toBe(1);
			expect(kill.mock.calls[0][0]).toBe(process.pid);
			expect(kill.mock.calls[0][1]).toBe("SIGINT");
		} finally {
			kill.mockRestore();
		}
	});

	it("PR-17: a reply that arrives after the deadline is harmless", async () => {
		const t = makeTerminal();
		await expect(probeTerminalBackground(t.io, 20)).resolves.toBeNull();
		expectHandoffReady(t);

		// Nothing of ours is listening any more; the late bytes must not throw
		// or flip state.
		t.reply(WHITE_REPLY);
		await tick();
		expect(t.stdin.listenerCount("data")).toBe(0);
		expect(t.stdin.isRaw).toBe(false);
		expect(t.setRawMode.mock.calls.map((c) => c[0])).toEqual([true, false]);
	});

	it("PR-18: reply and DA1 sentinel in one chunk finish exactly once", async () => {
		const t = makeTerminal();
		const p = probeTerminalBackground(t.io, 500);
		await tick();
		t.reply(`${BLACK_REPLY}${ESC}[?62c`);
		await expect(p).resolves.toBe("dark");
		expect(t.setRawMode.mock.calls.filter((c) => c[0] === false).length).toBe(
			1,
		);
		expectHandoffReady(t);
	});

	it("PR-19: consecutive probes on fresh terminals are independent", async () => {
		const first = makeTerminal();
		const p1 = probeTerminalBackground(first.io, 500);
		await tick();
		first.reply(WHITE_REPLY);
		await expect(p1).resolves.toBe("light");

		const second = makeTerminal();
		await expect(probeTerminalBackground(second.io, 20)).resolves.toBeNull();
		expectHandoffReady(second);
		expect(second.written().startsWith(QUERY)).toBe(true);

		const third = makeTerminal();
		const p3 = probeTerminalBackground(third.io, 500);
		await tick();
		third.reply(BLACK_REPLY);
		await expect(p3).resolves.toBe("dark");
		expectHandoffReady(third);
	});

	it("PR-16: type-ahead is neither echoed to stdout nor mistaken for a reply", async () => {
		const t = makeTerminal();
		const p = probeTerminalBackground(t.io, 500);
		await tick();
		t.reply("abc");
		await tick();
		t.reply(WHITE_REPLY);
		await expect(p).resolves.toBe("light");
		expect(t.written()).not.toContain("abc");
		expectHandoffReady(t);
	});
});
