import type { SettingsPage, ViewAction } from './view-model'
import { isLanguage, uiStrings as s, type Language } from './strings'

export function settingsPage(post: (action: ViewAction) => void) {
  const page = document.querySelector<HTMLElement>('#settingsPage')!
  const provider = page.querySelector<HTMLSelectElement>('#defaultProvider')!
  const model = page.querySelector<HTMLSelectElement>('#defaultModel')!
  const save = page.querySelector<HTMLButtonElement>('#saveDefault')!
  const back = page.querySelector<HTMLButtonElement>('#settingsBack')!
  const language = page.querySelector<HTMLSelectElement>('#uiLanguage')!
  const enterToSend = page.querySelector<HTMLInputElement>('#enterToSend')!
  enterToSend.onchange = () => {
    enterToSend.disabled = true
    post({ type: 'enterToSend', value: enterToSend.checked })
  }
  language.onchange = () => {
    if (isLanguage(language.value)) {
      language.disabled = true
      post({ type: 'language', value: language.value })
    }
  }
  let snapshot: SettingsPage | undefined
  let choicesKey = ''
  let awaiting = false
  const group = () => snapshot?.groups.find(item => JSON.stringify(item.id) === provider.value)
  const control = (id: string) => page.querySelector<HTMLButtonElement>('#' + id)!
  back.onclick = () => post({ type: 'back' })
  control('selectRuntime').onclick = () => post({ type: 'settingsBrowse' })
  control('resetRuntime').onclick = () => post({ type: 'settingsReset' })
  control('editProfile').onclick = () => post({ type: 'openConfig' })
  control('editShortcuts').onclick = () => post({ type: 'shortcuts' })
  control('showDiagnostics').onclick = () => post({ type: 'diagnostics' })

  function updateSave() {
    if (!snapshot) return
    const selected = group()
    const stored = snapshot.preference
    const changed = selected
      ? selected.models.some(item => item.value === model.value) && (stored?.group !== selected.id || stored.value !== model.value)
      : provider.value === '' && !!stored
    save.disabled = !changed || snapshot.pending || awaiting
  }
  function populateModels() {
    const selected = group()
    model.replaceChildren(...(selected?.models ?? []).map(item => new Option(item.name, item.value)))
    const stored = snapshot?.preference
    if (selected && stored?.group === selected.id && selected.models.some(item => item.value === stored.value)) {
      model.value = stored.value
    }
    page.querySelector<HTMLElement>('#defaultModelField')!.hidden = !selected
    updateSave()
  }
  provider.onchange = populateModels
  model.onchange = updateSave
  save.onclick = () => {
    if (save.disabled) return
    awaiting = true
    save.disabled = true
    const selected = group()
    post(selected ? { type: 'saveDefault', group: selected.id, value: model.value } : { type: 'followAcp' })
  }
  return (next: SettingsPage | undefined, approvalCount: number, preference: Language, sendOnEnter: boolean) => {
    const opened = !!next && !snapshot
    if (!!next !== !!snapshot) {
      document.body.classList.toggle('show-settings', !!next)
      page.hidden = !next
      choicesKey = ''
      awaiting = false
      if (!next) document.querySelector('textarea')?.focus()
    }
    if (snapshot?.pending && !next?.pending) awaiting = false
    snapshot = next
    if (!next) return
    if (!next.pending) {
      language.value = preference
      enterToSend.checked = sendOnEnter
    }
    language.disabled = next.pending
    enterToSend.disabled = next.pending
    const key = JSON.stringify([next.groups, next.preference])
    if (key !== choicesKey) {
      choicesKey = key
      provider.replaceChildren(new Option(s.followAcp, ''), ...next.groups.map(item => new Option(item.name, JSON.stringify(item.id))))
      const stored = next.preference
      if (stored) {
        const available = next.groups.some(g => g.id === stored.group && g.models.some(m => m.value === stored.value))
        if (!available) {
          const missing = new Option(`${stored.providerName} / ${stored.modelName} · ${s.missingOption}`, 'unavailable')
          missing.disabled = true
          provider.append(missing)
        }
        provider.value = available ? JSON.stringify(stored.group) : 'unavailable'
      }
      populateModels()
    }
    provider.options[0].text = s.followAcp
    const unavailable = provider.querySelector<HTMLOptionElement>('option[value="unavailable"]')
    if (unavailable && next.preference) unavailable.text = `${next.preference.providerName} / ${next.preference.modelName} · ${s.missingOption}`
    provider.disabled = model.disabled = next.pending
    control('selectRuntime').disabled = next.pending
    control('resetRuntime').hidden = !next.configured
    control('resetRuntime').disabled = next.pending
    page.querySelector<HTMLElement>('#runtimePath')!.textContent = next.executable
    page.querySelector<HTMLElement>('#catalogHint')!.hidden = next.groups.length > 0
    page.querySelector<HTMLElement>('#settingsStatus')!.textContent = next.feedback
    back.textContent = approvalCount ? `← ${s.back} · ${s.permission} (${approvalCount})` : `← ${s.back}`
    updateSave()
    if (opened) back.focus()
  }
}
