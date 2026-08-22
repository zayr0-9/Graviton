import type Database from 'better-sqlite3'
import type { Express } from 'express'
import { registerAppAutomationRoutes } from './appAutomationRoutes.js'

interface RegisterCrudRoutesDeps {
  db: Database.Database
  statements: any
}

/**
 * Phase 1 extraction wrapper.
 *
 * Today this delegates to legacy-compatible /api/app/* automation routes.
 * As migration proceeds, additional CRUD routes for third-party clients
 * should be composed here.
 */
export function registerCrudRoutes(app: Express, deps: RegisterCrudRoutesDeps): void {
  registerAppAutomationRoutes(app, deps)
}
