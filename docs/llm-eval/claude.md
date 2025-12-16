# Evaluating LLM Code Understanding for Semantic Search

Building a benchmark to evaluate which LLM best understands a specific codebase requires combining retrieval metrics, execution-based evaluation, and self-supervised techniques that work without extensive manual labeling. **Round-Trip Correctness (RTC)** emerges as the most powerful unsupervised technique, showing **0.95 Pearson correlation** with human-curated benchmarks like HumanEval. For retrieval quality, **NDCG with graded relevance** is the industry standard (used by CodeSearchNet), while **LLM-as-judge approaches** like ICE-Score and CodeJudge provide cost-effective quality assessment with 12-42% higher correlation with human judgment than traditional metrics like BLEU.

The research reveals a significant gap: even state-of-the-art models score only **~23% on complex multi-file tasks** (SWE-bench Pro) despite achieving 70%+ on simpler verified tasks. This makes codebase-specific evaluation essential—standard benchmarks don't capture real-world code understanding. Industry leaders like Cursor report **12.5% higher accuracy** with semantic search and use custom "Context Bench" evaluations on their own codebases to measure what matters for production use.

---

## Academic benchmarks provide foundational methodology

**CodeSearchNet** remains the gold standard for semantic code search evaluation, featuring ~6 million functions across 6 languages with 99 natural language queries and ~4,000 expert relevance annotations using a **0-3 graded relevance scale**. The primary metric is NDCG (Normalized Discounted Cumulative Gain), which appropriately weights results by position and relevance grade. MRR serves as a secondary metric for scenarios where only the first correct result matters.

**CodeXGLUE** (Microsoft, 2021) extends this with 10 tasks across 14 datasets, introducing **CodeBLEU**—a metric combining n-gram matching with AST comparison and data-flow analysis. Optimal weights favor structural components: (0.1, 0.1, 0.4, 0.4) for n-gram, weighted n-gram, AST match, and data-flow match respectively, achieving 0.98 correlation with human judgment for code tasks.

For execution-based evaluation, **HumanEval** and its enhanced version **EvalPlus** (with 80× more test cases) use the **pass@k** metric—the probability of solving a problem correctly with k attempts. EvalPlus revealed that original HumanEval had 10%+ incorrectly implemented ground truths, demonstrating why rigorous testing matters. The formula is:

```
pass@k = 1 - C(n-c,k)/C(n,k)
```

where n = total samples generated, c = correct samples. Standard k values are 1, 10, and 100.

**SWE-bench** represents the cutting edge for repository-level evaluation, using real GitHub issues requiring multi-file changes. The recently released **SWE-bench Pro** (1,865 tasks across 41 repositories) shows massive performance drops from isolated to real-world settings: models achieving **70%+ on SWE-bench Verified score only ~23% on Pro**—validating the need for codebase-specific evaluation.

---

## Retrieval metrics must match your use case

| Use Case | Primary Metric | Secondary Metrics | When to Use |
|----------|---------------|-------------------|-------------|
| Single correct answer | **MRR** | Precision@1, Recall@10 | IDE "I'm Feeling Lucky" |
| Multiple valid results | **MAP@10** | NDCG@10, Recall@10 | Code search interfaces |
| Graded relevance | **NDCG@10** | MAP@10, MRR | Expert-annotated systems |
| Comprehensive retrieval | **NDCG@100** | Recall@100 | Full codebase search |

**NDCG** should be your primary metric when you have graded relevance judgments. It uses logarithmic discounting to penalize relevant results appearing lower in rankings while normalizing against the ideal ordering. CodeSearchNet's 4-point scale (0=irrelevant, 1=marginally relevant, 2=fairly relevant, 3=highly relevant) works well because research by Sormunen found ~50% of "relevant" documents were only marginally relevant—binary judgments miss this nuance.

**MRR** (Mean Reciprocal Rank) works best when users only care about the first correct result. The formula is simply the average of 1/rank for the first relevant result across all queries. It's computationally cheap but ignores multiple valid code implementations—a common scenario where different functions correctly solve the same problem.

**MAP@10** handles multiple relevant results better by averaging precision at each relevant position. Research from CoSQA+ recommends it as the primary metric for multi-choice code search. The key difference: MAP "drops more rapidly if there are non-relevant items at the top" compared to NDCG, making it more sensitive to early mistakes.

For **embedding similarity**, cosine similarity between code and query embeddings is standard. Current code embedding models include **CodeBERT** (MRR ~0.27-0.41 on CodeSearchNet), **GraphCodeBERT** (~0.31-0.47, incorporating code structure), and **UniXcoder** (state-of-the-art, unified cross-modal). Key finding: models require fine-tuning on your specific codebase—GraphCodeBERT without fine-tuning shows limited performance on real queries.

---

## Evaluating code relationships requires multi-tier testing

Understanding code dependencies and cross-file context distinguishes true comprehension from surface-level pattern matching. Research identifies three tiers of evaluation complexity:

**Tier 1 (Basic identification)** tests whether the model can identify function calls, imports, and variable scopes. Use Tree-sitter to generate AST-based ground truth and compare model outputs directly. This reveals baseline structural understanding.

**Tier 2 (Relationship understanding)** evaluates call graph construction, cross-file reference resolution, and inheritance hierarchy mapping. The **CrossCodeEval** benchmark (NeurIPS 2023) specifically tests this using static analysis to identify code requiring cross-file context, measuring dramatic performance improvements when that context is provided.

**Tier 3 (Deep comprehension)** tests multi-hop reasoning: "What function calls function X which then accesses variable Y?" Research from arXiv 2407.21049 found performance degrades **up to 2× when a function references another defined later in the prompt**. Adding call-graph comments to prompts improved multi-step retrieval performance up to 3×—suggesting your benchmark should include context ordering variations.

For **design pattern recognition**, studies using CodeBERT and RoBERTa embeddings achieved **F1 of 0.91** on the P-MARt repository for GoF pattern detection. Testing pattern recognition reveals architectural understanding beyond syntax.

The **DynaCode** framework (2025) offers a sophisticated approach: constructing call-graph structures of varying complexity and evaluating models from both code complexity and call-graph complexity perspectives. Key finding: LLMs perform well on sequential call graphs but struggle significantly with complex, multi-branch dependencies.

---

## Round-Trip Correctness enables label-free evaluation

**Round-Trip Correctness (RTC)** from Google DeepMind represents the most validated unsupervised evaluation method. The approach:

1. **Forward pass**: Model describes code in natural language: `M(code) → description`
2. **Backward pass**: Model regenerates code from description: `M⁻¹(description) → code'`
3. **Evaluate**: Compare semantic equivalence of original and regenerated code

The critical finding: RTC achieves **Pearson r=0.95 correlation with pass@1 on HumanEval** while requiring no human annotations. The metric captures whether the model truly understood the code well enough to preserve its semantics through the description.

Implementation pseudocode:
```python
def evaluate_rtc(model, code_samples, test_suite):
    results = []
    for code in code_samples:
        description = model.describe(code)  # Forward
        regenerated = model.generate(description)  # Backward
        
        if has_tests(code):
            score = run_tests(regenerated, test_suite)  # Execution-based
        else:
            score = code_similarity(code, regenerated)  # Similarity-based
        results.append(score)
    return mean(results)
```

**Forward Lift** provides additional signal by comparing model-generated descriptions against an uninformative baseline ("TODO: Implement"). Positive lift indicates the description contains genuinely helpful information for regeneration.

**IdentityChain** extends this with a self-consistency framework: generate code from specification, generate specification from that code, then generate code again. A trustworthy model should produce semantically equivalent results. The Patched RTC extension applies this to patches and PR reviews with **0.81 Pearson correlation to Arena-Hard-Auto benchmark**.

---

## Existing artifacts provide free ground truth

Your codebase already contains evaluation data requiring no manual labeling:

**Test suites** offer the strongest ground truth. The SWE-Dev approach parses test files to extract test-to-code relationships, uses dynamic tracing to build call trees, then masks source code to create tasks with executable validation. This provides functionality-level feedback without human annotation.

**Docstrings and documentation** create natural (code, description) pairs. Extract functions with docstrings, mask the code, and evaluate whether the model can regenerate semantically equivalent implementations. **BERTScore** shows median similarity of ~75% between unrelated descriptions and ~84% for correct descriptions—use this 9-point gap as your discrimination threshold.

**Git history** provides (commit message, code diff) pairs representing real developer descriptions of changes. PR descriptions, code review comments, and linked issue descriptions extend this corpus. Merged PRs serve as positive examples of valid code changes.

**Import relationships** and function call graphs serve as implicit dependency labels. Module boundaries define natural context windows. Type annotations specify expected interface contracts. All extractable via static analysis without human effort.

For **silver label generation**, use LLMs to describe undocumented code, then apply self-consistency filtering:
```python
descriptions = [model.describe(code) for _ in range(3)]
confidence = semantic_similarity(descriptions)
if confidence > 0.8:
    use_as_silver_label(majority_vote(descriptions))
```

Research shows averaging token-level log probabilities provides reliable confidence scores, enabling 95%+ accuracy on labeling tasks with ensemble approaches.

---

## Industry practices reveal production-ready patterns

**Cursor** leads in semantic code search evaluation methodology. Their approach:
- **Context Bench**: Internal benchmark with known correct answers about codebase information
- Custom embedding model trained on agent session traces where LLMs rank helpful content
- A/B testing comparing semantic search vs. grep-only
- Key metrics: **code retention rate** (does generated code stay?) and **dissatisfied user request rate** (do users need follow-up corrections?)

Results: **12.5% higher accuracy** on average (6.5%-23.5% depending on model), **2.6% better code retention** on large codebases (1000+ files), **2.2% reduction** in dissatisfied requests.

**GitHub Copilot** uses a comprehensive SPACE framework: Satisfaction, Performance, Activity, Communication, Efficiency. Their controlled study (202 developers, 11 weeks) found:
- **56% more likely** to pass all unit tests
- **+3.62% readability**, **+2.94% reliability**, **+2.47% maintainability**
- Primary metric: **Acceptance Rate** (suggestions shown vs. accepted)
- Secondary metric: **Persistence Rate** (whether accepted code remains unchanged)

**Sourcegraph** tracks **Completion Acceptance Rate (CAR%)** and introduced **Percentage of Code Written (PCW)** measuring AI-generated code proportion. Their research cites Google findings that 98% of developers consider code search critical, using it 5.3 sessions per day.

Common patterns across industry:
- Hybrid evaluation combining automated tests + LLM-as-judge + optional human review
- A/B testing infrastructure for production comparison
- Effect sizes are often small (2-5%)—need sufficient sample sizes
- 11 weeks required for full productivity gains realization in controlled studies

---

## LLM-as-judge provides scalable quality assessment

**ICE-Score** (EACL 2024) evaluates code across dimensions: correctness, usefulness, comprehensiveness using 0-4 scales with Chain-of-Thought reasoning. It's reference-free (doesn't require gold-standard code) and achieves higher correlation with human judgment than BLEU/CodeBLEU.

**CodeJudge** (EMNLP 2024) improves on this with **12.1-41.8% higher correlation** with functional correctness. Key finding: open-source models like Llama-3-8B achieve comparable results to GPT-3.5. However, few-shot and CoT prompting can sometimes reduce correlation due to incorrect initial judgments propagating through reasoning chains.

Best practices for LLM-as-judge:
- **Separate evaluators per dimension**: Split correctness, completeness, relevance
- **Use small integer scales**: 1-4 or 1-5 rather than continuous ranges
- **One-shot prompting**: Often outperforms zero-shot and many-shot
- **Perturbation testing**: Swap positions, invert scoring scales to validate reliability
- **Known biases**: Verbosity bias (prefers longer outputs), position bias (GPT-4 prefers first output in pairwise comparison)

For code summarization specifically, research in "Out of the BLEU" (Evtikhiev et al., 2023) found **ChrF** (character n-gram F-score) correlates better with human judgment than BLEU or CodeBLEU. The practical implication: don't rely solely on BLEU for evaluating description quality.

---

## Building your benchmark system

**Phase 1: Extract existing ground truth (Week 1)**
```python
# Test suite relationships
tests = parse_test_files(repo)
test_to_code_map = trace_test_coverage(tests)

# Documentation pairs
docstring_pairs = [(f.code, f.docstring) for f in repo.functions if f.docstring]

# Git history
commits = parse_git_history(repo)
commit_pairs = [(c.message, c.diff) for c in commits]
```

**Phase 2: Implement core metrics (Week 2)**
- RTC evaluation with test execution where available
- NDCG@10 for retrieval quality using existing docstrings as queries
- Self-consistency checking across multiple model responses

**Phase 3: Generate evaluation dataset (Week 3)**
- Silver labels for undocumented functions using confidence filtering
- Cross-file test cases from dependency analysis
- Multi-hop queries from call graph traversal

**Phase 4: Benchmark LLMs (Week 4)**
- Run all metrics across candidate models
- Statistical significance testing via bootstrap (1000 replicates)
- Generate per-module performance breakdown to identify model strengths/weaknesses

**Recommended tool stack**:
- **Tree-sitter**: AST parsing for 138+ languages, ground truth extraction
- **bigcode-evaluation-harness**: Comprehensive code LLM evaluation
- **pytrec_eval**: Standard IR metrics (NDCG, MAP, MRR)
- **CodeBERTScore**: Semantic similarity for code

---

## Conclusion: Prioritizing what matters

Three metrics should form your evaluation core: **RTC for understanding verification** (0.95 correlation with human judgment, no labels required), **NDCG@10 for retrieval quality** (industry standard with graded relevance), and **pass@k on your test suite** for execution-based validation.

The key insight from this research: **standard benchmarks significantly overestimate real-world performance**. SWE-bench Pro shows 3× performance drops from verified to realistic multi-file scenarios. Cursor's semantic search provides only 2-3% improvement in production despite 12.5% gains on targeted evaluation. Your benchmark must use your actual codebase and realistic queries to predict production performance.

Start with RTC—it's the highest-signal unsupervised method available. Use existing test suites for execution-based ground truth. Generate silver labels for scale. Test cross-file understanding explicitly, as this is where models differ most dramatically. And implement statistical significance testing, because with production effect sizes of 2-5%, you need rigor to distinguish real improvements from noise.
