# AutoSDLC Web Console and Human Approval

The local Web console turns the runnable CLI workflow into an operator-facing
control surface. It is intentionally bound to one project and one project
profile when the server starts.

## Start the console

```bash
npm run web -- \
  --project "$PWD" \
  --profile examples/mvp/project.json \
  --port 4177
```

Open `http://127.0.0.1:4177`.

The default loopback binding is deliberate. This phase does not provide login,
SSO, or multi-tenant authorization and must not be exposed as a shared network
service.

## Operator flow

1. Create a run with a title, problem statement, acceptance criteria, and
   optional non-goals.
2. Wait for the read-only planning stage to reach `AWAITING_PLAN_APPROVAL`.
3. Inspect the plan summary, steps, expected file scope, verification, and risks.
4. Record an approval or rejection with an operator identity and note.
5. An approved plan moves to `PLAN_APPROVED`; implementation remains a separate
   explicit action.
6. Follow deterministic checks and independent review in the evidence panel.
7. When the run reaches `READY_FOR_PR`, explicitly create a Draft pull request.

## Approval evidence

Approval is stored in `approval.json` and in the run event stream. The record
binds:

- the decision and operator identity;
- the decision timestamp and note;
- the exact plan hash;
- the snapshotted profile hash;
- the base commit SHA.

Changing any bound input invalidates the approval and prevents implementation.
A rejected plan is terminal for that run; create a new run for a revised plan.
The approval artifact is created once with an atomic filesystem operation, so
concurrent approval and rejection attempts cannot overwrite the first decision.

Runs created by the earlier CLI-only MVP remain readable. When such a run has a
durable `plan.approved` event, its approval is migrated on first continuation and
bound to the original plan, profile snapshot, and base commit.

The operator identity is an audit label supplied by the user, not an
authenticated identity. Strong identity, RBAC, SSO, and remote access belong to
the next security phase.

## API surface

| Method | Route                    | Purpose                            |
| ------ | ------------------------ | ---------------------------------- |
| `GET`  | `/api/meta`              | Show the bound project and profile |
| `GET`  | `/api/runs`              | List project runs                  |
| `POST` | `/api/runs`              | Start planning a task              |
| `GET`  | `/api/runs/:id`          | Read the run and audit timeline    |
| `POST` | `/api/runs/:id/approval` | Approve or reject a plan           |
| `POST` | `/api/runs/:id/continue` | Start or retry implementation      |
| `POST` | `/api/runs/:id/publish`  | Publish an approved Draft PR       |

Long-running implementation and publication requests return `202` while the
console polls the durable run record. Duplicate actions for the same run are
rejected within the server process. If a background action fails before its
workflow stage can persist the error, the server records a durable
`*.background_failed` event. After a console restart, interrupted implementation,
verification, and review stages expose an explicit recovery action.

The API intentionally omits worktree paths and command stdout/stderr from the
browser response. Full evidence remains in the local run state directory.

## Current boundary

This phase provides a real local control surface and durable human plan
approval. It does not yet provide distributed workers, durable cross-process
job leasing, notifications, organization policy, automatic merge, or
deployment approval.
