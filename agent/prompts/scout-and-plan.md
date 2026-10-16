---
description: Background scout + planner workflow (no implementation)
---
Use the subagent tool to dispatch agents to background Herdr panes, and subagent_check to collect each result.

1. Dispatch a "scout" agent to find all code relevant to: $@
2. Call subagent_check with target = the dispatch id and wait: true, and use the returned report.
3. Dispatch a "planner" agent whose task is to create an implementation plan for "$@" using the scout's findings.
4. Call subagent_check again and report the plan.

Do NOT implement - just return the plan.
