---
name: remote-compute
description: Use when the user asks to run, submit, monitor, or cancel a job on a remote machine over SSH — their own GPU/CPU server, a workstation, or a Slurm cluster ("the cluster", a login node, "my 3090 box", "the compute server"). Picks a saved machine, runs the work directly over SSH (or via Slurm when present), tracks it, and fetches results back into the workspace.
---

# Remote compute over SSH

Run heavy work on the user's own machines over SSH with their own keys or their
own interactive sign-in — you never install anything remote and never handle
credentials yourself. A machine may be a plain server (CPU or GPU, no scheduler)
or a Slurm cluster.

## 0 · Always run ssh through the app's config

Every `ssh`, `scp` and `rsync` below passes `-F "$OPENSCIENCE_SSH_CONFIG"`. Write
it as `$SSHCFG` after defining it once per command you send:

```bash
SSHCFG="${OPENSCIENCE_SSH_CONFIG:+-F $OPENSCIENCE_SSH_CONFIG}"
```

That config makes your connection reuse the one the app already authenticated,
which is what lets clusters with two-factor authentication work at all: the user
signs in once, and every command after that needs no password or code. Without
it, such a host refuses every command you send.

### When a host asks for credentials

Many institutional clusters require a password or a one-time code on EVERY new
connection. If a command fails with a permission or authentication error
(`Permission denied`, `no supported authentication methods`), do NOT retry, and
do not report the failure yet: call the **`ssh_connect`** tool with that host.
It asks the desktop UI to prompt the user, and returns once the shared
connection is up — then retry your command unchanged.

Two errors that sign-in cannot fix, so do not call the tool for them: a host-key
error (`Host key verification failed` — the user must verify the fingerprint in
their own terminal once) and a network error (unreachable, timed out, unknown
host).

## 1 · Pick the machine

1. `cat .openscience/compute.json` in the workspace (the app keeps this file in
   sync from the user's settings — read it directly; the directory is hidden).
   It looks like:
   `{"machines":[{"host":"home-3090","label":"8x3090",
     "caps":{"cores":16,"mem_total_bytes":...,"gpus":["RTX 3090",...],"slurm":null}}]}`
   The directory is hidden — read the file directly.
2. If the file is missing or has no machines, ask the user to add one in
   **Settings → Remote compute**, or give you a `user@host`. Do not guess.
3. Choose by the task's needs and each machine's `caps`: a GPU job → a machine
   whose `caps.gpus` is non-empty; a CPU job → any reachable machine. If several
   fit, or none clearly does, ask the user which to use.
4. Confirm it's reachable and check live headroom before launching:
   `ssh $SSHCFG -o BatchMode=yes -o ConnectTimeout=8 <host> "nproc; free -h; nvidia-smi 2>/dev/null | head -15"`.
   On "Permission denied", the host wants credentials interactively: call the
   `ssh_connect` tool for it (see §0), then retry. Never send a password
   yourself and never disable host-key checking.

If the chosen machine's `caps.slurm` is set, use **§2-Slurm**. Otherwise use
**§2-Direct**.

## 2-Direct · Run on a plain server (no Slurm)

Long jobs must outlive the SSH connection. Use a per-job dir + a fully detached
process, mirroring how the app tracks runs.

1. Pick a job name and build the remote dir path (remember the literal string —
   shell variables do not survive between separate ssh calls):
   `REMOTE=openscience/jobs/<name>-<YYYYmmdd-HHMMSS>`
2. Create it and copy inputs (confirm with the user before copying > ~100 MB):
   ```bash
   ssh $SSHCFG -o BatchMode=yes <host> "mkdir -p <remote-dir>"
   scp $SSHCFG -o BatchMode=yes run.sh <input files> <host>:<remote-dir>/
   ```
   Write `run.sh` in the workspace first (so it is versioned in provenance);
   it should `cd` into the job dir and run the actual commands, e.g. use
   `CUDA_VISIBLE_DEVICES` to select GPUs. On a plain box the software
   environment is ambient (whatever is installed) — not declared anywhere — so
   pin it at run time by having `run.sh` write a manifest as its first step (it
   is fetched and recorded in §3–4). Keep it fail-safe so provenance never
   aborts the job:
   ```bash
   { python3 -V; echo "PLATFORM=$(uname -s)-$(uname -m)"; \
     echo '--- pip freeze ---'; python3 -m pip freeze; } > env.txt 2>&1 || true
   ```
3. Launch fully detached and capture the PID:
   ```bash
   ssh $SSHCFG -o BatchMode=yes <host> "cd <remote-dir> && \
     setsid bash -c 'bash run.sh >log 2>&1; echo \$? > exit_code' </dev/null >/dev/null 2>&1 & \
     echo \$! > pid; cat pid"
   ```
   Report the PID and the remote dir to the user.
4. **Track:**
   - Running? `ssh $SSHCFG <host> "kill -0 \$(cat <remote-dir>/pid) 2>/dev/null && echo RUNNING || echo DONE"`.
   - Progress: `ssh $SSHCFG <host> "tail -n 30 <remote-dir>/log"`; GPU use:
     `ssh $SSHCFG <host> "nvidia-smi"`.
   - Finished: `ssh $SSHCFG <host> "cat <remote-dir>/exit_code"` — `0` = success, other
     = failure. Do not assume success from an empty queue. When a run finishes
     you MUST complete §3 (fetch) **and** §4 (record) — every time, including a
     quick re-run or re-fetch. A run you don't record is invisible in Runs
     (neither the global view nor the session), so it may as well not exist.
   - Long jobs: report the PID + running state and stop; the user can ask you to
     check again later. Do not poll in a loop for more than ~2 minutes.
5. **Cancel** (only jobs you launched, or a PID/dir the user names): kill the
   whole process group so children die too:
   `ssh $SSHCFG <host> "kill -- -\$(cat <remote-dir>/pid) 2>/dev/null || kill \$(cat <remote-dir>/pid)"`.

## 2-Slurm · Run on a Slurm cluster

Use this only when `caps.slurm` is set.

1. Write `slurm/<job-name>.sbatch` in the workspace:
   ```bash
   #!/bin/bash
   #SBATCH --job-name=<job-name>
   #SBATCH --output=slurm-%j.out
   #SBATCH --error=slurm-%j.err
   #SBATCH --time=01:00:00

   set -euo pipefail
   cd "$SLURM_SUBMIT_DIR"
   <the actual commands>
   ```
   Only add `--partition/--gres/--mem/--cpus-per-task` when the user asks or the
   cluster rejects the default. Load modules (`module load …`) the user names.
2. Submit:
   ```bash
   REMOTE=openscience/jobs/<job-name>-$(date +%Y%m%d-%H%M%S)
   ssh $SSHCFG -o BatchMode=yes <host> "mkdir -p $REMOTE"
   scp $SSHCFG -o BatchMode=yes slurm/<job-name>.sbatch <input files> <host>:$REMOTE/
   ssh $SSHCFG -o BatchMode=yes <host> "cd $REMOTE && sbatch <job-name>.sbatch"
   ```
   Parse `Submitted batch job <id>`; remember the literal remote dir.
3. Track: `ssh $SSHCFG <host> "squeue -j <id> -h -o '%T %M'"`; when it returns nothing,
   `ssh $SSHCFG <host> "sacct -j <id> --format=State,Elapsed,ExitCode -n"` or read
   `slurm-<id>.out`. Cancel: `ssh $SSHCFG <host> "scancel <id>"`.

## 3 · Fetch results back

Copy **every** file the job produced into the workspace so they become
traceable artifacts — not just a summary. That means `log`, `env.txt`, and each
result/data/figure file the run wrote (e.g. `result.json` **and**
`trajectory.npz`, checkpoints, plots). Each finished run MUST use a fresh,
immutable local result directory; never fetch a rerun into a directory that was
already recorded. A fetched artifact is the only thing that survives; anything
left on the box is not provenance.
```bash
RESULT=results/<job-name>/<YYYYmmdd-HHMMSS>-<pid-or-job-id>
mkdir -p "$RESULT"
scp $SSHCFG -o BatchMode=yes "<host>:<remote-dir>/log" "<host>:<remote-dir>/env.txt" \
    "<host>:<remote-dir>/<each output file>" "$RESULT"/
```
`<remote-dir>` is the literal directory you created — name each file explicitly.
List the job dir first (`ssh $SSHCFG <host> "ls -la <remote-dir>"`) so you fetch them all.
If you want a convenience "latest" copy, create it only after recording; the
recorded `--output` paths must stay in the immutable run directory.

## 4 · Record the run (reproducibility) — REQUIRED, every time

Recording is not an optional finishing flourish: the app can't see the remote
machine, so this call is the ONLY thing that makes the run exist in Runs. Do it
after **every** finished run — first runs, quick re-runs, and recovered fetches
alike, always using a fresh `RESULT` directory. Skipping it (a common mistake on
a casual "just run it again") loses the run entirely. Record it **completely** —
the helper pins whatever you pass:

- `--code` once per script that actually ran — the entry script **and** every
  helper it calls (e.g. `run.sh` **and** `humanoid_sim.py`), not just the wrapper.
- `--output` once per file you fetched in §3 — every result/data/figure, not
  just the summary json. These paths must be under that run's fresh `RESULT`
  directory; the helper refuses to record output paths used by earlier runs.
- `--env-file` the fetched `env.txt`, so the ambient interpreter + package
  versions are pinned (this is what makes an SSH run reproducible).
- `--hardware` = what the job **used**, not what the box has. A CPU-only job on
  a GPU box is `"24 CPU cores, 62 GB (CPU-only)"`, not `"2× RTX 3090"`.
- `--session-id` from the workspace marker, so the run attaches to this session
  (not just the global Runs view). Pass it verbatim as shown; it's empty-safe.

```bash
python "$XDG_CONFIG_HOME/opencode/skills/remote-compute/record_run.py" \
  --surface ssh --command "bash run.sh" --status <ok|failed> --host <host> \
  --hardware "<hardware the job used>" \
  --code run.sh --code <each other script> \
  --output "$RESULT"/<each output file> \
  --env-file "$RESULT"/env.txt \
  --session-id "$(cat .openscience/session.txt 2>/dev/null)"
```

The helper warns if a recorded file is missing or if code/outputs are empty —
fix those rather than ignoring them. For a Slurm run use `--surface hpc`,
`--command "sbatch <name>.sbatch"`, `--job-id <id>`, and the `sacct`
hardware/state; the environment there is pinned by the sbatch `module load`
lines in the versioned script, so `--env-file` is not needed. Use
`--status failed` on a non-success exit code / `sacct` state.

Summarize: the machine, the final state (quote the `exit_code`/`sacct` state —
do not assume success), elapsed time, and the fetched files. If it failed, show
the tail of `log` (or `slurm-<id>.err`) and propose a fix instead of silently
rerunning.
