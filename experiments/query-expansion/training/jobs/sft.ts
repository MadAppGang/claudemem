#!/usr/bin/env bun
/**
 * Bun launcher for query expansion SFT training.
 *
 * The training stack itself is still PyTorch/TRL/PEFT, but the repo-owned
 * entrypoint and model registry now live in TypeScript. At runtime this script
 * asks uv to execute a small in-memory Python program with pinned dependencies,
 * so no Python source files need to live in the repository.
 *
 * Usage:
 *   HF_TOKEN=... bun experiments/query-expansion/training/jobs/sft.ts --model qwen3-1.7b
 *   bun experiments/query-expansion/training/jobs/sft.ts --model qwen3-1.7b --dry-run
 */

const MODELS = {
	"qwen3-4b-2507": {
		base: "Qwen/Qwen3-4B",
		hub_name: "claudemem-expansion-qwen3-4b",
		lora_rank: 16,
		lora_alpha: 32,
		epochs: 5,
		batch_size: 4,
		grad_accum: 4,
		lr: 2e-4,
		load_in_4bit: true,
	},
	"qwen3-1.7b": {
		base: "Qwen/Qwen3-1.7B",
		hub_name: "claudemem-expansion-qwen3-1.7b",
		lora_rank: 16,
		lora_alpha: 32,
		epochs: 5,
		batch_size: 4,
		grad_accum: 4,
		lr: 2e-4,
		load_in_4bit: true,
	},
	"lfm2-1.2b": {
		base: "LiquidAI/LFM2.5-1.2B-Instruct",
		hub_name: "claudemem-expansion-lfm2-1.2b",
		lora_rank: 16,
		lora_alpha: 32,
		epochs: 5,
		batch_size: 4,
		grad_accum: 4,
		lr: 2e-4,
		load_in_4bit: false,
	},
	"lfm2-700m": {
		base: "LiquidAI/LFM2-700M",
		hub_name: "claudemem-expansion-lfm2-700m",
		lora_rank: 16,
		lora_alpha: 32,
		epochs: 5,
		batch_size: 4,
		grad_accum: 4,
		lr: 2e-4,
		load_in_4bit: false,
	},
	"qwen3.5-9b": {
		base: "Qwen/Qwen3.5-9B",
		hub_name: "claudemem-expansion-qwen3.5-9b",
		lora_rank: 16,
		lora_alpha: 32,
		epochs: 5,
		batch_size: 1,
		grad_accum: 16,
		lr: 2e-4,
		load_in_4bit: true,
		gradient_checkpointing: true,
	},
	"qwen3.5-4b": {
		base: "Qwen/Qwen3.5-4B",
		hub_name: "claudemem-expansion-qwen3.5-4b",
		lora_rank: 16,
		lora_alpha: 32,
		epochs: 5,
		batch_size: 1,
		grad_accum: 16,
		lr: 2e-4,
		load_in_4bit: true,
		gradient_checkpointing: true,
	},
	"qwen3.5-2b": {
		base: "Qwen/Qwen3.5-2B",
		hub_name: "claudemem-expansion-qwen3.5-2b",
		lora_rank: 16,
		lora_alpha: 32,
		epochs: 5,
		batch_size: 2,
		grad_accum: 8,
		lr: 2e-4,
		load_in_4bit: true,
		gradient_checkpointing: true,
	},
	"phi4-mini": {
		base: "microsoft/Phi-4-mini-instruct",
		hub_name: "claudemem-expansion-phi4-mini",
		lora_rank: 16,
		lora_alpha: 32,
		epochs: 5,
		batch_size: 4,
		grad_accum: 4,
		lr: 2e-4,
		load_in_4bit: true,
	},
	"qwen3-8b": {
		base: "Qwen/Qwen3-8B",
		hub_name: "claudemem-expansion-qwen3-8b",
		lora_rank: 16,
		lora_alpha: 32,
		epochs: 5,
		batch_size: 2,
		grad_accum: 8,
		lr: 2e-4,
		load_in_4bit: true,
	},
} as const;

type ModelKey = keyof typeof MODELS;

interface Args {
	dryRun: boolean;
	help: boolean;
	hfUser: string;
	model?: ModelKey;
	uv: string;
}

const UV_DEPENDENCIES = [
	"trl>=0.15",
	"peft>=0.7.0",
	"transformers>=5.0.0",
	"accelerate>=0.24.0",
	"huggingface_hub>=0.25",
	"datasets",
	"bitsandbytes",
	"torch",
	"pillow",
	"torchvision",
];

const TRAINING_PROGRAM = String.raw`
import argparse
import json
import os

parser = argparse.ArgumentParser(description="SFT training for query expansion")
parser.add_argument("--model", required=True)
args = parser.parse_args()

MODELS = json.loads(os.environ["MNEMEX_SFT_MODELS"])
if args.model not in MODELS:
    raise SystemExit(f"Unknown model: {args.model}")

cfg = MODELS[args.model]
HF_USER = os.environ.get("MNEMEX_HF_USER", "jackrudenko")
DATASET_REPO = f"{HF_USER}/claudemem-expansion-data"
OUTPUT_MODEL = f"{HF_USER}/{cfg['hub_name']}"

from huggingface_hub import login, hf_hub_download

hf_token = os.environ.get("HF_TOKEN")
if hf_token:
    login(token=hf_token)

import torch
from datasets import Dataset
from peft import LoraConfig
from transformers import AutoModelForCausalLM, AutoTokenizer
from trl import SFTConfig, SFTTrainer

print(f"\n{'=' * 60}")
print(f"Training: {args.model}")
print(f"Base: {cfg['base']}")
print(f"LoRA r={cfg['lora_rank']} alpha={cfg['lora_alpha']}")
print(f"Epochs: {cfg['epochs']}, Batch: {cfg['batch_size']}x{cfg['grad_accum']}")
print(f"Output: {OUTPUT_MODEL}")
print(f"{'=' * 60}\n")

train_path = hf_hub_download(
    repo_id=DATASET_REPO,
    filename="train-split.jsonl",
    repo_type="dataset",
)
eval_path = hf_hub_download(
    repo_id=DATASET_REPO,
    filename="eval-split.jsonl",
    repo_type="dataset",
)

def load_jsonl_as_messages(path):
    conversations = []
    with open(path) as handle:
        for line in handle:
            if not line.strip():
                continue
            obj = json.loads(line)
            messages = obj.get("messages")
            if messages and len(messages) == 3:
                conversations.append({"messages": messages})
    return Dataset.from_list(conversations)

train_ds = load_jsonl_as_messages(train_path)
eval_ds = load_jsonl_as_messages(eval_path)
print(f"Train: {len(train_ds)} examples, Eval: {len(eval_ds)} examples")

tokenizer = AutoTokenizer.from_pretrained(cfg["base"])
if tokenizer.pad_token is None:
    tokenizer.pad_token = tokenizer.eos_token

def format_messages(example):
    text = tokenizer.apply_chat_template(
        example["messages"],
        tokenize=False,
        add_generation_prompt=False,
    )
    return {"text": text}

train_ds = train_ds.map(format_messages)
eval_ds = eval_ds.map(format_messages)

print("\nSample formatted text (first 300 chars):")
print(train_ds[0]["text"][:300])
print("...\n")

sft_config = SFTConfig(
    output_dir=f"outputs/{args.model}",
    push_to_hub=True,
    hub_model_id=OUTPUT_MODEL,
    hub_strategy="every_save",
    num_train_epochs=cfg["epochs"],
    per_device_train_batch_size=cfg["batch_size"],
    gradient_accumulation_steps=cfg["grad_accum"],
    learning_rate=cfg["lr"],
    max_length=512,
    logging_steps=10,
    save_strategy="epoch",
    save_total_limit=2,
    eval_strategy="epoch",
    warmup_ratio=0.03,
    lr_scheduler_type="cosine",
    bf16=True,
    gradient_checkpointing=cfg.get("gradient_checkpointing", False),
    report_to="none",
)

peft_config = LoraConfig(
    r=cfg["lora_rank"],
    lora_alpha=cfg["lora_alpha"],
    lora_dropout=0.0,
    bias="none",
    task_type="CAUSAL_LM",
    target_modules=[
        "q_proj",
        "k_proj",
        "v_proj",
        "o_proj",
        "gate_proj",
        "up_proj",
        "down_proj",
    ],
)

model_kwargs = {
    "device_map": "auto",
    "torch_dtype": torch.bfloat16,
}

if cfg["load_in_4bit"]:
    from transformers import BitsAndBytesConfig

    model_kwargs["quantization_config"] = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )

print("Initializing SFT trainer...")
model = AutoModelForCausalLM.from_pretrained(cfg["base"], **model_kwargs)
model.config.use_cache = False

trainer = SFTTrainer(
    model=model,
    train_dataset=train_ds,
    eval_dataset=eval_ds,
    args=sft_config,
    peft_config=peft_config,
)

print("Starting SFT training...")
trainer.train()

print("\nPushing to Hub...")
trainer.push_to_hub()
print(f"\nDone! Model: https://huggingface.co/{OUTPUT_MODEL}")
`;

function printHelp(): void {
	console.log(`SFT training launcher

Usage:
  HF_TOKEN=... bun experiments/query-expansion/training/jobs/sft.ts --model <name>
  bun experiments/query-expansion/training/jobs/sft.ts --model <name> --dry-run

Options:
  --model <name>   Model config to train
  --hf-user <name> HuggingFace namespace (default: jackrudenko)
  --uv <path>      uv binary path (default: uv)
  --dry-run        Print the uv command and model config only
  --help           Show this help

Models:
  ${Object.keys(MODELS).join(", ")}
`);
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		dryRun: false,
		help: false,
		hfUser: "jackrudenko",
		uv: "uv",
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--dry-run":
				args.dryRun = true;
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
			case "--hf-user": {
				const value = argv[++i];
				if (!value) throw new Error("--hf-user requires a value");
				args.hfUser = value;
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
	if (!args.model) {
		throw new Error("--model is required");
	}

	const command = [args.uv, "run"];
	for (const dependency of UV_DEPENDENCIES) {
		command.push("--with", dependency);
	}
	command.push("python", "-c", TRAINING_PROGRAM, "--model", args.model);
	return command;
}

async function main(): Promise<void> {
	const args = parseArgs(Bun.argv.slice(2));
	if (args.help || !args.model) {
		printHelp();
		return;
	}

	const command = buildUvCommand(args);
	const cfg = MODELS[args.model];
	if (args.dryRun) {
		console.log("Dry run: would execute");
		console.log(buildPrintableUvCommand(args).map(shellQuote).join(" "));
		console.log("\nModel config:");
		console.log(JSON.stringify(cfg, null, 2));
		return;
	}

	const proc = Bun.spawn(command, {
		stdout: "inherit",
		stderr: "inherit",
		stdin: "inherit",
		env: {
			...Bun.env,
			MNEMEX_HF_USER: args.hfUser,
			MNEMEX_SFT_MODELS: JSON.stringify(MODELS),
		},
	});
	const exitCode = await proc.exited;
	process.exit(exitCode);
}

function shellQuote(value: string): string {
	if (/^[a-zA-Z0-9_./:=@+-]+$/.test(value)) {
		return value;
	}
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildPrintableUvCommand(args: Args): string[] {
	const command = [args.uv, "run"];
	for (const dependency of UV_DEPENDENCIES) {
		command.push("--with", dependency);
	}
	command.push(
		"python",
		"-c",
		"<in-memory training program>",
		"--model",
		args.model ?? "<model>",
	);
	return command;
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : error);
	process.exit(1);
});
