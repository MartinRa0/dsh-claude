/** Optional, public-API bridge from Claude tools to Host-owned DSH activations. */
import { randomUUID } from 'node:crypto'
import { createSdkMcpServer, tool, type HookCallback } from '@anthropic-ai/claude-agent-sdk'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import type { ClaudeTaskInfo } from './events.ts'
import { canonicalClaudeModelId } from './model-catalog.ts'

interface ModelRoute { provider: string; model: string }
interface ModelPolicy { enabled: boolean; allowedModels: readonly ModelRoute[] }
interface ModelSettings { current(): ModelPolicy }
interface ModelInfo {
  name: string
  reasoning?: { efforts: readonly { id: string; name?: string; description?: string }[]; defaultEffort?: string }
}
interface RequestConfig extends ModelRoute { reasoningEffort?: string }
interface BridgeSession { id: string; requestHeader(): { config: RequestConfig } | undefined }
interface ChildResult {
  output: readonly { type: string; text?: string }[]
  stopReason: string
  diagnostic?: string
}
interface Activation { childId: string; result: Promise<ChildResult>; dispose(): Promise<void> }
interface ActivationSpec {
  provider: string
  childId: string
  label: string
  signal: AbortSignal
  delivery: 'caller'
  request: {
    parent: Agent
    agentPreset: string
    prompt: { type: 'text'; text: string }[]
    agentOptions: RequestConfig
    maxDepth?: number
  }
}
interface BridgeRuntime {
  getProvider(name: string): { capabilities: { agentPreset: boolean; agentOptions: boolean }; inheritsParentContext: boolean } | undefined
  resolveMaxDepth(): number | undefined
  startActivation(spec: ActivationSpec): Promise<Activation>
}
/** Only public service seams; these newer capabilities are optional on older Hosts. */
export interface DshSubagentHost {
  get(name: 'subagentModelSelection'): ModelSettings | undefined
  get(name: 'subagents'): BridgeRuntime | undefined
  llm: { resolveModelInfo(provider: string, model: string): Promise<ModelInfo> }
  agents: { get(id: string): { session: BridgeSession } | undefined }
  on(event: 'session/event', callback: (session: BridgeSession) => void): () => void
}
export interface DshSubagentBridgeContext {
  parent: Agent
  lifetimeSignal: AbortSignal
  activeContext(): { aborted: boolean; signal?: AbortSignal; cursor: { turn: number } } | undefined
  publish(task: ClaudeTaskInfo): Promise<void>
  onStarted?(task: ClaudeTaskInfo, stop: () => void): void
}
interface BridgeDependencies extends DshSubagentBridgeContext { ctx: DshSubagentHost }
export interface DelegateRequest extends ModelRoute {
  description: string
  prompt: string
  reasoning_effort?: string | undefined
}
export type DshSubagentBridgeFactory = (context: DshSubagentBridgeContext) => DshSubagentBridge | undefined

const NATIVE_DELEGATION = new Set(['Agent', 'Task', 'TeamCreate'])
const routeKey = ({ provider, model }: ModelRoute): string => `${provider}\0${model}`
function textResult(value: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) }
}
export const DSH_BRIDGE_TOOLS = ['mcp__dsh_subagents__list_models', 'mcp__dsh_subagents__delegate']
export const BRIDGE_INSTRUCTIONS = `DSH delegation integration: before delegating, call mcp__dsh_subagents__list_models.
When DSH model selection is enabled, use mcp__dsh_subagents__delegate with an exact authorized provider/model pair.
Native Agent/Task/TeamCreate delegation is blocked in that mode because it bypasses the DSH model policy.
DSH children run an independent standard preset, or the Claude preset for authorized Claude Code models, with inherited DSH permissions. Supply a self-contained task and context.
Multiple independent delegate calls may run in parallel. Each call returns the final answer and its observed model route.
Do not invoke another agent runtime through shell commands to bypass this policy. If delegation is unavailable, work directly or report the error.
When DSH model selection is disabled, use Claude's ordinary native agents instead.`

/** Feature detection at the public Context boundary keeps pre-bridge Hosts compatible. */
export function dshSubagentBridgeFactory(ctx: Context): DshSubagentBridgeFactory {
  // The dev graph predates the optional model-selection service and activation API.
  // No private module import or native-loop copy is needed to use these public seams.
  const host = ctx as unknown as DshSubagentHost
  return context => createDshSubagentBridge({ ...context, ctx: host })
}

export function createBridgeKernel({ ctx, parent, lifetimeSignal, activeContext, publish, onStarted }: BridgeDependencies) {
  interface Operation { controller: AbortController; activation?: Activation; disposing?: Promise<void> }
  const operations = new Set<Operation>()
  function policy(): ModelPolicy {
    const selection = ctx.get('subagentModelSelection')?.current()
    if (!selection) throw new Error('DSH subagent model settings are unavailable.')
    return selection
  }
  function authorized(args: ModelRoute): void {
    const selection = policy()
    if (!selection.enabled) throw new Error('DSH model selection is disabled; use Claude native agents or enable it for a new session.')
    if (!selection.allowedModels.some(route => routeKey(route) === routeKey(args))) {
      throw new Error('This provider/model is not authorized by DSH subagent settings. Call list_models again.')
    }
  }
  async function listModels() {
    const selection = policy()
    const models = await Promise.all(selection.allowedModels.map(async route => {
      try {
        const model = await ctx.llm.resolveModelInfo(route.provider, route.model)
        return { ...route, name: model.name, available: true, ...(model.reasoning ? { reasoning: model.reasoning } : {}) }
      } catch {
        return { ...route, available: false, reason: 'Provider/model is currently unavailable.' }
      }
    }))
    return { enabled: selection.enabled, models }
  }
  async function delegate(args: DelegateRequest, extra?: unknown) {
    authorized(args)
    const active = activeContext()
    if (!active || active.aborted) throw new Error('No active Claude turn owns this delegation.')
    const runtime = ctx.get('subagents')
    const backend = runtime?.getProvider('spawn')
    if (!runtime || !backend?.capabilities.agentPreset || !backend.capabilities.agentOptions || backend.inheritsParentContext) {
      throw new Error('DSH spawn backend with independent preset/model support is unavailable.')
    }
    const controller = new AbortController()
    const extraSignal = typeof extra === 'object' && extra !== null && 'signal' in extra && extra.signal instanceof AbortSignal
      ? extra.signal : undefined
    const signal = AbortSignal.any([lifetimeSignal, active.signal, extraSignal, controller.signal].filter((s): s is AbortSignal => s !== undefined))
    const operation: Operation = { controller }
    operations.add(operation)
    const dispose = (): Promise<void> | undefined => operation.activation === undefined ? undefined
      : operation.disposing ??= operation.activation.dispose()
    const onAbort = (): void => { void Promise.resolve(dispose()).catch(() => undefined) }
    signal.addEventListener('abort', onAbort, { once: true })
    let task: ClaudeTaskInfo | undefined
    const childId = randomUUID()
    let observedSession: BridgeSession | undefined
    const observe = (): void => {
      const config = (observedSession ?? ctx.agents.get(childId)?.session)?.requestHeader()?.config
      if (!config || !task) return
      task.actualProvider = config.provider
      task.actualModel = config.model
      if (config.reasoningEffort !== undefined) task.actualReasoningEffort = config.reasoningEffort
    }
    const stopObserving = ctx.on('session/event', session => {
      if (session.id !== childId) return
      observedSession = session
      observe()
    })
    try {
      signal.throwIfAborted()
      const info = await ctx.llm.resolveModelInfo(args.provider, args.model)
      const preset = args.provider === 'claude' ? 'claude' : 'standard'
      const expectedModel = preset === 'claude' ? canonicalClaudeModelId(args.model) : args.model
      if (args.reasoning_effort !== undefined && !info.reasoning?.efforts.some(item => item.id === args.reasoning_effort)) {
        throw new Error('The selected model does not advertise this reasoning effort.')
      }
      // A preference can be revoked while route preflight awaits IO.
      authorized(args)
      signal.throwIfAborted()
      const maxDepth = runtime.resolveMaxDepth()
      operation.activation = await runtime.startActivation({
        provider: 'spawn', childId, label: args.description, signal, delivery: 'caller',
        request: {
          parent, agentPreset: preset,
          prompt: [{ type: 'text', text: 'Return your result in your final assistant message. The calling bridge delivers it to the parent; do not use send_message to contact the parent.\n\n' + args.prompt }],
          agentOptions: { provider: args.provider, model: expectedModel,
            ...(args.reasoning_effort === undefined ? {} : { reasoningEffort: args.reasoning_effort }) },
          ...(maxDepth === undefined ? {} : { maxDepth }),
        },
      })
      task = {
        taskId: operation.activation.childId, description: args.description, status: 'running',
        taskType: 'local_agent', subagentType: 'DSH', bridge: true, originTurn: active.cursor.turn,
        requestedProvider: args.provider, requestedModel: args.model,
        ...(args.reasoning_effort === undefined ? {} : { requestedReasoningEffort: args.reasoning_effort }),
      }
      observe()
      await publish({ ...task })
      onStarted?.(task, () => controller.abort(new Error('DSH child stopped by user.')))
      if (signal.aborted) onAbort()
      let result: ChildResult
      try { result = await operation.activation.result }
      finally { observe() }
      if (task.actualProvider !== undefined && (task.actualProvider !== args.provider || task.actualModel !== expectedModel)) {
        task.status = 'failed'
        task.summary = 'DSH child effective route differed from the authorized requested route.'
        await publish({ ...task })
        throw new Error(task.summary)
      }
      const answer = result.output.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
      task.status = signal.aborted ? 'stopped' : result.stopReason === 'completed' ? 'completed' : 'failed'
      task.summary = answer || result.diagnostic || result.stopReason
      await publish({ ...task })
      signal.throwIfAborted()
      return {
        childId: task.taskId, provider: task.actualProvider ?? null, model: task.actualModel ?? null,
        requestedProvider: args.provider, requestedModel: args.model,
        modelVerified: task.actualModel !== undefined, stopReason: result.stopReason,
        answer, ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}),
      }
    } catch (error) {
      if (task?.status === 'running') {
        task.status = signal.aborted ? 'stopped' : 'failed'
        task.summary = signal.aborted ? 'Cancelled with the owning turn.' : 'DSH delegation failed.'
        await publish({ ...task })
      }
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
      stopObserving()
      try {
        await dispose()
      } catch {
        if (task !== undefined) {
          task.status = 'failed'
          task.summary = 'DSH child activation cleanup failed.'
          await publish({ ...task })
        }
        throw new Error('DSH child activation cleanup failed.')
      } finally {
        operations.delete(operation)
      }
    }
  }
  function cancelAll(): void {
    for (const { controller } of operations) controller.abort(new Error('Owning Claude turn stopped.'))
  }
  const guardNative: HookCallback = async input => {
    if (input.hook_event_name === 'PreToolUse' && NATIVE_DELEGATION.has(input.tool_name) && policy().enabled) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
        permissionDecisionReason: 'Use mcp__dsh_subagents__delegate; native Claude agents bypass the enabled DSH model policy.' } }
    }
    return {}
  }
  return { listModels, delegate, guardNative, cancelAll }
}

export type DshSubagentBridge = NonNullable<ReturnType<typeof createDshSubagentBridge>>

export function createDshSubagentBridge(deps: BridgeDependencies) {
  const settings = deps.ctx.get('subagentModelSelection')
  const runtime = deps.ctx.get('subagents')
  if (!settings || typeof settings.current !== 'function' || !runtime
    || typeof runtime.startActivation !== 'function' || typeof runtime.resolveMaxDepth !== 'function') return undefined
  const kernel = createBridgeKernel(deps)
  const respond = async (operation: () => Promise<unknown>) => {
    try {
      const result = await operation()
      const failed = typeof result === 'object' && result !== null && 'stopReason' in result && result.stopReason !== 'completed'
      return textResult(result, failed)
    } catch {
      // Provider exceptions can carry credentials or request payloads. Keep them out of tool results.
      return textResult({ error: 'DSH delegation rejected, cancelled or failed. Check authorized routes, model effort, limits and task status.' }, true)
    }
  }
  const server = createSdkMcpServer({
    name: 'dsh_subagents', version: '1.0.0', instructions: BRIDGE_INSTRUCTIONS,
    tools: [
      tool('list_models', 'List DSH-authorized subagent routes and reasoning efforts.', {}, () => respond(() => kernel.listModels())),
      tool('delegate', 'Run a DSH subagent on an authorized route and return its final answer. Independent calls may run in parallel.', {
        provider: z.string().min(1), model: z.string().min(1),
        description: z.string().min(1).max(200), prompt: z.string().min(1),
        reasoning_effort: z.string().min(1).optional(),
      }, (args, extra) => respond(() => kernel.delegate(args, extra))),
    ],
  })
  return { ...kernel, server, instructions: BRIDGE_INSTRUCTIONS }
}
