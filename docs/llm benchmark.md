# LLM Code Summary Evaluation Benchmark

## Complete Implementation Specification

---

## 1. System Overview

### Purpose
Evaluate and rank different LLM models on their ability to generate useful code summaries for RAG-based code navigation systems.

### Evaluation Pipeline

```
┌────────────────────────────────────────────────────────────────────────────┐
│ PHASE 1: EXTRACTION                                                        │
│ Extract code units (functions, classes, files) from target codebase        │
└────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ PHASE 2: GENERATION                                                        │
│ Run each model under test to generate summaries for all code units         │
└────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ PHASE 3: EVALUATION                                                        │
│ ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│ │ Eval 1:      │  │ Eval 2:      │  │ Eval 3:      │  │ Eval 4:      │    │
│ │ LLM-as-Judge │  │ Contrastive  │  │ Retrieval    │  │ Downstream   │    │
│ │ (Quality)    │  │ (Matching)   │  │ (Search)     │  │ (Tasks)      │    │
│ └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘    │
└────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ PHASE 4: AGGREGATION & REPORTING                                           │
│ Combine scores, generate rankings, produce detailed report                 │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Data Models

### 2.1 Code Unit Schema

```typescript
interface CodeUnit {
  id: string;                    // Unique identifier (hash of content + path)
  path: string;                  // File path relative to repo root
  name: string;                  // Function/class/file name
  type: 'function' | 'class' | 'method' | 'file' | 'module';
  language: string;              // typescript, javascript, go, python, java, etc.
  content: string;               // The actual code
  
  // AST-derived metadata
  metadata: {
    startLine: number;
    endLine: number;
    signature?: string;          // Function signature if applicable
    parameters?: Parameter[];
    returnType?: string;
    visibility?: 'public' | 'private' | 'protected';
    decorators?: string[];
    dependencies: string[];      // Imports/requires used
    exports?: string[];          // What this unit exports
    complexity?: number;         // Cyclomatic complexity if computed
  };
  
  // Relationships from AST
  relationships: {
    parentId?: string;           // Containing class/file
    childIds: string[];          // Methods if class, functions if file
    callsIds: string[];          // Functions this code calls
    calledByIds: string[];       // Functions that call this code
  };
}

interface Parameter {
  name: string;
  type?: string;
  description?: string;
  optional: boolean;
  defaultValue?: string;
}
```

### 2.2 Generated Summary Schema

```typescript
interface GeneratedSummary {
  id: string;                    // Unique identifier
  codeUnitId: string;            // Reference to CodeUnit
  modelId: string;               // Which model generated this
  
  summary: string;               // The generated summary text
  
  generationMetadata: {
    modelName: string;           // e.g., "claude-3.5-sonnet"
    modelVersion: string;        // e.g., "20241022"
    promptVersion: string;       // Version of the prompt used
    temperature: number;
    maxTokens: number;
    generatedAt: string;         // ISO timestamp
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    cost?: number;               // Estimated cost in USD
  };
}
```

### 2.3 Evaluation Result Schema

```typescript
interface EvaluationResult {
  id: string;
  summaryId: string;             // Reference to GeneratedSummary
  evaluationType: 'judge' | 'contrastive' | 'retrieval' | 'downstream';
  
  // For judge evaluation
  judgeResults?: {
    judgeModelId: string;
    scores: {
      accuracy: number;          // 1-5
      completeness: number;      // 1-5
      semanticRichness: number;  // 1-5
      abstraction: number;       // 1-5
      conciseness: number;       // 1-5
    };
    reasoning: string;           // Judge's explanation
    pairwiseWins?: number;       // Wins in head-to-head comparisons
    pairwiseLosses?: number;
  };
  
  // For contrastive evaluation
  contrastiveResults?: {
    correct: boolean;
    predictedRank: number;       // Where correct answer ranked (1 = first)
    distractorIds: string[];     // Which code units were distractors
    method: 'embedding' | 'llm';
  };
  
  // For retrieval evaluation
  retrievalResults?: {
    queryId: string;
    retrievedAtK: number[];      // [1, 3, 5, 10] - was it in top K?
    reciprocalRank: number;
  };
  
  // For downstream task evaluation
  downstreamResults?: {
    taskType: 'completion' | 'bug_localisation' | 'function_selection';
    taskId: string;
    success: boolean;
    partialScore?: number;       // 0-1 for partial credit
  };
  
  evaluatedAt: string;
}
```

### 2.4 Benchmark Run Schema

```typescript
interface BenchmarkRun {
  id: string;
  name: string;
  description: string;
  
  config: BenchmarkConfig;
  
  codebaseInfo: {
    name: string;
    repository?: string;
    commit?: string;
    languages: string[];
    totalCodeUnits: number;
    sampledCodeUnits: number;
  };
  
  modelsUnderTest: ModelConfig[];
  judgeModels: ModelConfig[];
  
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  
  results?: BenchmarkResults;
}

interface BenchmarkConfig {
  sampleSize: number;            // How many code units to test
  samplingStrategy: 'random' | 'stratified' | 'all';
  
  evaluations: {
    judge: {
      enabled: boolean;
      judgeModels: string[];
      usePairwise: boolean;
    };
    contrastive: {
      enabled: boolean;
      distractorCount: number;
      method: 'embedding' | 'llm' | 'both';
    };
    retrieval: {
      enabled: boolean;
      queriesPerUnit: number;
      kValues: number[];         // e.g., [1, 3, 5, 10]
    };
    downstream: {
      enabled: boolean;
      tasks: ('completion' | 'bug_localisation' | 'function_selection')[];
    };
  };
  
  weights: {
    judge: number;
    contrastive: number;
    retrieval: number;
    downstream: number;
  };
}

interface ModelConfig {
  id: string;
  provider: 'anthropic' | 'openai' | 'google' | 'openrouter' | 'local';
  modelName: string;
  apiEndpoint?: string;
  temperature: number;
  maxTokens: number;
}
```

---

## 3. Phase 1: Code Extraction

### 3.1 Extraction Pipeline

```typescript
interface ExtractionConfig {
  rootPath: string;
  languages: string[];
  includePatterns: string[];     // e.g., ["src/**/*.ts"]
  excludePatterns: string[];     // e.g., ["**/*.test.ts", "node_modules/**"]
  
  extraction: {
    functions: boolean;
    classes: boolean;
    methods: boolean;
    files: boolean;              // File-level summaries
  };
  
  filters: {
    minLines: number;            // Skip trivial code
    maxLines: number;            // Skip huge files
    skipGenerated: boolean;      // Skip auto-generated code
    skipTests: boolean;
  };
}
```

### 3.2 Language-Specific Extractors

Use tree-sitter for AST parsing. Required grammars:

| Language | Tree-sitter Grammar | NPM Package |
|----------|-------------------|-------------|
| TypeScript | tree-sitter-typescript | `tree-sitter-typescript` |
| JavaScript | tree-sitter-javascript | `tree-sitter-javascript` |
| Python | tree-sitter-python | `tree-sitter-python` |
| Go | tree-sitter-go | `tree-sitter-go` |
| Java | tree-sitter-java | `tree-sitter-java` |
| Rust | tree-sitter-rust | `tree-sitter-rust` |
| C# | tree-sitter-c-sharp | `tree-sitter-c-sharp` |
| Ruby | tree-sitter-ruby | `tree-sitter-ruby` |
| PHP | tree-sitter-php | `tree-sitter-php` |
| Kotlin | tree-sitter-kotlin | `tree-sitter-kotlin` |

### 3.3 Tree-sitter Query Examples

**TypeScript/JavaScript Functions:**
```scheme
(function_declaration
  name: (identifier) @name
  parameters: (formal_parameters) @params
  return_type: (type_annotation)? @return_type
  body: (statement_block) @body
) @function

(arrow_function
  parameters: (formal_parameters) @params
  return_type: (type_annotation)? @return_type
  body: (_) @body
) @arrow_function

(method_definition
  name: (property_identifier) @name
  parameters: (formal_parameters) @params
  return_type: (type_annotation)? @return_type
  body: (statement_block) @body
) @method
```

**Python Functions:**
```scheme
(function_definition
  name: (identifier) @name
  parameters: (parameters) @params
  return_type: (type)? @return_type
  body: (block) @body
) @function

(class_definition
  name: (identifier) @name
  body: (block) @body
) @class
```

**Go Functions:**
```scheme
(function_declaration
  name: (identifier) @name
  parameters: (parameter_list) @params
  result: (_)? @return_type
  body: (block) @body
) @function

(method_declaration
  receiver: (parameter_list) @receiver
  name: (field_identifier) @name
  parameters: (parameter_list) @params
  result: (_)? @return_type
  body: (block) @body
) @method
```

---

## 4. Phase 2: Summary Generation

### 4.1 Summary Generation Prompt

This is the prompt used for ALL models under test. Must be identical across models.

```
SYSTEM_PROMPT = """You are a code documentation expert. Your task is to write concise, useful summaries of code that will be used in a RAG (Retrieval-Augmented Generation) system to help developers find and understand code.

Your summaries will be:
1. Embedded as vectors for semantic search
2. Shown to LLMs as context when answering coding questions
3. Used by developers to quickly understand what code does

Write summaries that:
- Describe WHAT the code does and WHY (purpose/intent), not HOW (implementation details)
- Use terminology developers would search for
- Mention inputs, outputs, and important side effects
- Are concise but complete (aim for 2-4 sentences for functions, 3-6 for classes/files)
- Include the code's role in the broader system when apparent

Do NOT:
- Restate the code line-by-line in English
- Include implementation details unless critical to understanding
- Be vague or generic (avoid "handles various operations")
- Include the function/class name in the summary (it's provided separately)"""
```

```
USER_PROMPT_FUNCTION = """Write a summary for this {language} function:

Name: {name}
Signature: {signature}
File: {file_path}

Code:
```{language}
{code}
```

Provide only the summary, no additional commentary."""
```

```
USER_PROMPT_CLASS = """Write a summary for this {language} class:

Name: {name}
File: {file_path}
Methods: {method_list}

Code:
```{language}
{code}
```

Provide only the summary, no additional commentary."""
```

```
USER_PROMPT_FILE = """Write a summary for this {language} file:

Path: {file_path}
Exports: {exports_list}

Code:
```{language}
{code}
```

Provide only the summary, no additional commentary."""
```

### 4.2 Generation Parameters

Standard parameters for fair comparison:

```yaml
generation_params:
  temperature: 0.3          # Low for consistency
  max_tokens: 500           # Plenty for any summary
  top_p: 1.0
  frequency_penalty: 0.0
  presence_penalty: 0.0
```

### 4.3 Batch Generation Script

```typescript
async function generateSummaries(
  codeUnits: CodeUnit[],
  models: ModelConfig[],
  config: GenerationConfig
): Promise<GeneratedSummary[]> {
  const summaries: GeneratedSummary[] = [];
  
  for (const model of models) {
    const client = createClient(model);
    
    for (const unit of codeUnits) {
      const prompt = buildPrompt(unit);
      
      const startTime = Date.now();
      const response = await client.complete({
        model: model.modelName,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt }
        ],
        temperature: config.temperature,
        max_tokens: config.maxTokens
      });
      const latency = Date.now() - startTime;
      
      summaries.push({
        id: generateId(),
        codeUnitId: unit.id,
        modelId: model.id,
        summary: response.content,
        generationMetadata: {
          modelName: model.modelName,
          modelVersion: model.version,
          promptVersion: PROMPT_VERSION,
          temperature: config.temperature,
          maxTokens: config.maxTokens,
          generatedAt: new Date().toISOString(),
          latencyMs: latency,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cost: calculateCost(model, response.usage)
        }
      });
      
      // Rate limiting
      await delay(config.delayBetweenRequests);
    }
  }
  
  return summaries;
}
```

---

## 5. Phase 3a: LLM-as-Judge Evaluation

### 5.1 Point-wise Evaluation Prompt

This evaluates a single summary against the rubric.

```
JUDGE_SYSTEM_PROMPT = """You are an expert evaluator assessing the quality of code summaries for use in RAG-based code search systems.

You will evaluate summaries on 5 criteria, scoring each from 1-5.

The summaries will be used to:
1. Match developer search queries to relevant code
2. Provide context to LLMs helping developers
3. Help developers quickly understand unfamiliar code

Be strict but fair. A score of 3 is average/acceptable. Reserve 5 for exceptional summaries and 1 for summaries that would actively harm retrieval or understanding."""
```

```
JUDGE_USER_PROMPT = """Evaluate this code summary.

## Original Code
```{language}
{code}
```

## Summary to Evaluate
{summary}

## Evaluation Criteria

### 1. Accuracy (1-5)
Does the summary correctly describe what the code does?
- 1: Fundamentally wrong, misleading, or describes different functionality
- 2: Major errors or significant misunderstandings
- 3: Mostly correct with some inaccuracies or ambiguities
- 4: Accurate with only minor issues or omissions
- 5: Completely accurate representation of the code's functionality

### 2. Completeness (1-5)
Does the summary cover the important aspects?
- 1: Missing most key information (inputs, outputs, purpose, side effects)
- 2: Missing several important aspects
- 3: Covers main functionality but misses some relevant details
- 4: Covers all important aspects with minor omissions
- 5: Comprehensively covers all relevant aspects without being verbose

### 3. Semantic Richness (1-5)
Would this summary help match natural language queries to this code?
- 1: Uses only generic terms, wouldn't match relevant searches
- 2: Limited vocabulary, would miss many relevant queries
- 3: Decent terminology, would match obvious queries
- 4: Good use of domain terms, would match most relevant queries
- 5: Excellent vocabulary coverage, would match diverse query phrasings

### 4. Abstraction Level (1-5)
Does it describe WHAT/WHY rather than HOW?
- 1: Just restates code in English, line-by-line description
- 2: Mostly implementation details with some purpose
- 3: Mix of implementation and intent
- 4: Focuses on purpose with minimal implementation details
- 5: Clearly captures intent and purpose, implementation only when essential

### 5. Conciseness (1-5)
Is it appropriately brief without losing important information?
- 1: Extremely verbose OR so brief it's useless
- 2: Notably too long OR missing key information due to brevity
- 3: Acceptable length but could be tighter OR slightly more detailed
- 4: Well-balanced length, minor room for improvement
- 5: Optimal length - complete yet concise

## Response Format
Respond with a JSON object:
```json
{
  "scores": {
    "accuracy": <1-5>,
    "completeness": <1-5>,
    "semantic_richness": <1-5>,
    "abstraction": <1-5>,
    "conciseness": <1-5>
  },
  "reasoning": "<Brief explanation of scores, 2-3 sentences>",
  "weighted_average": <calculated weighted average>
}
```

Weights for weighted_average: accuracy=0.25, completeness=0.20, semantic_richness=0.25, abstraction=0.15, conciseness=0.15"""
```

### 5.2 Pairwise Comparison Prompt

For head-to-head model comparison.

```
PAIRWISE_SYSTEM_PROMPT = """You are an expert evaluator comparing code summaries for use in RAG-based code search systems.

You will compare two summaries of the same code and determine which is more useful for:
1. Matching developer search queries to relevant code
2. Providing context to LLMs helping developers
3. Helping developers quickly understand unfamiliar code

Be decisive. You must pick a winner or declare a tie only if they are truly equivalent."""
```

```
PAIRWISE_USER_PROMPT = """Compare these two summaries of the same code.

## Original Code
```{language}
{code}
```

## Summary A
{summary_a}

## Summary B
{summary_b}

## Comparison Criteria
Consider:
- Accuracy: Which more correctly describes the code?
- Completeness: Which covers more important aspects?
- Searchability: Which would better match developer queries?
- Clarity: Which better captures intent vs implementation?
- Conciseness: Which is more appropriately sized?

## Response Format
Respond with a JSON object:
```json
{
  "winner": "A" | "B" | "tie",
  "confidence": "high" | "medium" | "low",
  "reasoning": "<2-3 sentences explaining your decision>",
  "criteria_breakdown": {
    "accuracy": "A" | "B" | "tie",
    "completeness": "A" | "B" | "tie",
    "searchability": "A" | "B" | "tie",
    "clarity": "A" | "B" | "tie",
    "conciseness": "A" | "B" | "tie"
  }
}
```"""
```

### 5.3 Judge Selection Rules

```typescript
interface JudgeAssignment {
  summaryModelId: string;
  allowedJudgeModels: string[];
}

function selectJudges(
  summaryModel: string, 
  availableJudges: string[]
): string[] {
  // RULE 1: Never let a model judge its own summaries
  const eligible = availableJudges.filter(j => 
    !isSameModelFamily(j, summaryModel)
  );
  
  // RULE 2: Use at least 2 judges for reliability
  if (eligible.length < 2) {
    throw new Error('Insufficient judge models available');
  }
  
  // RULE 3: Prefer diverse model families
  return selectDiverse(eligible, 3);
}

function isSameModelFamily(model1: string, model2: string): boolean {
  const families = {
    'anthropic': ['claude-3-opus', 'claude-3-sonnet', 'claude-3-haiku', 'claude-3.5-sonnet'],
    'openai': ['gpt-4', 'gpt-4-turbo', 'gpt-4o', 'gpt-4o-mini'],
    'google': ['gemini-pro', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    'meta': ['llama-3', 'llama-3.1', 'llama-3.2']
  };
  
  for (const family of Object.values(families)) {
    const m1InFamily = family.some(f => model1.includes(f));
    const m2InFamily = family.some(f => model2.includes(f));
    if (m1InFamily && m2InFamily) return true;
  }
  
  return false;
}
```

### 5.4 Pairwise Tournament Implementation

```typescript
interface PairwiseResult {
  modelA: string;
  modelB: string;
  codeUnitId: string;
  judgeModel: string;
  winner: 'A' | 'B' | 'tie';
  positionSwapped: boolean;  // Did we swap A/B positions?
}

async function runPairwiseTournament(
  summaries: Map<string, GeneratedSummary[]>,  // modelId -> summaries
  codeUnits: CodeUnit[],
  judgeModels: string[]
): Promise<Map<string, TournamentScore>> {
  const results: PairwiseResult[] = [];
  const modelIds = Array.from(summaries.keys());
  
  // Generate all pairs
  const pairs: [string, string][] = [];
  for (let i = 0; i < modelIds.length; i++) {
    for (let j = i + 1; j < modelIds.length; j++) {
      pairs.push([modelIds[i], modelIds[j]]);
    }
  }
  
  for (const unit of codeUnits) {
    for (const [modelA, modelB] of pairs) {
      const summaryA = summaries.get(modelA)!.find(s => s.codeUnitId === unit.id)!;
      const summaryB = summaries.get(modelB)!.find(s => s.codeUnitId === unit.id)!;
      
      // Select judges (excluding both models under comparison)
      const judges = selectJudges([modelA, modelB], judgeModels);
      
      for (const judge of judges) {
        // Run comparison in both orders to counter position bias
        
        // Order 1: A first, B second
        const result1 = await runComparison(judge, unit, summaryA, summaryB, false);
        results.push({
          modelA, modelB,
          codeUnitId: unit.id,
          judgeModel: judge,
          winner: result1.winner,
          positionSwapped: false
        });
        
        // Order 2: B first, A second
        const result2 = await runComparison(judge, unit, summaryB, summaryA, true);
        results.push({
          modelA, modelB,
          codeUnitId: unit.id,
          judgeModel: judge,
          winner: result2.winner === 'A' ? 'B' : result2.winner === 'B' ? 'A' : 'tie',
          positionSwapped: true
        });
      }
    }
  }
  
  // Aggregate into scores
  return aggregateTournamentResults(results, modelIds);
}

function aggregateTournamentResults(
  results: PairwiseResult[],
  modelIds: string[]
): Map<string, TournamentScore> {
  const scores = new Map<string, TournamentScore>();
  
  for (const modelId of modelIds) {
    const wins = results.filter(r => 
      (r.modelA === modelId && r.winner === 'A') ||
      (r.modelB === modelId && r.winner === 'B')
    ).length;
    
    const losses = results.filter(r =>
      (r.modelA === modelId && r.winner === 'B') ||
      (r.modelB === modelId && r.winner === 'A')
    ).length;
    
    const ties = results.filter(r =>
      (r.modelA === modelId || r.modelB === modelId) && r.winner === 'tie'
    ).length;
    
    const total = wins + losses + ties;
    
    scores.set(modelId, {
      wins,
      losses,
      ties,
      winRate: (wins + 0.5 * ties) / total,
      // Bradley-Terry score for ranking
      btScore: calculateBradleyTerry(modelId, results)
    });
  }
  
  return scores;
}
```

---

## 6. Phase 3b: Contrastive Matching Evaluation

### 6.1 Distractor Selection Algorithm

```typescript
interface DistractorSet {
  targetCodeUnitId: string;
  distractorIds: string[];
  difficulty: 'easy' | 'medium' | 'hard';
}

async function selectDistractors(
  target: CodeUnit,
  allUnits: CodeUnit[],
  embeddings: Map<string, number[]>,
  count: number = 9
): Promise<DistractorSet> {
  const distractors: CodeUnit[] = [];
  const targetEmbedding = embeddings.get(target.id)!;
  
  // Filter candidates
  const candidates = allUnits.filter(u => 
    u.id !== target.id &&
    u.language === target.language &&
    u.type === target.type
  );
  
  // TIER 1: Same file (hardest - similar context)
  const sameFile = candidates.filter(c => c.path === target.path);
  distractors.push(...selectRandom(sameFile, Math.min(3, sameFile.length)));
  
  // TIER 2: Similar signature (hard - same interface, different logic)
  if (target.metadata.signature) {
    const similarSig = candidates.filter(c => 
      c.metadata.signature &&
      signatureSimilarity(c.metadata.signature, target.metadata.signature!) > 0.7
    );
    const needed = Math.min(3, 6 - distractors.length);
    distractors.push(...selectRandom(
      similarSig.filter(s => !distractors.includes(s)), 
      needed
    ));
  }
  
  // TIER 3: Semantic similarity (medium - similar purpose)
  const similarities = candidates
    .filter(c => !distractors.some(d => d.id === c.id))
    .map(c => ({
      unit: c,
      similarity: cosineSimilarity(embeddings.get(c.id)!, targetEmbedding)
    }))
    .sort((a, b) => b.similarity - a.similarity);
  
  // Get semantically similar but not too similar
  const semanticDistractors = similarities
    .filter(s => s.similarity > 0.5 && s.similarity < 0.95)
    .slice(0, count - distractors.length)
    .map(s => s.unit);
  
  distractors.push(...semanticDistractors);
  
  // TIER 4: Random padding if needed
  if (distractors.length < count) {
    const remaining = candidates.filter(c => !distractors.some(d => d.id === c.id));
    distractors.push(...selectRandom(remaining, count - distractors.length));
  }
  
  return {
    targetCodeUnitId: target.id,
    distractorIds: distractors.slice(0, count).map(d => d.id),
    difficulty: calculateDifficulty(distractors, target, embeddings)
  };
}

function signatureSimilarity(sig1: string, sig2: string): number {
  // Compare parameter count, types, return type
  const params1 = extractParams(sig1);
  const params2 = extractParams(sig2);
  
  const paramCountSim = 1 - Math.abs(params1.length - params2.length) / 
    Math.max(params1.length, params2.length, 1);
  
  const typeSim = calculateTypeOverlap(params1, params2);
  
  return (paramCountSim + typeSim) / 2;
}
```

### 6.2 Contrastive Test - Embedding Method

```typescript
interface ContrastiveTestResult {
  summaryId: string;
  targetCodeUnitId: string;
  distractorIds: string[];
  
  // Results
  predictedRank: number;       // 1 = correct, higher = worse
  correct: boolean;            // Was rank 1?
  confidenceGap: number;       // Difference between top 2 scores
  
  method: 'embedding';
  embeddingModel: string;
}

async function runContrastiveEmbedding(
  summary: GeneratedSummary,
  target: CodeUnit,
  distractors: CodeUnit[],
  embedModel: EmbeddingModel
): Promise<ContrastiveTestResult> {
  // Embed the summary
  const summaryEmbedding = await embedModel.embed(summary.summary);
  
  // Embed all code candidates
  const candidates = [target, ...distractors];
  const codeEmbeddings = await Promise.all(
    candidates.map(c => embedModel.embed(c.content))
  );
  
  // Calculate similarities
  const similarities = codeEmbeddings.map((emb, idx) => ({
    codeUnitId: candidates[idx].id,
    similarity: cosineSimilarity(summaryEmbedding, emb),
    isTarget: candidates[idx].id === target.id
  }));
  
  // Sort by similarity (descending)
  similarities.sort((a, b) => b.similarity - a.similarity);
  
  // Find rank of target
  const targetRank = similarities.findIndex(s => s.isTarget) + 1;
  
  return {
    summaryId: summary.id,
    targetCodeUnitId: target.id,
    distractorIds: distractors.map(d => d.id),
    predictedRank: targetRank,
    correct: targetRank === 1,
    confidenceGap: similarities[0].similarity - similarities[1].similarity,
    method: 'embedding',
    embeddingModel: embedModel.name
  };
}
```

### 6.3 Contrastive Test - LLM Method

```typescript
CONTRASTIVE_LLM_PROMPT = """Given a code summary, identify which code snippet it describes.

## Summary
{summary}

## Code Options
{code_options}

Which code option (1-{n}) does this summary describe?

Respond with ONLY a JSON object:
```json
{
  "selected": <number 1-{n}>,
  "confidence": "high" | "medium" | "low",
  "reasoning": "<brief explanation>"
}
```"""

async function runContrastiveLLM(
  summary: GeneratedSummary,
  target: CodeUnit,
  distractors: CodeUnit[],
  judgeModel: ModelClient
): Promise<ContrastiveTestResult> {
  // Randomize order
  const candidates = shuffle([target, ...distractors]);
  const targetPosition = candidates.findIndex(c => c.id === target.id) + 1;
  
  // Build code options string
  const codeOptions = candidates.map((c, idx) => 
    `### Option ${idx + 1}\n\`\`\`${c.language}\n${c.content}\n\`\`\``
  ).join('\n\n');
  
  const prompt = CONTRASTIVE_LLM_PROMPT
    .replace('{summary}', summary.summary)
    .replace('{code_options}', codeOptions)
    .replace('{n}', candidates.length.toString());
  
  const response = await judgeModel.complete({
    messages: [{ role: 'user', content: prompt }],
    temperature: 0
  });
  
  const result = parseJSON(response.content);
  
  return {
    summaryId: summary.id,
    targetCodeUnitId: target.id,
    distractorIds: distractors.map(d => d.id),
    predictedRank: result.selected === targetPosition ? 1 : 
      (result.selected < targetPosition ? 2 : result.selected),
    correct: result.selected === targetPosition,
    confidenceGap: 0,  // Not applicable for LLM method
    method: 'llm',
    llmModel: judgeModel.name
  };
}
```

---

## 7. Phase 3c: Retrieval Evaluation

### 7.1 Query Generation Prompt

```
QUERY_GENERATION_PROMPT = """Generate realistic search queries that a developer might use to find this code.

## Code
```{language}
{code}
```

## Context
File: {file_path}
Function/Class: {name}

Generate exactly 5 search queries of varying types:

1. **Vague query**: A partial or imprecise query (e.g., "something with users")
2. **Wrong terminology**: Uses related but not exact terms (e.g., "authenticate" instead of "login")
3. **Specific behavior**: Asks about a particular thing the code does
4. **Integration query**: Asks how to use this with something else
5. **Problem-based**: Describes a problem this code solves

These should be realistic queries a developer would type, NOT perfect descriptions.

Respond with JSON:
```json
{
  "queries": [
    {"type": "vague", "query": "..."},
    {"type": "wrong_terminology", "query": "..."},
    {"type": "specific_behavior", "query": "..."},
    {"type": "integration", "query": "..."},
    {"type": "problem_based", "query": "..."}
  ]
}
```"""
```

### 7.2 Retrieval Test Implementation

```typescript
interface RetrievalTestConfig {
  embeddingModel: string;
  kValues: number[];           // e.g., [1, 3, 5, 10]
  indexType: 'flat' | 'hnsw';
}

interface RetrievalTestResult {
  modelId: string;             // Model that generated summaries
  queryId: string;
  query: string;
  queryType: string;
  
  targetCodeUnitId: string;
  
  // Did target appear in top K results?
  hitAtK: Record<number, boolean>;  // { 1: false, 3: true, 5: true, 10: true }
  
  reciprocalRank: number;      // 1/rank, 0 if not in top K
  retrievedRank: number | null;
}

async function runRetrievalEvaluation(
  summariesByModel: Map<string, GeneratedSummary[]>,
  queries: Map<string, GeneratedQuery[]>,  // codeUnitId -> queries
  codeUnits: CodeUnit[],
  config: RetrievalTestConfig
): Promise<Map<string, RetrievalTestResult[]>> {
  const results = new Map<string, RetrievalTestResult[]>();
  const maxK = Math.max(...config.kValues);
  
  for (const [modelId, summaries] of summariesByModel) {
    // Build index for this model's summaries
    const index = await buildVectorIndex(summaries, config);
    
    const modelResults: RetrievalTestResult[] = [];
    
    for (const [codeUnitId, codeQueries] of queries) {
      for (const query of codeQueries) {
        // Search
        const searchResults = await index.search(query.query, maxK);
        
        // Find target rank
        const targetRank = searchResults.findIndex(
          r => r.codeUnitId === codeUnitId
        ) + 1;  // 0 if not found, convert to 1-indexed
        
        const hitAtK: Record<number, boolean> = {};
        for (const k of config.kValues) {
          hitAtK[k] = targetRank > 0 && targetRank <= k;
        }
        
        modelResults.push({
          modelId,
          queryId: query.id,
          query: query.query,
          queryType: query.type,
          targetCodeUnitId: codeUnitId,
          hitAtK,
          reciprocalRank: targetRank > 0 ? 1 / targetRank : 0,
          retrievedRank: targetRank > 0 ? targetRank : null
        });
      }
    }
    
    results.set(modelId, modelResults);
  }
  
  return results;
}

interface AggregatedRetrievalMetrics {
  modelId: string;
  
  // Hit rate at various K
  precision: Record<number, number>;  // { 1: 0.45, 3: 0.72, 5: 0.85, 10: 0.93 }
  
  // Mean Reciprocal Rank
  mrr: number;
  
  // By query type
  byQueryType: Record<string, {
    precision: Record<number, number>;
    mrr: number;
  }>;
}

function aggregateRetrievalResults(
  results: RetrievalTestResult[],
  kValues: number[]
): AggregatedRetrievalMetrics {
  const precision: Record<number, number> = {};
  
  for (const k of kValues) {
    const hits = results.filter(r => r.hitAtK[k]).length;
    precision[k] = hits / results.length;
  }
  
  const mrr = results.reduce((sum, r) => sum + r.reciprocalRank, 0) / results.length;
  
  // Group by query type
  const byType = groupBy(results, r => r.queryType);
  const byQueryType: Record<string, any> = {};
  
  for (const [type, typeResults] of Object.entries(byType)) {
    const typePrecision: Record<number, number> = {};
    for (const k of kValues) {
      const hits = typeResults.filter(r => r.hitAtK[k]).length;
      typePrecision[k] = hits / typeResults.length;
    }
    
    byQueryType[type] = {
      precision: typePrecision,
      mrr: typeResults.reduce((sum, r) => sum + r.reciprocalRank, 0) / typeResults.length
    };
  }
  
  return {
    modelId: results[0].modelId,
    precision,
    mrr,
    byQueryType
  };
}
```

---

## 8. Phase 3d: Downstream Task Evaluation

### 8.1 Task 1: Code Completion

Given a partial function and relevant summaries, complete the code.

```
COMPLETION_TASK_PROMPT = """Complete this code using the provided context.

## Context from Codebase
{summaries}

## Code to Complete
```{language}
{partial_code}
// TODO: Complete this function
```

## Requirements
{requirements}

Provide only the completed code, no explanations."""
```

```typescript
interface CompletionTask {
  id: string;
  codeUnitId: string;
  
  partialCode: string;         // Code with parts removed
  fullCode: string;            // Original complete code
  requirements: string;        // What the completion should do
  
  relevantSummaryIds: string[];  // Summaries that should help
  
  // For evaluation
  testCases?: TestCase[];
}

interface CompletionResult {
  taskId: string;
  modelId: string;             // Model that generated summaries
  completionModelId: string;   // Model that did the completion
  
  generatedCode: string;
  
  metrics: {
    exactMatch: boolean;
    codeBleu: number;
    passesTests: boolean | null;
    passRate: number | null;    // % of test cases passed
  };
}

async function runCompletionTask(
  task: CompletionTask,
  summariesByModel: Map<string, GeneratedSummary[]>,
  completionModel: ModelClient,
  config: CompletionConfig
): Promise<Map<string, CompletionResult>> {
  const results = new Map<string, CompletionResult>();
  
  for (const [modelId, summaries] of summariesByModel) {
    // Get relevant summaries
    const relevantSummaries = task.relevantSummaryIds
      .map(id => summaries.find(s => s.codeUnitId === id))
      .filter(Boolean)
      .map(s => s!.summary)
      .join('\n\n---\n\n');
    
    const prompt = COMPLETION_TASK_PROMPT
      .replace('{summaries}', relevantSummaries)
      .replace('{language}', task.language)
      .replace('{partial_code}', task.partialCode)
      .replace('{requirements}', task.requirements);
    
    const response = await completionModel.complete({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0
    });
    
    const generatedCode = extractCode(response.content);
    
    // Evaluate
    const metrics = await evaluateCompletion(
      generatedCode, 
      task.fullCode, 
      task.testCases
    );
    
    results.set(modelId, {
      taskId: task.id,
      modelId,
      completionModelId: completionModel.name,
      generatedCode,
      metrics
    });
  }
  
  return results;
}
```

### 8.2 Task 2: Bug Localization

Given a bug description and file summaries, identify the buggy file.

```
BUG_LOCALIZATION_PROMPT = """A bug has been reported. Based on the file summaries below, identify which file most likely contains the bug.

## Bug Report
{bug_description}

## File Summaries
{file_summaries}

Which file most likely contains this bug? Respond with JSON:
```json
{
  "predicted_file": "<file path>",
  "confidence": "high" | "medium" | "low",
  "reasoning": "<brief explanation>"
}
```"""
```

```typescript
interface BugLocalizationTask {
  id: string;
  bugDescription: string;
  actualBuggyFile: string;
  candidateFiles: string[];    // File paths to choose from
}

interface BugLocalizationResult {
  taskId: string;
  modelId: string;
  localizerModelId: string;
  
  predictedFile: string;
  correct: boolean;
  confidence: string;
}

async function runBugLocalization(
  task: BugLocalizationTask,
  summariesByModel: Map<string, GeneratedSummary[]>,
  localizerModel: ModelClient
): Promise<Map<string, BugLocalizationResult>> {
  const results = new Map<string, BugLocalizationResult>();
  
  for (const [modelId, summaries] of summariesByModel) {
    // Build file summaries string
    const fileSummaries = task.candidateFiles.map(filePath => {
      const summary = summaries.find(s => s.codeUnitPath === filePath);
      return `### ${filePath}\n${summary?.summary || '[No summary available]'}`;
    }).join('\n\n');
    
    const prompt = BUG_LOCALIZATION_PROMPT
      .replace('{bug_description}', task.bugDescription)
      .replace('{file_summaries}', fileSummaries);
    
    const response = await localizerModel.complete({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0
    });
    
    const result = parseJSON(response.content);
    
    results.set(modelId, {
      taskId: task.id,
      modelId,
      localizerModelId: localizerModel.name,
      predictedFile: result.predicted_file,
      correct: result.predicted_file === task.actualBuggyFile,
      confidence: result.confidence
    });
  }
  
  return results;
}
```

### 8.3 Task 3: Function Selection

Given a task description and function summaries, pick the right function.

```
FUNCTION_SELECTION_PROMPT = """You need to accomplish a task. Based on the available functions, select the most appropriate one.

## Task
{task_description}

## Available Functions
{function_summaries}

Which function should be used? Respond with JSON:
```json
{
  "selected_function": "<function name>",
  "confidence": "high" | "medium" | "low",
  "reasoning": "<brief explanation>"
}
```"""
```

```typescript
interface FunctionSelectionTask {
  id: string;
  taskDescription: string;
  correctFunction: string;
  candidateFunctions: string[];  // Function names/IDs
}

// Similar implementation to bug localization...
```

---

## 9. Phase 4: Aggregation & Scoring

### 9.1 Score Normalization

```typescript
interface NormalizedScores {
  modelId: string;
  
  // Individual evaluations (0-1 scale)
  judge: {
    pointwise: number;         // Average of normalized rubric scores
    pairwise: number;          // Win rate from tournament
    combined: number;          // Weighted combination
  };
  
  contrastive: {
    embedding: number;         // Accuracy
    llm: number;               // Accuracy
    combined: number;
  };
  
  retrieval: {
    precision1: number;
    precision5: number;
    mrr: number;
    combined: number;
  };
  
  downstream: {
    completion: number;
    bugLocalization: number;
    functionSelection: number;
    combined: number;
  };
  
  // Final score
  overall: number;
}

function normalizeScores(
  rawScores: RawModelScores,
  config: ScoringConfig
): NormalizedScores {
  // Judge scores: already 1-5, normalize to 0-1
  const judgePointwise = (rawScores.judge.averageScore - 1) / 4;
  const judgePairwise = rawScores.judge.winRate;
  const judgeCombined = 
    config.judgeWeights.pointwise * judgePointwise +
    config.judgeWeights.pairwise * judgePairwise;
  
  // Contrastive: already 0-1 (accuracy)
  const contrastiveCombined = 
    config.contrastiveWeights.embedding * rawScores.contrastive.embeddingAccuracy +
    config.contrastiveWeights.llm * rawScores.contrastive.llmAccuracy;
  
  // Retrieval: already 0-1
  const retrievalCombined =
    config.retrievalWeights.precision1 * rawScores.retrieval.precision[1] +
    config.retrievalWeights.precision5 * rawScores.retrieval.precision[5] +
    config.retrievalWeights.mrr * rawScores.retrieval.mrr;
  
  // Downstream: accuracy, already 0-1
  const downstreamCombined =
    config.downstreamWeights.completion * rawScores.downstream.completion.passRate +
    config.downstreamWeights.bugLocalization * rawScores.downstream.bugLocalization.accuracy +
    config.downstreamWeights.functionSelection * rawScores.downstream.functionSelection.accuracy;
  
  // Overall
  const overall =
    config.evalWeights.judge * judgeCombined +
    config.evalWeights.contrastive * contrastiveCombined +
    config.evalWeights.retrieval * retrievalCombined +
    config.evalWeights.downstream * downstreamCombined;
  
  return {
    modelId: rawScores.modelId,
    judge: {
      pointwise: judgePointwise,
      pairwise: judgePairwise,
      combined: judgeCombined
    },
    contrastive: {
      embedding: rawScores.contrastive.embeddingAccuracy,
      llm: rawScores.contrastive.llmAccuracy,
      combined: contrastiveCombined
    },
    retrieval: {
      precision1: rawScores.retrieval.precision[1],
      precision5: rawScores.retrieval.precision[5],
      mrr: rawScores.retrieval.mrr,
      combined: retrievalCombined
    },
    downstream: {
      completion: rawScores.downstream.completion.passRate,
      bugLocalization: rawScores.downstream.bugLocalization.accuracy,
      functionSelection: rawScores.downstream.functionSelection.accuracy,
      combined: downstreamCombined
    },
    overall
  };
}
```

### 9.2 Default Weight Configuration

```typescript
const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  // How to combine judge methods
  judgeWeights: {
    pointwise: 0.4,
    pairwise: 0.6        // Pairwise more reliable
  },
  
  // How to combine contrastive methods
  contrastiveWeights: {
    embedding: 0.5,
    llm: 0.5
  },
  
  // How to combine retrieval metrics
  retrievalWeights: {
    precision1: 0.3,
    precision5: 0.4,
    mrr: 0.3
  },
  
  // How to combine downstream tasks
  downstreamWeights: {
    completion: 0.4,
    bugLocalization: 0.3,
    functionSelection: 0.3
  },
  
  // How to combine evaluation types for overall score
  evalWeights: {
    judge: 0.30,         // Subjective quality
    contrastive: 0.25,   // Objective code matching
    retrieval: 0.25,     // Search effectiveness
    downstream: 0.20     // Real task performance
  }
};
```

### 9.3 Statistical Significance Testing

```typescript
interface SignificanceTest {
  modelA: string;
  modelB: string;
  metric: string;
  
  meanDifference: number;
  pValue: number;
  significant: boolean;    // p < 0.05
  confidenceInterval: [number, number];
}

function runPairedTTest(
  scoresA: number[],
  scoresB: number[]
): { tStatistic: number; pValue: number } {
  const n = scoresA.length;
  const differences = scoresA.map((a, i) => a - scoresB[i]);
  
  const meanDiff = mean(differences);
  const stdDiff = std(differences);
  const se = stdDiff / Math.sqrt(n);
  
  const tStatistic = meanDiff / se;
  const pValue = 2 * (1 - tCDF(Math.abs(tStatistic), n - 1));
  
  return { tStatistic, pValue };
}

function bootstrapConfidenceInterval(
  scoresA: number[],
  scoresB: number[],
  iterations: number = 10000,
  alpha: number = 0.05
): [number, number] {
  const bootstrapDiffs: number[] = [];
  const n = scoresA.length;
  
  for (let i = 0; i < iterations; i++) {
    const indices = Array.from({ length: n }, () => 
      Math.floor(Math.random() * n)
    );
    
    const sampleA = indices.map(idx => scoresA[idx]);
    const sampleB = indices.map(idx => scoresB[idx]);
    
    bootstrapDiffs.push(mean(sampleA) - mean(sampleB));
  }
  
  bootstrapDiffs.sort((a, b) => a - b);
  
  const lowerIdx = Math.floor((alpha / 2) * iterations);
  const upperIdx = Math.floor((1 - alpha / 2) * iterations);
  
  return [bootstrapDiffs[lowerIdx], bootstrapDiffs[upperIdx]];
}
```

---

## 10. Output Report Schema

### 10.1 Full Report Structure

```typescript
interface BenchmarkReport {
  metadata: {
    benchmarkId: string;
    name: string;
    runDate: string;
    duration: string;
    
    codebase: {
      name: string;
      repository?: string;
      commit?: string;
      languages: string[];
      totalCodeUnits: number;
      sampledCodeUnits: number;
    };
    
    configuration: BenchmarkConfig;
  };
  
  // Main results
  rankings: ModelRanking[];
  
  // Detailed breakdowns
  detailed: {
    byModel: Map<string, DetailedModelResults>;
    byLanguage: Map<string, LanguageResults>;
    byCodeType: Map<string, CodeTypeResults>;
  };
  
  // Head-to-head comparisons
  comparisons: ModelComparison[];
  
  // Statistical analysis
  statistics: {
    significanceTests: SignificanceTest[];
    correlations: CorrelationMatrix;
  };
  
  // Failure analysis
  failures: {
    byModel: Map<string, FailureAnalysis>;
    commonPatterns: FailurePattern[];
  };
  
  // Cost analysis
  costs: {
    byModel: Map<string, CostBreakdown>;
    total: number;
  };
}

interface ModelRanking {
  rank: number;
  modelId: string;
  modelName: string;
  
  overallScore: number;
  
  scores: {
    judge: number;
    contrastive: number;
    retrieval: number;
    downstream: number;
  };
  
  // Change from baseline (if applicable)
  deltaFromBaseline?: number;
}

interface ModelComparison {
  modelA: string;
  modelB: string;
  
  winner: string;
  scoreDifference: number;
  significant: boolean;
  
  pairwiseRecord: {
    aWins: number;
    bWins: number;
    ties: number;
  };
  
  strengthsA: string[];
  strengthsB: string[];
}

interface FailureAnalysis {
  modelId: string;
  
  // Where did this model fail most?
  weakestMetric: string;
  weakestLanguage: string;
  weakestCodeType: string;
  
  // Example failures
  examples: {
    codeUnitId: string;
    summary: string;
    issue: string;
    category: string;
  }[];
}
```

### 10.2 Sample Report Output

```yaml
# LLM Code Summary Benchmark Report

## Overview
- **Benchmark**: MadAppGang Codebase Evaluation
- **Run Date**: 2024-12-16
- **Code Units**: 1,247 sampled from 12,450 total
- **Languages**: TypeScript (45%), Go (35%), Python (20%)

## Rankings

| Rank | Model | Overall | Judge | Contrastive | Retrieval | Downstream |
|------|-------|---------|-------|-------------|-----------|------------|
| 1 | claude-3.5-sonnet | 0.847 | 0.89 | 0.91 | 0.78 | 0.82 |
| 2 | gpt-4o | 0.831 | 0.86 | 0.88 | 0.81 | 0.79 |
| 3 | gemini-1.5-pro | 0.794 | 0.82 | 0.84 | 0.76 | 0.77 |
| 4 | llama-3.1-70b | 0.756 | 0.78 | 0.79 | 0.71 | 0.74 |
| 5 | mistral-large | 0.742 | 0.76 | 0.77 | 0.72 | 0.71 |

## Head-to-Head: Top 2 Models

### claude-3.5-sonnet vs gpt-4o
- **Winner**: claude-3.5-sonnet (p=0.023)
- **Score difference**: +0.016
- **Pairwise record**: 547 wins, 421 wins, 279 ties

**Claude strengths**:
- Better at capturing intent vs implementation
- More consistent terminology for searchability
- Stronger on TypeScript code

**GPT-4o strengths**:
- Better retrieval metrics (MRR +0.03)
- Stronger on Go code
- More concise summaries

## By Language

| Language | Best Model | Runner-up |
|----------|------------|-----------|
| TypeScript | claude-3.5-sonnet (0.87) | gpt-4o (0.84) |
| Go | gpt-4o (0.85) | claude-3.5-sonnet (0.83) |
| Python | claude-3.5-sonnet (0.86) | gemini-1.5-pro (0.84) |

## Failure Analysis

### Common Failure Patterns

1. **Generic descriptions** (23% of low scores)
   - Models falling back to "handles various operations"
   - Most common in complex utility functions

2. **Implementation focus** (18% of low scores)
   - Describing loops and conditionals instead of purpose
   - Especially in algorithmic code

3. **Missing side effects** (15% of low scores)
   - Not mentioning database writes, API calls
   - Critical for understanding code impact

### Model-Specific Weaknesses

- **llama-3.1-70b**: Struggles with async/await patterns
- **mistral-large**: Often misses error handling behavior
- **gemini-1.5-pro**: Verbose on simple functions

## Cost Analysis

| Model | Cost/1K summaries | Total Cost |
|-------|------------------|------------|
| claude-3.5-sonnet | $2.34 | $29.18 |
| gpt-4o | $2.87 | $35.79 |
| gemini-1.5-pro | $1.12 | $13.97 |
| llama-3.1-70b | $0.89 | $11.10 |
| mistral-large | $0.67 | $8.35 |

## Recommendations

1. **Best overall**: claude-3.5-sonnet for highest quality
2. **Best value**: gemini-1.5-pro (3rd place at 40% the cost)
3. **For Go-heavy codebases**: Consider gpt-4o
4. **Budget option**: llama-3.1-70b with quality tradeoff
```

---

## 11. CLI Interface

### 11.1 Commands

```bash
# Initialize a new benchmark
summarybench init --name "My Benchmark" --codebase ./path/to/code

# Add models to test
summarybench add-model anthropic/claude-3.5-sonnet
summarybench add-model openai/gpt-4o
summarybench add-model google/gemini-1.5-pro

# Add judge models
summarybench add-judge anthropic/claude-3-opus
summarybench add-judge openai/gpt-4-turbo

# Configure evaluation
summarybench config --sample-size 1000
summarybench config --eval judge,contrastive,retrieval,downstream

# Extract code units
summarybench extract --languages typescript,go,python

# Generate summaries
summarybench generate --parallel 5

# Run evaluations
summarybench evaluate --all
summarybench evaluate --only judge
summarybench evaluate --only contrastive

# Generate report
summarybench report --format markdown --output ./report.md
summarybench report --format json --output ./results.json
summarybench report --format html --output ./report.html

# Compare specific models
summarybench compare claude-3.5-sonnet gpt-4o --detailed
```

### 11.2 Configuration File

```yaml
# summarybench.yaml
name: "MadAppGang Codebase Benchmark"

codebase:
  root: ./
  include:
    - "src/**/*.ts"
    - "pkg/**/*.go"
    - "scripts/**/*.py"
  exclude:
    - "**/*.test.ts"
    - "**/*_test.go"
    - "**/node_modules/**"
    - "**/vendor/**"

extraction:
  types: [function, class, method, file]
  minLines: 5
  maxLines: 500
  skipGenerated: true

models:
  test:
    - provider: anthropic
      model: claude-3-5-sonnet-20241022
      temperature: 0.3
    - provider: openai
      model: gpt-4o
      temperature: 0.3
    - provider: google
      model: gemini-1.5-pro
      temperature: 0.3
      
  judge:
    - provider: anthropic
      model: claude-3-opus-20240229
    - provider: openai
      model: gpt-4-turbo

evaluation:
  sampleSize: 1000
  sampling: stratified  # by language and code type
  
  judge:
    enabled: true
    pairwise: true
    
  contrastive:
    enabled: true
    distractors: 9
    methods: [embedding, llm]
    embeddingModel: voyage-code-2
    
  retrieval:
    enabled: true
    queriesPerUnit: 5
    kValues: [1, 3, 5, 10]
    embeddingModel: voyage-code-2
    
  downstream:
    enabled: true
    tasks: [completion, bug_localisation, function_selection]
    completionModel: claude-3-5-sonnet-20241022

weights:
  judge: 0.30
  contrastive: 0.25
  retrieval: 0.25
  downstream: 0.20

output:
  directory: ./benchmark-results
  formats: [markdown, json, html]
```

---

## 12. Implementation Checklist

### Phase 1: Core Infrastructure (Week 1)
- [ ] Set up project structure
- [ ] Implement data models (TypeScript interfaces)
- [ ] Create database schema (SQLite or PostgreSQL)
- [ ] Build model client abstraction (Anthropic, OpenAI, Google, OpenRouter)
- [ ] Implement tree-sitter extraction for TypeScript, Go, Python

### Phase 2: Generation Pipeline (Week 2)
- [ ] Implement summary generation prompts
- [ ] Build batch generation with rate limiting
- [ ] Add cost tracking
- [ ] Add progress reporting
- [ ] Implement resume/checkpoint for large runs

### Phase 3: Judge Evaluation (Week 3)
- [ ] Implement pointwise evaluation
- [ ] Implement pairwise tournament
- [ ] Build judge selection logic (no self-judging)
- [ ] Add position bias mitigation
- [ ] Aggregate judge scores

### Phase 4: Contrastive Evaluation (Week 4)
- [ ] Implement distractor selection algorithm
- [ ] Build embedding-based contrastive test
- [ ] Build LLM-based contrastive test
- [ ] Add difficulty calibration

### Phase 5: Retrieval Evaluation (Week 5)
- [ ] Implement query generation
- [ ] Build vector index (FAISS or similar)
- [ ] Implement retrieval metrics (P@K, MRR)
- [ ] Add per-query-type analysis

### Phase 6: Downstream Tasks (Week 6)
- [ ] Implement code completion task
- [ ] Implement bug localization task
- [ ] Implement function selection task
- [ ] Build task evaluation metrics

### Phase 7: Aggregation & Reporting (Week 7)
- [ ] Implement score normalization
- [ ] Build statistical significance tests
- [ ] Create report generator (Markdown, JSON, HTML)
- [ ] Add visualization (charts, tables)

### Phase 8: CLI & Polish (Week 8)
- [ ] Build CLI interface
- [ ] Add configuration file support
- [ ] Write documentation
- [ ] Add example benchmarks
- [ ] Performance optimization

---

## 13. Dependencies

```json
{
  "dependencies": {
    // LLM clients
    "@anthropic-ai/sdk": "^0.20.0",
    "openai": "^4.20.0",
    "@google/generative-ai": "^0.2.0",
    
    // Tree-sitter
    "tree-sitter": "^0.20.0",
    "tree-sitter-typescript": "^0.20.0",
    "tree-sitter-python": "^0.20.0",
    "tree-sitter-go": "^0.20.0",
    
    // Vector search
    "faiss-node": "^0.5.0",
    "voyageai": "^0.1.0",
    
    // Database
    "better-sqlite3": "^9.0.0",
    
    // CLI
    "commander": "^11.0.0",
    "ora": "^7.0.0",
    "chalk": "^5.0.0",
    
    // Utilities
    "glob": "^10.0.0",
    "yaml": "^2.0.0",
    "lodash": "^4.17.0",
    
    // Statistics
    "jstat": "^1.9.0",
    
    // Reporting
    "marked": "^9.0.0",
    "chart.js": "^4.0.0"
  }
}
```