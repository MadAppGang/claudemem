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
