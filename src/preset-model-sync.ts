import { CLAUDE_CODE_PRESET_ID, CLAUDE_CODE_PROVIDER, CLAUDE_CODE_PROVIDER_IDS } from './constants.ts'
import { canonicalClaudeModelId } from './model-catalog.ts'

/**
 * Keeps a blank session's model on the side its preset runs: a Claude model
 * under the Claude preset, a non-Claude model under every other one.
 *
 * DSH presets carry no model, and a session's model is a separate selection
 * that also becomes the profile default. Switching presets, or opening a new
 * session after the default was last picked on the other side, would leave
 * the picker on a model the preset cannot use. The last model seen on each
 * side is remembered in memory and restored when a session crosses over.
 */

export interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface PresetModelSyncDeps {
  /** The session's current selection: its pending pick, else the profile default. */
  currentSelection(sessionId: string): ModelSelection | undefined
  /** Whether this is an ordinary session that has made no model request yet. Only those are touched. */
  isBlank(sessionId: string): boolean
  /** `sessionController.selectModel`, which also keeps the Host's selection cache. */
  selectModel(request: { sessionId: string } & ModelSelection): Promise<unknown>
  /** First model of a non-Claude provider, for when that side was never seen. */
  fallbackOtherModel(): Promise<ModelSelection | undefined>
  /** The Claude model a session starts on when none was seen. */
  defaultClaudeModel(): string
  warn(message: string): void
}

export function isClaudeSelection(selection: ModelSelection): boolean {
  return (CLAUDE_CODE_PROVIDER_IDS as readonly string[]).includes(selection.provider)
}

export function createPresetModelSync(deps: PresetModelSyncDeps) {
  let lastClaude: ModelSelection | undefined
  let lastOther: ModelSelection | undefined
  const remember = (selection: ModelSelection | undefined): void => {
    if (selection === undefined) return
    if (isClaudeSelection(selection)) lastClaude = selection
    else lastOther = selection
  }

  return {
    remember,
    /** Move the session to its preset's side when it sits on the other one. */
    async sync(sessionId: string, preset: string): Promise<void> {
      if (!deps.isBlank(sessionId)) return
      const current = deps.currentSelection(sessionId)
      remember(current)
      const wantsClaude = preset === CLAUDE_CODE_PRESET_ID
      if (current !== undefined && isClaudeSelection(current) === wantsClaude) return
      const target = wantsClaude
        ? lastClaude ?? { provider: CLAUDE_CODE_PROVIDER, model: canonicalClaudeModelId(deps.defaultClaudeModel()) }
        : lastOther ?? await deps.fallbackOtherModel()
      if (target === undefined) return
      try {
        await deps.selectModel({ sessionId, ...target })
      } catch (error) {
        deps.warn(`dsh-claude: could not move session ${sessionId} to ${target.provider}/${target.model} for preset ${preset}: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}
