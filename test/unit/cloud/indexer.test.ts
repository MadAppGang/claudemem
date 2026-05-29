/**
 * Unit tests for CloudAwareIndexer
 *
 * Uses LocalCloudStub (no real HTTP) and a mock IChangeDetector
 * (no real git repository). File I/O is mocked via mock.module.
 *
 * Tests verify the 10-step flow:
 *  1. getHeadSha() called
 *  2. skips upload if commit already "ready"
 *  3. parent SHA resolution
 *  4. changed-files retrieval
 *  5. file reading + chunking
 *  6. chunk deduplication via checkChunks
 *  7. embedding (thin mode)
 *  8/9. upload request built and sent
 * 10. correct CloudIndexResult returned
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import { LocalCloudStub } from "../../../src/cloud/stub.js";
import type {
	ChangedFile,
	DirtyFile,
	IChangeDetector,
} from "../../../src/cloud/types.js";
import type { TeamConfig } from "../../../src/cloud/types.js";
import type { EmbedResult, IEmbeddingsClient } from "../../../src/types.js";

const realFs = {
	readFileSync: fs.readFileSync.bind(fs),
	existsSync: fs.existsSync.bind(fs),
	mkdirSync: fs.mkdirSync.bind(fs),
	writeFileSync: fs.writeFileSync.bind(fs),
	chmodSync: fs.chmodSync.bind(fs),
	statSync: fs.statSync.bind(fs),
	readdirSync: fs.readdirSync.bind(fs),
};

// ============================================================================
// Module mocks
// ============================================================================

// Mock node:fs so we can control file reading without a real filesystem
const MOCK_PROJECT_PATH = "/project";
const isMockProjectPath = (path: unknown): path is string =>
	typeof path === "string" && path.startsWith(MOCK_PROJECT_PATH);

const mockReadFileSync = mock((_path: unknown, _enc: unknown): string => {
	if (!isMockProjectPath(_path)) {
		return realFs.readFileSync(
			_path as fs.PathOrFileDescriptor,
			_enc as BufferEncoding,
		);
	}
	return 'function hello() { return "hello world"; }';
});

mock.module("node:fs", () => ({
	...fs,
	readFileSync: mockReadFileSync,
	existsSync: mock((path: unknown) =>
		isMockProjectPath(path) ? true : realFs.existsSync(path as fs.PathLike),
	),
	mkdirSync: mock((path: unknown, options?: fs.MakeDirectoryOptions) => {
		if (!isMockProjectPath(path)) {
			return realFs.mkdirSync(path as fs.PathLike, options);
		}
	}),
	writeFileSync: mock(
		(
			path: unknown,
			data: string | NodeJS.ArrayBufferView,
			options?: fs.WriteFileOptions,
		) => {
			if (!isMockProjectPath(path)) {
				return realFs.writeFileSync(
					path as fs.PathOrFileDescriptor,
					data,
					options,
				);
			}
		},
	),
	chmodSync: mock((path: unknown, mode: fs.Mode) => {
		if (!isMockProjectPath(path)) {
			return realFs.chmodSync(path as fs.PathLike, mode);
		}
	}),
	statSync: mock((path: unknown, options?: fs.StatSyncOptions) =>
		isMockProjectPath(path)
			? ({ isDirectory: () => false, size: 100 } as fs.Stats)
			: realFs.statSync(path as fs.PathLike, options),
	),
	readdirSync: mock((path: unknown, options?: fs.ObjectEncodingOptions) =>
		isMockProjectPath(path)
			? []
			: realFs.readdirSync(path as fs.PathLike, options),
	),
}));

afterAll(() => {
	mock.restore();
});

// Mock the chunker to avoid needing real tree-sitter parsers in unit tests
mock.module("../../../src/core/chunker.js", () => ({
	chunkFileByPath: mock(
		async (source: string, filePath: string, fileHash: string) => {
			// Return a single fake chunk for any file
			return [
				{
					id: `id-${fileHash.slice(0, 8)}`,
					contentHash: `contenthash-${fileHash.slice(0, 8)}`,
					content: source,
					filePath,
					startLine: 1,
					endLine: 3,
					language: "typescript",
					chunkType: "function",
					name: "hello",
					fileHash,
				},
			];
		},
	),
	canChunkFile: mock(() => true),
}));

// Import after mocking
const { CloudAwareIndexer, createCloudIndexer } = await import(
	"../../../src/cloud/indexer.js"
);

// ============================================================================
// Testdata and helpers
// ============================================================================

const PROJECT_PATH = MOCK_PROJECT_PATH;
const COMMIT_SHA = "aaaa1111bbbb2222cccc3333dddd4444eeee5555";
const PARENT_SHA = "bbbb2222cccc3333dddd4444eeee5555ffff6666";
const REPO = "acme-corp/my-repo";
const ORG = "acme-corp";

const TEAM_CONFIG: TeamConfig = {
	orgSlug: ORG,
	repoSlug: REPO,
	cloudMode: "thin",
};

/** Minimal IChangeDetector that returns controllable values */
class MockChangeDetector implements IChangeDetector {
	headSha: string = COMMIT_SHA;
	parentShas: string[] = [PARENT_SHA];
	changedFiles: ChangedFile[] = [
		{ filePath: "src/hello.ts", status: "modified" },
	];

	async getHeadSha(): Promise<string> {
		return this.headSha;
	}

	async getParentShas(_sha: string): Promise<string[]> {
		return this.parentShas;
	}

	async getChangedFiles(
		_from: string | null,
		_to: string,
	): Promise<ChangedFile[]> {
		return this.changedFiles;
	}

	async getDirtyFiles(): Promise<DirtyFile[]> {
		return [];
	}
}

/** Minimal IEmbeddingsClient that returns deterministic fake vectors */
class MockEmbeddingsClient implements IEmbeddingsClient {
	private readonly dim: number;

	constructor(dim = 4) {
		this.dim = dim;
	}

	async embed(texts: string[]): Promise<EmbedResult> {
		return {
			embeddings: texts.map((_, i) =>
				Array.from({ length: this.dim }, (__, j) => i * 0.1 + j * 0.01),
			),
			cost: texts.length * 0.0001,
		};
	}

	async embedOne(_text: string): Promise<number[]> {
		return Array.from({ length: this.dim }, (_, i) => i * 0.01);
	}

	getModel(): string {
		return "mock-model";
	}

	getDimension(): number {
		return this.dim;
	}

	getProvider() {
		return "local" as const;
	}

	isLocal(): boolean {
		return true;
	}
}

let stub: LocalCloudStub;
let changeDetector: MockChangeDetector;
let embeddingsClient: MockEmbeddingsClient;

beforeEach(() => {
	stub = new LocalCloudStub();
	changeDetector = new MockChangeDetector();
	embeddingsClient = new MockEmbeddingsClient();
});

function makeIndexer(
	overrides: {
		teamConfig?: TeamConfig;
		embeddingsClient?: IEmbeddingsClient | null;
		changeDetector?: IChangeDetector;
	} = {},
): InstanceType<typeof CloudAwareIndexer> {
	// Use null as sentinel to explicitly pass no embeddingsClient
	const resolvedClient =
		"embeddingsClient" in overrides
			? (overrides.embeddingsClient ?? undefined)
			: embeddingsClient;
	return new CloudAwareIndexer({
		projectPath: PROJECT_PATH,
		cloudClient: stub,
		changeDetector: overrides.changeDetector ?? changeDetector,
		embeddingsClient: resolvedClient,
		teamConfig: overrides.teamConfig ?? TEAM_CONFIG,
	});
}

// ============================================================================
// Factory function
// ============================================================================

describe("createCloudIndexer", () => {
	test("returns a CloudAwareIndexer instance", () => {
		const indexer = createCloudIndexer({
			projectPath: PROJECT_PATH,
			cloudClient: stub,
			changeDetector,
			teamConfig: TEAM_CONFIG,
		});
		expect(indexer).toBeInstanceOf(CloudAwareIndexer);
	});
});

// ============================================================================
// Step 2: Skip if already indexed
// ============================================================================

describe("CloudAwareIndexer — skips already-indexed commits", () => {
	test("returns skipped status when commit is already ready", async () => {
		// Pre-upload the commit so it's marked "ready"
		await stub.uploadIndex({
			orgSlug: ORG,
			repoSlug: REPO,
			commitSha: COMMIT_SHA,
			parentShas: [],
			chunks: [],
			mode: "thin",
		});

		const indexer = makeIndexer();
		const result = await indexer.indexToCloud();

		expect(result.status).toBe("skipped");
		expect(result.commitSha).toBe(COMMIT_SHA);
		expect(result.filesChanged).toBe(0);
		expect(result.chunksUploaded).toBe(0);
	});
});

// ============================================================================
// Step 4–9: Normal indexing flow
// ============================================================================

describe("CloudAwareIndexer — normal indexing flow", () => {
	test("returns ready status after successful upload", async () => {
		const indexer = makeIndexer();
		const result = await indexer.indexToCloud();

		expect(result.status).toBe("ready");
		expect(result.commitSha).toBe(COMMIT_SHA);
	});

	test("includes correct filesChanged count", async () => {
		changeDetector.changedFiles = [
			{ filePath: "src/a.ts", status: "modified" },
			{ filePath: "src/b.ts", status: "added" },
		];
		const indexer = makeIndexer();
		const result = await indexer.indexToCloud();

		expect(result.filesChanged).toBe(2);
	});

	test("excludes deleted files from filesChanged", async () => {
		changeDetector.changedFiles = [
			{ filePath: "src/a.ts", status: "modified" },
			{ filePath: "src/old.ts", status: "deleted" },
		];
		const indexer = makeIndexer();
		const result = await indexer.indexToCloud();

		expect(result.filesChanged).toBe(1);
	});

	test("uploads chunks to the cloud stub", async () => {
		const indexer = makeIndexer();
		await indexer.indexToCloud();

		const stored = stub.getAllChunks();
		expect(stored.length).toBeGreaterThan(0);
	});

	test("records commit in the cloud stub", async () => {
		const indexer = makeIndexer();
		await indexer.indexToCloud();

		const record = stub.getCommitRecord(REPO, COMMIT_SHA);
		expect(record).toBeDefined();
		if (!record) {
			throw new Error("Expected commit record to be stored");
		}
		expect(record.commitSha).toBe(COMMIT_SHA);
	});

	test("durationMs is non-negative", async () => {
		const indexer = makeIndexer();
		const result = await indexer.indexToCloud();

		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	test("chunksDeduped is 0 on fresh upload", async () => {
		const indexer = makeIndexer();
		const result = await indexer.indexToCloud();

		expect(result.chunksDeduped).toBe(0);
	});
});

// ============================================================================
// Deduplication (Step 6)
// ============================================================================

describe("CloudAwareIndexer — chunk deduplication", () => {
	test("deduplicates chunks that already exist in cloud", async () => {
		// First indexing run — uploads the chunks
		const indexer1 = makeIndexer();
		await indexer1.indexToCloud();

		// Second run with a new commit SHA but same file content
		changeDetector.headSha = "newsha1234567890newsha1234567890newsha12";
		changeDetector.parentShas = [COMMIT_SHA];

		const indexer2 = makeIndexer();
		const result = await indexer2.indexToCloud();

		// Chunks should be deduped (already exist)
		expect(result.chunksDeduped).toBeGreaterThan(0);
		expect(result.chunksUploaded).toBe(0);
	});
});

// ============================================================================
// Initial commit (no parent)
// ============================================================================

describe("CloudAwareIndexer — initial commit (no parent)", () => {
	test("handles initial commit with no parent SHA", async () => {
		changeDetector.parentShas = [];
		changeDetector.changedFiles = [
			{ filePath: "src/index.ts", status: "added" },
		];

		const indexer = makeIndexer();
		const result = await indexer.indexToCloud();

		expect(result.status).toBe("ready");
		expect(result.filesChanged).toBe(1);
	});
});

// ============================================================================
// Thin mode embedding (Step 7)
// ============================================================================

describe("CloudAwareIndexer — thin mode embedding", () => {
	test("attaches vectors to chunks when embeddingsClient is provided", async () => {
		const indexer = makeIndexer();
		await indexer.indexToCloud();

		const stored = stub.getAllChunks();
		// Each stored chunk should have a vector
		for (const chunk of stored) {
			expect(chunk.vector).toBeDefined();
			expect(Array.isArray(chunk.vector)).toBe(true);
		}
	});

	test("includes embeddingCost when embeddings client reports cost", async () => {
		const indexer = makeIndexer();
		const result = await indexer.indexToCloud();

		// MockEmbeddingsClient reports cost
		expect(result.embeddingCost).toBeDefined();
		expect(result.embeddingCost).toBeGreaterThan(0);
	});

	test("works without embeddingsClient (no vectors attached)", async () => {
		// Pass null to explicitly opt out of embeddings (undefined would fall back to module-level client)
		const indexer = makeIndexer({ embeddingsClient: null });
		const result = await indexer.indexToCloud();

		expect(result.status).toBe("ready");
		// No embedding cost reported
		expect(result.embeddingCost).toBeUndefined();
	});
});

// ============================================================================
// Deleted files
// ============================================================================

describe("CloudAwareIndexer — deleted files", () => {
	test("passes deleted file paths in upload request", async () => {
		changeDetector.changedFiles = [
			{ filePath: "src/hello.ts", status: "modified" },
			{ filePath: "src/removed.ts", status: "deleted" },
		];

		const indexer = makeIndexer();
		await indexer.indexToCloud();

		const record = stub.getCommitRecord(REPO, COMMIT_SHA);
		expect(record).toBeDefined();
		if (!record) {
			throw new Error("Expected commit record to be stored");
		}
		expect(record.deletedFiles).toContain("src/removed.ts");
	});
});

// ============================================================================
// Empty changeset
// ============================================================================

describe("CloudAwareIndexer — empty changeset", () => {
	test("handles commits with no changed files gracefully", async () => {
		changeDetector.changedFiles = [];

		const indexer = makeIndexer();
		const result = await indexer.indexToCloud();

		expect(result.status).toBe("ready");
		expect(result.filesChanged).toBe(0);
		expect(result.chunksUploaded).toBe(0);
	});
});

// ============================================================================
// Repo slug resolution
// ============================================================================

describe("CloudAwareIndexer — repo slug resolution", () => {
	test("uses explicit repoSlug from teamConfig", async () => {
		const teamConfig: TeamConfig = {
			orgSlug: ORG,
			repoSlug: "custom/slug",
			cloudMode: "thin",
		};
		const indexer = makeIndexer({ teamConfig });
		await indexer.indexToCloud();

		const record = stub.getCommitRecord("custom/slug", COMMIT_SHA);
		expect(record).toBeDefined();
	});

	test("derives repo slug from projectPath basename when repoSlug not set", async () => {
		const teamConfig: TeamConfig = {
			orgSlug: ORG,
			// No repoSlug — should derive from projectPath
			cloudMode: "thin",
		};
		const indexer = makeIndexer({ teamConfig });
		await indexer.indexToCloud();

		// projectPath is "/project" → basename is "project"
		// slug should be "acme-corp/project"
		const record = stub.getCommitRecord("acme-corp/project", COMMIT_SHA);
		expect(record).toBeDefined();
	});
});
