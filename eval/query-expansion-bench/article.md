We ran 12 small language models through a structured evaluation. 50 code search queries. Five scoring dimensions. Most models couldn't reliably produce three lines of formatted output.

This isn't a toy benchmark. We're building the query understanding layer for claudemem, a semantic code search engine that ships to production. When a developer types "authentication middleware" our system needs to instantly expand that into keyword variants for BM25 retrieval, a semantic rephrasing for vector search, and a hypothetical code snippet for HyDE matching. That expansion has to run locally, on device, in under two seconds.

The base model we pick for fine-tuning determines whether this pipeline works or falls apart in production.

We evaluated three model families across 11 configurations: Alibaba's Qwen3.5 (0.8B, 2B, 4B, 9B), Qwen3 (4B, 4B-2507 revision, 8B), and Liquid AI's LFM2 (350M, 700M, 1.2B, 2.6B). All 4-bit quantized. All running on Apple Silicon M-series through LM Studio's inference server. 4-bit because that's what we'll deploy after fine-tuning.

The test set covers five categories that represent real developer search patterns: symbol lookups, error diagnostics, architecture concepts, framework-specific queries, and code review tasks. Ten queries per category.

```
Model             Fmt   Lex   Vec   HyDE  Speed   Total
LFM2-2.6B        1.00  0.91  1.00  0.60  1.9s    0.816
Qwen3-4B-2507    1.00  0.96  1.00  0.63  2.2s    0.811
LFM2.5-1.2B      0.99  0.69  1.00  0.27  0.6s    0.728
Qwen3.5-2B       0.96  0.99  0.90  0.49  9.4s    0.712
LFM2-700M        0.88  0.86  0.86  0.26  0.7s    0.708
Qwen3.5-0.8B     1.00  0.80  1.00  0.34  7.5s    0.666
LFM2-350M        0.46  0.00  0.60  0.25  1.3s    0.366
Qwen3-4B         0.34  0.52  0.29  0.06  5.5s    0.278
Qwen3-8B         0.32  0.31  0.23  0.14  12.2s   0.222
Qwen3.5-4B       0.00  0.00  0.00  0.00  8.3s    BROKEN
Qwen3.5-9B       0.00  0.00  0.00  0.00  14.6s   BROKEN
```

Fmt: format compliance. Lex: keyword expansion quality. Vec: semantic rephrasing. HyDE: hypothetical code generation. Total: weighted composite (format 0.20, lex 0.20, vec 0.20, hyde 0.25, speed 0.15).

Qwen3.5-4B and Qwen3.5-9B scored zero across every dimension. Not low. Zero. The models crash mid-inference with a Channel Error in LM Studio's MLX backend. We tested MLX 4-bit, MLX 8-bit, and GGUF Q4_K_M variants of the 9B. All broken. We spent significant time ruling out configuration issues.

The most interesting finding wasn't a model. It was a revision.

Qwen3-4B scored 0.278. Qwen3-4B-2507, the July 2025 training data refresh of the same architecture, scored 0.811. Same parameter count. Same quantization format. Same inference stack. A 2.9x improvement from training data alone. That revision jumped from 34% format compliance to 100%, and produced the highest quality hypothetical code of any model we tested.

The scoring pipeline evaluates each model response on five axes:

```typescript
const WEIGHTS = {
  format: 0.20,    // structured output compliance
  keyword: 0.20,   // BM25 term expansion quality
  semantic: 0.20,  // vector search rephrasing
  hyde: 0.25,      // hypothetical code generation
  speed: 0.15      // inference latency
};
```

HyDE quality carries the highest weight because it's the hardest task and the biggest differentiator between models. Format compliance and keyword expansion become table stakes above 700M parameters. But generating a plausible code snippet that matches search intent requires genuine code understanding. Only two models scored above 0.50 on HyDE: LFM2-2.6B (0.60) and Qwen3-4B-2507 (0.63).

Three findings that will shape our fine-tuning strategy.

**Bigger breaks at 4-bit.** The 8B and 9B models consistently performed worse than 4B models. Qwen3.5's larger variants produce degenerate output at aggressive quantization levels. This isn't a minor quality degradation. It's total failure. If you're planning to deploy quantized models above 4B parameters in the Qwen3.5 family, test thoroughly before committing.

**Liquid's LFM2 architecture has a massive speed advantage.** LFM2 models run 8-10x faster than equivalent Qwen models on identical hardware. The LFM2.5-1.2B completes a query expansion in 558ms. The comparable Qwen3.5-2B takes 9.4 seconds. For interactive developer tools where query expansion runs on every keystroke, this gap is the difference between usable and unusable.

**Training data revision matters more than architecture or scale.** A 4B Qwen3 model from July 2025 matches a 2.6B Liquid model built on a fundamentally different architecture. The conventional wisdom that you need to move up a parameter class to get meaningfully better results doesn't hold when the smaller model has better training data.

Our production fine-tuning lineup:

Qwen3-4B-2507 as the premium tier. Highest quality, best code generation, reasonable speed at 2.2 seconds. LFM2.5-1.2B as the default tier. Third in quality but fastest at 558ms in a 663MB package. LFM2-700M for constrained environments. Scores 0.708 in 422MB.

The open question we're taking into fine-tuning: the Qwen3-4B-2507 already outperforms every other model on structured output compliance without any task-specific training. Will fine-tuning close the gap for the LFM2 models on HyDE quality, or will the Qwen's stronger base understanding of code compound during fine-tuning and pull further ahead?

We'll publish the fine-tuning results when we have them.
