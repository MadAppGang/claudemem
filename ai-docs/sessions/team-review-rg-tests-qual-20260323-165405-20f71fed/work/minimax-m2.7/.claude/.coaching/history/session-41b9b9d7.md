# Session 41b9b9d7-47dd-4d5a-b6ee-8b95db58abfe

Date: 2026-03-23T05:59:47.358Z

[human]
session: 41b9b9d7
count: 0


[claude]
count: 2

1. You ran 8 grep/rg searches this session. For faster semantic code exploration:
  `mnemex --agent map "your concept"` -- understands intent, not just text
  `mnemex --agent symbol "SymbolName"` -- direct AST symbol lookup
  Skill: use the Skill tool with `code-analysis:mnemex-search`
2. You ran 8 Grep searches with no mnemex calls. For codebase investigation, mnemex provides semantic understanding:
  Skill({ "skill": "code-analysis:mnemex-search" }) -- before any mnemex usage
  `/code-analysis:setup` -- index your codebase for AST-aware search
  `mnemex callers <function>` -- find all callers without grep
  `mnemex map <concept>` -- semantic concept search across the codebase
