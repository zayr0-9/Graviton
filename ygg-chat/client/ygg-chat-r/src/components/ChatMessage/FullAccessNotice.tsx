import { ShieldCheck } from 'lucide-react'
import { RunSettingsNotice } from './RunSettingsNotice'

export function FullAccessNotice() {
  return <RunSettingsNotice icon={ShieldCheck} label='Full access enabled' detail='Outside workspace · Approvals still apply' />
}
