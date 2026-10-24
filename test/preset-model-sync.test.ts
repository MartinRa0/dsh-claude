import { describe, expect, it, vi } from 'vitest'
import { createPresetModelSync, type ModelSelection, type PresetModelSyncDeps } from '../src/preset-model-sync.ts'

const deepseek: ModelSelection = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
const opus: ModelSelection = { provider: 'claude', model: 'opus' }

function harness(current: ModelSelection | undefined, overrides: Partial<PresetModelSyncDeps> = {}) {
  const state = { current }
  const deps: PresetModelSyncDeps = {
    currentSelection: () => state.current,
    isBlank: () => true,
    selectModel: vi.fn(async ({ sessionId: _, ...selection }) => { state.current = selection }),
    fallbackOtherModel: vi.fn(async () => ({ provider: 'deepseek-account', model: 'deepseek-flash' })),
    defaultClaudeModel: () => 'default',
    warn: vi.fn(),
    ...overrides,
  }
  return { state, deps, sync: createPresetModelSync(deps) }
}

describe('preset model sync', () => {
  it('leaves a session already on its preset\'s side alone', async () => {
    const { deps, sync } = harness(opus)
    await sync.sync('s', 'claude')
    const other = harness(deepseek)
    await other.sync.sync('s', 'standard')
    expect(deps.selectModel).not.toHaveBeenCalled()
    expect(other.deps.selectModel).not.toHaveBeenCalled()
  })

  it('round-trips each side to the model it last held', async () => {
    const { state, deps, sync } = harness(deepseek)
    await sync.sync('s', 'standard')
    state.current = opus
    await sync.sync('s', 'claude')
    // Back to a DeepSeek preset: the remembered DeepSeek model, not the fallback.
    await sync.sync('s', 'standard')
    expect(deps.selectModel).toHaveBeenLastCalledWith({ sessionId: 's', ...deepseek })
    expect(deps.fallbackOtherModel).not.toHaveBeenCalled()
    // And into Claude again: the remembered Claude model.
    await sync.sync('s', 'claude')
    expect(deps.selectModel).toHaveBeenLastCalledWith({ sessionId: 's', ...opus })
  })

  it('falls back when a side was never seen', async () => {
    const claudeOnly = harness(opus)
    await claudeOnly.sync.sync('s', 'standard')
    expect(claudeOnly.deps.selectModel).toHaveBeenCalledWith({ sessionId: 's', provider: 'deepseek-account', model: 'deepseek-flash' })
    const deepseekOnly = harness(deepseek)
    await deepseekOnly.sync.sync('s', 'claude')
    expect(deepseekOnly.deps.selectModel).toHaveBeenCalledWith({ sessionId: 's', provider: 'claude', model: 'default' })
  })

  it('touches only blank sessions and survives a refused selection', async () => {
    const started = harness(opus, { isBlank: () => false })
    await started.sync.sync('s', 'standard')
    expect(started.deps.selectModel).not.toHaveBeenCalled()
    const refused = harness(opus, { selectModel: vi.fn(async () => { throw new Error('model unavailable') }) })
    await expect(refused.sync.sync('s', 'standard')).resolves.toBeUndefined()
    expect(refused.deps.warn).toHaveBeenCalledWith(expect.stringContaining('model unavailable'))
  })

  it('does nothing when no non-Claude model exists', async () => {
    const { deps, sync } = harness(opus, { fallbackOtherModel: async () => undefined })
    await sync.sync('s', 'standard')
    expect(deps.selectModel).not.toHaveBeenCalled()
  })
})
