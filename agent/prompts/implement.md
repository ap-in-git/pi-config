---
description: Background implementation workflow - scout gathers context, planner creates plan, worker implements
---
Use the subagent tool to dispatch agents to background Herdr panes, and subagent_check to collect each result.

1. Dispatch a "scout" agent to find all code relevant to: $@
2. Call subagent_check with target = the dispatch id and wait: true, and use the returned report.
3. Dispatch a "planner" agent whose task is to create an implementation plan for "$@" using the scout's findings.
4. Call subagent_check again to collect the plan.
5. Dispatch a "worker" agent whose task is to implement the plan.
6. Call subagent_check a final time and report the worker's output.

Run each step in the background and check it before starting the next. Do not implement anything yourself.
