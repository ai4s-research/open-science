"""AstaBench solver adapter for the Open Science Desktop agent harness.

This baseline intentionally uses InspectAI's model and tool loop so AstaBench can
record model usage and execute its task-provided tools. It loads the canonical
Open Science agent policy from the target repository at runtime.
"""

from __future__ import annotations

import os
from pathlib import Path

from inspect_ai.solver import Solver, basic_agent, solver, system_message


DEFAULT_TARGET_REPO = Path("/Users/zjh/Documents/Agent/open-science")
HARNESS_POLICY = Path("runtime/harness/AGENTS.md")


def load_open_science_policy(target_repo: Path | None = None) -> str:
    root = target_repo or Path(os.environ.get("OPEN_SCIENCE_REPO", DEFAULT_TARGET_REPO))
    path = root / HARNESS_POLICY
    if not path.is_file():
        raise FileNotFoundError(f"Open Science harness policy not found: {path}")
    return path.read_text(encoding="utf-8")


@solver
def open_science_agent(
    message_limit: int = 50,
    token_limit: int = 120_000,
    max_tool_output: int = 32_768,
) -> Solver:
    """Run the Open Science harness as an InspectAI-compatible research agent."""

    policy = load_open_science_policy()
    benchmark_rules = """
## Benchmark-mode rules

- Treat the current AstaBench sample as the only active goal.
- Use the tools already present in the task state; do not replace or bypass them.
- Work only inside the task-provided sandbox and workspace.
- Do not request interactive approval or wait for a human response.
- When the task is complete, call the submit tool exactly once with the final answer.
- Prefer a complete task answer over creating unrelated research artifacts.
"""
    return basic_agent(
        init=system_message(f"{policy}\n\n{benchmark_rules}"),
        message_limit=message_limit,
        token_limit=token_limit,
        max_tool_output=max_tool_output,
        max_attempts=1,
    )

