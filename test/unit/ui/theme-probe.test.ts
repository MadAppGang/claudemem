/**
 * The OSC 11 probe: restore on every path (architecture §4.3, §6).
 *
 * Every case asserts the same post-conditions, because the probe's contract
 * is about the state it leaves behind, not just the value it returns: raw
 * mode toggled on then back off (or never touched), no `data` listener of
 * ours left on stdin, stdin paused, and stdout carrying exactly the query
 * bytes (or nothing when the preconditions failed).
 */

import { describe, expect, it, mock } from "bun:test";
import { PassThrough } from "node:stream";
import {
	OSC11_PROBE_TIMEOUT_MS,
	type ProbeIo,
	probeTerminalBackground,
} from "../../../src/ui/theme-detect.js";

const ESC = "\x1b";
const BEL = "\x07";
const QUERY = `${ESC}]11;?${BEL}${ESC}[c`;
const DA1_REPLY = `${ESC}[?62;22c`;
const WHITE_REPLY = `${ESC}]11;rgb:ffff/ffff/ffff${BEL}`;
const BLACK_REPLY = `${ESC}]11;rgb:0000/0000/0000${BEL}`;

interface FakeTerminal {
	io: ProbeIo;
	stdin: PassThrough;
	setRawMode: ReturnType<typeof mock<(raw: boolean) => void>>;
	pause: ReturnType<typeof mock<() => PassThrough>>;
	/** Everything the probe wrote to stdout, concatenated. */
	written: () => string;
	/** Push bytes as if the terminal answered. */
	reply: (text: string) => void;
}

function makeTerminal(
	opts: {
		stdinIsTTY?: boolean;
		stdoutIsTTY?: boolean;
		setRawModeThrows?: boolean;
		noSetRawMode?: boolean;
	} = {},
): FakeTerminal {
	const stdin = new PassThrough() as PassThrough & {
		isTTY?: boolean;
		isRaw?: boolean;
		setRawMode?: (raw: boolean) => void;
	};
	stdin.isTTY = opts.stdinIsTTY ?? true;
	stdin.isRaw = false;

	const setRawMode = mock((raw: boolean): void => {
		if (opts.setRawModeThrows) throw new Error("EIO: not a tty");
		stdin.isRaw = raw;
	});
	if (!opts.noSetRawMode) stdin.setRawMode = setRawMode;

	const originalPause = stdin.pause.bind(stdin);
	const pause = mock((): PassThrough => originalPause());
	stdin.pause = pause;

	const stdout = new PassThrough() as PassThrough & { isTTY?: boolean };
	stdout.isTTY = opts.stdoutIsTTY ?? true;
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

/** The post-conditions every path must satisfy once the probe ran. */
function expectRestored(t: FakeTerminal): void {
	expect(t.setRawMode.mock.calls.map((c) => c[0])).toEqual([true, false]);
	expect(t.stdin.listenerCount("data")).toBe(0);
	expect(t.pause).toHaveBeenCalled();
	expect(t.written()).toBe(QUERY);
}

/** Let the write to stdout and the setup settle before the terminal answers. */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe("probeTerminalBackground", () => {
	it("classifies a 16-bit white reply as light and restores stdin", async () => {
		const t = makeTerminal();
		const p = probeTerminalBackground(t.io, 500);
		await tick();
		t.reply(WHITE_REPLY);
		await expect(p).resolves.toBe("light");
		expectRestored(t);
	});

	it("classifies a black reply as dark and restores stdin", async () => {
		const t = makeTerminal();
		const p = probeTerminalBackground(t.io, 500);
		await tick();
		t.reply(BLACK_REPLY);
		await expect(p).resolves.toBe("dark");
		expectRestored(t);
	});

	it("DA1 sentinel without an OSC 11 reply resolves null immediately, not at the timeout", async () => {
		const t = makeTerminal();
		const started = performance.now();
		const p = probeTerminalBackground(t.io, 1000);
		await tick();
		t.reply(DA1_REPLY);
		await expect(p).resolves.toBeNull();
		expect(performance.now() - started).toBeLessThan(200);
		expectRestored(t);
	});

	it("a mute terminal resolves null at the timeout and restores stdin", async () => {
		const t = makeTerminal();
		const started = performance.now();
		await expect(probeTerminalBackground(t.io, 20)).resolves.toBeNull();
		expect(performance.now() - started).toBeGreaterThanOrEqual(15);
		expectRestored(t);
	});

	it("an OSC 11 reply followed by DA1 in the same chunk still classifies", async () => {
		const t = makeTerminal();
		const p = probeTerminalBackground(t.io, 500);
		await tick();
		t.reply(`${WHITE_REPLY}${DA1_REPLY}`);
		await expect(p).resolves.toBe("light");
		expectRestored(t);
	});

	it("accumulates a reply split across two chunks", async () => {
		const t = makeTerminal();
		const p = probeTerminalBackground(t.io, 500);
		await tick();
		t.reply(`${ESC}]11;rgb:ff`);
		await tick();
		t.reply(`ff/ffff/ffff${BEL}`);
		await expect(p).resolves.toBe("light");
		expectRestored(t);
	});

	it("ignores junk (type-ahead) before the reply", async () => {
		const t = makeTerminal();
		const p = probeTerminalBackground(t.io, 500);
		await tick();
		t.reply("j\x04k");
		await tick();
		t.reply(BLACK_REPLY);
		await expect(p).resolves.toBe("dark");
		expectRestored(t);
	});

	it("setRawMode throwing yields null, writes nothing, and still pauses stdin", async () => {
		const t = makeTerminal({ setRawModeThrows: true });
		await expect(probeTerminalBackground(t.io, 500)).resolves.toBeNull();
		// Both the enable and the restore were attempted; both threw and were caught.
		expect(t.setRawMode.mock.calls.map((c) => c[0])).toEqual([true, false]);
		expect(t.stdin.listenerCount("data")).toBe(0);
		expect(t.pause).toHaveBeenCalled();
		expect(t.written()).toBe("");
	});

	it("stdin not a TTY: null, no writes, setRawMode never called", async () => {
		const t = makeTerminal({ stdinIsTTY: false });
		await expect(probeTerminalBackground(t.io, 500)).resolves.toBeNull();
		expect(t.setRawMode).not.toHaveBeenCalled();
		expect(t.written()).toBe("");
		expect(t.stdin.listenerCount("data")).toBe(0);
	});

	it("stdout not a TTY: null, no writes, setRawMode never called", async () => {
		const t = makeTerminal({ stdoutIsTTY: false });
		await expect(probeTerminalBackground(t.io, 500)).resolves.toBeNull();
		expect(t.setRawMode).not.toHaveBeenCalled();
		expect(t.written()).toBe("");
	});

	it("stdin without setRawMode: null, no writes", async () => {
		const t = makeTerminal({ noSetRawMode: true });
		await expect(probeTerminalBackground(t.io, 500)).resolves.toBeNull();
		expect(t.written()).toBe("");
		expect(t.stdin.listenerCount("data")).toBe(0);
	});

	it("restores stdin to raw when it was already raw", async () => {
		const t = makeTerminal();
		(t.stdin as PassThrough & { isRaw?: boolean }).isRaw = true;
		const p = probeTerminalBackground(t.io, 500);
		await tick();
		t.reply(WHITE_REPLY);
		await expect(p).resolves.toBe("light");
		expect(t.setRawMode.mock.calls.map((c) => c[0])).toEqual([true, true]);
	});

	it("a stdout write error (EPIPE) yields null and restores stdin", async () => {
		const t = makeTerminal();
		const stdout = t.io.stdout as unknown as PassThrough;
		stdout.write = ((
			_chunk: unknown,
			cb?: (err?: Error | null) => void,
		): boolean => {
			cb?.(new Error("EPIPE"));
			return false;
		}) as typeof stdout.write;
		await expect(probeTerminalBackground(t.io, 500)).resolves.toBeNull();
		expect(t.setRawMode.mock.calls.map((c) => c[0])).toEqual([true, false]);
		expect(t.stdin.listenerCount("data")).toBe(0);
		expect(t.pause).toHaveBeenCalled();
	});

	// Only meaningful when the runner's stdio is not a terminal; on a real tty
	// the default io would actually query it, and the answer depends on the
	// terminal, not the code under test.
	const stdioIsTTY =
		process.stdin.isTTY === true && process.stdout.isTTY === true;
	it.skipIf(stdioIsTTY)(
		"defaults to process stdio and the 200 ms bound; under a non-TTY runner → null at once",
		async () => {
			expect(OSC11_PROBE_TIMEOUT_MS).toBe(200);
			const started = performance.now();
			await expect(probeTerminalBackground()).resolves.toBeNull();
			expect(performance.now() - started).toBeLessThan(100);
		},
	);
});
