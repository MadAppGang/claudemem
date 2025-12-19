/**
 * Pipeline Module
 *
 * State machine and orchestration for benchmark execution.
 */

export {
	PipelineStateMachine,
	createPipelineStateMachine,
	PHASES,
	PHASE_DEPENDENCIES,
	PHASE_NAMES,
	type PhaseState,
	type PipelineState,
} from "./state.js";

export {
	PipelineOrchestrator,
	createOrchestrator,
	type PhaseContext,
	type PhaseResult,
	type PhaseExecutor,
	type OrchestratorOptions,
} from "./orchestrator.js";
