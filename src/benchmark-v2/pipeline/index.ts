/**
 * Pipeline Module
 *
 * State machine and orchestration for benchmark execution.
 */

export {
	createOrchestrator,
	type OrchestratorOptions,
	type PhaseContext,
	type PhaseExecutor,
	type PhaseResult,
	PipelineOrchestrator,
} from "./orchestrator.js";
export {
	createPipelineStateMachine,
	PHASE_DEPENDENCIES,
	PHASE_NAMES,
	PHASES,
	type PhaseState,
	type PipelineState,
	PipelineStateMachine,
} from "./state.js";
