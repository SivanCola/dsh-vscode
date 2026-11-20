import type { SessionConfigOption } from '@agentclientprotocol/sdk'

export type ModelGroup = { id: string | null; name: string; models: { name: string; value: string }[] }
export type ModelPreference = { group: string | null; providerName: string; modelName: string; value: string }

export function modelGroups(options: SessionConfigOption[]): ModelGroup[] {
  const option = options.find(o => o.id === 'model')
  if (option?.type !== 'select') return []
  const groups: ModelGroup[] = []
  const ungrouped: ModelGroup = { id: null, name: 'ACP', models: [] }
  for (const entry of option.options) {
    if ('group' in entry) {
      if (entry.options.length) groups.push({
        id: entry.group, name: entry.name, models: entry.options.map(({ name, value }) => ({ name, value })),
      })
    } else ungrouped.models.push({ name: entry.name, value: entry.value })
  }
  if (ungrouped.models.length) groups.push(ungrouped)
  return groups
}

/** Admit the first prompt only after the new agent confirms its advertised selection. */
export async function applyDefaultModel(
  options: SessionConfigOption[], preference: ModelPreference | undefined,
  select: (value: string) => Promise<SessionConfigOption[]>, unavailable: string,
) {
  if (!preference) return options
  const group = modelGroups(options).find(group => group.id === preference.group)
  if (!group?.models.some(model => model.value === preference.value)) throw new Error(unavailable)
  const result = await select(preference.value)
  const selected = result.find(o => o.id === 'model')
  if (selected?.type !== 'select' || selected.currentValue !== preference.value) throw new Error(unavailable)
  return result
}
