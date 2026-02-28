/**
 * TUI App Context
 *
 * Provides shared state for the entire TUI application:
 * - FileTracker singleton
 * - Active tab
 * - Navigation history (for graph drill-in/back)
 * - Error state
 */

import {
	createContext,
	useContext,
	useState,
	useCallback,
	type ReactNode,
} from "react";
import { FileTracker } from "../core/tracker.js";
import { getIndexVersion } from "../core/index-version.js";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

// ============================================================================
// Types
// ============================================================================

export type TabId = "search" | "map" | "graph" | "analysis" | "doctor";

export interface AppContextValue {
	/** FileTracker singleton for the current project */
	tracker: FileTracker;
	/** The project root path */
	projectPath: string;
	/** Currently active tab */
	activeTab: TabId;
	/** Switch to a different tab */
	setActiveTab: (tab: TabId) => void;
	/** Navigation history for graph drill-in */
	navHistory: string[];
	/** Push a symbol name to navigation history */
	pushNav: (symbolName: string) => void;
	/** Go back in navigation history */
	popNav: () => string | undefined;
	/** Current error message, if any */
	error: string | null;
	/** Set global error message */
	setError: (msg: string | null) => void;
	/** Whether help overlay is visible */
	showHelp: boolean;
	/** Toggle help overlay */
	toggleHelp: () => void;
	/** Whether an input field is focused (suppresses global shortcuts) */
	inputFocused: boolean;
	/** Set input focus state */
	setInputFocused: (focused: boolean) => void;
	/** Index format version (1 = legacy, 2 = with code units) */
	indexVersion: number;
	/** Cleanly shut down the TUI (unmount + renderer destroy) */
	quit: () => void;
}

// ============================================================================
// Context
// ============================================================================

const AppContext = createContext<AppContextValue | null>(null);

// ============================================================================
// Provider
// ============================================================================

export interface AppProviderProps {
	projectPath: string;
	quit: () => void;
	children: ReactNode;
}

export function AppProvider({
	projectPath,
	quit,
	children,
}: AppProviderProps) {
	const [activeTab, setActiveTab] = useState<TabId>("search");
	const [navHistory, setNavHistory] = useState<string[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [showHelp, setShowHelp] = useState(false);
	const [inputFocused, setInputFocused] = useState(false);
	const [indexVersion] = useState(() => getIndexVersion(projectPath));

	// Create FileTracker singleton
	const dbDir = join(projectPath, ".claudemem");
	if (!existsSync(dbDir)) {
		mkdirSync(dbDir, { recursive: true });
	}
	const dbPath = join(dbDir, "index.db");
	const tracker = new FileTracker(dbPath, projectPath);

	const pushNav = useCallback((symbolName: string) => {
		setNavHistory((prev: string[]) => [...prev, symbolName]);
	}, []);

	const popNav = useCallback((): string | undefined => {
		let popped: string | undefined;
		setNavHistory((prev: string[]) => {
			const copy = [...prev];
			popped = copy.pop();
			return copy;
		});
		return popped;
	}, []);

	const toggleHelp = useCallback(() => {
		setShowHelp((prev: boolean) => !prev);
	}, []);

	const value: AppContextValue = {
		tracker,
		projectPath,
		activeTab,
		setActiveTab,
		navHistory,
		pushNav,
		popNav,
		error,
		setError,
		showHelp,
		toggleHelp,
		inputFocused,
		setInputFocused,
		indexVersion,
		quit,
	};

	return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

// ============================================================================
// Hook
// ============================================================================

export function useAppContext(): AppContextValue {
	const ctx = useContext(AppContext);
	if (!ctx) {
		throw new Error("useAppContext must be used inside AppProvider");
	}
	return ctx;
}
