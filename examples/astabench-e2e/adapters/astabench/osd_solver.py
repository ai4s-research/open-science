"""Real AstaBench adapter for Open Science Desktop (OSD).

The evaluated model runs inside OSD. Inspect remains the benchmark controller:
it owns the sample state, official tools, cutoff filters, scorers, and logs.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

import mcp.types as mcp_types
import uvicorn
from inspect_ai.model import ModelUsage
from inspect_ai.solver import Generate, Solver, TaskState, solver
from inspect_ai.tool import ContentText, ToolDef, ToolError
from mcp.server.fastmcp import FastMCP

from astabench.util.model import record_model_usage_with_inspect

from open_science_solver import load_open_science_policy


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_WORKSPACE = PROJECT_ROOT / "runtime/astabench-osd"
DEFAULT_PROFILE = PROJECT_ROOT / "configs/profiles/astabench-paper-finder.json"
PRODUCT_SKILLS = (
    "literature-review",
    "bibliometric-analysis",
    "citation-reviewer",
    "figure-provenance",
    "paper-to-report",
    "reproducible-research",
)
MAX_E2E_ARTIFACT_CHARACTERS = 10_000
MAX_E2E_CODE_CHARACTERS = 60_000
MAX_E2E_CAPTURE_CODE_CHARACTERS = 12_000
MAX_E2E_CAPTURE_OUTPUT_CHARACTERS = 8_000
MAX_E2E_EVIDENCE_ITEMS = 12


def load_product_skills(target_repo: Path | None = None) -> str:
    """Read the new product skills from the repo the run is pointed at."""
    root = target_repo or Path(os.environ.get("OPEN_SCIENCE_REPO", "/Users/zjh/Documents/Agent/open-science"))
    parts: list[str] = []
    for name in PRODUCT_SKILLS:
        path = root / "runtime/skills/core" / name / "SKILL.md"
        if path.is_file():
            parts.append(f"### {name}\n\n{path.read_text(encoding='utf-8')}")
    return "\n\n".join(parts)


def load_benchmark_profile(path: Path | None = None) -> tuple[dict[str, Any], str]:
    """Load adapter-scoped benchmark strategy and reusable capability skills."""
    if os.environ.get("ASTABENCH_SUPERVISION_ONLY") == "1":
        return {"output_contract": "e2e_discovery", "instructions": "", "capability_skills": []}, ""
    profile_path = path or Path(os.environ.get("BENCHMARK_PROFILE", DEFAULT_PROFILE))
    if not profile_path.is_file():
        raise FileNotFoundError(f"Benchmark profile not found: {profile_path}")
    profile = json.loads(profile_path.read_text(encoding="utf-8"))
    capability_texts: list[str] = []
    for relative_path in profile.get("capability_skills", []):
        skill_path = PROJECT_ROOT / relative_path
        if not skill_path.is_file():
            raise FileNotFoundError(f"Capability skill not found: {skill_path}")
        capability_texts.append(skill_path.read_text(encoding="utf-8"))
    return profile, "\n\n".join(capability_texts)


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _safe_sample_name(value: object) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", str(value)).strip("-") or "sample"


def _write_live_progress(sample_id: object, state: str = "running") -> None:
    """Publish the in-flight sample for the read-only local dashboard."""
    raw_path = os.environ.get("ASTABENCH_PROGRESS_FILE")
    if not raw_path:
        return
    path = Path(raw_path)
    payload = {
        "state": state,
        "sample_id": str(sample_id),
        "updated_at": datetime.now().astimezone().isoformat(),
    }
    temporary = path.with_suffix(".next")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary.write_text(json.dumps(payload) + "\n", encoding="utf-8")
        temporary.replace(path)
    except OSError:
        # Monitoring must never affect a scored evaluation.
        return


def _tool_result_text(result: Any) -> str:
    if isinstance(result, str):
        return result
    if isinstance(result, list):
        texts: list[str] = []
        for item in result:
            if isinstance(item, ContentText):
                texts.append(item.text)
            elif hasattr(item, "model_dump"):
                texts.append(json.dumps(item.model_dump(mode="json"), ensure_ascii=False))
            else:
                texts.append(str(item))
        return "\n".join(texts)
    if hasattr(result, "model_dump"):
        return json.dumps(result.model_dump(mode="json"), ensure_ascii=False)
    if isinstance(result, (dict, tuple)):
        return json.dumps(result, ensure_ascii=False, default=str)
    return str(result)


def _redact_sensitive_text(text: str) -> str:
    """Remove configured credentials if a tool or model accidentally echoes them."""
    redacted = text
    for name, value in os.environ.items():
        upper = name.upper()
        if len(value) >= 8 and any(marker in upper for marker in ("KEY", "TOKEN", "SECRET")):
            redacted = redacted.replace(value, f"[REDACTED:{name}]")
    return redacted


def _python_stage_violation(code: str) -> str | None:
    """Reject the highest-risk monolithic acquisition+training cell pattern."""
    lowered = code.lower()
    acquisition = any(marker in lowered for marker in (
        "load_dataset(", "snapshot_download(", "hf_hub_download(",
        "wget ", "curl ", "pip install", "!pip install",
    ))
    training = any(marker in lowered for marker in (
        ".fit(", ".train(", "trainer(", "trainer.train(",
        "optimizer.step(", "backward(",
    ))
    if acquisition and training:
        return (
            "This cell combines acquisition and training. Run acquisition alone, "
            "verify/cache the result, then train in a separate python_session call."
        )
    # Conservative unbounded-training guard: a large literal training loop with no
    # persistence anywhere in the cell will neither finish inside the 300s ceiling nor
    # leave a recoverable checkpoint, so it wedges the kernel. Kept high-precision to
    # avoid false positives — a legitimately checkpointed loop contains a save call.
    loop_counts = [int(match) for match in re.findall(r"range\(\s*(\d+)", lowered)]
    big_loop = any(count >= 50 for count in loop_counts)
    persists = any(marker in lowered for marker in (
        ".save(", "torch.save(", ".save_pretrained(", "to_csv(", "np.save(",
        "savez", "json.dump", "pickle.dump(", "checkpoint",
    ))
    if training and big_loop and not persists:
        return (
            "This cell runs a large training loop without persisting anything, so it "
            "cannot finish inside the 300-second cell ceiling or leave a recoverable "
            "checkpoint. Cap the epochs/steps to a small number, checkpoint to disk "
            "each iteration, and target 240 seconds per python_session call."
        )
    return None


class InspectToolBridge:
    """Expose one sample's Inspect tools over MCP without losing tool state.

    FastMCP handles separate HTTP requests in separate asyncio tasks. Some
    official AstaBench tools (notably ``python_session``) keep their live
    Jupyter handle in a ContextVar, so invoking them directly in request tasks
    silently creates a new context on later calls. A dedicated per-sample
    worker executes every tool call serially in one task, preserving the
    ContextVar and therefore the stateful Python session.
    """

    def __init__(self, tools: list[Any]) -> None:
        self.tool_defs = {td.name: td for td in (ToolDef(tool) for tool in tools)}
        self.submission: str | None = None
        self.evidence: list[dict[str, str]] = []
        self.port = _free_port()
        self._server: uvicorn.Server | None = None
        self._task: asyncio.Task[None] | None = None
        self._tool_queue: asyncio.Queue[
            tuple[
                str,
                dict[str, Any],
                asyncio.Future[mcp_types.CallToolResult],
            ]
            | None
        ] | None = None
        self._tool_worker_task: asyncio.Task[None] | None = None
        self._python_busy = False
        self._python_needs_continue = False
        self._python_last_result = ""

        fast = FastMCP(
            "astabench-inspect-tools",
            host="127.0.0.1",
            port=self.port,
        )
        low = fast._mcp_server  # FastMCP's public registration API cannot accept an existing JSON schema.

        @low.list_tools()
        async def list_tools() -> list[mcp_types.Tool]:
            tools = [
                mcp_types.Tool(
                    name=td.name,
                    description=td.description,
                    inputSchema=td.parameters.model_dump(mode="json", exclude_none=True),
                )
                for td in self.tool_defs.values()
            ]
            if "python_session" in self.tool_defs:
                tools.extend([
                    mcp_types.Tool(
                        name="python_execution_status",
                        description=(
                            "Check whether the previous python_session call is still running, "
                            "finished, or waiting for continuation. Never submit new Python while "
                            "this reports running or needs_continue."
                        ),
                        inputSchema={"type": "object", "properties": {}},
                    ),
                    mcp_types.Tool(
                        name="python_continue_wait",
                        description=(
                            "Continue waiting for a Python cell that reached the five-minute "
                            "Jupyter timeout without interrupting it. Call execution_status first."
                        ),
                        inputSchema={"type": "object", "properties": {}},
                    ),
                    mcp_types.Tool(
                        name="python_interrupt",
                        description="Interrupt the currently running or timed-out Python cell.",
                        inputSchema={"type": "object", "properties": {}},
                    ),
                    mcp_types.Tool(
                        name="python_restart",
                        description=(
                            "Last-resort recovery: kill and respawn the Python kernel. Use only "
                            "when a cell is wedged and python_interrupt did not free it (common for "
                            "CPU-bound native training/inference that ignores interrupt signals). "
                            "This clears ALL in-memory variables; files, downloads, caches, and "
                            "checkpoints on disk survive. After restarting, reload datasets, model "
                            "weights, and checkpoints from disk. The 300-second per-cell ceiling "
                            "still applies."
                        ),
                        inputSchema={"type": "object", "properties": {}},
                    ),
                ])
            return tools

        @low.call_tool(validate_input=True)
        async def call_tool(name: str, arguments: dict[str, Any]) -> mcp_types.CallToolResult:
            return await self._dispatch_tool_call(name, arguments)

        # OpenCode's `remote` MCP client currently connects via SSE.
        self._app = fast.sse_app()

    async def _execute_tool_call(
        self, name: str, arguments: dict[str, Any],
    ) -> mcp_types.CallToolResult:
        if name == "python_execution_status":
            status = (
                "running" if self._python_busy
                else "needs_continue" if self._python_needs_continue
                else "completed" if self._python_last_result
                else "idle"
            )
            payload = {"status": status}
            if status == "completed":
                payload["result"] = self._python_last_result[
                    -MAX_E2E_CAPTURE_OUTPUT_CHARACTERS:
                ]
            return mcp_types.CallToolResult(content=[mcp_types.TextContent(
                type="text", text=json.dumps(payload, ensure_ascii=False),
            )])
        if name == "python_restart":
            # Terminal recovery for a wedged kernel. interrupt_kernel() only sends a
            # SIGINT, which CPU-bound native code (BLAS/torch) will not honour until it
            # returns to Python; a full shutdown+setup kills the kernel subprocess
            # outright. Runs even while _python_busy is True — that is exactly the case
            # it exists for. On-disk state (caches, checkpoints, downloads) survives.
            print("[python_restart] kernel restart requested", file=sys.stderr, flush=True)
            try:
                from astabench.tools.stateful_python import get_sandbox_jupyter

                jupyter = await get_sandbox_jupyter()
                await jupyter.cleanup()
                await jupyter.setup()
                # Reset flags AFTER the respawn so a late-returning in-flight run_code
                # (whose finally clears _python_busy) cannot leave us mislabelled.
                self._python_busy = False
                self._python_needs_continue = False
                self._python_last_result = ""
                print("[python_restart] kernel restart succeeded", file=sys.stderr, flush=True)
                return mcp_types.CallToolResult(content=[mcp_types.TextContent(
                    type="text",
                    text=json.dumps({
                        "status": "restarted",
                        "instruction": (
                            "Python kernel restarted. All in-memory variables are gone; "
                            "reload datasets, model weights, and checkpoints from disk. "
                            "The 300-second per-cell ceiling still applies."
                        ),
                    }, ensure_ascii=False),
                )])
            except Exception as error:
                print(f"[python_restart] kernel restart failed: {error}", file=sys.stderr, flush=True)
                return mcp_types.CallToolResult(isError=True, content=[mcp_types.TextContent(
                    type="text", text=f"python_restart failed: {error}",
                )])
        if name in {"python_continue_wait", "python_interrupt"}:
            if self._python_busy:
                return mcp_types.CallToolResult(content=[mcp_types.TextContent(
                    type="text",
                    text=json.dumps({
                        "status": "running",
                        "instruction": "Wait, then call python_execution_status again.",
                    }),
                )])
            try:
                from astabench.tools.stateful_python import get_sandbox_jupyter

                jupyter = await get_sandbox_jupyter()
                self._python_busy = True
                if name == "python_continue_wait":
                    result = await jupyter.continue_after_timeout()
                else:
                    result = await jupyter.interrupt_kernel()
                result_text = _redact_sensitive_text(_tool_result_text(result))
                self._python_last_result = result_text
                self._python_needs_continue = (
                    "still running" in result_text.lower()
                    or "continue to wait" in result_text.lower()
                )
                if name == "python_interrupt":
                    self._python_needs_continue = False
                return mcp_types.CallToolResult(content=[mcp_types.TextContent(
                    type="text", text=result_text,
                )])
            except Exception as error:
                return mcp_types.CallToolResult(isError=True, content=[mcp_types.TextContent(
                    type="text", text=f"{name} failed: {error}",
                )])
            finally:
                self._python_busy = False

        td = self.tool_defs.get(name)
        if td is None:
            return mcp_types.CallToolResult(
                isError=True,
                content=[mcp_types.TextContent(type="text", text=f"Unknown tool: {name}")],
            )
        if name == "python_session":
            self._python_busy = True
            self._python_last_result = ""
        try:
            result = await td.tool(**arguments)
            if name in {"submit", "submit_tool"} and isinstance(
                arguments.get("submission"), str
            ):
                self.submission = arguments["submission"]
            result_text = _redact_sensitive_text(_tool_result_text(result))
            if name == "python_session" and isinstance(arguments.get("code"), str):
                self._python_last_result = result_text
                self._python_needs_continue = (
                    "still running" in result_text.lower()
                    or "continue to wait" in result_text.lower()
                )
                sequence = len(self.evidence) + 1
                self.evidence.append({
                    "filename": f"analysis_{sequence:03d}.py",
                    "code": _redact_sensitive_text(arguments["code"])[
                        :MAX_E2E_CAPTURE_CODE_CHARACTERS
                    ],
                    "artifact_filename": f"analysis_{sequence:03d}_output.txt",
                    "artifact": result_text[:MAX_E2E_CAPTURE_OUTPUT_CHARACTERS],
                })
            return mcp_types.CallToolResult(
                content=[mcp_types.TextContent(type="text", text=result_text)]
            )
        except ToolError as error:
            return mcp_types.CallToolResult(
                isError=True,
                content=[mcp_types.TextContent(type="text", text=str(error))],
            )
        except Exception as error:
            # Tool failures are data for the agent, not failures of the SSE
            # transport. Keeping them inside CallToolResult also prevents one
            # sample from corrupting the shared Inspect task group.
            return mcp_types.CallToolResult(
                isError=True,
                content=[mcp_types.TextContent(
                    type="text", text=f"tool {name} failed: {error}")],
            )
        finally:
            if name == "python_session":
                self._python_busy = False

    async def _tool_worker(self) -> None:
        assert self._tool_queue is not None
        while True:
            request = await self._tool_queue.get()
            try:
                if request is None:
                    return
                name, arguments, future = request
                result = await self._execute_tool_call(name, arguments)
                if not future.cancelled():
                    future.set_result(result)
            except BaseException as error:
                if request is not None:
                    future = request[2]
                    if not future.done():
                        future.set_exception(error)
                if isinstance(error, asyncio.CancelledError):
                    raise
            finally:
                self._tool_queue.task_done()

    async def _dispatch_tool_call(
        self, name: str, arguments: dict[str, Any],
    ) -> mcp_types.CallToolResult:
        if self._tool_queue is None or self._tool_worker_task is None:
            return mcp_types.CallToolResult(
                isError=True,
                content=[mcp_types.TextContent(
                    type="text", text="tool bridge worker is not running"
                )],
            )
        if name == "python_restart" or name == "python_execution_status" or (
            name in {"python_continue_wait", "python_interrupt"}
            and self._python_busy
        ):
            # Status/control requests must never sit behind the long-running call
            # they are meant to observe. python_restart in particular is the escape
            # hatch for a wedged cell, so it bypasses the serial queue and runs even
            # while _python_busy is True. Busy interrupt/continue return immediately
            # with clear guidance and can be retried after the active call unwinds.
            return await self._execute_tool_call(name, arguments)
        if name == "python_session" and (self._python_busy or self._python_needs_continue):
            status = "running" if self._python_busy else "needs_continue"
            return mcp_types.CallToolResult(isError=True, content=[mcp_types.TextContent(
                type="text",
                text=json.dumps({
                    "status": status,
                    "error": "Previous Python work must finish before new code is submitted.",
                    "next": (
                        "Call python_execution_status, then python_continue_wait if requested. "
                        "If it stays wedged and python_interrupt does not free it (common for "
                        "native training), call python_restart and reload state from disk."
                    ),
                }),
            )])
        if (name == "python_session" and isinstance(arguments.get("code"), str)
                and os.environ.get("ASTABENCH_SUPERVISION_ONLY") != "1"):
            violation = _python_stage_violation(arguments["code"])
            if violation:
                return mcp_types.CallToolResult(isError=True, content=[mcp_types.TextContent(
                    type="text",
                    text=json.dumps({
                        "status": "rejected_monolithic_cell",
                        "error": violation,
                    }),
                )])
        future: asyncio.Future[mcp_types.CallToolResult] = (
            asyncio.get_running_loop().create_future()
        )
        await self._tool_queue.put((name, arguments, future))
        return await future

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/sse"

    async def start(self) -> None:
        self._tool_queue = asyncio.Queue()
        self._tool_worker_task = asyncio.create_task(self._tool_worker())
        config = uvicorn.Config(
            self._app,
            host="127.0.0.1",
            port=self.port,
            # Normal SSE cancellation during sample teardown otherwise produces
            # a long, misleading Starlette/ASGI traceback after successful work.
            log_level="critical",
            access_log=False,
        )
        self._server = uvicorn.Server(config)

        async def _serve_guarded() -> None:
            # Isolate the per-sample bridge: if its SSE server crashes or is cancelled
            # it must never propagate into inspect's task group. Catch BaseException so
            # the CancelledError raised while tearing down the SSE lifespan is swallowed.
            try:
                await self._server.serve()
            except asyncio.CancelledError:
                pass
            except BaseException as error:  # noqa: BLE001 - deliberate isolation
                print(f"[bridge:{self.port}] server stopped: {error!r}", file=sys.stderr)

        self._task = asyncio.create_task(_serve_guarded())
        for _ in range(100):
            if self._task.done():
                await self._task
            try:
                reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
                writer.close()
                await writer.wait_closed()
                return
            except OSError:
                await asyncio.sleep(0.05)
        raise RuntimeError("Timed out starting the per-sample MCP tool bridge")

    async def stop(self) -> None:
        # Teardown must never raise: a CancelledError/timeout escaping here propagates
        # into inspect's task group and aborts the whole eval. Try graceful shutdown,
        # then force-cancel, swallowing everything.
        if self._server is not None:
            self._server.should_exit = True
        task = self._task
        if task is not None:
            # An MCP SSE response intentionally remains open for the session.
            # Graceful uvicorn shutdown races Starlette's streaming response and
            # can emit a false "response.start" ASGI error after a good sample.
            # Cancelling the isolated server task closes that stream cleanly;
            # _serve_guarded deliberately contains the cancellation.
            task.cancel()
            try:
                await task
            except BaseException:
                pass
        worker = self._tool_worker_task
        queue = self._tool_queue
        if worker is not None and queue is not None and not worker.done():
            await queue.put(None)
            try:
                await asyncio.wait_for(worker, timeout=10)
            except BaseException:
                worker.cancel()
                try:
                    await worker
                except BaseException:
                    pass
        self._tool_worker_task = None
        self._tool_queue = None


def _run_osd(arguments: list[str], timeout: int) -> Any:
    osd = shutil.which("osd")
    if not osd:
        raise RuntimeError("osd CLI is not installed or is not on PATH")
    completed = subprocess.run(
        [osd, *arguments, "--json"],
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        raise RuntimeError(f"osd command failed: {detail}")
    return json.loads(completed.stdout)


# Transient failures worth retrying on the SAME OSD session: the model upstream
# (apevon) returns 5xx/overload, or the gateway is momentarily unreachable. These
# are recoverable — a bounded backoff plus a continuation nudge lets the agent
# resume its existing conversation and live sandbox instead of losing all progress.
_TRANSIENT_OSD_ERROR_MARKERS = (
    # OSD's own verdict, when it offers one, is more reliable than guessing.
    '"isretryable":true',
    "upstream_error", "upstream request failed", "cannot reach the gateway",
    "error sending request", "connection refused", "connection reset",
    # apevon closes the socket mid-turn on long E2E runs; the wording shares no
    # keyword with the gateway errors above, so it needs its own markers.
    "cannot connect to api", "socket connection was closed", "socket hang up",
    "connection closed", "peer closed connection", "incomplete chunked read",
    "temporarily unavailable", "service unavailable", "overloaded",
    "too many requests", "rate limit", " 429", " 500", " 502", " 503", " 504",
)

_RESUME_NUDGE = (
    "The previous turn was interrupted by a transient upstream/gateway error, not "
    "by anything you did. Continue exactly where you left off, reusing the work "
    "already in this session and the files/variables already in your sandbox. Do "
    "not restart steps that already completed; if unsure of the current state, "
    "inspect the sandbox first, then proceed."
)


def _is_transient_osd_error(message: str) -> bool:
    low = message.lower()
    return any(marker in low for marker in _TRANSIENT_OSD_ERROR_MARKERS)


def _is_osd_cli_wait_expired(message: str) -> bool:
    """Return true when the CLI stopped waiting but the turn is still running."""
    low = message.lower()
    return "still running after" in low and "it keeps going" in low


def _session_messages(payload: Any) -> list[dict[str, Any]] | None:
    """Normalize the message array returned by ``session show --json``."""
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("messages", "items"):
            value = payload.get(key)
            if isinstance(value, list):
                return value
    return None


def _session_turn_completed(payload: Any) -> bool:
    """Check completion metadata without accepting a partial assistant message."""
    messages = _session_messages(payload)
    if messages is None:
        return False
    for message in reversed(messages):
        info = message.get("info", {})
        if info.get("role") != "assistant":
            continue
        timing = info.get("time") or {}
        status = str(info.get("status") or "").lower()
        return bool(
            timing.get("completed")
            or info.get("finish")
            or status in {"completed", "success", "done", "error", "failed"}
        )
    return False


async def _wait_for_existing_osd_turn(
    session_id: str, deadline: float, sample_id: str,
) -> list[dict[str, Any]]:
    """Poll the same turn after OSD CLI's fixed one-hour wait expires.

    This never sends another prompt. The per-sample MCP bridge therefore remains
    alive while the original agent turn continues using its existing tool state.
    """
    poll_interval = max(
        1.0, float(os.environ.get("ASTABENCH_OSD_STATUS_POLL_INTERVAL", "15"))
    )
    print(
        f"[osd-wait] sample {sample_id}: CLI wait window expired; the original "
        "turn is still running, polling the same session without resending",
        file=sys.stderr,
    )
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError(
                f"OSD turn for sample {sample_id} exceeded the configured turn timeout"
            )
        await asyncio.sleep(min(poll_interval, remaining))
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            continue
        try:
            payload = await asyncio.to_thread(
                _run_osd,
                ["session", "show", session_id],
                max(1, min(30, int(remaining))),
            )
        except (RuntimeError, subprocess.TimeoutExpired) as error:
            if isinstance(error, RuntimeError) and not (
                _is_transient_osd_error(str(error))
                or _is_osd_cli_wait_expired(str(error))
            ):
                raise
            continue
        if not _session_turn_completed(payload):
            continue
        messages = _session_messages(payload)
        if messages is None:
            raise RuntimeError("OSD session show returned no message array")
        return messages


async def _send_osd_turn(
    session_id: str,
    first_send_args: list[str],
    model: str | None,
    turn_timeout: int,
    sample_id: str,
) -> Any:
    """Send one OSD turn, retrying transient upstream/gateway failures in place.

    Retries re-send to the SAME session so the agent's conversation and its live
    sandbox (python_session state) are preserved — the first turn carries the full
    task prompt, later turns carry only a continuation nudge. Non-transient errors
    and exhausted retries propagate unchanged.
    """
    retries = max(0, int(os.environ.get("ASTABENCH_OSD_TURN_RETRIES", "3")))
    backoffs = (15, 45, 90, 120)
    resume_args = ["session", "send", session_id, _RESUME_NUDGE, "--wait"]
    if model:
        resume_args.extend(["--model", model])
    attempt = 0
    deadline = time.monotonic() + turn_timeout
    while True:
        args = first_send_args if attempt == 0 else resume_args
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError(
                    f"OSD turn for sample {sample_id} exceeded the configured turn timeout"
                )
            return await asyncio.to_thread(_run_osd, args, max(1, int(remaining)))
        except RuntimeError as error:
            if _is_osd_cli_wait_expired(str(error)):
                return await _wait_for_existing_osd_turn(
                    session_id, deadline, sample_id
                )
            if attempt >= retries or not _is_transient_osd_error(str(error)):
                raise
            delay = backoffs[min(attempt, len(backoffs) - 1)]
            print(
                f"[osd-resume] sample {sample_id}: transient OSD failure "
                f"(attempt {attempt + 1}/{retries}); waiting {delay}s then resuming the "
                f"same session. Detail: {str(error)[:200]}",
                file=sys.stderr,
            )
            await asyncio.sleep(delay)
            attempt += 1


async def _new_project_when_ready(name: str, timeout: int = 90) -> Any:
    """Register a project (retrying until the OSD runtime is up). Returns its JSON.

    A per-sample project is the isolation unit: `osd project new` creates a directory
    under OSD's projects area, and a session opened with `--project <name>` uses that
    directory's .opencode/opencode.json. (`--directory` rejects unregistered paths.)
    """
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            return await asyncio.to_thread(_run_osd, ["project", "new", name], 15)
        except RuntimeError as error:
            last_error = error
            await asyncio.sleep(0.25)
    raise RuntimeError(f"OSD agent runtime did not become ready: {last_error}")


async def _new_session_in_project(name: str, timeout: int | None = None) -> Any:
    """Open a session in the per-sample project.

    The session connects to the project's astabench MCP. For sandboxed tasks (E2E) that
    MCP's tools (python_session) depend on the Docker sandbox being ready, so session
    creation blocks much longer than a lightweight task's — a fixed 15s is too tight and
    fails the sample before the sandbox/MCP finish warming up. Use a generous, env-tunable
    timeout (OSD_SESSION_NEW_TIMEOUT) so creation waits instead of failing. The lightweight
    path (no sandbox) still returns in a few seconds, so the larger ceiling is harmless.
    """
    if timeout is None:
        timeout = int(os.environ.get("OSD_SESSION_NEW_TIMEOUT", "240"))
    # Session creation is as vulnerable to a transient gateway blip as sending a turn
    # is, and a failure here wastes the whole sample before any work starts (the
    # gateway itself is often still healthy — the request just did not land). Retry
    # transient failures with backoff instead of failing the sample.
    retries = max(0, int(os.environ.get("ASTABENCH_OSD_SESSION_RETRIES", "3")))
    backoffs = (5, 15, 30, 45)
    attempt = 0
    while True:
        try:
            return await asyncio.to_thread(
                _run_osd, ["session", "new", "--project", name, "--title", name], timeout
            )
        except RuntimeError as error:
            if attempt >= retries or not _is_transient_osd_error(str(error)):
                raise
            delay = backoffs[min(attempt, len(backoffs) - 1)]
            print(
                f"[osd-resume] session creation hit a transient failure "
                f"(attempt {attempt + 1}/{retries}); retrying in {delay}s. "
                f"Detail: {str(error)[:200]}",
                file=sys.stderr,
            )
            await asyncio.sleep(delay)
            attempt += 1


def _write_project_mcp(sample_dir: Path, bridge_url: str) -> None:
    """Point this sample's project at its OWN tool bridge via per-directory config.

    OpenCode honors a directory's .opencode/opencode.json mcp section and isolates it
    per directory within one sidecar, so concurrent sessions (each in its own project
    dir) reach their own tools with no shared registration to clobber. The config must
    exist before the session's first use — OpenCode caches directory config on load.
    """
    config_dir = sample_dir / ".opencode"
    config_dir.mkdir(parents=True, exist_ok=True)
    (config_dir / "opencode.json").write_text(
        json.dumps({
            "$schema": "https://opencode.ai/config.json",
            "mcp": {
                "astabench": {"type": "remote", "url": bridge_url, "enabled": True},
            },
        }, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _gateway_request(path: str, method: str = "GET", timeout: int = 15) -> Any:
    gateway = os.environ.get("OSD_GATEWAY", "").rstrip("/")
    token = os.environ.get("OSD_TOKEN", "")
    if not gateway or not token:
        raise RuntimeError("OSD_GATEWAY/OSD_TOKEN are not set")
    data = b"{}" if method != "GET" else None
    request = urllib.request.Request(
        gateway + path,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read()
        return json.loads(body) if body else None


async def _connect_astabench_mcp(timeout: int = 90) -> None:
    """Ensure the long-lived OSD gateway has its one MCP connection.

    The hub itself changes upstreams for every Inspect sample. Reconnecting an
    already-connected OSD client is both unnecessary and, in practice, can
    interrupt its in-flight tool-schema refresh.
    """
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            status = await asyncio.to_thread(_gateway_request, "/mcp", "GET", 10)
            if status.get("astabench", {}).get("status") == "connected":
                return
            detail = status.get("astabench", {}).get("error")
            if detail:
                last_error = RuntimeError(detail)
        except Exception as error:
            last_error = error
        try:
            # Make one bounded recovery attempt only after confirming that the
            # connection is absent. Do not repeatedly POST while OSD is still
            # processing the previous request.
            await asyncio.to_thread(_gateway_request, "/mcp/astabench/connect", "POST", 30)
        except Exception as error:
            last_error = error
        await asyncio.sleep(0.75)
    raise RuntimeError(f"AstaBench tools did not connect to OSD: {last_error}")


def _messages_prompt(
    state: TaskState, policy: str, profile: dict[str, Any],
    capability_instructions: str, sample_dir: Path, product_skills: str = "",
) -> str:
    history: list[str] = []
    for message in state.messages:
        text = getattr(message, "text", "")
        if text:
            history.append(f"[{message.role.upper()}]\n{text}")
    output_contract = ""
    artifact_instruction = f"Store any task artifacts under `{sample_dir}`."
    if profile.get("output_contract") == "e2e_discovery":
        artifact_instruction = (
            "Do all computation through the official `python_session` tool. The sandbox is the "
            "authoritative execution environment; do not claim a result that was not produced there. "
            "Run one bounded stage per call. If a Python call times out or the MCP client stops "
            "waiting, call `python_execution_status`; while work is running never submit another "
            "Python cell. If status is `needs_continue`, call `python_continue_wait` until the "
            "cell finishes, or `python_interrupt` only when abandoning that stage. If a cell stays "
            "wedged after `python_interrupt` (common for CPU-bound native training that ignores "
            "the interrupt signal), call `python_restart` to kill and respawn the kernel, then "
            "reload datasets, weights, and checkpoints from disk. Checkpoint to disk frequently so "
            "a restart never loses real progress."
        )
        output_contract = """
## Mandatory E2E Discovery output contract

Your final response must contain ONLY one valid JSON object, with no Markdown fence and no text
before or after it. Use exactly this top-level shape:
{
  "results": {
    "report": "A self-contained scientific report with methods, numeric results, limitations, and conclusions.",
    "code": [{"filename": "analysis.py", "code": "complete reproducible source code"}],
    "artifacts": [{"filename": "results.json", "format": "json", "artifact": "serialized evidence"}]
  }
}
The report, code, and artifacts must agree. Include the substantive code that produced every reported
number and compact machine-readable outputs that verify it. Never fabricate missing experimental
results. If a computation fails, report the failure and the strongest result actually supported by
the tool output.
"""
    if os.environ.get("ASTABENCH_SUPERVISION_ONLY") == "1":
        # Only the transport/output contract is added to OSD's unchanged policy.
        # These controls preserve the official stateful tool; they are not an
        # experiment plan, model choice, sample-size rule, or scoring heuristic.
        return f"""{policy}

## Official evaluation interface
Use only the tools exposed by this sample's astabench MCP server. Execute in the
official sandbox. The current sample is the only task. Return your own results;
the adapter will not reconstruct missing experiments or replace your answer.
Tool recovery: python_execution_status reports pending Python execution;
python_continue_wait waits for it. Do not submit new code while it is pending.
python_interrupt abandons a cell; python_restart resets the kernel and loses
in-memory state. These controls are adapter-provided compatibility tools.
{output_contract}

## Benchmark conversation
{chr(10).join(history)}
"""
    return f"""{policy}

## Active benchmark profile

{profile.get("instructions", "")}

## Loaded capability skills

{capability_instructions}

## Product skills

{product_skills}

## AstaBench evaluation mode

You are being evaluated on one isolated benchmark sample. Complete the task below autonomously.
Use only the tools exposed by the `astabench` MCP server. Those are the official tools attached
to this sample and may enforce a historical cutoff. Never bypass those restrictions or request
interactive approval. If a submit tool is available, call it exactly once with the complete final
answer. Otherwise, put only the complete answer in your final response.
{artifact_instruction}

{output_contract}

## Benchmark conversation

{chr(10).join(history)}
"""


def _json_object_from_text(text: str) -> dict[str, Any] | None:
    """Parse a JSON object from a plain or fenced model response."""
    candidate = (text or "").strip()
    if candidate.startswith("```"):
        candidate = re.sub(r"^```(?:json)?\s*", "", candidate, flags=re.IGNORECASE)
        candidate = re.sub(r"\s*```$", "", candidate)
    try:
        value = json.loads(candidate)
        return value if isinstance(value, dict) else None
    except (TypeError, json.JSONDecodeError):
        pass

    decoder = json.JSONDecoder()
    for match in re.finditer(r"\{", candidate):
        try:
            value, _ = decoder.raw_decode(candidate[match.start():])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    return None


def _normalise_e2e_completion(
    completion: str, evidence: list[dict[str, str]],
) -> tuple[str, bool]:
    """Return scorer-safe E2E JSON while preserving only executed evidence."""
    parsed = _json_object_from_text(completion)
    repaired = parsed is None or not isinstance(parsed.get("results"), dict)
    results = parsed.get("results", {}) if not repaired else {}

    report = results.get("report")
    if not isinstance(report, str) or not report.strip():
        report = completion.strip() or "No scientific report was returned by the agent."
        repaired = True

    code = results.get("code")
    if not isinstance(code, list):
        code = []
        repaired = True
    valid_code = [
        {
            "filename": str(item["filename"]),
            "code": _redact_sensitive_text(str(item["code"]))[:MAX_E2E_CODE_CHARACTERS],
        }
        for item in code
        if isinstance(item, dict) and "filename" in item and "code" in item
    ]
    if len(valid_code) != len(code):
        repaired = True

    artifacts = results.get("artifacts")
    if not isinstance(artifacts, list):
        artifacts = []
        repaired = True
    valid_artifacts = [
        {
            "filename": str(item["filename"]),
            "format": str(item["format"]),
            "artifact": _redact_sensitive_text(str(item["artifact"]))[:MAX_E2E_ARTIFACT_CHARACTERS],
        }
        for item in artifacts
        if isinstance(item, dict)
        and all(key in item for key in ("filename", "format", "artifact"))
    ]
    if len(valid_artifacts) != len(artifacts):
        repaired = True

    bounded_evidence = evidence
    if len(evidence) > MAX_E2E_EVIDENCE_ITEMS:
        bounded_evidence = evidence[:2] + evidence[-(MAX_E2E_EVIDENCE_ITEMS - 2):]

    if bounded_evidence and not valid_code:
        valid_code = [
            {"filename": item["filename"], "code": item["code"]}
            for item in bounded_evidence
        ]
        repaired = True
    if bounded_evidence and not valid_artifacts:
        valid_artifacts = [
            {
                "filename": item["artifact_filename"],
                "format": "txt",
                "artifact": item["artifact"],
            }
            for item in bounded_evidence
            if item["artifact"].strip()
        ]
        repaired = True

    canonical = {
        "results": {
            "report": _redact_sensitive_text(report),
            "code": valid_code,
            "artifacts": valid_artifacts,
        }
    }
    return json.dumps(canonical, ensure_ascii=False), repaired


def _assistant_result(messages: Any) -> tuple[str, dict[str, int], float | None]:
    if not isinstance(messages, list):
        raise RuntimeError("Unexpected OSD response: expected a message array")
    for message in reversed(messages):
        info = message.get("info", {})
        if info.get("role") != "assistant":
            continue
        text = "\n".join(
            part.get("text", "")
            for part in message.get("parts", [])
            if part.get("type") == "text" and part.get("text")
        ).strip()
        tokens = info.get("tokens") or {}
        return text, tokens, info.get("cost")
    raise RuntimeError("OSD returned no assistant message")


@asynccontextmanager
async def _bridge_for(tools: list[Any]):
    bridge = InspectToolBridge(tools)
    await bridge.start()
    try:
        yield bridge
    finally:
        await bridge.stop()


@solver
def osd_agent(timeout: int = 900, workspace: str | None = None) -> Solver:
    """Run a benchmark sample through a real, isolated OSD session."""

    policy = load_open_science_policy()
    profile, capability_instructions = load_benchmark_profile()
    product_skills = load_product_skills()
    workspace_root = Path(workspace) if workspace else Path(
        os.environ.get("OSD_BENCH_WORKSPACE", DEFAULT_WORKSPACE)
    )
    turn_timeout = min(
        timeout,
        max(60, int(os.environ.get("ASTABENCH_OSD_TURN_TIMEOUT", "6900"))),
    )

    async def solve(state: TaskState, generate: Generate) -> TaskState:
        sample_dir = (
            workspace_root / "projects"
            / f"sample-{_safe_sample_name(state.sample_id)}-{state.epoch}"
        )
        sample_dir.mkdir(parents=True, exist_ok=True)
        _write_live_progress(state.sample_id)
        started = time.monotonic()
        bridge_name = f"astabench-{_safe_sample_name(state.sample_id)}-{state.epoch}"

        async with _bridge_for(state.tools) as bridge:
            # Isolate this sample in its own OSD project whose .opencode/opencode.json
            # points at THIS sample's bridge. Write the config before the first session
            # (OpenCode caches dir config on load). No shared registration / global
            # connect → safe under --max-samples N.
            project_name = (
                f"bench-{_safe_sample_name(state.sample_id)}-{state.epoch}-{bridge.port}"
            )
            project = await _new_project_when_ready(project_name)
            _write_project_mcp(Path(project["path"]), bridge.url)
            session = await _new_session_in_project(project_name)
            session_id = session["id"]
            model = os.environ.get("OSD_MODEL_FULL") or "/".join(
                filter(None, (os.environ.get("OSD_PROVIDER"), os.environ.get("OSD_MODEL")))
            )
            send_args = [
                "session",
                "send",
                session_id,
                _messages_prompt(state, policy, profile, capability_instructions, sample_dir, product_skills),
                "--wait",
            ]
            if model:
                send_args.extend(["--model", model])
            messages = await _send_osd_turn(
                session_id, send_args, model, turn_timeout, str(state.sample_id)
            )
            assistant, tokens, cost = _assistant_result(messages)

        completion = bridge.submission or assistant
        raw_completion = _redact_sensitive_text(completion)
        output_repaired = False
        if (profile.get("output_contract") == "e2e_discovery"
                and os.environ.get("ASTABENCH_SUPERVISION_ONLY") != "1"):
            completion, output_repaired = _normalise_e2e_completion(completion, bridge.evidence)
        state.output.completion = completion
        state.output.model = model or "osd/default"
        state.output.time = time.monotonic() - started
        state.output.metadata = {
            "osd_session_id": session_id,
            "osd_cost": cost,
            "osd_workspace": str(sample_dir),
            "submission_via_tool": bridge.submission is not None,
            "output_contract": profile.get("output_contract"),
            "output_repaired": output_repaired,
            "osd_raw_completion": raw_completion,
            "captured_python_calls": len(bridge.evidence),
            "osd_turn_timeout_seconds": turn_timeout,
        }

        input_tokens = int(tokens.get("input", 0) or 0)
        output_tokens = int(tokens.get("output", 0) or 0)
        cache_read = int((tokens.get("cache") or {}).get("read", 0) or 0)
        reasoning = int(tokens.get("reasoning", 0) or 0)
        usage = ModelUsage(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=input_tokens + output_tokens,
            input_tokens_cache_read=cache_read or None,
            reasoning_tokens=reasoning or None,
        )
        state.output.usage = usage
        record_model_usage_with_inspect(state.output.model, usage, normalize_name=False, allow_invalid=True)
        _write_live_progress(state.sample_id, state="completed")
        return state

    return solve
