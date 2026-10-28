# Host-owned subagents from the Claude preset

This fork adds an optional bridge from Claude Code to DSH's existing subagent
runtime. Claude remains the main agent. The native **Subagents → Model
selection** preference supplies the authorized provider/model pairs.

## Use

1. Build and install this fork into the profile you actually use, following
   [the source installation runbook](../INSTALL.md#3-install-from-a-source-checkout).
2. Restart that DSH instance while its tasks are idle, then reload its browser.
3. Enable model selection in DSH's Subagents settings, choose the desired
   routes, and save. Start a new Claude conversation after changing composition.
4. Claude can discover those routes with
   `mcp__dsh_subagents__list_models` and delegate with
   `mcp__dsh_subagents__delegate`.

The package identity remains `@norman-else/dsh-claude` for DSH module-loader and
preset compatibility. Installing the upstream npm package over this fork
removes the fork's changes; this is not a separately published npm release.

The bridge requires public Host model-selection and managed activation APIs,
including independent child presets. They are feature-detected: an older Host
without those APIs retains ordinary Claude behavior. The development type graph
remains pinned to DSH 0.1.7-rc.2; the local prototype's live validation used DSH
0.2.1-rc.2 and Claude Agent SDK 0.3.247.

## Behavior and ownership

Only the exact routes selected in DSH can be requested. The bridge checks the
preference again after model preflight, so revoking a route during that wait
prevents admission. Provider failures do not silently select another route.
Model reasoning effort must be advertised by that route.

DSH starts and owns each managed child activation. Most routes, including
DeepSeek and Codex, receive an independent `standard` preset. The `claude`
adapter receives an independent `claude` preset because it is a complete Claude
Code runtime. Child tools, permission inheritance, recursion and active-child
limits remain DSH responsibilities. No native loop or vendor API client is
copied into this plugin, and credentials remain in the existing providers.

The two policy-checked bridge tools are auto-allowed in the Claude SDK; other
MCP tools retain their existing approval behavior. When DSH model selection is
enabled, a `PreToolUse` hook rejects native Claude `Agent`, `Task` and
`TeamCreate` delegation because those calls do not consult DSH's selection.
Disabling model selection leaves native Claude delegation available. This is
a delegation-tool contract, not a claim to confine arbitrary shell programs or
to enforce vendor-internal model routing.

Independent delegate calls may run concurrently. Each MCP call returns the
child's final answer after activation teardown. Cancelling the parent turn,
closing its process or stopping its Host background job cancels the matching
child; other siblings retain their own cancellation channels.

## Model labels

The team roster and teammate detail show the provider/model from the child's
observed Host request header. Requested and observed routes are stored
separately. An unobserved request is labelled **unverified**, and historical
records without model metadata remain **unavailable**. A model reported by a
native Claude subagent's assistant message is retained when supplied by the SDK.
All persisted metadata follows the sidecar's existing bounds and redaction.

The Host execution route is not proof of a provider's internal model weights or
hidden routing. Full child tool transcripts are not merged into the Claude
teammate panel: its report follows the existing bounded task-summary contract,
while the complete final answer is returned to the main Claude tool call.

## Validation

Run `pnpm check` for Host and Client typechecks, all tests and both bundles.
Regression coverage includes a real SDK in-process MCP transport with simulated
DSH activations, whitelist revocation, cancellation and cleanup, the Host's
capacity refusal, optional older-Host behavior, sidecar round trips, supervisor
wiring, and rendering observed versus unverified models.

The preceding local bundled-JavaScript prototype completed three minimal live
routes on 2026-10-28: DeepSeek Flash returned 56 for 7×8; Codex returned 63 for
7×9; Claude Sonnet returned 64 for 8×8. The latter two ran concurrently. Those
checks accessed no project files. They do not establish long-task, file-edit,
reconnect or upgrade compatibility, and are distinct from the source fork's
automated checks.

Source-fork verification on 2026-10-28: `pnpm check` passed both typechecks,
104 test files (1057 tests passed, 1 skipped), and Host/Client builds. The
upstream UI-primitives package omits its source map, and the existing client
module-loader transform reports a source-map warning; neither failed the gate.
