/**
 * Sandboxed child for every black-box scenario that touches `~/.mnemex/config.json`.
 *
 * Invoked as: bun child-runner.ts <scenario> <json-params>
 * Env contract (set by the parent): HOME=<temp>, MNEMEX_BB_HOME=<temp>, MNEMEX_KEYCHAIN_TEST_GUARD=1.
 *
 * The FIRST thing it does is prove os.homedir() is the sandbox. Only then does it import any
 * mnemex module. It prints one line `BB_RESULT <json>` on stdout at the end; everything else
 * written to stdout/stderr during the scenario is captured into the result for N2 checks.
 */
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { exitUnlessSandboxed } from "../../helpers/sandbox-guard.js";

// The repo's blessed precondition for anything that can write ~/.mnemex/config.json.
exitUnlessSandboxed(homedir(), process.env.MNEMEX_TEST_SANDBOX_HOME, tmpdir());

const expectedHome = process.env.MNEMEX_BB_HOME;
const actualHome = homedir();
const tmpReal = realpathSync(tmpdir());
if (
	!expectedHome ||
	actualHome !== expectedHome ||
	!realpathSync(actualHome).startsWith(tmpReal) ||
	!actualHome.includes("mnemex-bb-")
) {
	process.stderr.write(
		`BB CHILD REFUSED: homedir()=${actualHome} expected=${expectedHome}\n`,
	);
	process.exit(99);
}
process.env.MNEMEX_KEYCHAIN_TEST_GUARD = "1";
// The blessed child env inherits the parent's shell; drop any real credentials before
// any mnemex module loads. Scenario-provided `env` is applied later, on purpose.
for (const k of [
	"OPENROUTER_API_KEY",
	"VOYAGE_API_KEY",
	"ANTHROPIC_API_KEY",
	"CONTEXT7_API_KEY",
	"OLLAMA_API_KEY",
	"MNEMEX_KEYCHAIN_FILE",
]) {
	delete process.env[k];
}

const scenario = process.argv[2];
const params = JSON.parse(process.argv[3] ?? "{}");

const configDir = join(actualHome, ".mnemex");
const configPath = join(configDir, "config.json");

function writeExisting(existing: unknown, mode?: number) {
	if (existing === undefined || existing === null) return;
	mkdirSync(configDir, { recursive: true });
	const text =
		typeof existing === "string" ? existing : JSON.stringify(existing, null, 2);
	writeFileSync(configPath, text);
	if (mode !== undefined) chmodSync(configPath, mode);
}

function fileState() {
	if (!existsSync(configPath)) return { exists: false };
	const text = readFileSync(configPath, "utf8");
	let json: unknown = null;
	try {
		json = JSON.parse(text);
	} catch {
		json = null;
	}
	return {
		exists: true,
		text,
		json,
		mode: (statSync(configPath).mode & 0o777).toString(8),
	};
}

function dirEntries(): Record<string, string> {
	if (!existsSync(configDir)) return {};
	const out: Record<string, string> = {};
	for (const name of readdirSync(configDir)) {
		try {
			out[name] = readFileSync(join(configDir, name), "utf8");
		} catch {
			out[name] = "<unreadable>";
		}
	}
	return out;
}

// Capture everything the code under test writes to stdout/stderr.
const captured = { stdout: "", stderr: "" };
const realOut = process.stdout.write.bind(process.stdout);
const realErr = process.stderr.write.bind(process.stderr);
function startCapture() {
	// biome-ignore lint/suspicious/noExplicitAny: monkeypatching stream write
	(process.stdout as any).write = (chunk: unknown) => {
		captured.stdout += String(chunk);
		return true;
	};
	// biome-ignore lint/suspicious/noExplicitAny: monkeypatching stream write
	(process.stderr as any).write = (chunk: unknown) => {
		captured.stderr += String(chunk);
		return true;
	};
}
function stopCapture() {
	// biome-ignore lint/suspicious/noExplicitAny: restoring stream write
	(process.stdout as any).write = realOut;
	// biome-ignore lint/suspicious/noExplicitAny: restoring stream write
	(process.stderr as any).write = realErr;
}

const { createFakeKeychain } = await import("./fake-keychain.js");
const kc = await import("../../../src/core/keychain.js");
const sec = await import("../../../src/core/secrets.js");

const fake = createFakeKeychain(params.fake ?? {});
kc.setKeychainTestDeps(fake.deps);
if (!params.keepDisabled) {
	delete process.env.MNEMEX_DISABLE_KEYCHAIN;
}
for (const [k, v] of Object.entries(params.env ?? {})) {
	if (v === null) delete process.env[k];
	else process.env[k] = String(v);
}

writeExisting(params.existing, params.existingMode);

const result: Record<string, unknown> = { homedir: actualHome, scenario };
const config = await import("../../../src/config.js");

const invalidateAll = () => {
	kc.invalidateKeychainCache();
	sec.invalidateSecretSessionCache();
};

const getters: Record<string, () => string | undefined> = {
	openrouter: () => config.getApiKey(),
	voyage: () => config.getVoyageApiKey(),
	anthropic: () => config.getAnthropicApiKey(),
	ollama: () => config.getOllamaApiKey(),
	context7: () => config.getContext7ApiKey(),
};

startCapture();
try {
	switch (scenario) {
		case "save": {
			const before = fileState();
			let report: unknown;
			let thrown: string | undefined;
			const incoming = { ...(params.incoming ?? {}) };
			// JSON cannot carry `undefined`; the parent names the fields to set explicitly undefined.
			for (const f of params.incomingUndefinedFields ?? [])
				incoming[f] = undefined;
			try {
				report = config.saveGlobalConfig(incoming);
			} catch (e) {
				thrown = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
			}
			result.before = before;
			result.report = report;
			result.thrown = thrown;
			break;
		}
		case "resolve": {
			const getter = getters[params.getter];
			if (!getter) throw new Error(`unknown getter ${params.getter}`);
			const stages: Record<string, unknown> = {};
			const envVar = params.envVar as string | undefined;

			// Stage A: env set (as provided), keychain has item, file has value.
			let c0 = fake.calls.length;
			stages.envSet = { value: getter(), calls: fake.calls.length - c0 };

			// Stage B: env empty string -> must NOT win.
			if (envVar) {
				process.env[envVar] = "";
				invalidateAll();
				c0 = fake.calls.length;
				stages.envEmpty = { value: getter(), calls: fake.calls.length - c0 };
				delete process.env[envVar];
			}

			// Stage C: env unset -> keychain; cold then warm.
			invalidateAll();
			c0 = fake.calls.length;
			const cold = getter();
			const coldCalls = fake.calls.length - c0;
			c0 = fake.calls.length;
			const warm = getter();
			const warmCalls = fake.calls.length - c0;
			stages.keychain = { cold, coldCalls, warm, warmCalls };

			// Stage D: keychain empty -> file.
			fake.store.clear();
			invalidateAll();
			c0 = fake.calls.length;
			stages.file = { value: getter(), calls: fake.calls.length - c0 };
			result.stages = stages;
			result.ENV = config.ENV;
			break;
		}
		case "load": {
			let c0 = fake.calls.length;
			const plain = config.loadGlobalConfig();
			result.loadCalls = fake.calls.length - c0;
			result.loadValue = plain[params.field as keyof typeof plain];
			c0 = fake.calls.length;
			const hydrated = config.loadGlobalConfigWithSecrets();
			result.hydratedCalls = fake.calls.length - c0;
			result.hydratedValue = hydrated[params.field as keyof typeof hydrated];
			if (params.thenSaveHydratedWith) {
				// Simulate the wizard: take the hydrated object, change one non-secret field, save it.
				fake.options.failWrite = !!params.failWriteOnSave;
				const report = config.saveGlobalConfig({
					...hydrated,
					...params.thenSaveHydratedWith,
				});
				result.report = report;
			}
			break;
		}
		default:
			throw new Error(`unknown scenario ${scenario}`);
	}
} catch (e) {
	result.fatal =
		e instanceof Error ? `${e.name}: ${e.message}\n${e.stack}` : String(e);
} finally {
	stopCapture();
}

result.after = fileState();
result.dir = dirEntries();
result.calls = fake.calls;
result.store = Object.fromEntries(fake.store);
result.captured = captured;
result.realSpawns = kc.realKeychainSpawnCount();
result.pendingWarnings = sec.getPendingSecretWarnings();

kc.setKeychainTestDeps(null);
realOut(`BB_RESULT ${JSON.stringify(result)}\n`);
