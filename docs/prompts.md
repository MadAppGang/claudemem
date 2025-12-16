# Code Summarization System - Complete Prompt Library

All prompts used in the code summarization, indexing, and retrieval system.

---

## Table of Contents

1. [Summary Generation Prompts](#1-summary-generation-prompts)
   - System Prompt
   - Function/Method Summary
   - Class/Interface Summary
   - File/Module Summary
2. [Query Processing Prompts](#2-query-processing-prompts)
   - Query Classification
   - Query Expansion
3. [Retrieval Prompts](#3-retrieval-prompts)
   - LLM Reranking
   - Context Relevance Scoring
4. [Structural Analysis Prompts](#4-structural-analysis-prompts)
   - Relationship Extraction
   - Usage Pattern Detection
5. [Quality Assurance Prompts](#5-quality-assurance-prompts)
   - Summary Validation
   - Consistency Check

---

## 1. Summary Generation Prompts

### 1.1 System Prompt (Used for All Summary Generation)

```
You are a senior software engineer writing documentation for a code search and retrieval system. Your summaries will be:

1. **Embedded as vectors** for semantic search - use terminology developers would search for
2. **Shown to AI coding assistants** as context - be precise about behavior and contracts
3. **Read by developers** to quickly understand unfamiliar code - prioritize clarity

## Writing Guidelines

**DO:**
- Describe WHAT the code does and WHY (purpose, intent, business logic)
- Mention inputs, outputs, return values, and their meanings
- Note important side effects (database writes, API calls, file I/O, state mutations)
- Include error conditions and edge cases when significant
- Use domain terminology that matches how developers think about the problem
- Mention relationships to other code when it aids understanding

**DON'T:**
- Describe HOW the code works (implementation details, algorithms used)
- Start with "This function..." or "This class..." - just describe what it does
- Be vague ("handles various operations", "processes data")
- Include obvious information derivable from the signature
- Repeat parameter names without adding meaning
- Add unnecessary qualifiers ("basically", "essentially", "simply")

## Length Guidelines
- Functions/Methods: 2-4 sentences
- Classes/Interfaces: 3-6 sentences
- Files/Modules: 4-8 sentences

## Output Format
Provide ONLY the summary text. No markdown formatting, no labels, no additional commentary.
```

---

### 1.2 Function/Method Summary Prompt

```
Write a summary for this {language} {unit_type}.

**Name:** {name}
**Signature:** {signature}
**File:** {file_path}
**Visibility:** {visibility}
{async_marker}
{decorator_info}

{caller_context}

```{language}
{code}
```

Summary:
```

**Variable Definitions:**

| Variable | Source | Example |
|----------|--------|---------|
| `language` | Detected from file extension | `typescript`, `go`, `python` |
| `unit_type` | AST node type | `function`, `method`, `arrow function` |
| `name` | AST extraction | `handleUserAuthentication` |
| `signature` | Built from AST | `(userId: string, credentials: AuthCredentials) => Promise<AuthResult>` |
| `file_path` | Relative to repo root | `src/services/auth/handler.ts` |
| `visibility` | AST extraction | `public`, `private`, `exported`, `internal` |
| `async_marker` | If async | `**Async:** Yes` or omitted |
| `decorator_info` | If decorators present | `**Decorators:** @authenticated, @rateLimit(100)` or omitted |
| `caller_context` | From dependency graph | `**Called by:** LoginController.login, SessionManager.refresh` or omitted if none |
| `code` | Raw source code | The actual function code |

**Example Input:**

```
Write a summary for this typescript method.

**Name:** validateAndRefreshToken
**Signature:** (token: string, options?: RefreshOptions) => Promise<TokenResult>
**File:** src/services/auth/token-manager.ts
**Visibility:** public
**Async:** Yes
**Decorators:** @authenticated

**Called by:** SessionMiddleware.handle, ApiGateway.authenticateRequest

```typescript
async validateAndRefreshToken(token: string, options?: RefreshOptions): Promise<TokenResult> {
  const decoded = this.jwtService.verify(token);
  
  if (this.isExpiringSoon(decoded, options?.thresholdMinutes ?? 5)) {
    const user = await this.userRepository.findById(decoded.userId);
    if (!user || user.status !== 'active') {
      throw new AuthenticationError('User not found or inactive');
    }
    
    const newToken = await this.jwtService.sign({
      userId: user.id,
      roles: user.roles,
      permissions: await this.permissionService.getForUser(user.id)
    });
    
    await this.tokenStore.revoke(token);
    await this.tokenStore.store(newToken, user.id);
    
    return { token: newToken, refreshed: true, expiresAt: this.getExpiry(newToken) };
  }
  
  return { token, refreshed: false, expiresAt: this.getExpiry(token) };
}
```

Summary:
```

**Example Output:**

```
Validates a JWT token and automatically refreshes it if expiring within a configurable threshold (default 5 minutes). Returns the original or new token along with refresh status and expiration time. Throws AuthenticationError if the associated user is not found or inactive. Revokes the old token and stores the new one when refreshing, ensuring single-use tokens.
```

---

### 1.3 Class/Interface Summary Prompt

```
Write a summary for this {language} {unit_type}.

**Name:** {name}
**File:** {file_path}
{inheritance_info}
{interface_info}

**Public Methods:**
{method_list}

**Properties:**
{property_list}

{usage_context}

```{language}
{code}
```

Summary:
```

**Variable Definitions:**

| Variable | Source | Example |
|----------|--------|---------|
| `unit_type` | AST | `class`, `interface`, `type`, `struct` |
| `inheritance_info` | AST | `**Extends:** BaseService` or omitted |
| `interface_info` | AST | `**Implements:** Cacheable, Serializable` or omitted |
| `method_list` | Child summaries (first sentence only) | Bulleted list |
| `property_list` | AST extraction | `- cache: Map<string, CacheEntry> (private)` |
| `usage_context` | Dependency graph | `**Used by:** PaymentController, OrderService` or omitted |

**Example Input:**

```
Write a summary for this typescript class.

**Name:** RateLimiter
**File:** src/middleware/rate-limiter.ts
**Implements:** Middleware, Resettable

**Public Methods:**
- handle: Checks request against rate limit and either allows or rejects
- reset: Clears rate limit counters for a specific key or all keys
- getStatus: Returns current rate limit status for a key

**Properties:**
- store: RateLimitStore (private) - backing storage for counters
- config: RateLimitConfig (readonly) - limits and window configuration

**Used by:** ApiRouter, WebhookHandler, GraphQLServer

```typescript
export class RateLimiter implements Middleware, Resettable {
  private readonly store: RateLimitStore;
  private readonly config: RateLimitConfig;
  
  constructor(store: RateLimitStore, config: RateLimitConfig) {
    this.store = store;
    this.config = config;
  }
  
  async handle(req: Request, res: Response, next: NextFunction): Promise<void> {
    const key = this.extractKey(req);
    const current = await this.store.increment(key, this.config.windowMs);
    
    res.setHeader('X-RateLimit-Limit', this.config.max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, this.config.max - current));
    
    if (current > this.config.max) {
      res.setHeader('Retry-After', Math.ceil(this.config.windowMs / 1000));
      throw new RateLimitExceededError(key);
    }
    
    next();
  }
  
  async reset(key?: string): Promise<void> {
    if (key) {
      await this.store.delete(key);
    } else {
      await this.store.clear();
    }
  }
  
  async getStatus(key: string): Promise<RateLimitStatus> {
    const current = await this.store.get(key);
    return {
      limit: this.config.max,
      remaining: Math.max(0, this.config.max - (current ?? 0)),
      resetAt: await this.store.getTTL(key)
    };
  }
  
  private extractKey(req: Request): string {
    return this.config.keyGenerator?.(req) ?? req.ip;
  }
}
```

Summary:
```

**Example Output:**

```
Express middleware that enforces request rate limits using a sliding window algorithm. Tracks request counts per client (identified by IP or custom key generator) and rejects requests exceeding the configured maximum with a 429 status. Sets standard rate limit headers (X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After) on all responses. Supports manual counter reset for individual keys or full cache clearing, useful for admin overrides or testing. Requires an external RateLimitStore implementation for counter persistence (supports Redis, memory, or custom backends).
```

---

### 1.4 File/Module Summary Prompt

```
Write a summary for this {language} file.

**Path:** {file_path}
**Module/Package:** {module_name}

**Exports:**
{exports_list}

**Internal (non-exported):**
{internal_list}

**Dependencies:**
{import_summary}

**Imported by:**
{dependents_list}

Summary:
```

**Variable Definitions:**

| Variable | Source | Example |
|----------|--------|---------|
| `module_name` | Package/module system | `@app/services/auth`, `github.com/org/pkg/auth` |
| `exports_list` | AST + child summaries | Name + one-line summary for each export |
| `internal_list` | AST | Name + type for internal helpers |
| `import_summary` | AST | Grouped by external vs internal |
| `dependents_list` | Dependency graph | Files that import this file |

**Example Input:**

```
Write a summary for this typescript file.

**Path:** src/services/payment/processor.ts
**Module/Package:** @app/services/payment

**Exports:**
- PaymentProcessor (class): Orchestrates payment flow from validation through capture
- PaymentResult (type): Outcome of a payment attempt with transaction details
- PaymentError (class): Custom error with payment-specific codes and retry info
- createProcessor (function): Factory function with default configuration

**Internal (non-exported):**
- validatePaymentMethod (function): Checks payment method is valid and not expired
- calculateFees (function): Computes processing fees based on method and amount
- formatForGateway (function): Transforms internal format to gateway-specific format

**Dependencies:**
External: stripe, @sentry/node, decimal.js
Internal: @app/config, @app/services/user, @app/services/audit, @app/utils/retry

**Imported by:**
- src/controllers/checkout.controller.ts
- src/services/subscription/billing.ts
- src/workers/payment-retry.worker.ts
- src/api/webhooks/stripe.handler.ts

Summary:
```

**Example Output:**

```
Core payment processing module that handles the complete payment lifecycle for the checkout system. Exports PaymentProcessor as the main entry point, which coordinates validation, fraud checks, gateway communication (Stripe), and transaction recording. Supports multiple payment methods (cards, bank transfers, digital wallets) with automatic fee calculation based on method and region. Provides structured error handling through PaymentError with specific codes for declined cards, insufficient funds, and gateway timeouts - includes retry eligibility info for the retry worker. Used by checkout flow for immediate payments and by the subscription billing service for recurring charges. All transactions are audit-logged and errors reported to Sentry.
```

---

### 1.5 Go-Specific Function Summary Prompt

```
Write a summary for this Go function.

**Name:** {name}
**Signature:** {signature}
**File:** {file_path}
**Package:** {package_name}
**Receiver:** {receiver_info}
**Exported:** {is_exported}

{error_return_info}

```go
{code}
```

Summary:
```

**Additional Variables for Go:**

| Variable | Source | Example |
|----------|--------|---------|
| `package_name` | Package declaration | `auth`, `main` |
| `receiver_info` | Method receiver | `(s *Service)` or `None (standalone function)` |
| `is_exported` | First letter capitalized | `Yes`, `No` |
| `error_return_info` | Return type analysis | `**Returns error:** Yes - wraps underlying errors with context` |

**Example Input:**

```
Write a summary for this Go function.

**Name:** ProcessWebhook
**Signature:** func (h *WebhookHandler) ProcessWebhook(ctx context.Context, payload []byte, signature string) (*WebhookResult, error)
**File:** internal/webhooks/handler.go
**Package:** webhooks
**Receiver:** (h *WebhookHandler)
**Exported:** Yes

**Returns error:** Yes - returns ErrInvalidSignature, ErrUnknownEvent, or wrapped processing errors

```go
func (h *WebhookHandler) ProcessWebhook(ctx context.Context, payload []byte, signature string) (*WebhookResult, error) {
	if err := h.verifier.Verify(payload, signature); err != nil {
		h.metrics.InvalidSignature.Inc()
		return nil, fmt.Errorf("%w: %v", ErrInvalidSignature, err)
	}

	var event WebhookEvent
	if err := json.Unmarshal(payload, &event); err != nil {
		return nil, fmt.Errorf("failed to parse webhook payload: %w", err)
	}

	handler, ok := h.handlers[event.Type]
	if !ok {
		h.logger.Warn("unknown webhook event type", zap.String("type", event.Type))
		return &WebhookResult{Acknowledged: true, Processed: false}, nil
	}

	if err := handler.Handle(ctx, event); err != nil {
		h.metrics.ProcessingErrors.WithLabelValues(event.Type).Inc()
		return nil, fmt.Errorf("failed to process %s event: %w", event.Type, err)
	}

	h.metrics.ProcessedEvents.WithLabelValues(event.Type).Inc()
	return &WebhookResult{Acknowledged: true, Processed: true, EventType: event.Type}, nil
}
```

Summary:
```

**Example Output:**

```
Validates and dispatches incoming webhook events to registered type-specific handlers. Verifies the request signature before processing to prevent spoofed webhooks (returns ErrInvalidSignature on failure). Unknown event types are acknowledged but not processed, allowing graceful handling of new webhook types before handlers are implemented. Records metrics for invalid signatures, processing errors by event type, and successful processing counts. All errors are wrapped with context for debugging while preserving the original error chain.
```

---

### 1.6 Python-Specific Function Summary Prompt

```
Write a summary for this Python function.

**Name:** {name}
**Signature:** {signature}
**File:** {file_path}
**Module:** {module_path}
**Decorators:** {decorators}
**Async:** {is_async}

{docstring_context}

```python
{code}
```

Summary:
```

**Additional Variables for Python:**

| Variable | Source | Example |
|----------|--------|---------|
| `module_path` | Import path | `app.services.ml.predictor` |
| `decorators` | AST | `@lru_cache(maxsize=1000)`, `@retry(max_attempts=3)` |
| `is_async` | AST | `Yes`, `No` |
| `docstring_context` | If docstring exists | `**Existing docstring (for context, not repetition):** ...` or omitted |

**Example Input:**

```
Write a summary for this Python function.

**Name:** predict_batch
**Signature:** def predict_batch(self, inputs: List[Dict[str, Any]], *, batch_size: int = 32, timeout: float = 30.0) -> PredictionResults
**File:** app/services/ml/predictor.py
**Module:** app.services.ml.predictor
**Decorators:** @trace_span("ml.predict")
**Async:** No

**Existing docstring (for context, not repetition):**
Run model inference on a batch of inputs.

```python
@trace_span("ml.predict")
def predict_batch(
    self,
    inputs: List[Dict[str, Any]],
    *,
    batch_size: int = 32,
    timeout: float = 30.0
) -> PredictionResults:
    """Run model inference on a batch of inputs."""
    if not inputs:
        return PredictionResults(predictions=[], metadata={"empty": True})
    
    preprocessed = [self._preprocess(inp) for inp in inputs]
    
    all_predictions = []
    for batch_start in range(0, len(preprocessed), batch_size):
        batch = preprocessed[batch_start:batch_start + batch_size]
        tensor = self._to_tensor(batch)
        
        with torch.no_grad():
            with timeout_context(timeout / len(range(0, len(preprocessed), batch_size))):
                raw_output = self.model(tensor)
        
        predictions = self._postprocess(raw_output)
        all_predictions.extend(predictions)
    
    return PredictionResults(
        predictions=all_predictions,
        metadata={
            "model_version": self.model_version,
            "batch_count": len(range(0, len(preprocessed), batch_size)),
            "total_inputs": len(inputs)
        }
    )
```

Summary:
```

**Example Output:**

```
Runs batched inference on a list of input dictionaries, splitting large inputs into configurable batch sizes for memory efficiency. Each batch runs within a proportional timeout slice of the total allowed time, preventing single slow batches from consuming the entire timeout budget. Returns predictions with metadata including model version and batch statistics. Empty inputs return immediately with an empty result rather than failing. Automatically traced for observability via the ml.predict span.
```

---

## 2. Query Processing Prompts

### 2.1 Query Classification Prompt

```
Classify this code search query into one of the following categories:

**Categories:**
1. **symbol_lookup** - Looking for a specific named entity (function, class, variable, type)
   - Examples: "UserService", "handleAuth function", "PaymentError type"

2. **structural** - Asking about code relationships or structure
   - Examples: "methods in UserService", "functions that call processPayment", "files importing auth module"

3. **semantic** - Natural language question about functionality or behavior
   - Examples: "how does authentication work", "where is rate limiting implemented", "code that handles retries"

4. **similarity** - Looking for code similar to a given example
   - Examples: "code like this error handling pattern", "similar to the retry logic in utils"

5. **location** - Looking for code in a specific location
   - Examples: "tests for payment module", "handlers in api folder", "config files"

**Query:** {query}

Respond with JSON only:
```json
{
  "category": "<category_name>",
  "confidence": <0.0-1.0>,
  "extracted_entities": ["<any specific names or identifiers mentioned>"],
  "reasoning": "<one sentence explanation>"
}
```
```

**Example Input:**

```
**Query:** what functions call the validateToken method
```

**Example Output:**

```json
{
  "category": "structural",
  "confidence": 0.95,
  "extracted_entities": ["validateToken"],
  "reasoning": "Query asks about call relationships to a specific named method"
}
```

---

### 2.2 Query Expansion Prompt

```
Expand this code search query with related terms, synonyms, and alternate phrasings that might match relevant code.

**Original Query:** {query}
**Detected Language Context:** {language_hint}

Generate expansions that:
1. Include synonyms (auth → authentication, verify, validate)
2. Include related concepts (login → session, token, credentials)
3. Include common implementation patterns (cache → memoize, store, LRU)
4. Include language-specific terms if applicable

Respond with JSON only:
```json
{
  "original": "<original query>",
  "synonyms": ["<direct synonyms>"],
  "related_concepts": ["<semantically related terms>"],
  "implementation_patterns": ["<common implementation terms>"],
  "expanded_query": "<combined query for search>"
}
```
```

**Example Input:**

```
**Original Query:** how does caching work
**Detected Language Context:** typescript
```

**Example Output:**

```json
{
  "original": "how does caching work",
  "synonyms": ["cache", "caching", "cached"],
  "related_concepts": ["memoization", "store", "storage", "invalidation", "TTL", "expiry", "Redis", "memory cache"],
  "implementation_patterns": ["LRU", "cache-aside", "write-through", "Map", "WeakMap", "lru-cache"],
  "expanded_query": "cache caching memoization store TTL invalidation LRU Redis memory"
}
```

---

## 3. Retrieval Prompts

### 3.1 LLM Reranking Prompt

```
You are ranking code search results by relevance to a query.

**Query:** {query}

**Candidates:**
{candidates_formatted}

Rate each candidate's relevance from 0-10:
- **10**: Exactly what the query is looking for
- **7-9**: Highly relevant, directly addresses the query
- **4-6**: Somewhat relevant, related but not directly answering
- **1-3**: Tangentially related at best
- **0**: Not relevant

Consider:
- Does the code/summary directly address the query's intent?
- Would this help someone trying to understand or modify related functionality?
- Is this the right level of abstraction (not too high-level, not too low-level)?

Respond with JSON only:
```json
{
  "rankings": [
    {"index": 1, "score": <0-10>, "reason": "<brief explanation>"},
    {"index": 2, "score": <0-10>, "reason": "<brief explanation>"},
    ...
  ]
}
```
```

**Candidate Formatting Template:**

```
[{index}] {name} ({type}) - {path}
Summary: {summary}
---
```

**Example Input:**

```
**Query:** how to refresh expired JWT tokens

**Candidates:**
[1] validateAndRefreshToken (method) - src/services/auth/token-manager.ts
Summary: Validates a JWT token and automatically refreshes it if expiring within a configurable threshold. Returns the original or new token along with refresh status and expiration time.
---
[2] JwtService (class) - src/services/auth/jwt.service.ts
Summary: Low-level JWT operations including signing, verification, and decoding. Wraps jsonwebtoken library with configured secrets and algorithms.
---
[3] AuthMiddleware (class) - src/middleware/auth.middleware.ts
Summary: Express middleware that validates JWT tokens on incoming requests and attaches user context. Rejects requests with invalid or missing tokens.
---
[4] generateAccessToken (function) - src/services/auth/token-manager.ts
Summary: Creates a new JWT access token for a user with their roles and permissions encoded. Tokens expire after configured TTL.
---
[5] UserRepository (class) - src/repositories/user.repository.ts
Summary: Data access layer for user entities. Provides CRUD operations and queries for user lookup by ID, email, or external provider ID.
---
```

**Example Output:**

```json
{
  "rankings": [
    {"index": 1, "score": 10, "reason": "Directly addresses token refresh with expiry checking - exact match for query intent"},
    {"index": 4, "score": 7, "reason": "Related to token creation which is part of refresh flow, but doesn't handle the refresh logic itself"},
    {"index": 2, "score": 6, "reason": "Underlying JWT operations used by refresh, but too low-level for understanding refresh flow"},
    {"index": 3, "score": 4, "reason": "Uses tokens but focuses on validation not refresh"},
    {"index": 5, "score": 1, "reason": "User data access, not related to token refresh"}
  ]
}
```

---

### 3.2 Context Relevance Filter Prompt

```
Given a coding task, filter this list of code snippets to only those that would be helpful context.

**Task:** {task_description}

**Available Context:**
{context_list}

For each item, decide:
- **include**: Essential or very helpful for the task
- **maybe**: Might be useful for reference
- **exclude**: Not relevant to this specific task

Respond with JSON only:
```json
{
  "include": [<indices of essential items>],
  "maybe": [<indices of potentially useful items>],
  "exclude": [<indices of irrelevant items>],
  "reasoning": "<brief explanation of filtering logic>"
}
```
```

**Example Input:**

```
**Task:** Add retry logic to the payment processing when the gateway times out

**Available Context:**
[1] PaymentProcessor.process - Main payment flow
[2] RetryHelper - Generic retry utility with exponential backoff
[3] PaymentGateway.charge - Gateway API call
[4] UserService.getById - User lookup
[5] PaymentError - Payment-specific error types
[6] Logger - Application logging
[7] CircuitBreaker - Circuit breaker pattern implementation
[8] PaymentRepository - Payment record storage
```

**Example Output:**

```json
{
  "include": [1, 2, 3, 5, 7],
  "maybe": [8],
  "exclude": [4, 6],
  "reasoning": "Core payment flow (1,3), retry utility (2), error handling (5), and circuit breaker (7) are directly relevant to implementing retry on timeout. Payment storage (8) might be needed if retry state needs persistence. User lookup (4) and generic logging (6) aren't specific to retry implementation."
}
```

---

## 4. Structural Analysis Prompts

### 4.1 Relationship Extraction Prompt

Used when AST analysis is insufficient or for cross-file relationships.

```
Analyze this code and identify its relationships to other code in the system.

**Code Unit:** {name} ({type})
**File:** {path}

```{language}
{code}
```

Identify:
1. **Direct dependencies**: Functions/classes this code directly calls or uses
2. **Type dependencies**: Types, interfaces, or classes referenced
3. **Implicit dependencies**: Services or resources accessed (databases, APIs, caches)
4. **Likely callers**: What kind of code would typically call this (based on its purpose)

Respond with JSON only:
```json
{
  "calls": ["<function/method names called>"],
  "uses_types": ["<type names referenced>"],
  "accesses_resources": ["<database:users>", "<api:payment-gateway>", "<cache:session>"],
  "likely_called_by": ["<description of typical callers>"],
  "exports": ["<what this makes available to other code>"]
}
```
```

---

### 4.2 Usage Pattern Detection Prompt

```
Analyze this function and identify common usage patterns it implements.

**Function:** {name}
**File:** {path}

```{language}
{code}
```

Identify which patterns this code implements:
- Error handling patterns (try-catch, Result type, error codes)
- Async patterns (promises, callbacks, async/await, goroutines)
- Caching patterns (memoization, cache-aside, write-through)
- Retry patterns (exponential backoff, circuit breaker, retry with jitter)
- Validation patterns (schema validation, guard clauses, assertions)
- Data transformation patterns (map/reduce, pipeline, builder)
- Concurrency patterns (mutex, semaphore, worker pool)

Respond with JSON only:
```json
{
  "patterns": [
    {
      "name": "<pattern name>",
      "confidence": <0.0-1.0>,
      "evidence": "<brief description of how it's implemented>"
    }
  ],
  "architectural_role": "<e.g., controller, service, repository, utility, middleware>"
}
```
```

---

## 5. Quality Assurance Prompts

### 5.1 Summary Validation Prompt

Used to check if a generated summary meets quality standards.

```
Evaluate this code summary for quality.

**Code:**
```{language}
{code}
```

**Summary:**
{summary}

Evaluate on these criteria (1-5 scale):

1. **Accuracy**: Does it correctly describe what the code does?
2. **Completeness**: Does it mention inputs, outputs, side effects, errors?
3. **Abstraction**: Does it describe WHAT/WHY not HOW?
4. **Searchability**: Would developers find this with relevant queries?
5. **Conciseness**: Is it appropriately brief?

Respond with JSON only:
```json
{
  "scores": {
    "accuracy": <1-5>,
    "completeness": <1-5>,
    "abstraction": <1-5>,
    "searchability": <1-5>,
    "conciseness": <1-5>
  },
  "overall": <1-5>,
  "issues": ["<list any specific problems>"],
  "suggestions": ["<specific improvements if score < 4>"]
}
```
```

---

### 5.2 Summary Consistency Check Prompt

Used to ensure parent and child summaries are consistent.

```
Check if these summaries are consistent with each other.

**Parent (File):**
Path: {file_path}
Summary: {file_summary}

**Children (Functions/Classes):**
{children_summaries}

Check for:
1. **Contradictions**: Does any child summary contradict the file summary?
2. **Missing coverage**: Are there children doing significant work not reflected in file summary?
3. **Terminology consistency**: Do they use the same terms for the same concepts?

Respond with JSON only:
```json
{
  "consistent": <true/false>,
  "contradictions": ["<description of any contradictions>"],
  "missing_from_parent": ["<significant child behaviors not mentioned in parent>"],
  "terminology_issues": ["<inconsistent term usage>"],
  "suggested_parent_update": "<updated file summary if needed, or null>"
}
```
```

---

## 6. Incremental Update Prompts

### 6.1 Change Impact Analysis Prompt

```
Analyze what other summaries might need updating based on this code change.

**Changed File:** {file_path}
**Change Type:** {change_type}  // added, modified, deleted

**Before:**
```{language}
{old_code}
```

**After:**
```{language}
{new_code}
```

**Existing Summary:**
{existing_summary}

Determine:
1. Does the existing summary need updating?
2. What other code might be affected by this change?

Respond with JSON only:
```json
{
  "summary_update_needed": <true/false>,
  "update_reason": "<why update is/isn't needed>",
  "suggested_summary": "<new summary if update needed, null otherwise>",
  "potentially_affected": {
    "callers_may_break": <true/false>,
    "return_type_changed": <true/false>,
    "parameters_changed": <true/false>,
    "behavior_changed": <true/false>,
    "affected_patterns": ["<what kinds of calling code might be affected>"]
  }
}
```
```

---

## 7. Query Generation Prompts (For Evaluation)

### 7.1 Generate Test Queries Prompt

Used to generate realistic search queries for testing retrieval.

```
Generate realistic search queries that a developer might use to find this code.

**Code:**
```{language}
{code}
```

**Context:**
- File: {file_path}
- Name: {name}
- Purpose: {summary}

Generate 5 diverse queries:

1. **Vague/partial**: Query with incomplete information
2. **Wrong terminology**: Uses related but inexact terms
3. **Specific behavior**: Asks about one particular thing the code does
4. **Problem-based**: Describes a problem this code solves
5. **Integration**: Asks how to use this with something else

Make queries realistic - what a developer would actually type, not perfect descriptions.

Respond with JSON only:
```json
{
  "queries": [
    {"type": "vague", "query": "<query text>", "should_find": true},
    {"type": "wrong_terminology", "query": "<query text>", "should_find": true},
    {"type": "specific_behavior", "query": "<query text>", "should_find": true},
    {"type": "problem_based", "query": "<query text>", "should_find": true},
    {"type": "integration", "query": "<query text>", "should_find": true}
  ]
}
```
```

**Example Output:**

```json
{
  "queries": [
    {"type": "vague", "query": "token refresh", "should_find": true},
    {"type": "wrong_terminology", "query": "renew jwt when expired", "should_find": true},
    {"type": "specific_behavior", "query": "automatic token refresh before expiry", "should_find": true},
    {"type": "problem_based", "query": "prevent users getting logged out when token expires", "should_find": true},
    {"type": "integration", "query": "refresh token in auth middleware", "should_find": true}
  ]
}
```

---

## Appendix: Language-Specific Considerations

### TypeScript/JavaScript

- Include generic type parameters in signatures
- Note if function is exported default vs named
- Identify React components, hooks, and their dependencies
- Flag async functions and Promise return types

### Go

- Always include receiver type for methods
- Note exported vs unexported (capitalization)
- Include error return handling patterns
- Identify interface implementations

### Python

- Include decorator effects (not just names)
- Note type hints if present
- Identify class methods vs static methods vs instance methods
- Flag async def and generator functions

### Java

- Include full generic signatures
- Note annotations with their effects
- Identify Spring/framework-specific patterns
- Include visibility modifiers and final/static

### Rust

- Include lifetime parameters
- Note Result/Option return types
- Identify trait implementations
- Flag async functions and ownership patterns