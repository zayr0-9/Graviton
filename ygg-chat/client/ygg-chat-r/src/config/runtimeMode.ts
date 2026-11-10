import { isNativeShell } from '../platform/clientCapabilities'
import { LOCAL_USER_ID } from '../../../../shared/localUser'

/** The single local identity (Graviton has no accounts). */
export const LOCAL_AUTH_USER_ID = LOCAL_USER_ID

export const isElectronMode = isNativeShell
