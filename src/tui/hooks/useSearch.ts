/**
 * useSearch Hook
 *
 * Manages semantic search state with debouncing.
 * Lazy-loads the indexer on first search to avoid startup overhead.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { SearchResult } from "../../types.js";

// ============================================================================
// Types
// ============================================================================

export type SortOrder = "score" | "file" | "name";

export interface UseSearchReturn {
	query: string;
	setQuery: (q: string) => void;
	results: SearchResult[];
	loading: boolean;
	error: string | null;
	selectedIndex: number;
	setSelectedIndex: (idx: number) => void;
	expandedIndex: number | null;
	toggleExpanded: (idx: number) => void;
	sortOrder: SortOrder;
	setSortOrder: (order: SortOrder) => void;
	language: string | null;
	setLanguage: (lang: string | null) => void;
}

// ============================================================================
// Hook
// ============================================================================

export function useSearch(projectPath: string): UseSearchReturn {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<SearchResult[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
	const [sortOrder, setSortOrder] = useState<SortOrder>("score");
	const [language, setLanguage] = useState<string | null>(null);

	// Keep reference to debounce timer
	const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Perform search
	const performSearch = useCallback(
		async (q: string) => {
			if (!q.trim()) {
				setResults([]);
				setLoading(false);
				return;
			}

			setLoading(true);
			setError(null);

			try {
				// Lazy-load the indexer to avoid loading LanceDB at startup
				const { createIndexer } = await import("../../core/indexer.js");
				const indexer = createIndexer({ projectPath });
				const rawResults = await indexer.search(q, {
					limit: 50,
					language: language ?? undefined,
				});

				// Sort results
				let sorted = [...rawResults];
				if (sortOrder === "file") {
					sorted.sort((a, b) =>
						a.chunk.filePath.localeCompare(b.chunk.filePath),
					);
				} else if (sortOrder === "name") {
					sorted.sort((a, b) =>
						(a.chunk.name ?? "").localeCompare(b.chunk.name ?? ""),
					);
				}
				// "score" order is default from the indexer

				setResults(sorted);
				setSelectedIndex(0);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				setResults([]);
			} finally {
				setLoading(false);
			}
		},
		[projectPath, language, sortOrder],
	);

	// Debounce search on query change
	useEffect(() => {
		if (debounceTimer.current) {
			clearTimeout(debounceTimer.current);
		}

		debounceTimer.current = setTimeout(() => {
			performSearch(query);
		}, 150);

		return () => {
			if (debounceTimer.current) {
				clearTimeout(debounceTimer.current);
			}
		};
	}, [query, performSearch]);

	const toggleExpanded = useCallback((idx: number) => {
		setExpandedIndex((prev: number | null) => (prev === idx ? null : idx));
	}, []);

	return {
		query,
		setQuery,
		results,
		loading,
		error,
		selectedIndex,
		setSelectedIndex,
		expandedIndex,
		toggleExpanded,
		sortOrder,
		setSortOrder,
		language,
		setLanguage,
	};
}
