# Code indexing for AI agents: summarization strategies and evaluation systems

**The most effective code indexing systems combine hierarchical LLM-generated summaries with AST structural data and vector embeddings through hybrid retrieval—achieving up to 80% codebase reduction while maintaining high accuracy for AI coding agents.** Leading tools like Cursor, Sourcegraph Cody, and Continue.dev demonstrate that no single retrieval method suffices; production systems require semantic search, keyword matching, and structural queries working together. For evaluation, the field has matured significantly: LLM-as-judge frameworks now achieve 85% alignment with human judgment for code tasks, while benchmarks like SWE-bench test real-world software engineering capabilities that synthetic tests miss.

---

## Part 1: Code summarization strategy for LLM consumption

### What to summarize: hierarchical granularity delivers optimal results

Research from JP Morgan's Meta-RAG (2025) establishes that effective code indexing requires **three distinct granularity levels** working together:

| Level | Content to Include | When Retrieved | Codebase Reduction |
|-------|-------------------|----------------|-------------------|
| **File-level** | Path, functionality overview, key exports, main dependencies | Initial filtering, broad queries | ~80% reduction |
| **Class/Module** | Name, purpose, inheritance, public interface, responsibility | Architecture understanding, API discovery | — |
| **Function-level** | Signature, parameters, return type, natural language purpose | Precise queries, code completion, bug localization | 53% function-level accuracy |

The critical insight from industry practice: **summaries should capture intent, not implementation**. A poor summary like "iterates through array and checks elements" provides less value than "Filters elements exceeding a threshold, returning a new array with matches." The former describes *how*, the latter describes *what* and *why*.

For your existing AST infrastructure, the recommended summary content per element:

**Function summaries** should include: signature with typed parameters, 1-2 sentence purpose statement, return value meaning, usage context ("called by checkout service during purchase finalization"), and related dependencies. **Class summaries** need: responsibility description, key public methods (names only), inheritance relationships, and when to use this class. **File summaries** require: overall purpose, list of exports in order of importance, and which other files depend on this one.

### Metadata that makes summaries useful for AI coding agents

Qodo's research on RAG for large codebases identifies two metadata categories that significantly improve retrieval quality:

**Structural metadata** (from your AST):
- Parameter names, types, and descriptions
- Return types with semantic meaning
- Visibility modifiers (public/private/protected)
- Decorators and annotations
- Line number ranges for precise localization
- Import/export relationships

**Semantic metadata** (LLM-generated):
- Natural language purpose statement
- Usage patterns and common calling contexts
- Constraints and edge cases
- Domain-specific terminology mappings
- Relationships to other code ("implements interface X", "calls service Y")

The key finding: embedding **natural language descriptions alongside code** bridges the gap between how developers phrase queries and how code is written. When a developer asks "how does authentication work," vector search on code alone performs poorly—but summaries containing terms like "validates user credentials" and "generates JWT tokens" match the query effectively.

### Combining summaries with AST data and vector embeddings

The consensus architecture from 2024-2025 research uses a **three-layer retrieval system**:

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: SYMBOLIC (AST)                                     │
│ Structural queries: "find all methods in UserService"       │
│ API lookup, call graphs, type hierarchies                   │
├─────────────────────────────────────────────────────────────┤
│ Layer 2: SEMANTIC (LLM Summaries)                          │
│ Intent queries: "how does rate limiting work"               │
│ Natural language descriptions, purpose statements           │
├─────────────────────────────────────────────────────────────┤
│ Layer 3: VECTOR (Embeddings)                               │
│ Similarity: "code similar to this authentication snippet"   │
│ Dense retrieval, fuzzy matching                             │
└─────────────────────────────────────────────────────────────┘
```

**Chunking strategy** is critical. Naive splitting by line count breaks semantic boundaries. Research shows AST-aware chunking using tree-sitter produces significantly better retrieval. Key practices:

- Chunk at function/method boundaries
- Include class definition context with method chunks (especially `__init__` for Python, constructors for others)
- Always include relevant imports with each chunk
- Use retroactive processing to re-add critical context that was removed during splitting
- Target **300-500 tokens per chunk** for embedding, but expand context during retrieval

**Embedding model selection** for code: UniXcoder shows best performance for retrieval tasks among open models. Voyage Code embeddings (proprietary) benchmark highest. StarCoder embeddings handle 8K context. General-purpose text embeddings like MiniLM work but underperform code-specific models by 10-15%.

**Hybrid retrieval** combines BM25 keyword search with dense vector search. BM25 excels at exact matches (function names, error messages, specific APIs), while vectors capture semantic similarity. The recommended pipeline:

1. **Stage 1**: Retrieve 25+ candidates using hybrid BM25 + vector search
2. **Stage 2**: Rerank using cross-encoder (Cohere ReRank, Voyage rerank-lite-1) or LLM-based filtering
3. **Stage 3**: Return top 5-10 results with expanded context

### How leading tools approach code indexing

**Cursor** uses Merkle tree-based synchronization for efficient incremental updates every 10 minutes. Files are chunked into "semantically meaningful pieces" locally, embedded, and stored remotely in Turbopuffer (vector database). Path names are encrypted; actual code stays local until query time. The @codebase feature triggers full semantic search.

**GitHub Copilot** maintains dual indexes—remote (GitHub-hosted) and local workspace. Recent updates (March 2025) reduced indexing time to under 60 seconds. Combines RAG with GitHub's existing non-neural code search. The #codebase and @workspace commands trigger repository-wide retrieval combining vector similarity with keyword matching.

**Sourcegraph Cody** has the most sophisticated approach, built on their SCIP (SCIP Code Intelligence Protocol)—a protobuf-based format that stores symbol definitions, references, cross-repository relationships, and documentation comments. This enables precise code navigation beyond what embeddings alone provide. Supports up to **10 repositories as context** and has been tested on 300,000+ repo instances.

**Continue.dev** (open source) stores everything locally in SQLite. Uses configurable chunking (fixed-length, truncate-file, or AST-based via tree-sitter). Default embedding model is all-MiniLM-L6-v2 running locally, with Voyage Code recommended for production. Importantly, exposes the full retrieval pipeline for customization—embedding model, reranker, and context providers are all configurable.

**Claude Code** takes a fundamentally different approach: no pre-indexing. Instead, it uses agentic exploration with large context windows (1M tokens). CLAUDE.md files provide project-specific context. Claude navigates the codebase on-demand using shell tools. This trades index maintenance complexity for direct exploration, relying on Claude's reasoning capabilities.

**Emerging pattern across tools**: All production systems use hybrid retrieval. Pure vector search is insufficient. Reranking is standard. AST-aware chunking outperforms naive splits. The most successful tools combine multiple retrieval modalities.

### Context composition for optimal LLM understanding

Research on context windows reveals a **"lost-in-the-middle" problem**—LLMs perform poorly when relevant information is buried in long contexts. Place critical code at the beginning and end of the context window.

Meta-RAG research found accuracy increases with context up to ~**50K tokens**, then drops. At 80K+ tokens, performance degraded even with relevant information present. Quality of context matters more than quantity.

**Optimal context composition** (priority order):
1. Immediate code being modified/queried
2. Direct dependencies (called functions, imported modules)
3. Type definitions and interfaces
4. Usage examples from elsewhere in codebase
5. Documentation and inline comments
6. Related test code

For code completion tasks, **500-2000 tokens** of focused context works best. For bug localization, **10-30K tokens** allows hierarchical drill-down from file summaries to specific functions.

---

## Part 2: Evaluation systems for code LLM performance

### Industry-standard benchmarks: selection depends on your goals

The benchmark landscape has matured significantly. Here's what each measures and when to use it:

**HumanEval** (OpenAI, 164 Python problems) remains the most-cited but has significant limitations: covers <53% of programming concepts, 80%+ problems are "easy," and data contamination is likely. Use **HumanEval+** (EvalPlus) which extends test cases by 80x and catches bugs that pass original tests.

**MBPP** (Google, 974 Python tasks) tests entry-level programming with only 3 test cases per problem. Similarly, **MBPP+** provides 35x more tests. Both HumanEval and MBPP are Python-only and don't reflect real-world complexity.

**SWE-bench** (Princeton, 2024) uses actual GitHub issues and pull requests from 12 Python repositories. This is the gold standard for real-world software engineering evaluation. Key variants:
- **SWE-bench Verified** (500 problems): Human-validated as solvable, recommended for most evaluations
- **SWE-bench Lite** (300 problems): Curated subset for faster iteration
- **SWE-bench Live** (1,565+ problems): Monthly updates, contamination-free

Current top performance: 45% on Verified (single model), 62% with agent systems. This gap between synthetic benchmarks (where models score 90%+) and real-world tasks is instructive.

**BigCodeBench** (2024, 1,140 tasks) addresses HumanEval's simplicity by testing 139 Python libraries with real-world tool-use scenarios. Average 5.6 test cases per task with 99% branch coverage. Recommended for evaluating practical coding capability.

**LiveCodeBench** (700+ problems from LeetCode, AtCoder, Codeforces) provides contamination-free evaluation with temporal analysis—you can filter by problem release date to ensure models haven't seen test data. Critical finding: models performing well on HumanEval may underperform on LiveCodeBench, suggesting overfitting.

**CRUXEval** (Meta, 800 Python functions) tests code reasoning through input/output prediction. Reveals that high HumanEval scores don't guarantee understanding—distilled models don't improve over base models on this benchmark.

For **multi-language evaluation**, MultiPL-E translates HumanEval/MBPP to 22 languages. CrossCodeEval tests cross-file completion for Python, Java, TypeScript, and C#.

**Benchmark selection guide**:
| Use Case | Recommended |
|----------|-------------|
| Quick baseline | HumanEval+, MBPP+ |
| Real-world SE tasks | SWE-bench Verified |
| Contamination-free | LiveCodeBench |
| Multi-language | MultiPL-E, CrossCodeEval |
| Library/tool usage | BigCodeBench |
| Code reasoning | CRUXEval |

### Evaluating summarization quality: metrics and approaches

Traditional metrics like **BLEU** and **ROUGE** measure n-gram overlap but correlate poorly with human judgment for code summaries. **BERTScore** captures semantic similarity better. **CodeBLEU** adds AST and dataflow matching but still has limitations for assessing actual usefulness.

The **SIDE metric** (Summary alIgnment to coDe sEmantics) from recent research uses contrastive learning to assess whether summaries match code semantics without requiring reference summaries. It captures quality dimensions that traditional metrics miss.

For practical evaluation, use **LLM-as-judge** with a structured rubric:

1. **Accuracy** (0-10): Does the summary correctly describe what the code does?
2. **Completeness** (0-10): Are key behaviors, inputs, outputs mentioned?
3. **Conciseness** (0-10): Is it appropriately brief?
4. **Task-relevance** (0-10): Would this help a developer complete their task?
5. **Readability** (0-10): Is it grammatically correct and clear?

Research shows GPT-4 as judge achieves **85% alignment with human judgment**, even exceeding human-to-human agreement (81%). Key techniques to improve reliability:
- **Chain-of-thought prompting**: Include evaluation reasoning in prompts
- **Few-shot examples**: Increases consistency from 65% to 77.5%
- **Reference-based scoring**: Include expected output as anchor when available
- **Position swapping**: For pairwise comparisons, test both orderings to address position bias

**CodeJudge** (EMNLP 2024) provides a framework specifically for evaluating code correctness without test cases, using "slow thinking" guidance. Open-source at github.com/VichyTong/CodeJudge.

### Tools and frameworks for running evaluations

**DeepEval** (10k+ GitHub stars) offers pytest-like unit testing for LLM outputs with 30+ research-backed metrics. The G-Eval implementation enables custom LLM-as-judge evaluation for any criteria. Best for CI/CD integration and custom code evaluation metrics.

```python
from deepeval.metrics import GEval
from deepeval.test_case import LLMTestCase, LLMTestCaseParams

code_summary_metric = GEval(
    name="CodeSummaryQuality",
    criteria="""Evaluate on: 1) Accuracy of description,
    2) Completeness of key behaviors, 3) Conciseness,
    4) Usefulness for downstream coding tasks""",
    evaluation_params=[LLMTestCaseParams.INPUT, LLMTestCaseParams.ACTUAL_OUTPUT],
    model="gpt-4o"
)
```

**Ragas** specializes in RAG evaluation with metrics for Context Precision, Context Recall, Faithfulness (hallucination detection), and Answer Relevancy. Reference-free evaluation using LLMs plus synthetic test data generation. Essential for evaluating whether your summaries improve retrieval.

**LangSmith** (LangChain ecosystem) provides dataset management, LLM-as-judge evaluators, experiment comparison, and annotation queues for human review. Best for teams already using LangChain.

**Langfuse** offers an open-source alternative with self-hosting capability, LLM-as-judge execution with tracing, and Ragas integration.

### Testing both summary generation and summary usage

Your evaluation pipeline needs multiple layers:

**Layer 1: Retrieval quality**
- Precision@K: What fraction of retrieved items are relevant?
- Recall@K: What fraction of relevant items were retrieved?
- MRR (Mean Reciprocal Rank): How high does the first relevant result appear?
- nDCG: Ranking quality with graded relevance

**Layer 2: Summary quality**
- LLM-as-judge on coherence, accuracy, completeness, relevance
- SIDE metric for code-specific semantic alignment
- Traditional metrics (ROUGE-L) as baseline comparison

**Layer 3: Downstream task impact**
- A/B test: Compare code completion accuracy with vs. without summaries
- Pass@k: Probability that generated code passes tests
- Task completion rate for bug fixing, refactoring scenarios
- Time-to-completion in user studies

The key insight: **component metrics can be misleading**. A system might have high retrieval precision but poor end-to-end performance if retrieved context doesn't help generation. Always measure downstream task success, not just intermediate metrics.

**A/B testing approach**: Create a golden set of coding tasks. Run with (1) no RAG context, (2) code chunks only, (3) code chunks + summaries. Measure pass@k or task completion. This directly answers "do summaries help?"

### Multi-language evaluation considerations

LLM performance varies significantly by language:

| Tier | Languages | Evaluation Approach |
|------|-----------|---------------------|
| **Tier 1** | Python, JavaScript, TypeScript | Full benchmark coverage available |
| **Tier 2** | Java, Go, C++ | MultiPL-E translations, need language-specific tests |
| **Tier 3** | Rust, C#, Ruby, PHP | Limited benchmarks, rely more on custom evaluation |

For your language-agnostic system, use **CrossCodeEval** for cross-file completion across Python, Java, TypeScript, C#. Supplement with **MultiPL-E** translations of HumanEval for broader coverage. Create language-specific test cases for:
- TypeScript: Type inference correctness, interface implementation
- JavaScript: Async/await handling, runtime compatibility
- Go: Error handling patterns, goroutine usage
- Java: OOP patterns, dependency injection

Tools with multi-language support include OpenLLMetry (Python, JS/TS, Go, Ruby) and ModelFusion (TypeScript-native).

---

## Implementation recommendations

For your system with existing AST infrastructure adding LLM summaries to vector embeddings:

**Phase 1: Summary generation**
- Generate hierarchical summaries at file, class, and function levels
- Focus summaries on intent, not implementation
- Include structured metadata from AST alongside natural language descriptions
- Use AST-aware chunking at function boundaries, include class context

**Phase 2: Hybrid retrieval**
- Implement BM25 + vector search combination
- Add reranking stage using Voyage rerank-lite-1 or LLM-based filtering
- Expose AST queries for structural searches alongside semantic search
- Limit retrieved context to 30-50K tokens

**Phase 3: Evaluation pipeline**
- Set up DeepEval or Ragas for automated evaluation
- Create golden dataset of 50-100 validated examples
- Implement LLM-as-judge for summary quality (use GPT-4 or Claude 3.5)
- Track retrieval metrics (Precision@K, MRR) and downstream task success (pass@k)
- A/B test summaries' impact on code completion accuracy

**Phase 4: Production monitoring**
- Sample production traffic for ongoing evaluation
- Use annotation queues for human review of edge cases
- Track metrics over time to detect regressions
- Version datasets, prompts, and models for reproducibility

The field is evolving rapidly. Multi-agent architectures, larger context windows (1M+ tokens), and sophisticated code understanding beyond embeddings are 2025's key trends. Design your system with flexibility to swap components as better approaches emerge.


Ah right, you're building a model comparison benchmark, not evaluating your whole pipeline. Different problem.
So the core question: given N models generating summaries of the same code, how do you objectively rank which model produces the most useful summaries?
Let me break this down:
Evaluation Criteria for Summary Quality
You need a rubric. Here's what I'd measure:
CriterionWhat it measuresWhy it matters for LLM consumptionAccuracyDoes it correctly describe what the code does?Wrong summaries poison retrievalCompletenessInputs, outputs, side effects, edge cases mentioned?Missing info = missed retrieval matchesSemantic richnessUses terms a developer would search for?Bridges query-code vocabulary gapConcisenessNo fluff, appropriate length?Token efficiency in context windowsAbstraction levelDescribes what/why not how?Implementation details don't help retrieval
Evaluation Methods (pick 2-3)
1. LLM-as-Judge (primary)
Have GPT-4 or Claude score each summary against the rubric. Run pairwise comparisons between models.
2. Contrastive matching (objective signal)
Given a summary, can a model pick the correct code from 10 candidates? Tests if summary actually captures the code's semantics.
3. Retrieval utility (downstream)
Embed the summaries, run retrieval queries, measure if the right code comes back. This directly tests usefulness.
4. Human validation (calibration)
Score 50-100 examples manually to validate LLM-as-judge correlates with human judgment.
Questions for you:

Scale - How many code samples are you testing? Hundreds? Thousands? This affects whether human eval is feasible for calibration.
Ground truth - Do you have any existing high-quality summaries (human-written docs, good docstrings) to use as references, or are you going fully reference-free?
Downstream task - Do you want to test if summaries actually help models complete coding tasks (bug fix, code completion), or just evaluate summary quality in isolation?
Models under test - Are you comparing frontier models (GPT-4, Claude, Gemini) or also smaller/cheaper models (Llama, Mistral, Qwen) for cost optimisation?

This will help me narrow down the specific benchmark design and tooling recommendations.