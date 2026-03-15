/**
 * Setup TUI Wizard Types
 *
 * All wizard state, step definitions, and shared screen props.
 */

import type { EmbeddingProvider } from "../../types.js";
import type { HardwareProfile } from "./hardware.js";

// ============================================================================
// Wizard Step and Mode Types
// ============================================================================

/**
 * All valid screen names for the wizard history stack.
 */
export type WizardStep =
	| "mode-select"
	| "hardware-detect"
	| "provider-select"
	| "model-select"
	| "cloud-warning"
	| "cloud-setup"
	| "enrichment-setup"
	| "scope-select"
	| "review"
	| "saving"
	| "done";

/** Deployment mode chosen on the first screen. */
export type DeploymentMode = "local" | "shared" | "full-cloud";

/** Scope for config file writes. */
export type ConfigScope = "global" | "project" | "both";

// ============================================================================
// Wizard State
// ============================================================================

/**
 * Complete wizard state — single object, passed down and updated via onUpdate.
 * All fields are optional or have sensible defaults. Filled progressively.
 */
export interface WizardState {
	// Mode
	mode: DeploymentMode | null;

	// Hardware (Local mode)
	hardware: HardwareProfile | "detecting" | null;

	// Embedding Provider (Local + Shared modes)
	provider: EmbeddingProvider | null;
	ollamaEndpoint: string;
	lmstudioEndpoint: string;
	localEndpoint: string;
	model: string;
	pullProgress: string | null;
	pullComplete: boolean;

	// Cloud (Shared + Full Cloud modes)
	cloudEndpoint: string;
	cloudApiKey: string;
	orgSlug: string;
	repoSlug: string;

	// Enrichment (All modes)
	llm: string | null;
	llmApiKey: string | null;
	enrichmentSkipped: boolean;
	llmEndpoint: string | null;

	// Scope
	scope: ConfigScope;
	mergeExisting: boolean;
	projectConfigExists: boolean;

	// Post-save
	runIndexAfterSave: boolean | null;
}

// ============================================================================
// Screen Props
// ============================================================================

/** Props shared by all screen components. */
export interface ScreenProps {
	wizardState: WizardState;
	onUpdate: (partial: Partial<WizardState>) => void;
	onNext: (override?: WizardStep) => void;
	onBack: () => void;
	onQuit: () => void;
}

// ============================================================================
// Constants
// ============================================================================

/** Default wizard state. */
export const DEFAULT_WIZARD_STATE: WizardState = {
	mode: null,
	hardware: null,
	provider: null,
	ollamaEndpoint: "http://localhost:11434",
	lmstudioEndpoint: "http://localhost:1234/v1",
	localEndpoint: "",
	model: "",
	pullProgress: null,
	pullComplete: false,
	cloudEndpoint: "https://mem.madappgang.com",
	cloudApiKey: "",
	orgSlug: "",
	repoSlug: "",
	llm: "cc/sonnet",
	llmApiKey: null,
	enrichmentSkipped: false,
	llmEndpoint: null,
	scope: "global",
	mergeExisting: true,
	projectConfigExists: false,
	runIndexAfterSave: null,
};

/** Mode to ordered screen list (for step count display). */
export const STEP_LISTS: Record<DeploymentMode, WizardStep[]> = {
	local: [
		"mode-select",
		"hardware-detect",
		"provider-select",
		"model-select",
		"enrichment-setup",
		"scope-select",
		"review",
	],
	shared: [
		"mode-select",
		"cloud-setup",
		"provider-select",
		"model-select",
		"enrichment-setup",
		"scope-select",
		"review",
	],
	"full-cloud": [
		"mode-select",
		"cloud-warning",
		"cloud-setup",
		"enrichment-setup",
		"scope-select",
		"review",
	],
};

export function getStepLabel(
	step: WizardStep,
	mode: DeploymentMode | null,
): string {
	if (!mode) return "Step 1 of 5";
	const list = STEP_LISTS[mode];
	const idx = list.indexOf(step);
	if (idx < 0) return "";
	return `Step ${idx + 1} of ${list.length}`;
}
