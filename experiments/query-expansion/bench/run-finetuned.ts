#!/usr/bin/env bun
/**
 * Bun launcher for fine-tuned query expansion benchmarks.
 *
 * The benchmark itself still needs the Python ML runtime because it loads
 * Transformers + PEFT adapters locally. Keeping the entrypoint in TypeScript
 * removes repo-owned .py files while preserving the old local-inference result
 * path.
 *
 * Usage:
 *   HF_TOKEN=... bun experiments/query-expansion/bench/run-finetuned.ts --model qwen3-1.7b
 *   HF_TOKEN=... bun experiments/query-expansion/bench/run-finetuned.ts --all
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MODELS = {
	"qwen3-1.7b": {
		base: "Qwen/Qwen3-1.7B",
		adapter: "jackrudenko/claudemem-expansion-qwen3-1.7b",
		family: "qwen3-ft",
		paramsB: 1.7,
	},
	"qwen3-4b": {
		base: "Qwen/Qwen3-4B",
		adapter: "jackrudenko/claudemem-expansion-qwen3-4b",
		family: "qwen3-ft",
		paramsB: 4,
	},
	"lfm2-1.2b": {
		base: "LiquidAI/LFM2.5-1.2B-Instruct",
		adapter: "jackrudenko/claudemem-expansion-lfm2-1.2b",
		family: "lfm2-ft",
		paramsB: 1.2,
	},
	"lfm2-700m": {
		base: "LiquidAI/LFM2-700M",
		adapter: "jackrudenko/claudemem-expansion-lfm2-700m",
		family: "lfm2-ft",
		paramsB: 0.7,
	},
	"qwen3-8b": {
		base: "Qwen/Qwen3-8B",
		adapter: "jackrudenko/claudemem-expansion-qwen3-8b",
		family: "qwen3-ft",
		paramsB: 8,
	},
	"phi4-mini": {
		base: "microsoft/Phi-4-mini-instruct",
		adapter: "jackrudenko/claudemem-expansion-phi4-mini",
		family: "phi4-ft",
		paramsB: 3.8,
	},
	"qwen3.5-2b": {
		base: "Qwen/Qwen3.5-2B",
		adapter: "jackrudenko/claudemem-expansion-qwen3.5-2b",
		family: "qwen3.5-ft",
		paramsB: 2,
	},
	"qwen3.5-4b": {
		base: "Qwen/Qwen3.5-4B",
		adapter: "jackrudenko/claudemem-expansion-qwen3.5-4b",
		family: "qwen3.5-ft",
		paramsB: 4,
	},
	"qwen3.5-9b": {
		base: "Qwen/Qwen3.5-9B",
		adapter: "jackrudenko/claudemem-expansion-qwen3.5-9b",
		family: "qwen3.5-ft",
		paramsB: 9,
	},
} as const;

type ModelKey = keyof typeof MODELS;

interface Args {
	all: boolean;
	help: boolean;
	model?: ModelKey;
	uv: string;
}

const UV_DEPENDENCIES = [
	"transformers>=5.0.0",
	"peft>=0.7.0",
	"accelerate>=0.24.0",
	"torch",
	"huggingface_hub>=0.25",
	"pillow",
	"torchvision",
];

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));

const BENCHMARK_PROGRAM = String.raw`
import argparse
import json
import os
import re
import time
from pathlib import Path

HF_USER = os.environ.get("MNEMEX_FT_HF_USER", "jackrudenko")
MODELS = json.loads(os.environ["MNEMEX_FT_MODELS"])

SYSTEM_PROMPT = """You are a code search query expansion engine. Given a search query, expand it into three types:
- lex: keyword variants for BM25 search (technical terms, synonyms, related identifiers)
- vec: a natural language rephrasing for semantic vector search
- hyde: a short hypothetical code snippet that would match this query

Respond with exactly 3 lines, no other text:
lex: ...
vec: ...
hyde: ..."""

BENCH_DIR = Path(os.environ["MNEMEX_FT_BENCH_DIR"])
QUERIES_PATH = BENCH_DIR / "queries.json"
RESULTS_DIR = BENCH_DIR.parent / "results" / "finetuned"

def parse_expansion(raw):
    lex = vec = hyde = None
    for line in raw.strip().split("\n"):
        trimmed = line.strip()
        lower = trimmed.lower()
        if lower.startswith("lex:"):
            lex = trimmed[4:].strip()
        elif lower.startswith("vec:"):
            vec = trimmed[4:].strip()
        elif lower.startswith("hyde:"):
            hyde = trimmed[5:].strip()
    return {"raw": raw, "lex": lex, "vec": vec, "hyde": hyde}

def score_format(exp):
    score = 0.0
    if exp["lex"] and len(exp["lex"]) > 0:
        score += 0.33
    if exp["vec"] and len(exp["vec"]) > 0:
        score += 0.33
    if exp["hyde"] and len(exp["hyde"]) > 0:
        score += 0.34
    return score

def score_keywords(exp, query):
    if not exp["lex"]:
        return 0.0
    lex_terms = [t.strip().lower() for t in re.split(r"[,;|\s]+", exp["lex"]) if len(t.strip()) > 1]
    if not lex_terms:
        return 0.0
    query_terms = [t.lower() for t in query.split() if len(t) > 1]
    score = 0.0
    unique = set(lex_terms)
    score += min(len(unique) / 10, 1.0) * 0.4
    has_overlap = any(any(lt in qt or qt in lt for lt in lex_terms) for qt in query_terms)
    if has_overlap:
        score += 0.3
    new_terms = [lt for lt in lex_terms if lt not in query_terms]
    if new_terms:
        score += 0.3
    return min(score, 1.0)

def score_semantic(exp, query):
    if not exp["vec"]:
        return 0.0
    vec = exp["vec"]
    score = 0.0
    if 10 <= len(vec) <= 200:
        score += 0.3
    elif len(vec) > 3:
        score += 0.1
    if vec.lower() != query.lower():
        score += 0.3
    else:
        score += 0.05
    if " " in vec and len(vec) > 15:
        score += 0.4
    return min(score, 1.0)

def score_hyde(exp):
    if not exp["hyde"]:
        return 0.0
    hyde = exp["hyde"]
    score = 0.0
    if len(hyde) > 20:
        score += 0.2
    elif len(hyde) > 5:
        score += 0.1
    code_patterns = [
        r"[{}()\[\]]",
        r"\b(function|const|let|var|class|def|import|export|return|if|for|while|async|await)\b",
        r"[=;:]",
        r"\.\w+\(",
        r"\w+\s*=>",
        r"//",
    ]
    match_count = sum(1 for pattern in code_patterns if re.search(pattern, hyde))
    score += min(match_count / 4, 1.0) * 0.5
    line_count = len(hyde.split("\n"))
    if line_count >= 2:
        score += 0.15
    if line_count >= 3:
        score += 0.15
    return min(score, 1.0)

def score_speed(latency_ms):
    if latency_ms <= 500:
        return 1.0
    if latency_ms <= 1500:
        return 0.7
    if latency_ms <= 5000:
        return 0.4
    if latency_ms <= 15000:
        return 0.1
    return 0.0

WEIGHTS = {"format": 0.2, "keyword": 0.2, "semantic": 0.2, "hyde": 0.25, "speed": 0.15}

def score_query(query_id, query, model_name, raw, latency_ms):
    exp = parse_expansion(raw)
    fmt = score_format(exp)
    kw = score_keywords(exp, query)
    sem = score_semantic(exp, query)
    hy = score_hyde(exp)
    spd = score_speed(latency_ms)
    total = fmt * WEIGHTS["format"] + kw * WEIGHTS["keyword"] + sem * WEIGHTS["semantic"] + hy * WEIGHTS["hyde"] + spd * WEIGHTS["speed"]
    return {
        "queryId": query_id,
        "query": query,
        "modelName": model_name,
        "format": fmt,
        "keyword": kw,
        "semantic": sem,
        "hyde": hy,
        "latencyMs": latency_ms,
        "total": total,
        "expansion": exp,
    }

def load_model(model_key):
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import PeftModel

    cfg = MODELS[model_key]
    print(f"\nLoading {model_key}...")
    print(f"  Base: {cfg['base']}")
    print(f"  Adapter: {cfg['adapter']}")

    if torch.backends.mps.is_available():
        device = "mps"
        dtype = torch.float16
    elif torch.cuda.is_available():
        device = "cuda"
        dtype = torch.bfloat16
    else:
        device = "cpu"
        dtype = torch.float32

    print(f"  Device: {device}, dtype: {dtype}")
    tokenizer = AutoTokenizer.from_pretrained(cfg["adapter"])
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    base_model = AutoModelForCausalLM.from_pretrained(cfg["base"], torch_dtype=dtype, device_map=device)
    model = PeftModel.from_pretrained(base_model, cfg["adapter"])
    model = model.merge_and_unload()
    model.eval()

    print(f"  Model loaded and merged on {device}")
    return model, tokenizer, device

def generate_expansion(model, tokenizer, device, query, max_new_tokens=300):
    import torch

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": f"Query: {query}"},
    ]

    text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = tokenizer(text, return_tensors="pt").to(device)

    start = time.perf_counter()
    with torch.no_grad():
        outputs = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            temperature=0.3,
            do_sample=True,
            top_p=0.9,
            pad_token_id=tokenizer.pad_token_id,
        )
    latency_ms = (time.perf_counter() - start) * 1000
    new_tokens = outputs[0][inputs["input_ids"].shape[1]:]
    output = tokenizer.decode(new_tokens, skip_special_tokens=True)
    return output.strip(), latency_ms

def benchmark_model(model_key, queries):
    import torch

    cfg = MODELS[model_key]
    display_name = f"{model_key}-FT"
    model, tokenizer, device = load_model(model_key)
    scores = []
    raw_results = []
    success_count = 0
    fail_count = 0

    print("\n" + "=" * 60)
    print(f"Benchmarking: {display_name} ({cfg['paramsB']}B, fine-tuned)")
    print("=" * 60)

    for index, query in enumerate(queries):
        progress = f"[{index + 1}/{len(queries)}]"
        try:
            output, latency_ms = generate_expansion(model, tokenizer, device, query["query"])
            score = score_query(query["id"], query["query"], display_name, output, latency_ms)
            scores.append(score)
            raw_results.append({
                "queryId": query["id"],
                "query": query["query"],
                "output": output,
                "latencyMs": latency_ms,
            })
            success_count += 1
            print(f'  {progress} "{query["query"][:40]}..." -> fmt={score["format"]:.2f} total={score["total"]:.2f} {latency_ms:.0f}ms')
        except Exception as error:
            fail_count += 1
            print(f'  {progress} "{query["query"][:40]}..." -> FAILED: {str(error)[:60]}')
            raw_results.append({
                "queryId": query["id"],
                "query": query["query"],
                "output": "",
                "latencyMs": 0,
                "error": str(error),
            })

    if scores:
        avg = {
            "format": sum(score["format"] for score in scores) / len(scores),
            "keyword": sum(score["keyword"] for score in scores) / len(scores),
            "semantic": sum(score["semantic"] for score in scores) / len(scores),
            "hyde": sum(score["hyde"] for score in scores) / len(scores),
            "latencyMs": sum(score["latencyMs"] for score in scores) / len(scores),
            "total": sum(score["total"] for score in scores) / len(scores),
        }
    else:
        avg = {"format": 0, "keyword": 0, "semantic": 0, "hyde": 0, "latencyMs": 0, "total": 0}

    print(f"\n  Results: {success_count} ok, {fail_count} failed")
    print(f"  Avg: format={avg['format']:.3f} kw={avg['keyword']:.3f} sem={avg['semantic']:.3f} hyde={avg['hyde']:.3f} speed={avg['latencyMs']:.0f}ms total={avg['total']:.3f}")

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    result_file = RESULTS_DIR / f"{model_key}-ft.json"
    result_data = {
        "model": {
            "name": display_name,
            "lmsKey": cfg["adapter"],
            "family": cfg["family"],
            "paramsB": cfg["paramsB"],
        },
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        "config": {
            "port": 0,
            "timeout": 60000,
            "retries": 0,
            "note": "Local inference via transformers+peft, not LM Studio",
        },
        "summary": avg,
        "queryCount": len(queries),
        "successCount": success_count,
        "failCount": fail_count,
        "scores": scores,
        "rawResults": raw_results,
    }
    result_file.write_text(json.dumps(result_data, indent=2))
    print(f"  Saved: {result_file}")

    del model
    del tokenizer
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    elif torch.backends.mps.is_available():
        torch.mps.empty_cache()

    return result_data

def main():
    parser = argparse.ArgumentParser(description="Evaluate fine-tuned query expansion models")
    parser.add_argument("--model", choices=list(MODELS.keys()), help="Run a single model")
    parser.add_argument("--all", action="store_true", help="Run all models")
    args = parser.parse_args()

    if not args.model and not args.all:
        parser.print_help()
        print(f"\nAvailable models: {', '.join(MODELS.keys())}")
        return

    if not QUERIES_PATH.exists():
        print(f"Queries file not found: {QUERIES_PATH}")
        return

    query_set = json.loads(QUERIES_PATH.read_text())
    queries = query_set["queries"]
    print(f"Loaded {len(queries)} queries ({query_set['version']})")

    model_keys = list(MODELS.keys()) if args.all else [args.model]
    print(f"Models to evaluate: {', '.join(model_keys)}")
    all_results = []
    start = time.time()

    for key in model_keys:
        try:
            result = benchmark_model(key, queries)
            all_results.append(result)
        except Exception as error:
            print(f"\nFATAL: {key} failed: {error}")
            import traceback
            traceback.print_exc()

    total_time = int(time.time() - start)
    print("\n" + "=" * 60)
    print(f"Benchmark Complete ({total_time}s total)")
    print("=" * 60)

    if all_results:
        print(f"\n{'Model':<20} {'Format':>7} {'Lex':>7} {'Vec':>7} {'HyDE':>7} {'Speed':>8} {'Total':>7}")
        print("-" * 70)
        for result in all_results:
            summary = result["summary"]
            print(
                f"{result['model']['name']:<20} "
                f"{summary['format']:>7.3f} "
                f"{summary['keyword']:>7.3f} "
                f"{summary['semantic']:>7.3f} "
                f"{summary['hyde']:>7.3f} "
                f"{summary['latencyMs']:>7.0f}ms "
                f"{summary['total']:>7.3f}"
            )

    print("\nRun report.ts for full comparison:")
    print("  bun run experiments/query-expansion/bench/report.ts")

if __name__ == "__main__":
    main()
`;

function printHelp(): void {
	console.log(`Fine-tuned query expansion benchmark

Usage:
  HF_TOKEN=... bun experiments/query-expansion/bench/run-finetuned.ts --model <name>
  HF_TOKEN=... bun experiments/query-expansion/bench/run-finetuned.ts --all

Options:
  --model <name>   Run one fine-tuned model
  --all            Run all fine-tuned models
  --uv <path>      uv binary path (default: uv)
  --help           Show this help

Models:
  ${Object.keys(MODELS).join(", ")}
`);
}

function parseArgs(argv: string[]): Args {
	const args: Args = { all: false, help: false, uv: "uv" };

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--all":
				args.all = true;
				break;
			case "--help":
			case "-h":
				args.help = true;
				break;
			case "--model": {
				const value = argv[++i];
				if (!value || !(value in MODELS)) {
					throw new Error(
						`Unknown model '${value ?? ""}'. Available: ${Object.keys(MODELS).join(", ")}`,
					);
				}
				args.model = value as ModelKey;
				break;
			}
			case "--uv": {
				const value = argv[++i];
				if (!value) throw new Error("--uv requires a path");
				args.uv = value;
				break;
			}
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return args;
}

function buildUvCommand(args: Args): string[] {
	const command = [args.uv, "run"];
	for (const dependency of UV_DEPENDENCIES) {
		command.push("--with", dependency);
	}
	command.push("python", "-c", BENCHMARK_PROGRAM);
	if (args.all) {
		command.push("--all");
	} else if (args.model) {
		command.push("--model", args.model);
	}
	return command;
}

async function main(): Promise<void> {
	const args = parseArgs(Bun.argv.slice(2));
	if (args.help || (!args.model && !args.all)) {
		printHelp();
		return;
	}

	const proc = Bun.spawn(buildUvCommand(args), {
		stdout: "inherit",
		stderr: "inherit",
		stdin: "inherit",
		env: {
			...Bun.env,
			MNEMEX_FT_BENCH_DIR: BENCH_DIR,
			MNEMEX_FT_MODELS: JSON.stringify(MODELS),
		},
	});
	const exitCode = await proc.exited;
	process.exit(exitCode);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : error);
	process.exit(1);
});
