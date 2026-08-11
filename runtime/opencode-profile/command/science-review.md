---
description: review this workspace's finished work for scientific rigour (traceability, statistics, units, provenance)
agent: reviewer
---

Review the work in this workspace and report findings.

Scope: $ARGUMENTS

When the scope above is empty, review what changed most recently — `git status
--short` and `git diff HEAD~1` — rather than the whole workspace. Follow your
output contract exactly: a short summary, then one `review` fenced block as the
last thing in the message.
