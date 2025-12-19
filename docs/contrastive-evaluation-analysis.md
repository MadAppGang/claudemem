# Contrastive Evaluation Analysis: Why All Models Hit 100%

**Date**: 2025-12-18
**Status**: Critical Issue - Evaluation Cannot Differentiate Models
**Files Analyzed**:
- `/Users/jack/mag/claudemem/src/benchmark-v2/evaluators/contrastive/index.ts`
- `/Users/jack/mag/claudemem/src/benchmark-v2/scorers/aggregator.ts`
- `/Users/jack/mag/claudemem/src/benchmark-v2/types.ts`

---

## Executive Summary

The contrastive evaluation system is **fundamentally too easy**, causing all models to achieve near-perfect accuracy (100%). This makes it useless for model differentiation. The core issue is that distractors are **not similar enough** to the target code, making the matching task trivial for both embedding-based and LLM-based methods.

**Key Finding**: With only 4 distractors (default config), and poor distractor selection, models are essentially doing a 1-in-5 multiple choice test where the correct answer is obvious.

---

## Current Implementation Analysis

### 1. Distractor Selection Algorithm (Lines 57-139)

**Current Approach**: 4-tier system
```typescript
// DEFAULT: Only 4 distractors (line 96 in index.ts)
distractorCount: 4

// TIER 1: Same file (up to 3)
const sameFile = candidates.filter((c) => c.path === target.path);
distractors.push(...shuffleAndTake(sameFile, Math.min(3, sameFile.length)));

// TIER 2: Similar signature (up to 3)
const similarSig = candidates.filter(c =>
    signatureSimilarity(c.metadata.signature, target.metadata.signature!) > 0.7
);

// TIER 3: Semantic similarity (0.5 < sim < 0.95)
const similarities = candidates
    .filter((s) => s.similarity > 0.5 && s.similarity < 0.95)
    .sort((a, b) => (b.similarity || 0) - (a.similarity || 0));

// TIER 4: Random padding
```

### 2. Why This Fails (Root Causes)

#### Problem 1: Insufficient Distractors
- **Only 4 distractors** = 1-in-5 chance by random guessing (20% baseline)
- Models achieving 100% suggests task is ~5x easier than random
- Industry standard: **9-19 distractors** for challenging contrastive tasks

#### Problem 2: Tier Selection is Broken
```typescript
// Lines 86-101: Same file distractors
const sameFile = candidates.filter((c) => c.path === target.path);
distractors.push(...shuffleAndTake(sameFile, Math.min(3, sameFile.length)));
```

**Issue**: If target file only has 1-2 functions, you get 0-1 same-file distractors. Then you fall through to **random padding** (Tier 4), which is trivially different.

**Example Scenario**:
- Target: `function authenticateUser(email, password)` in `auth.ts`
- Same-file distractors (0-1): Maybe `function hashPassword()`
- Random distractors (3-4): Functions from completely different files like `formatDate()`, `renderUI()`, `parseJSON()`
- **Result**: Target is OBVIOUSLY the only authentication function in the list

#### Problem 3: Semantic Similarity Filter is Too Restrictive
```typescript
// Line 113: Filters OUT very similar distractors
.filter((s) => s.similarity !== null && s.similarity > 0.5 && s.similarity < 0.95)
```

**This is backwards!** You WANT highly similar distractors (0.8-0.95) to make the task hard. The current filter **excludes** the best distractors.

**Why 0.95 upper bound fails**:
- Similarity 0.85-0.94: Perfect distractors (same purpose, different implementation)
- Similarity 0.5-0.7: Too different (easy to distinguish)
- **Current filter picks the easy ones**

#### Problem 4: Signature Similarity is Naive
```typescript
// Lines 146-160: Simple parameter counting
function signatureSimilarity(sig1: string, sig2: string): number {
    const params1 = extractParamNames(sig1);
    const params2 = extractParamNames(sig2);
    const countSim = 1 - Math.abs(params1.length - params2.length) /
        Math.max(params1.length, params2.length, 1);
    const common = params1.filter((p) => params2.includes(p)).length;
    const nameSim = common / Math.max(params1.length, params2.length, 1);
    return (countSim + nameSim) / 2;
}
```

**Problems**:
- Doesn't consider parameter **types** (e.g., `string` vs `number`)
- Doesn't consider return types
- Doesn't consider function names (they could be in `metadata.signature`)
- `foo(x, y)` has 1.0 similarity to `bar(a, b)` with this logic

#### Problem 5: Difficulty Calculation is Misleading
```typescript
// Lines 189-199: Difficulty based only on same-file count
function calculateDifficulty(
    distractors: BenchmarkCodeUnit[],
    target: BenchmarkCodeUnit
): DistractorDifficulty {
    const sameFileCount = distractors.filter((d) => d.path === target.path).length;
    if (sameFileCount >= 3) return "hard";
    if (sameFileCount >= 1) return "medium";
    return "easy";
}
```

**Issue**: Marks as "hard" when it has 3+ same-file distractors, but doesn't actually measure semantic similarity. A file with `renderButton()`, `renderInput()`, `authenticateUser()` would be marked "hard" but is trivially easy.

### 3. Embedding-Based Evaluation (Lines 205-277)

**Current Method**:
```typescript
// Embed summary and all code candidates
const candidates = [codeUnit, ...distractorUnits];
const texts = [summary.summary, ...candidates.map((c) => c.content)];
const embeddings = await this.embeddingsClient.embed(texts);

// Calculate similarities and sort
const similarities = codeEmbs.map((emb, idx) => ({
    unitId: candidates[idx].id,
    similarity: cosineSimilarity(summaryEmb, emb) || 0,
    isTarget: candidates[idx].id === codeUnit.id,
}));
similarities.sort((a, b) => b.similarity - a.similarity);

// Check if target is rank 1
const targetRank = similarities.findIndex((s) => s.isTarget) + 1;
const correct = targetRank === 1;
```

**Why 100% Accuracy**:
1. Summary was generated FROM the target code
2. Distractors are semantically distant (due to broken selection)
3. Cosine similarity between summary and target code is naturally highest
4. With only 4 weak distractors, this is trivial

**Confidence Gap** (line 261):
```typescript
confidenceGap: similarities[0].similarity - similarities[1].similarity
```
This is likely **high** (>0.2), indicating the task is too easy.

### 4. LLM-Based Evaluation (Lines 289-378)

**Current Method**:
```typescript
// Lines 318-330: Truncate code to 1500 chars, randomize order
const candidates = [codeUnit, ...distractorUnits].sort(() => Math.random() - 0.5);
const codeOptions = candidates.map((c, idx) =>
    `### Option ${idx + 1}\n\`\`\`${c.language}\n${this.truncateCode(c.content, 1500)}\n\`\`\``
).join("\n\n");
```

**Why 100% Accuracy**:
1. LLM sees the summary + 5 code snippets (1 target + 4 distractors)
2. Distractors are semantically different (e.g., auth vs UI vs parsing)
3. LLM easily matches summary terminology to target code
4. Modern LLMs (Claude, GPT-4) are exceptionally good at semantic matching

**Prompt is too simple** (lines 31-48):
```
Which code option (1-{n}) does this summary describe?
```
No adversarial elements, no similar-function distractors.

---

## Quantitative Analysis

### Current Difficulty Metrics

| Metric | Current | Target for Differentiation |
|--------|---------|---------------------------|
| Distractor Count | 4 | 9-19 |
| Random Baseline Accuracy | 20% | 5-10% |
| Observed Accuracy | ~100% | 60-85% (varies by model) |
| Semantic Similarity Range | 0.5-0.95 (wrong!) | 0.75-0.95 (want high) |
| Difficulty Granularity | 3 levels (easy/med/hard) | 5+ levels |
| Same-file focus | Yes | No (use semantic) |

### Expected Difficulty Curve

For a properly calibrated contrastive test:

| Model Tier | Expected Accuracy | Current Accuracy |
|-----------|------------------|------------------|
| Frontier (Claude Opus, GPT-4) | 75-85% | 100% |
| Strong (Sonnet, GPT-4o-mini) | 65-75% | 100% |
| Mid-tier (Llama 70B) | 55-65% | 100% |
| Weak (Llama 7B) | 40-50% | 100% |

**Result**: No model differentiation possible.

---

## Concrete Recommendations

### Priority 1: Fix Distractor Selection (CRITICAL)

#### Recommendation 1.1: Increase Distractor Count
**File**: `/Users/jack/mag/claudemem/src/benchmark-v2/index.ts`
**Line**: 96

```typescript
// BEFORE
export const DEFAULT_CONTRASTIVE_CONFIG: ContrastiveEvaluationConfig = {
    enabled: true,
    method: "both",
    distractorCount: 4,  // ❌ TOO FEW
};

// AFTER
export const DEFAULT_CONTRASTIVE_CONFIG: ContrastiveEvaluationConfig = {
    enabled: true,
    method: "both",
    distractorCount: 9,  // ✅ Industry standard
    // Consider: Add difficulty tiers with 4/9/19 distractors
};
```

**Impact**: Reduces random baseline from 20% to 10%.

#### Recommendation 1.2: Invert Semantic Similarity Filter
**File**: `/Users/jack/mag/claudemem/src/benchmark-v2/evaluators/contrastive/index.ts`
**Lines**: 103-120

```typescript
// BEFORE (Line 113)
.filter((s) => s.similarity !== null && s.similarity > 0.5 && s.similarity < 0.95)
//                                                            ❌ WRONG: excludes best distractors

// AFTER - Strategy 1: High-similarity distractors
.filter((s) => s.similarity !== null && s.similarity > 0.75 && s.similarity < 0.98)
//                                       ✅ FIXED: Want highly similar code

// AFTER - Strategy 2: Multi-tier difficulty
function selectSemanticDistractors(
    candidates: BenchmarkCodeUnit[],
    targetEmb: number[],
    count: number,
    difficulty: 'easy' | 'medium' | 'hard'
): BenchmarkCodeUnit[] {
    const similarities = candidates.map(c => ({
        unit: c,
        similarity: cosineSimilarity(embeddings.get(c.id), targetEmb)
    })).sort((a, b) => b.similarity - a.similarity);

    // Select distractors based on difficulty
    let range: [number, number];
    switch (difficulty) {
        case 'hard':
            range = [0.85, 0.98]; // Very similar functions
            break;
        case 'medium':
            range = [0.70, 0.85]; // Similar purpose
            break;
        case 'easy':
            range = [0.50, 0.70]; // Somewhat related
            break;
    }

    return similarities
        .filter(s => s.similarity >= range[0] && s.similarity < range[1])
        .slice(0, count)
        .map(s => s.unit);
}
```

**Impact**: Dramatically increases task difficulty by using confusable code.

#### Recommendation 1.3: Improve Signature Similarity
**File**: `/Users/jack/mag/claudemem/src/benchmark-v2/evaluators/contrastive/index.ts`
**Lines**: 146-170

```typescript
// BEFORE: Only counts parameters
function signatureSimilarity(sig1: string, sig2: string): number {
    const params1 = extractParamNames(sig1);
    const params2 = extractParamNames(sig2);
    const countSim = 1 - Math.abs(params1.length - params2.length) /
        Math.max(params1.length, params2.length, 1);
    const nameSim = common / Math.max(params1.length, params2.length, 1);
    return (countSim + nameSim) / 2;
}

// AFTER: Consider types, return type, and name patterns
interface ParsedSignature {
    functionName: string;
    params: Array<{ name: string; type?: string }>;
    returnType?: string;
}

function parseSignature(sig: string): ParsedSignature {
    // Extract: function name, param types, return type
    // e.g., "function foo(x: number, y: string): boolean"
    const nameMatch = sig.match(/function\s+(\w+)/);
    const functionName = nameMatch ? nameMatch[1] : '';

    const paramsMatch = sig.match(/\((.*?)\)/);
    const params = paramsMatch
        ? paramsMatch[1].split(',').map(p => {
            const parts = p.trim().split(':');
            return {
                name: parts[0]?.trim() || '',
                type: parts[1]?.trim()
            };
        })
        : [];

    const returnMatch = sig.match(/:\s*(\w+)\s*$/);
    const returnType = returnMatch ? returnMatch[1] : undefined;

    return { functionName, params, returnType };
}

function signatureSimilarity(sig1: string, sig2: string): number {
    const parsed1 = parseSignature(sig1);
    const parsed2 = parseSignature(sig2);

    // 1. Parameter count similarity
    const countSim = 1 - Math.abs(parsed1.params.length - parsed2.params.length) /
        Math.max(parsed1.params.length, parsed2.params.length, 1);

    // 2. Parameter type similarity
    const types1 = parsed1.params.map(p => p.type).filter(Boolean);
    const types2 = parsed2.params.map(p => p.type).filter(Boolean);
    const commonTypes = types1.filter(t => types2.includes(t)).length;
    const typeSim = types1.length > 0 || types2.length > 0
        ? commonTypes / Math.max(types1.length, types2.length, 1)
        : 0.5; // No type info = neutral

    // 3. Return type similarity
    const returnSim = parsed1.returnType && parsed2.returnType
        ? (parsed1.returnType === parsed2.returnType ? 1 : 0)
        : 0.5; // No return type = neutral

    // 4. Function name semantic similarity (optional)
    const nameSim = functionNameSimilarity(parsed1.functionName, parsed2.functionName);

    // Weighted combination
    return (
        0.25 * countSim +
        0.35 * typeSim +
        0.20 * returnSim +
        0.20 * nameSim
    );
}

function functionNameSimilarity(name1: string, name2: string): number {
    // Check for common prefixes/suffixes
    const prefixes = ['get', 'set', 'is', 'has', 'create', 'delete', 'update', 'find', 'fetch', 'send'];
    const prefix1 = prefixes.find(p => name1.toLowerCase().startsWith(p)) || '';
    const prefix2 = prefixes.find(p => name2.toLowerCase().startsWith(p)) || '';

    if (prefix1 === prefix2 && prefix1.length > 0) {
        return 0.7; // Same action type (e.g., both getters)
    }

    // Use Levenshtein distance for name similarity
    const distance = levenshteinDistance(name1.toLowerCase(), name2.toLowerCase());
    const maxLen = Math.max(name1.length, name2.length);
    return 1 - (distance / maxLen);
}
```

**Impact**: Better detection of similar interfaces (e.g., `getUser(id: string)` vs `getPost(id: string)`).

### Priority 2: Add Graduated Difficulty

#### Recommendation 2.1: Multi-Level Difficulty System
**File**: `/Users/jack/mag/claudemem/src/benchmark-v2/types.ts`
**Line**: 281

```typescript
// BEFORE
export type DistractorDifficulty = "easy" | "medium" | "hard";

// AFTER
export type DistractorDifficulty =
    | "trivial"      // 1-in-5 with random code (baseline)
    | "easy"         // 1-in-5 with same-type code
    | "medium"       // 1-in-10 with similar signatures
    | "hard"         // 1-in-10 with semantic similarity 0.7-0.85
    | "very_hard"    // 1-in-20 with semantic similarity 0.85-0.95
    | "adversarial"; // 1-in-20 with partial matches (see Rec 3.1)
```

**File**: `/Users/jack/mag/claudemem/src/benchmark-v2/evaluators/contrastive/index.ts`
**Add new function after line 138**:

```typescript
function calculateDifficultyV2(
    distractors: BenchmarkCodeUnit[],
    target: BenchmarkCodeUnit,
    embeddings?: Map<string, number[]>
): DistractorDifficulty {
    const sameFileCount = distractors.filter(d => d.path === target.path).length;

    // Calculate semantic similarity if available
    let avgSimilarity = 0;
    if (embeddings) {
        const targetEmb = embeddings.get(target.id);
        if (targetEmb) {
            const similarities = distractors
                .map(d => cosineSimilarity(embeddings.get(d.id), targetEmb))
                .filter((s): s is number => s !== null);
            avgSimilarity = similarities.reduce((a, b) => a + b, 0) / similarities.length;
        }
    }

    // Multi-factor difficulty scoring
    let score = 0;

    // Factor 1: Semantic similarity (0-40 points)
    if (avgSimilarity > 0.90) score += 40;
    else if (avgSimilarity > 0.80) score += 30;
    else if (avgSimilarity > 0.70) score += 20;
    else if (avgSimilarity > 0.60) score += 10;

    // Factor 2: Same file (0-20 points)
    score += Math.min(sameFileCount * 7, 20);

    // Factor 3: Signature similarity (0-20 points)
    const sigSimilarities = distractors
        .filter(d => d.metadata.signature && target.metadata.signature)
        .map(d => signatureSimilarity(d.metadata.signature!, target.metadata.signature!));
    const avgSigSim = sigSimilarities.reduce((a, b) => a + b, 0) / (sigSimilarities.length || 1);
    score += avgSigSim * 20;

    // Factor 4: Same language/type (0-10 points)
    const sameType = distractors.filter(d => d.type === target.type).length;
    score += (sameType / distractors.length) * 10;

    // Factor 5: Distractor count bonus (0-10 points)
    if (distractors.length >= 19) score += 10;
    else if (distractors.length >= 9) score += 5;

    // Map score to difficulty (0-100 scale)
    if (score >= 80) return "adversarial";
    if (score >= 65) return "very_hard";
    if (score >= 50) return "hard";
    if (score >= 35) return "medium";
    if (score >= 20) return "easy";
    return "trivial";
}
```

**Impact**: Properly quantify difficulty for analysis and stratified sampling.

### Priority 3: Add Harder Contrastive Variants

#### Recommendation 3.1: Partial Match Distractors
**File**: `/Users/jack/mag/claudemem/src/benchmark-v2/evaluators/contrastive/index.ts`
**Add after line 139**:

```typescript
/**
 * Generate "partial match" distractors by modifying summaries
 * to create adversarial cases
 */
function generatePartialMatchDistractors(
    target: BenchmarkCodeUnit,
    summary: string,
    allUnits: BenchmarkCodeUnit[],
    count: number
): BenchmarkCodeUnit[] {
    const distractors: BenchmarkCodeUnit[] = [];

    // Strategy 1: Find code that matches PART of the summary
    // E.g., summary says "authenticates user and logs activity"
    // Distractor: Code that only "logs activity" (partial match)

    const summaryTokens = tokenize(summary.toLowerCase());

    const candidates = allUnits
        .filter(u => u.id !== target.id && u.language === target.language)
        .map(u => ({
            unit: u,
            // Count how many summary concepts appear in code
            matchScore: countConceptOverlap(summaryTokens, tokenize(u.content.toLowerCase()))
        }))
        .filter(c => c.matchScore > 0.3 && c.matchScore < 0.8) // Partial, not full
        .sort((a, b) => b.matchScore - a.matchScore);

    distractors.push(...candidates.slice(0, count).map(c => c.unit));

    return distractors;
}

function tokenize(text: string): Set<string> {
    return new Set(
        text
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(t => t.length > 2)
    );
}

function countConceptOverlap(set1: Set<string>, set2: Set<string>): number {
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    return intersection.size / union.size; // Jaccard similarity
}
```

**Impact**: Creates adversarial cases where distractors match parts of the summary.

#### Recommendation 3.2: Add Negative Sampling Strategy
**File**: `/Users/jack/mag/claudemem/src/benchmark-v2/evaluators/contrastive/index.ts`
**Modify selectDistractors function (lines 57-139)**:

```typescript
export function selectDistractors(
    target: BenchmarkCodeUnit,
    allUnits: BenchmarkCodeUnit[],
    count: number = 9,
    embeddings?: Map<string, number[]>,
    difficulty: DistractorDifficulty = "hard" // NEW: explicit difficulty
): DistractorSet {
    const distractors: BenchmarkCodeUnit[] = [];

    // Filter candidates
    const candidates = allUnits.filter(u =>
        u.id !== target.id &&
        u.language === target.language &&
        u.type === target.type
    );

    if (candidates.length < count) {
        throw new InsufficientDistractorsError(target.id, count, candidates.length);
    }

    // NEW: Difficulty-based selection strategy
    switch (difficulty) {
        case "adversarial":
            // 100% high-similarity (0.85-0.98)
            distractors.push(...selectSemanticDistractors(
                candidates, embeddings, target, count, 0.85, 0.98
            ));
            break;

        case "very_hard":
            // 70% high-similarity, 30% same-file
            const vhCount = Math.ceil(count * 0.7);
            distractors.push(...selectSemanticDistractors(
                candidates, embeddings, target, vhCount, 0.80, 0.95
            ));
            const sameFile = candidates.filter(c => c.path === target.path);
            distractors.push(...shuffleAndTake(sameFile, count - distractors.length));
            break;

        case "hard":
            // 50% semantic (0.75-0.90), 30% same-file, 20% similar-sig
            const hSemCount = Math.ceil(count * 0.5);
            distractors.push(...selectSemanticDistractors(
                candidates, embeddings, target, hSemCount, 0.75, 0.90
            ));
            // ... add same-file and similar-sig
            break;

        case "medium":
            // Mix of strategies
            // ... implement
            break;

        case "easy":
        case "trivial":
            // Random sampling (baseline)
            distractors.push(...shuffleAndTake(candidates, count));
            break;
    }

    return {
        targetCodeUnitId: target.id,
        distractorIds: distractors.slice(0, count).map(d => d.id),
        difficulty: calculateDifficultyV2(distractors, target, embeddings)
    };
}

function selectSemanticDistractors(
    candidates: BenchmarkCodeUnit[],
    embeddings: Map<string, number[]> | undefined,
    target: BenchmarkCodeUnit,
    count: number,
    minSim: number,
    maxSim: number
): BenchmarkCodeUnit[] {
    if (!embeddings) {
        return shuffleAndTake(candidates, count);
    }

    const targetEmb = embeddings.get(target.id);
    if (!targetEmb) {
        return shuffleAndTake(candidates, count);
    }

    const similarities = candidates
        .filter(c => !distractors.some(d => d.id === c.id))
        .map(c => ({
            unit: c,
            similarity: cosineSimilarity(embeddings.get(c.id), targetEmb)
        }))
        .filter(s => s.similarity !== null && s.similarity >= minSim && s.similarity < maxSim)
        .sort((a, b) => (b.similarity || 0) - (a.similarity || 0));

    return similarities.slice(0, count).map(s => s.unit);
}
```

**Impact**: Explicit control over difficulty for analysis.

### Priority 4: Improve Evaluation Metrics

#### Recommendation 4.1: Add Rank-Based Metrics
**File**: `/Users/jack/mag/claudemem/src/benchmark-v2/types.ts`
**Lines**: 144-152

```typescript
// BEFORE
export interface ContrastiveResults {
    correct: boolean;           // Only tracks rank 1
    predictedRank: number;
    distractorIds: string[];
    method: ContrastiveMethod;
    confidenceGap?: number;
    embeddingModel?: string;
    llmModel?: string;
}

// AFTER
export interface ContrastiveResults {
    correct: boolean;           // Rank 1
    topK: {
        top1: boolean;          // Rank 1 (same as correct)
        top3: boolean;          // Rank 1-3
        top5: boolean;          // Rank 1-5
    };
    predictedRank: number;
    reciprocalRank: number;     // NEW: 1/rank (0 if not in top K)
    distractorIds: string[];
    method: ContrastiveMethod;
    confidenceGap?: number;     // Gap between rank 1 and rank 2
    difficultyScore?: number;   // NEW: Computed difficulty (0-100)
    embeddingModel?: string;
    llmModel?: string;
}
```

**Update aggregation** in `/Users/jack/mag/claudemem/src/benchmark-v2/scorers/aggregator.ts`:

```typescript
// Lines 243-282: Update aggregateContrastive
private aggregateContrastive(results: EvaluationResult[]): ContrastiveAggregation {
    const contrastiveResults = results.filter(
        (r) => r.evaluationType === "contrastive" && r.contrastiveResults
    );

    const embeddingResults = contrastiveResults.filter(
        (r) => r.contrastiveResults!.method === "embedding"
    );
    const llmResults = contrastiveResults.filter(
        (r) => r.contrastiveResults!.method === "llm"
    );

    // OLD: Just accuracy
    const embeddingCorrect = embeddingResults.filter(
        (r) => r.contrastiveResults!.correct
    ).length;

    // NEW: Top-K metrics
    const embeddingTop3 = embeddingResults.filter(
        (r) => r.contrastiveResults!.topK?.top3
    ).length;

    const embeddingMRR = embeddingResults.reduce(
        (sum, r) => sum + (r.contrastiveResults!.reciprocalRank || 0), 0
    ) / (embeddingResults.length || 1);

    const embeddingAccuracy =
        embeddingResults.length > 0 ? embeddingCorrect / embeddingResults.length : 0;

    // ... similar for LLM results

    return {
        embedding: {
            accuracy: embeddingAccuracy,
            top3: embeddingTop3 / (embeddingResults.length || 1),
            mrr: embeddingMRR,
            count: embeddingResults.length
        },
        llm: {
            accuracy: llmAccuracy,
            top3: llmTop3 / (llmResults.length || 1),
            mrr: llmMRR,
            count: llmResults.length
        },
        combined: (embeddingMRR + llmMRR) / 2, // Use MRR for combined score
    };
}
```

**Impact**: More granular metrics even if top-1 saturates at 100%.

### Priority 5: Add Stratified Evaluation

#### Recommendation 5.1: Report by Difficulty
**File**: `/Users/jack/mag/claudemem/src/benchmark-v2/scorers/aggregator.ts`
**Add new interface**:

```typescript
export interface ContrastiveAggregationV2 extends ContrastiveAggregation {
    byDifficulty: {
        trivial: { accuracy: number; mrr: number; count: number };
        easy: { accuracy: number; mrr: number; count: number };
        medium: { accuracy: number; mrr: number; count: number };
        hard: { accuracy: number; mrr: number; count: number };
        very_hard: { accuracy: number; mrr: number; count: number };
        adversarial: { accuracy: number; mrr: number; count: number };
    };
}
```

**Impact**: Reveals that models only fail on "adversarial" difficulty, not others.

---

## Implementation Priority

### Phase 1 (Immediate - 1-2 days)
1. ✅ Increase `distractorCount` from 4 to 9 (line 96 in `index.ts`)
2. ✅ Invert semantic similarity filter from `< 0.95` to range `[0.75, 0.98]` (line 113 in `contrastive/index.ts`)
3. ✅ Add top-K and MRR metrics to `ContrastiveResults` interface

**Expected Impact**: Accuracy drops from 100% to ~70-85% for top models.

### Phase 2 (Near-term - 3-5 days)
4. ✅ Implement improved signature similarity (consider types, return values)
5. ✅ Implement multi-level difficulty system with 6 tiers
6. ✅ Add difficulty-based distractor selection strategies
7. ✅ Update aggregation to report by difficulty

**Expected Impact**: Can differentiate models across difficulty spectrum (e.g., GPT-4 at 85% hard, Llama 70B at 65% hard).

### Phase 3 (Future - 1-2 weeks)
8. ⚪ Implement partial-match distractor generation
9. ⚪ Add adversarial contrastive variants (e.g., swap key terms in summary)
10. ⚪ Implement cross-language distractors (for polyglot codebases)
11. ⚪ Add confidence calibration analysis (does `confidenceGap` correlate with actual correctness?)

---

## Expected Outcomes

### After Phase 1 (Immediate Fixes)

| Model | Current Accuracy | Expected Accuracy (9 distractors, better selection) |
|-------|-----------------|-----------------------------------------------------|
| Claude Opus 4.5 | 100% | 80-85% |
| GPT-4o | 100% | 78-83% |
| Claude Sonnet 3.5 | 100% | 75-80% |
| Gemini 1.5 Pro | 100% | 72-78% |
| Llama 3.1 70B | 100% | 65-72% |
| Llama 3.1 8B | 100% | 50-60% |

**Differentiation**: ✅ Clear separation between model tiers

### After Phase 2 (Full Implementation)

| Difficulty | Top Model | Mid Model | Weak Model |
|-----------|-----------|-----------|------------|
| Trivial | 100% | 100% | 95% |
| Easy | 95% | 92% | 85% |
| Medium | 88% | 82% | 70% |
| Hard | 82% | 72% | 58% |
| Very Hard | 75% | 62% | 45% |
| Adversarial | 65% | 48% | 30% |

**Differentiation**: ✅✅ Strong separation across all difficulty levels

---

## Testing Plan

### Validation Steps

1. **Baseline Test** (Current System)
   - Run contrastive eval on 100 code units with 4 distractors
   - Measure: Accuracy, confidence gap, difficulty distribution
   - Expected: 100% accuracy, high confidence gap (>0.2)

2. **Phase 1 Test** (9 distractors + fixed similarity)
   - Re-run on same 100 code units with updated config
   - Measure: Accuracy, confidence gap, difficulty distribution
   - Expected: 70-85% accuracy, lower confidence gap (<0.15)

3. **Phase 2 Test** (Full system)
   - Run stratified evaluation across all difficulty levels
   - Measure: Per-difficulty accuracy for 3+ models
   - Expected: Clear model differentiation with correlation to overall quality

### Metrics to Track

```typescript
interface ContrastiveValidationMetrics {
    // Accuracy metrics
    overallAccuracy: number;
    accuracyByDifficulty: Record<DistractorDifficulty, number>;
    accuracyByLanguage: Record<string, number>;

    // Rank metrics
    meanReciprocalRank: number;
    top3Accuracy: number;
    top5Accuracy: number;

    // Distractor quality
    meanDistractorSimilarity: number;        // Should be 0.75-0.90
    confidenceGapDistribution: number[];     // Should spread, not cluster at >0.3

    // Difficulty distribution
    difficultyHistogram: Record<DistractorDifficulty, number>;

    // Correlation
    confidenceGapAccuracyCorrelation: number; // Should be positive
}
```

---

## Conclusion

The contrastive evaluation system is **critically broken** due to:
1. Too few distractors (4 instead of 9-19)
2. Inverted similarity filter (excludes hard distractors)
3. Naive signature matching (ignores types)
4. No difficulty stratification

**Immediate Action**: Implement Phase 1 fixes (increase distractor count, fix similarity filter) to restore evaluation discriminative power.

**Success Criteria**: After fixes, top-tier models should achieve 75-85% accuracy, mid-tier 65-75%, weak models 45-60% on contrastive matching tasks.
