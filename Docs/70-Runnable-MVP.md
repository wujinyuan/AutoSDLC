# Runnable AutoSDLC MVP

The MVP provides one evidence-backed path through the software delivery lifecycle:

```text
task.json
  -> read-only planning agent
  -> explicit plan approval
  -> isolated Git branch and worktree
  -> implementation agent
  -> deterministic project checks
  -> independent read-only review agent
  -> optional commit, push, and Draft pull request
```

It deliberately does not auto-merge or deploy. Git is the source of truth for code,
configured commands are the source of truth for verification, and the run state
directory contains the workflow record and evidence.

The task, project profile, and base commit are snapshotted at run creation. Later
changes to the profile cannot weaken checks or broaden writable paths for an
existing run.

The implementation stage must leave Git-ignored files unchanged and must not
create commits. This prevents local-only inputs or hidden branch history from
affecting verification without appearing in the reviewed pull request.

Plan approval also binds the plan's `expectedFiles`. A new or renamed file outside
that set requires a new plan. The verified Git tree is recorded before review and
must still match at publication time and after commit hooks run. A contradictory
review containing blocking findings cannot pass only because its verdict says
`pass`.

## Prerequisites

- Node.js 20+
- Git
- An authenticated `codex` CLI
- An authenticated `gh` CLI only when using `publish`

## Run it

Build the CLI:

```bash
npm ci
npm run build
```

Start a task. The project must be a clean Git repository and the profile's base
branch must exist locally.

```bash
node dist/src/mvp/cli.js start \
  --project "$PWD" \
  --profile examples/mvp/project.json \
  --task examples/mvp/task.example.json
```

The command creates an isolated `autosdlc/<run-id>` branch and worktree, writes a
structured plan, and stops at `AWAITING_PLAN_APPROVAL`. By default, run evidence
is kept outside the target repository under
`~/.autosdlc/projects/<project-key>/runs/<run-id>`. The CLI prints the exact path.
Inspect:

```text
<state-dir>/runs/<run-id>/task.md
<state-dir>/runs/<run-id>/profile.snapshot.json
<state-dir>/runs/<run-id>/plan.json
<state-dir>/runs/<run-id>/run.json
<state-dir>/runs/<run-id>/events.jsonl
```

Approve the plan and continue:

```bash
node dist/src/mvp/cli.js continue \
  --project "$PWD" \
  --profile examples/mvp/project.json \
  --run <run-id> \
  --approve-plan
```

The run stops at `VERIFICATION_FAILED`, `REVIEW_FAILED`, or `FAILED` when evidence
is not acceptable or execution is interrupted. If the run has a valid plan and its
worktree still exists, running `continue` again asks the implementation agent to
repair or resume the same worktree using the recorded failure evidence.

When the status is `READY_FOR_PR`, create a commit, push the run branch, and open a
Draft pull request:

```bash
node dist/src/mvp/cli.js publish \
  --project "$PWD" \
  --profile examples/mvp/project.json \
  --run <run-id>
```

## Project profile

The profile controls the base branch, writable path scope, setup commands,
deterministic checks, agent executable, and Git remote. Commands are executable-and-argument arrays;
they are not passed through a shell.

`allowedPaths` is mandatory. Any changed path outside it, or inside
`blockedPaths`, fails the run before verification or publication.
At least one deterministic check is mandatory, and checks must not modify the
reviewed Git tree. Changes to ignored files are rejected unless the path is
explicitly declared in `verificationOutputPaths`, for example `dist/**` for a
TypeScript build. An undeclared mutating check invalidates verification even if
it exits zero.

## Evidence boundary

A successful build does not by itself approve a task. `READY_FOR_PR` requires:

1. a reviewed plan;
2. a real repository diff within the configured scope;
3. every configured verification command returning exit code zero;
4. a separate read-only review invocation returning `pass`.

Final merge and product acceptance remain human decisions.
