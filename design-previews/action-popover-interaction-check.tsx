import React, { useState } from 'react'
import { createRoot } from '../ygg-chat/node_modules/react-dom/client'
import { ActionPopover } from '../ygg-chat/client/ygg-chat-r/src/components/ActionPopover/ActionPopover'
import { ActionPopoverButton, ActionPopoverDisclosure, ActionPopoverSwitch } from '../ygg-chat/client/ygg-chat-r/src/components/ActionPopover/ActionPopoverControls'

function Fixture() {
  const [fast, setFast] = useState(false)
  const [allow, setAllow] = useState(false)
  return <div onClick={() => { document.body.dataset.ancestorClick = 'true' }}>
    <ActionPopover footer={<><div className='action-cloud-row'><span>Fast mode</span><ActionPopoverSwitch checked={fast} label='Fast mode' onClick={() => setFast(v => !v)} /></div><ActionPopoverDisclosure><button>Image size</button></ActionPopoverDisclosure></>}>
      <ActionPopoverButton label={allow ? 'Allow all' : 'Ask'} active={allow} icon={<span />} onClick={() => setAllow(v => !v)} />
    </ActionPopover>
  </div>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
const wait = (ms = 350) => new Promise(resolve => setTimeout(resolve, ms))
const results: string[] = []
function check(value: unknown, name: string) { if (!value) throw new Error(name); results.push('PASS: ' + name) }
async function run() {
  await wait()
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Toggle chat options"]')!
  trigger.click(); await wait()
  const shell = document.querySelector<HTMLElement>('[aria-label="Chat options"]')!
  check(shell, 'popover opens')
  document.body.dataset.ancestorClick = 'false'
  shell.click(); await wait()
  check(trigger.getAttribute('aria-expanded') === 'true', 'empty surface click stays open')
  check(document.body.dataset.ancestorClick === 'false', 'portal click does not bubble into composer')
  const fast = document.querySelector<HTMLButtonElement>('[aria-label="Fast mode"]')!
  fast.click(); await wait()
  check(trigger.getAttribute('aria-expanded') === 'true' && fast.getAttribute('aria-checked') === 'true', 'Fast mode changes and stays open')
  check(document.querySelector('[aria-label="Chat options"]') === shell, 'shell remains mounted through state update')
  document.querySelector<HTMLButtonElement>('.action-cloud-pill')!.click(); await wait()
  check(trigger.getAttribute('aria-expanded') === 'true' && shell.textContent!.includes('Allow all'), 'animated label update stays open')
  const bottom = shell.getBoundingClientRect().bottom
  document.querySelector<HTMLButtonElement>('.action-cloud-disclosure > button')!.click(); await wait()
  check(Math.abs(shell.getBoundingClientRect().bottom - bottom) < 1, 'disclosure keeps bottom anchor')
  const portal = document.createElement('div'); portal.dataset.yggOverlay = 'select-dropdown'; document.body.append(portal)
  portal.click(); await wait()
  check(trigger.getAttribute('aria-expanded') === 'true', 'custom dropdown portal click stays open')
  portal.remove()
  document.getElementById('outside')!.click(); await wait()
  check(trigger.getAttribute('aria-expanded') === 'false', 'outside click closes')
  trigger.click(); await wait(); document.querySelector<HTMLElement>('[aria-label="Chat options"]')!.click(); await wait()
  check(trigger.getAttribute('aria-expanded') === 'true', 'reopened popover still accepts surface clicks')
}
run().catch(error => results.push('FAIL: ' + error.message)).finally(() => {
  const output = document.getElementById('results')!; output.textContent = results.join('\n'); output.dataset.complete = 'true'
})
