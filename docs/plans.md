# Plans Found

This document captures the roadmap, plan, and task-list artifacts currently present in the mnemex repository. It is a status index, not a commitment that every plan is still current.

| Plan | Source | State |
|---|---|---|
| `mnemex rg` finalization and Claude Code shim | `ai-docs/sessions/dev-dev-mnemex-rg-finalise-20260414-140422-75eb/final-report.md`, corrected by `ai-docs/sessions/dev-research-rg-shim-bypass-20260415-123552/report.md` | Implemented locally; docs/testdata cleanup remains |
| Query expansion SFT round 2 | `experiments/query-expansion/NEXT-TRAINING-PLAN.md` | Open training queue: Qwen3.5-9B, 4B, MiMo-7B, Phi-4-mini, 2B, Qwen3-14B |
| Query expansion/model pipeline | `ai-docs/sessions/dev-arch-20260304-133830-aeaeb600/architecture.md` | Multi-phase plan: data, fine-tuning, eval, search integration, FIM, docs |
| Cloud/team mnemex | `ai-docs/sessions/dev-arch-20260303-110649-56cc19cc/architecture.md` | Big roadmap: interfaces, cloud client, overlay, smart mode, enrichment graph |
| Continuous learning validation | `docs/continuous-learning-validation-plan.md` | Roadmap exists; some related code already exists, checklist not reconciled |
| E2E validation system | `docs/e2e-validation-system-design.md` | Roadmap for validation scenarios, experiment engine, CLI/reporting |
| Validation system test coverage | `docs/validation-system-testing.md` | Planned tests remain for integration/error/concurrency/performance |
| LLM code summary benchmark | `docs/llm benchmark.md` | 8-week implementation checklist |
| Code retrieval/summarization system | `docs/code retreaval system.md` | Broad 7-phase design: extraction through MCP/API |
| Cognitive codebase memory | `docs/adr/004-cognitive-codebase-memory.md` | 7-phase roadmap for temporal/session memory and consolidation |
| Contrastive evaluation fixes | `docs/contrastive-evaluation-analysis.md` | Immediate/near-term/future fix plan |
| Extended language support | `ai-docs/sessions/dev-feature-extended-language-support-20260106-232702-7757d852/requirements.md`, `ai-docs/sessions/dev-feature-extended-language-support-20260106-232702-7757d852/report.md` | Mostly implemented; remaining recommendations are grammar/tests/quality |
| Dingo language support | `ai-docs/sessions/dev-feature-dingo-language-20260108-012619-adac0346/implementation-log.md` | Marked implemented; post-implementation validation/docs remain |
| Landing page UX review | `ai-docs/design-reviews/landing-page-usability-review.md` | Priority action list: immediate, short-term, long-term |
| SEO/content roadmap | `ai-docs/seo-research-claudemem-positioning.md` | Historical positioning roadmap; likely stale after rename |

## Suggested Triage

The current checkout would be easiest to stabilize by splitting work into three lanes:

1. `rg` release cleanup: testdata index setup, docs/install output, and push/PR.
2. TUI index prompt: finish the index-required flow and validate the OpenTUI type surface.
3. Generated/format churn: decide which eval, VS Code extension, and landing-page changes are intentional before committing.
