# Intent: stop mesh turns after a timeout

## Raw Request
Improve the auto-workflow and investigate independent reviews that time out.

## Problem
A mesh session timeout aborts a controller and reports failure, but the signal does not reach the agent turn. The reply fence prevents a late reply while the turn can continue calling a provider or starting tools after the requester has been told the attempt failed.

## Desired Outcome
A timed-out mesh request cannot start another provider call or tool after the abort is observed. The agent receives the same abort signal as the mesh session, and a request aborted during the pre-turn conversation check does not start a turn.

## Scope
The mesh session handler, the channel adapter and their integration with the existing cooperative AgentSession cancellation contract. Tests use isolated stores and a synthetic provider.

## Non-Goals
Determining why a turn exceeds its deadline, changing timeout duration or retries, cancelling an already-started arbitrary external operation, retroactively stopping existing sessions, modifying live services, or guaranteeing that a remote side effect can be rolled back.

## Constraints
Preserve reply fencing and non-mesh channel behavior. Never claim an in-flight tool was cancelled if it does not honor the signal. Keep the existing failure-notification path.

## Success Criteria
- Aborting the mesh signal is visible inside the agent turn and its provider query.
- A delayed provider response containing a write tool after the abort does not create the target file or start another provider call.
- An abort during the conversation check does not start the turn, and a late answer cannot replace the failure reply.
- A normal non-aborted mesh request still runs and replies once.

## Risks
Already-started tools or remote effects may complete after cancellation. The change prevents subsequent tool/provider starts via the existing cooperative turn loop; it is not rollback or hard process isolation.

## Intent Approval
Status: APPROVED

Approved by: owner-delegated auto-workflow debugging and local repair; no publication or deployment approval implied.
Date: 2026-11-23
