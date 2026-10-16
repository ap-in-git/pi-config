---
description: Background worker + reviewer + worker workflow
---
Use the subagent tool to dispatch agents to background Herdr panes, and subagent_check to collect each result.

1. Dispatch a "worker" agent to implement: $@
2. Call subagent_check with target = the dispatch id and wait: true, and use the returned result.
3. Dispatch a "reviewer" agent whose task is to review the implementation from the previous step and list only actionable findings.
4. Call subagent_check again to collect the review.
5. Dispatch a "worker" agent whose task is to apply the review feedback.
6. Call subagent_check a final time and report the final output.

Run each step in the background and check it before starting the next.
