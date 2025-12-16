# Code Summarization System - Implementation Plan

## System Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                           CODE SUMMARIZATION SYSTEM                           │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐   │
│  │   PHASE 1   │───▶│   PHASE 2   │───▶│   PHASE 3   │───▶│   PHASE 4   │   │
│  │ EXTRACTION  │    │ SUMMARIZE   │    │   INDEXING  │    │  RETRIEVAL  │   │
│  └─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘   │
│        │                  │                  │                  │            │
│        ▼                  ▼                  ▼                  ▼            │
│   AST Parsing        LLM Calls         Vector DB          Query Router      │
│   Dependency Map     Hierarchical      BM25 Index         Context Builder   │
│   Relationship       Summaries         Symbol Index       Reranker          │
│   Graph                                                                      │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Code Extraction Pipeline

### 1.1 Entry Point - Scan Codebase

```
FUNCTION scan_codebase(root_path, config):
    
    // Step 1: Discover all source files
    source_files = find_files(
        root_path,
        include_patterns = config.include,      // ["src/**/*.ts", "pkg/**/*.go"]
        exclude_patterns = config.exclude       // ["**/test/**", "**/vendor/**"]
    )
    
    // Step 2: Group by language
    files_by_language = group_by(source_files, detect_language)
    
    // Step 3: Process each language with appropriate parser
    all_code_units = []
    
    FOR language, files IN files_by_language:
        parser = get_parser_for_language(language)  // tree-sitter based
        
        FOR file IN files:
            code_units = extract_code_units(file, parser)
            all_code_units.extend(code_units)
    
    // Step 4: Build relationship graph
    relationship_graph = build_dependency_graph(all_code_units)
    
    // Step 5: Enrich code units with relationships
    FOR unit IN all_code_units:
        unit.relationships = relationship_graph.get_relationships(unit.id)
    
    RETURN all_code_units, relationship_graph
```

### 1.2 Extract Code Units from Single File

```
FUNCTION extract_code_units(file_path, parser):
    
    source_code = read_file(file_path)
    ast = parser.parse(source_code)
    
    code_units = []
    
    // Extract file-level unit
    file_unit = CodeUnit(
        id = hash(file_path + source_code),
        type = "file",
        path = file_path,
        name = basename(file_path),
        content = source_code,
        language = parser.language,
        metadata = extract_file_metadata(ast)
    )
    code_units.append(file_unit)
    
    // Extract classes/interfaces/types
    FOR class_node IN ast.query("class_declaration, interface_declaration"):
        class_unit = CodeUnit(
            id = hash(file_path + class_node.text),
            type = "class",
            path = file_path,
            name = class_node.name,
            content = class_node.text,
            language = parser.language,
            metadata = extract_class_metadata(class_node),
            parent_id = file_unit.id
        )
        code_units.append(class_unit)
        
        // Extract methods within class
        FOR method_node IN class_node.query("method_definition"):
            method_unit = extract_function_unit(method_node, file_path, class_unit.id)
            code_units.append(method_unit)
    
    // Extract standalone functions
    FOR func_node IN ast.query("function_declaration"):
        IF NOT is_inside_class(func_node):
            func_unit = extract_function_unit(func_node, file_path, file_unit.id)
            code_units.append(func_unit)
    
    RETURN code_units
```

### 1.3 Extract Function-Level Metadata

```
FUNCTION extract_function_unit(func_node, file_path, parent_id):
    
    RETURN CodeUnit(
        id = hash(file_path + func_node.start_line + func_node.name),
        type = "function" OR "method",
        path = file_path,
        name = func_node.name,
        content = func_node.text,
        
        metadata = {
            signature = build_signature(func_node),
            parameters = extract_parameters(func_node),
            return_type = extract_return_type(func_node),
            visibility = extract_visibility(func_node),      // public/private/protected
            decorators = extract_decorators(func_node),
            is_async = check_async(func_node),
            is_exported = check_exported(func_node),
            
            // Location info
            start_line = func_node.start_position.row,
            end_line = func_node.end_position.row,
            
            // Dependencies (from AST)
            imports_used = find_imports_used(func_node),
            functions_called = find_function_calls(func_node),
            types_referenced = find_type_references(func_node)
        },
        
        parent_id = parent_id
    )
```

### 1.4 Build Dependency Graph

```
FUNCTION build_dependency_graph(code_units):
    
    graph = DirectedGraph()
    
    // Add all units as nodes
    FOR unit IN code_units:
        graph.add_node(unit.id, unit)
    
    // Build symbol table for resolution
    symbol_table = {}
    FOR unit IN code_units:
        IF unit.type IN ["function", "class", "method"]:
            key = unit.path + ":" + unit.name
            symbol_table[key] = unit.id
            
            // Also add exported symbols with just name
            IF unit.metadata.is_exported:
                symbol_table[unit.name] = unit.id
    
    // Resolve relationships
    FOR unit IN code_units:
        
        // Parent-child (file contains function, class contains method)
        IF unit.parent_id:
            graph.add_edge(unit.parent_id, unit.id, "contains")
            graph.add_edge(unit.id, unit.parent_id, "contained_by")
        
        // Call relationships
        FOR called_func IN unit.metadata.functions_called:
            target_id = resolve_symbol(called_func, unit.path, symbol_table)
            IF target_id:
                graph.add_edge(unit.id, target_id, "calls")
                graph.add_edge(target_id, unit.id, "called_by")
        
        // Type relationships
        FOR type_ref IN unit.metadata.types_referenced:
            target_id = resolve_symbol(type_ref, unit.path, symbol_table)
            IF target_id:
                graph.add_edge(unit.id, target_id, "uses_type")
        
        // Import relationships
        FOR import_info IN unit.metadata.imports_used:
            target_id = resolve_import(import_info, symbol_table)
            IF target_id:
                graph.add_edge(unit.id, target_id, "imports")
    
    RETURN graph
```

---

## Phase 2: Summary Generation

### 2.1 Hierarchical Summarization Strategy

```
FUNCTION generate_all_summaries(code_units, relationship_graph, config):
    
    summaries = {}
    
    // IMPORTANT: Generate in order - functions first, then classes, then files
    // This allows higher-level summaries to reference lower-level ones
    
    // Step 1: Summarize functions/methods (leaf nodes)
    function_units = filter(code_units, type IN ["function", "method"])
    
    FOR unit IN function_units:
        summary = generate_function_summary(unit, relationship_graph)
        summaries[unit.id] = summary
        
        // Rate limiting
        wait(config.delay_between_requests)
    
    // Step 2: Summarize classes (using method summaries)
    class_units = filter(code_units, type = "class")
    
    FOR unit IN class_units:
        method_summaries = get_child_summaries(unit, summaries, relationship_graph)
        summary = generate_class_summary(unit, method_summaries, relationship_graph)
        summaries[unit.id] = summary
    
    // Step 3: Summarize files (using function/class summaries)
    file_units = filter(code_units, type = "file")
    
    FOR unit IN file_units:
        child_summaries = get_child_summaries(unit, summaries, relationship_graph)
        summary = generate_file_summary(unit, child_summaries, relationship_graph)
        summaries[unit.id] = summary
    
    RETURN summaries
```

### 2.2 Function Summary Generation

```
FUNCTION generate_function_summary(unit, relationship_graph):
    
    // Gather context from relationships
    callers = relationship_graph.get_edges(unit.id, "called_by")
    callees = relationship_graph.get_edges(unit.id, "calls")
    
    // Build caller context string (who uses this function)
    caller_context = ""
    IF callers:
        caller_names = [get_unit_name(c) FOR c IN callers[:3]]  // Limit to 3
        caller_context = "Called by: " + join(caller_names, ", ")
    
    // Build the prompt
    prompt = FUNCTION_SUMMARY_PROMPT.format(
        language = unit.language,
        name = unit.name,
        signature = unit.metadata.signature,
        file_path = unit.path,
        code = unit.content,
        caller_context = caller_context
    )
    
    // Call LLM
    response = llm.complete(
        system = SUMMARY_SYSTEM_PROMPT,
        user = prompt,
        temperature = 0.3,
        max_tokens = 300
    )
    
    // Parse and validate
    summary_text = extract_summary_text(response)
    
    RETURN Summary(
        code_unit_id = unit.id,
        text = summary_text,
        type = "function",
        metadata = {
            generated_at = now(),
            model = llm.model_name,
            prompt_version = PROMPT_VERSION
        }
    )
```

### 2.3 Class Summary Generation

```
FUNCTION generate_class_summary(unit, method_summaries, relationship_graph):
    
    // Build method overview
    method_overview = []
    FOR method_id, summary IN method_summaries:
        method_name = get_unit_name(method_id)
        // One-liner per method
        method_overview.append(f"- {method_name}: {summary.text.split('.')[0]}")
    
    method_overview_text = join(method_overview, "\n")
    
    // Get inheritance info
    inheritance_info = ""
    IF unit.metadata.extends:
        inheritance_info = f"Extends: {unit.metadata.extends}"
    IF unit.metadata.implements:
        inheritance_info += f"\nImplements: {join(unit.metadata.implements, ', ')}"
    
    prompt = CLASS_SUMMARY_PROMPT.format(
        language = unit.language,
        name = unit.name,
        file_path = unit.path,
        inheritance = inheritance_info,
        method_overview = method_overview_text,
        code = truncate_code_for_context(unit.content, max_tokens=2000)
    )
    
    response = llm.complete(
        system = SUMMARY_SYSTEM_PROMPT,
        user = prompt,
        temperature = 0.3,
        max_tokens = 400
    )
    
    RETURN Summary(
        code_unit_id = unit.id,
        text = extract_summary_text(response),
        type = "class",
        metadata = {...}
    )
```

### 2.4 File Summary Generation

```
FUNCTION generate_file_summary(unit, child_summaries, relationship_graph):
    
    // Categorize children
    exports = []
    internal = []
    
    FOR child_id, summary IN child_summaries:
        child_unit = get_unit(child_id)
        entry = {
            name = child_unit.name,
            type = child_unit.type,
            summary = summary.text.split('.')[0]  // First sentence only
        }
        
        IF child_unit.metadata.is_exported:
            exports.append(entry)
        ELSE:
            internal.append(entry)
    
    // Get file-level info
    imports = extract_import_statements(unit.content)
    
    // Files that import this file
    dependents = relationship_graph.get_edges(unit.id, "imported_by")
    dependent_paths = [get_unit_path(d) FOR d IN dependents[:5]]
    
    prompt = FILE_SUMMARY_PROMPT.format(
        language = unit.language,
        file_path = unit.path,
        exports_overview = format_exports_list(exports),
        internal_overview = format_internal_list(internal),
        imports = join(imports, "\n"),
        used_by = join(dependent_paths, ", ") OR "Not imported by other files"
    )
    
    response = llm.complete(
        system = SUMMARY_SYSTEM_PROMPT,
        user = prompt,
        temperature = 0.3,
        max_tokens = 500
    )
    
    RETURN Summary(
        code_unit_id = unit.id,
        text = extract_summary_text(response),
        type = "file",
        metadata = {...}
    )
```

### 2.5 Summary Prompts

```
SUMMARY_SYSTEM_PROMPT = """
You are a code documentation expert. Write concise summaries for a RAG system 
that helps developers find and understand code.

Your summaries will be:
1. Embedded as vectors for semantic search
2. Shown to LLMs as context for coding tasks
3. Used by developers to quickly understand unfamiliar code

Guidelines:
- Describe WHAT and WHY, not HOW (implementation details)
- Use terminology developers would search for
- Mention inputs, outputs, side effects, error conditions
- Keep it concise: 2-4 sentences for functions, 3-6 for classes/files
- Include the code's role in the broader system when apparent
- Never start with "This function..." - just describe what it does
"""

FUNCTION_SUMMARY_PROMPT = """
Write a summary for this {language} function.

Name: {name}
Signature: {signature}
File: {file_path}
{caller_context}

```{language}
{code}
```

Summary:
"""

CLASS_SUMMARY_PROMPT = """
Write a summary for this {language} class.

Name: {name}
File: {file_path}
{inheritance}

Methods:
{method_overview}

```{language}
{code}
```

Summary:
"""

FILE_SUMMARY_PROMPT = """
Write a summary for this {language} file.

Path: {file_path}

Exports:
{exports_overview}

Internal functions/classes:
{internal_overview}

Imports:
{imports}

Used by: {used_by}

Summary:
"""
```

---

## Phase 3: Index Building

### 3.1 Build Hybrid Index

```
FUNCTION build_hybrid_index(code_units, summaries, config):
    
    // Create three index types
    vector_index = VectorIndex(config.embedding_model)
    keyword_index = BM25Index()
    symbol_index = SymbolIndex()
    
    // Process each code unit
    FOR unit IN code_units:
        summary = summaries.get(unit.id)
        
        // 1. Vector index: embed summary + code snippet
        document = build_embedding_document(unit, summary)
        embedding = config.embedding_model.embed(document)
        
        vector_index.add(
            id = unit.id,
            embedding = embedding,
            metadata = {
                type = unit.type,
                path = unit.path,
                name = unit.name,
                language = unit.language
            }
        )
        
        // 2. Keyword index: index code + summary for BM25
        keyword_document = build_keyword_document(unit, summary)
        keyword_index.add(
            id = unit.id,
            text = keyword_document
        )
        
        // 3. Symbol index: structured lookup
        symbol_index.add(
            id = unit.id,
            symbols = extract_symbols(unit)
        )
    
    RETURN HybridIndex(vector_index, keyword_index, symbol_index)
```

### 3.2 Build Embedding Document

```
FUNCTION build_embedding_document(unit, summary):
    
    // Combine summary with key code elements for embedding
    // Goal: capture both semantic meaning AND important identifiers
    
    parts = []
    
    // Summary first (most important for semantic search)
    IF summary:
        parts.append(summary.text)
    
    // Add signature (important for API discovery)
    IF unit.metadata.signature:
        parts.append(f"Signature: {unit.metadata.signature}")
    
    // Add file path context
    parts.append(f"Location: {unit.path}")
    
    // Add key identifiers (function name, class name)
    parts.append(f"Name: {unit.name}")
    
    // For small functions, include the code itself
    IF unit.type = "function" AND count_tokens(unit.content) < 200:
        parts.append(f"Code:\n{unit.content}")
    
    RETURN join(parts, "\n\n")
```

### 3.3 Build Keyword Document

```
FUNCTION build_keyword_document(unit, summary):
    
    // Optimized for BM25 keyword matching
    // Include things developers literally type in searches
    
    parts = []
    
    // Function/class name (often searched directly)
    parts.append(unit.name)
    
    // Camelcase/snake_case split (UserService -> user service)
    parts.append(split_identifier(unit.name))
    
    // File path words
    path_words = extract_path_words(unit.path)
    parts.append(join(path_words, " "))
    
    // Parameter names and types
    IF unit.metadata.parameters:
        FOR param IN unit.metadata.parameters:
            parts.append(param.name)
            IF param.type:
                parts.append(param.type)
    
    // Summary text
    IF summary:
        parts.append(summary.text)
    
    // Import names (people search for "axios", "express", etc.)
    FOR import_name IN unit.metadata.imports_used:
        parts.append(import_name)
    
    // The actual code (for exact matches)
    parts.append(unit.content)
    
    RETURN join(parts, " ")
```

### 3.4 Symbol Index Structure

```
FUNCTION extract_symbols(unit):
    
    // Structured data for exact lookups
    
    symbols = {
        // Primary identifiers
        name = unit.name,
        qualified_name = unit.path + ":" + unit.name,
        
        // Type information
        type = unit.type,
        visibility = unit.metadata.visibility,
        
        // For functions
        parameters = [p.name FOR p IN unit.metadata.parameters] IF unit.metadata.parameters,
        return_type = unit.metadata.return_type,
        
        // For classes
        methods = unit.metadata.methods IF unit.type = "class",
        extends = unit.metadata.extends,
        implements = unit.metadata.implements,
        
        // Navigation
        path = unit.path,
        line = unit.metadata.start_line,
        
        // Relationships
        exports = unit.metadata.is_exported,
        calls = unit.metadata.functions_called,
        called_by = []  // Populated from graph
    }
    
    RETURN symbols
```

---

## Phase 4: Retrieval Pipeline

### 4.1 Query Router

```
FUNCTION retrieve(query, index, config):
    
    // Step 1: Classify query type
    query_type = classify_query(query)
    
    // Step 2: Route to appropriate retrieval strategy
    SWITCH query_type:
        
        CASE "symbol_lookup":
            // Direct queries: "UserService", "handleAuth function"
            candidates = symbol_lookup(query, index.symbol_index)
        
        CASE "structural":
            // AST queries: "all methods in UserService", "functions that call X"
            candidates = structural_query(query, index.symbol_index)
        
        CASE "semantic":
            // Intent queries: "how does authentication work"
            candidates = hybrid_search(query, index, config)
        
        CASE "similarity":
            // "code similar to this snippet"
            candidates = vector_search(query, index.vector_index, config)
    
    // Step 3: Rerank candidates
    reranked = rerank(query, candidates, config)
    
    // Step 4: Expand context
    results = expand_context(reranked, index, config)
    
    RETURN results
```

### 4.2 Query Classification

```
FUNCTION classify_query(query):
    
    // Pattern matching for query types
    
    // Symbol lookup patterns
    IF matches_identifier_pattern(query):
        // "UserService", "handleAuth", "pkg/auth"
        RETURN "symbol_lookup"
    
    // Structural query patterns
    structural_keywords = ["methods in", "functions in", "calls to", 
                          "called by", "imports", "exports", "all"]
    IF any(keyword IN query.lower() FOR keyword IN structural_keywords):
        RETURN "structural"
    
    // Similarity patterns
    IF query contains code block OR "similar to" OR "like this":
        RETURN "similarity"
    
    // Default: semantic search
    RETURN "semantic"
```

### 4.3 Hybrid Search

```
FUNCTION hybrid_search(query, index, config):
    
    // Run both searches in parallel
    
    // Vector search for semantic similarity
    vector_results = index.vector_index.search(
        query = query,
        k = config.candidates_per_method,    // e.g., 25
        filters = config.filters              // language, type, etc.
    )
    
    // BM25 for keyword matching
    keyword_results = index.keyword_index.search(
        query = query,
        k = config.candidates_per_method
    )
    
    // Merge results using Reciprocal Rank Fusion (RRF)
    merged = reciprocal_rank_fusion(
        vector_results,
        keyword_results,
        k = 60,  // RRF constant
        weights = {vector: 0.6, keyword: 0.4}
    )
    
    RETURN merged[:config.max_candidates]  // e.g., top 50
```

### 4.4 Reciprocal Rank Fusion

```
FUNCTION reciprocal_rank_fusion(result_lists, k=60, weights=None):
    
    // RRF combines multiple ranked lists into one
    // Score = sum of 1/(k + rank) across all lists
    
    IF weights IS None:
        weights = {list_name: 1.0 FOR list_name IN result_lists}
    
    scores = {}
    
    FOR list_name, results IN result_lists:
        weight = weights[list_name]
        
        FOR rank, item IN enumerate(results):
            IF item.id NOT IN scores:
                scores[item.id] = {score: 0, item: item}
            
            // RRF formula
            scores[item.id].score += weight * (1.0 / (k + rank + 1))
    
    // Sort by combined score
    sorted_results = sorted(scores.values(), by=score, descending=True)
    
    RETURN [r.item FOR r IN sorted_results]
```

### 4.5 Reranking

```
FUNCTION rerank(query, candidates, config):
    
    // Use cross-encoder or LLM for precise relevance scoring
    
    IF config.reranker_type = "cross_encoder":
        // Fast: ~100ms for 50 candidates
        scores = cross_encoder.score_pairs(
            [(query, get_document(c)) FOR c IN candidates]
        )
    
    ELSE IF config.reranker_type = "llm":
        // Slower but more accurate
        scores = llm_rerank(query, candidates, config.rerank_model)
    
    // Combine with original scores
    FOR i, candidate IN enumerate(candidates):
        candidate.rerank_score = scores[i]
        candidate.final_score = (
            config.rerank_weight * scores[i] + 
            (1 - config.rerank_weight) * candidate.original_score
        )
    
    // Sort by final score
    reranked = sorted(candidates, by=final_score, descending=True)
    
    RETURN reranked[:config.top_k]  // e.g., top 10
```

### 4.6 LLM-based Reranking

```
FUNCTION llm_rerank(query, candidates, model):
    
    // Score relevance of each candidate
    
    prompt = """
    Query: {query}
    
    Rate the relevance of each code snippet to the query.
    Score 0-10 where 10 is perfectly relevant.
    
    {candidates_formatted}
    
    Respond with JSON: {"scores": [score1, score2, ...]}
    """
    
    // Format candidates with numbers
    candidates_formatted = ""
    FOR i, candidate IN enumerate(candidates):
        candidates_formatted += f"""
        [{i+1}] {candidate.name} ({candidate.path})
        Summary: {candidate.summary}
        ---
        """
    
    response = model.complete(prompt)
    scores = parse_json(response).scores
    
    RETURN scores
```

### 4.7 Context Expansion

```
FUNCTION expand_context(results, index, config):
    
    // Expand each result with relevant surrounding context
    
    expanded_results = []
    
    FOR result IN results:
        unit = get_code_unit(result.id)
        
        expanded = ExpandedResult(
            primary = result,
            context = []
        )
        
        // Add parent context (file for function, class for method)
        IF unit.parent_id:
            parent = get_code_unit(unit.parent_id)
            expanded.context.append({
                type = "parent",
                unit = parent,
                relevance = "contains"
            })
        
        // Add direct dependencies
        deps = get_dependencies(unit.id, index)
        FOR dep IN deps[:config.max_dependencies]:
            expanded.context.append({
                type = "dependency",
                unit = dep,
                relevance = "calls" OR "imports"
            })
        
        // Add type definitions if referenced
        types = get_referenced_types(unit.id, index)
        FOR type_unit IN types[:config.max_types]:
            expanded.context.append({
                type = "type_definition",
                unit = type_unit,
                relevance = "uses_type"
            })
        
        // Add related test file if exists
        test_file = find_related_test(unit.path)
        IF test_file:
            expanded.context.append({
                type = "test",
                unit = test_file,
                relevance = "tested_by"
            })
        
        expanded_results.append(expanded)
    
    RETURN expanded_results
```

---

## Phase 5: Context Composition for LLM

### 5.1 Build Final Context Window

```
FUNCTION compose_context(query, retrieved_results, config):
    
    // Compose context optimally for LLM consumption
    // Key insight: place most relevant at START and END (lost-in-middle problem)
    
    context_parts = []
    token_budget = config.max_context_tokens  // e.g., 30000
    tokens_used = 0
    
    // SECTION 1: Primary results (most relevant - goes at START)
    primary_section = []
    FOR result IN retrieved_results[:config.primary_count]:  // Top 3-5
        formatted = format_code_unit_full(result.primary)
        primary_section.append(formatted)
        tokens_used += count_tokens(formatted)
    
    context_parts.append({
        position = "start",
        priority = 1,
        content = join(primary_section, "\n\n---\n\n")
    })
    
    // SECTION 2: Dependencies and types (middle - less important)
    dependency_section = []
    FOR result IN retrieved_results:
        FOR ctx IN result.context:
            IF ctx.type IN ["dependency", "type_definition"]:
                formatted = format_code_unit_brief(ctx.unit)
                IF tokens_used + count_tokens(formatted) < token_budget * 0.7:
                    dependency_section.append(formatted)
                    tokens_used += count_tokens(formatted)
    
    context_parts.append({
        position = "middle",
        priority = 3,
        content = join(dependency_section, "\n\n")
    })
    
    // SECTION 3: File summaries (overview - goes at END)
    file_summaries = get_relevant_file_summaries(retrieved_results)
    summary_section = []
    FOR summary IN file_summaries:
        formatted = format_file_summary(summary)
        IF tokens_used + count_tokens(formatted) < token_budget:
            summary_section.append(formatted)
            tokens_used += count_tokens(formatted)
    
    context_parts.append({
        position = "end",
        priority = 2,
        content = join(summary_section, "\n\n")
    })
    
    // Assemble in order: START -> MIDDLE -> END
    final_context = assemble_by_position(context_parts)
    
    RETURN final_context
```

### 5.2 Format Code Unit (Full)

```
FUNCTION format_code_unit_full(unit):
    
    // Full format for primary results
    
    output = f"""
## {unit.name}
**File**: {unit.path}
**Type**: {unit.type}

### Summary
{unit.summary}

### Code
```{unit.language}
{unit.content}
```
"""
    
    IF unit.metadata.signature:
        output = insert_after_type(output, f"**Signature**: `{unit.metadata.signature}`")
    
    IF unit.metadata.parameters:
        params_str = format_parameters(unit.metadata.parameters)
        output = insert_before_code(output, f"**Parameters**:\n{params_str}")
    
    RETURN output
```

### 5.3 Format Code Unit (Brief)

```
FUNCTION format_code_unit_brief(unit):
    
    // Condensed format for supporting context
    
    output = f"""
### {unit.name} ({unit.path})
{unit.summary}

```{unit.language}
{truncate(unit.content, max_lines=20)}
```
"""
    
    RETURN output
```

### 5.4 Dynamic Budget Allocation

```
FUNCTION allocate_token_budget(query_complexity, result_count, config):
    
    // Dynamically allocate tokens based on query type
    
    base_budget = config.max_context_tokens
    
    // Simple query: less context needed
    IF query_complexity = "simple":
        RETURN {
            primary = 0.6 * base_budget,
            dependencies = 0.2 * base_budget,
            file_summaries = 0.2 * base_budget
        }
    
    // Complex/architectural query: more breadth
    IF query_complexity = "architectural":
        RETURN {
            primary = 0.3 * base_budget,
            dependencies = 0.3 * base_budget,
            file_summaries = 0.4 * base_budget
        }
    
    // Bug investigation: deep context
    IF query_complexity = "debugging":
        RETURN {
            primary = 0.5 * base_budget,
            dependencies = 0.4 * base_budget,
            file_summaries = 0.1 * base_budget
        }
    
    // Default balanced
    RETURN {
        primary = 0.5 * base_budget,
        dependencies = 0.3 * base_budget,
        file_summaries = 0.2 * base_budget
    }
```

---

## Phase 6: Incremental Updates

### 6.1 Watch for Changes

```
FUNCTION watch_codebase(root_path, index, config):
    
    // File system watcher for incremental updates
    
    watcher = FileSystemWatcher(root_path, config.include_patterns)
    
    change_queue = Queue()
    
    ON watcher.file_changed(file_path, change_type):
        change_queue.enqueue({
            path = file_path,
            type = change_type,  // created, modified, deleted
            timestamp = now()
        })
    
    // Process changes in batches (debounce)
    EVERY config.update_interval:  // e.g., 30 seconds
        IF change_queue.not_empty():
            changes = change_queue.drain()
            deduplicated = deduplicate_changes(changes)
            process_changes(deduplicated, index, config)
```

### 6.2 Process Incremental Changes

```
FUNCTION process_changes(changes, index, config):
    
    FOR change IN changes:
        
        IF change.type = "deleted":
            // Remove from all indexes
            units_to_remove = index.symbol_index.get_by_path(change.path)
            FOR unit_id IN units_to_remove:
                index.vector_index.delete(unit_id)
                index.keyword_index.delete(unit_id)
                index.symbol_index.delete(unit_id)
        
        ELSE IF change.type IN ["created", "modified"]:
            // Re-extract code units from changed file
            parser = get_parser_for_language(detect_language(change.path))
            new_units = extract_code_units(change.path, parser)
            
            // Remove old entries for this file
            old_units = index.symbol_index.get_by_path(change.path)
            FOR unit_id IN old_units:
                index.vector_index.delete(unit_id)
                index.keyword_index.delete(unit_id)
                index.symbol_index.delete(unit_id)
            
            // Generate summaries for new units
            summaries = generate_summaries_for_units(new_units, config)
            
            // Add to indexes
            FOR unit IN new_units:
                summary = summaries.get(unit.id)
                add_to_indexes(unit, summary, index)
    
    // Update relationship graph
    update_dependency_graph(changes, index)
```

### 6.3 Smart Invalidation

```
FUNCTION update_dependency_graph(changes, index):
    
    // When a file changes, potentially invalidate dependent summaries
    
    changed_unit_ids = []
    FOR change IN changes:
        units = index.symbol_index.get_by_path(change.path)
        changed_unit_ids.extend(units)
    
    // Find units that depend on changed units
    affected_units = set()
    
    FOR unit_id IN changed_unit_ids:
        // Files that import this file
        importers = index.relationship_graph.get_edges(unit_id, "imported_by")
        affected_units.update(importers)
        
        // Functions that call changed functions
        callers = index.relationship_graph.get_edges(unit_id, "called_by")
        affected_units.update(callers)
    
    // Mark affected summaries as stale (regenerate on next access or in background)
    FOR unit_id IN affected_units:
        IF unit_id NOT IN changed_unit_ids:  // Don't double-process
            index.mark_stale(unit_id)
    
    // Optionally: regenerate stale summaries in background
    IF config.eager_regeneration:
        regenerate_stale_summaries(affected_units, index, config)
```

---

## Phase 7: API Design

### 7.1 Core API Endpoints

```
// Initialize/rebuild index
POST /index/build
    body: { root_path, config }
    response: { job_id, status }

// Index status
GET /index/status
    response: { 
        code_units_count,
        summaries_count,
        last_updated,
        languages,
        index_health
    }

// Search
POST /search
    body: { 
        query,
        filters: { language, type, path_prefix },
        limit,
        include_context
    }
    response: {
        results: [
            {
                id, name, path, type, language,
                summary, relevance_score,
                code_snippet,
                context: [...]
            }
        ],
        total_found,
        search_time_ms
    }

// Get composed context (for LLM consumption)
POST /context
    body: {
        query,
        max_tokens,
        context_style: "full" | "brief" | "summaries_only"
    }
    response: {
        context_text,
        token_count,
        sources: [{ id, name, path }]
    }

// Symbol lookup
GET /symbol/{name}
    response: {
        exact_matches: [...],
        partial_matches: [...]
    }

// Get specific code unit
GET /unit/{id}
    response: { unit, summary, relationships }

// Structural queries
POST /query/structural
    body: {
        type: "calls" | "called_by" | "methods_of" | "files_importing",
        target: "symbol_name or id"
    }
    response: { results: [...] }
```

### 7.2 MCP Server Integration

```
// Model Context Protocol server for Claude Code integration

MCP_TOOLS = {
    
    "search_codebase": {
        description: "Search the codebase for relevant code using natural language",
        parameters: {
            query: "string - what to search for",
            limit: "number - max results (default 10)"
        },
        handler: FUNCTION(params):
            results = search(params.query, limit=params.limit)
            RETURN format_search_results(results)
    },
    
    "get_context": {
        description: "Get relevant code context for a task",
        parameters: {
            task: "string - description of the coding task",
            max_tokens: "number - maximum context size"
        },
        handler: FUNCTION(params):
            results = retrieve(params.task)
            context = compose_context(params.task, results, max_tokens=params.max_tokens)
            RETURN context
    },
    
    "lookup_symbol": {
        description: "Look up a specific function, class, or symbol",
        parameters: {
            name: "string - symbol name to look up"
        },
        handler: FUNCTION(params):
            matches = symbol_lookup(params.name)
            RETURN format_symbol_results(matches)
    },
    
    "find_callers": {
        description: "Find all code that calls a specific function",
        parameters: {
            function_name: "string - name of the function"
        },
        handler: FUNCTION(params):
            callers = structural_query("called_by", params.function_name)
            RETURN format_caller_results(callers)
    },
    
    "get_file_summary": {
        description: "Get a summary of what a file does",
        parameters: {
            path: "string - file path"
        },
        handler: FUNCTION(params):
            summary = get_summary_for_path(params.path)
            RETURN summary
    }
}
```

---

## Configuration Reference

### Default Configuration

```yaml
# summarizer-config.yaml

extraction:
  languages:
    - typescript
    - javascript
    - go
    - python
    - java
  
  include_patterns:
    - "src/**/*"
    - "pkg/**/*"
    - "lib/**/*"
  
  exclude_patterns:
    - "**/node_modules/**"
    - "**/vendor/**"
    - "**/*.test.*"
    - "**/*_test.*"
    - "**/dist/**"
    - "**/build/**"
  
  min_lines: 3
  max_lines: 1000
  skip_generated: true

summarization:
  model: "claude-3-5-sonnet-20241022"  # or "gpt-4o"
  temperature: 0.3
  max_tokens: 400
  
  # Rate limiting
  requests_per_minute: 50
  delay_between_requests_ms: 100
  
  # Hierarchical generation
  generate_function_summaries: true
  generate_class_summaries: true
  generate_file_summaries: true

indexing:
  embedding_model: "voyage-code-2"  # or "text-embedding-3-small"
  embedding_dimensions: 1024
  
  vector_index:
    type: "hnsw"
    ef_construction: 200
    M: 16
  
  keyword_index:
    type: "bm25"
    k1: 1.2
    b: 0.75

retrieval:
  default_limit: 10
  max_limit: 50
  
  hybrid_search:
    vector_weight: 0.6
    keyword_weight: 0.4
    candidates_per_method: 30
  
  reranking:
    enabled: true
    type: "cross_encoder"  # or "llm"
    model: "cross-encoder/ms-marco-MiniLM-L-12-v2"
    top_k_before_rerank: 50
    top_k_after_rerank: 10

context_composition:
  max_tokens: 30000
  
  allocation:
    primary_results: 0.5
    dependencies: 0.3
    file_summaries: 0.2
  
  format:
    include_line_numbers: true
    include_signatures: true
    truncate_long_functions: true
    max_function_lines: 100

incremental_updates:
  enabled: true
  watch_interval_seconds: 30
  batch_changes: true
  eager_regeneration: false  # regenerate affected summaries immediately

storage:
  type: "sqlite"  # or "postgres"
  path: "./.code-index/index.db"
  
  vector_store:
    type: "faiss"  # or "qdrant", "pinecone"
    path: "./.code-index/vectors"
```

---

## Usage Examples

### CLI Usage

```bash
# Initialize and build index
code-summarizer init ./my-project
code-summarizer build --config ./summarizer-config.yaml

# Search
code-summarizer search "how does authentication work"
code-summarizer search "UserService" --type symbol
code-summarizer search "functions that call handlePayment"

# Get context for LLM
code-summarizer context "implement rate limiting for the API" --max-tokens 20000

# Watch mode
code-summarizer watch

# Export summaries
code-summarizer export --format json > summaries.json
```

### Programmatic Usage

```
// Initialize
summarizer = CodeSummarizer(config_path="./summarizer-config.yaml")
summarizer.build_index("./my-project")

// Search
results = summarizer.search("authentication flow")
FOR result IN results:
    print(result.name, result.summary, result.relevance_score)

// Get context for LLM task
context = summarizer.get_context(
    task = "Add error handling to the payment processing",
    max_tokens = 25000
)
// context is ready to pass to LLM

// Symbol lookup
matches = summarizer.lookup("UserService")

// Structural query
callers = summarizer.find_callers("processPayment")
```

---

## Performance Targets

| Operation | Target Latency | Notes |
|-----------|---------------|-------|
| Initial index build | 1-2 min per 1000 files | Parallelizable |
| Summary generation | 500ms per unit | LLM-bound |
| Embedding generation | 50ms per unit | Batch for efficiency |
| Search (hybrid) | < 100ms | For 100K units |
| Reranking | < 200ms | Cross-encoder |
| Context composition | < 50ms | After retrieval |
| Incremental update | < 5s per changed file | Including re-summarization |

## Storage Requirements

| Component | Size Estimate | Notes |
|-----------|--------------|-------|
| Code units DB | ~1KB per unit | Metadata + content |
| Summaries | ~500B per unit | Text only |
| Vector index | ~4KB per unit | 1024-dim float32 |
| Keyword index | ~2KB per unit | Inverted index |
| Symbol index | ~500B per unit | Structured data |
| **Total** | **~8KB per code unit** | 1GB for 125K units |