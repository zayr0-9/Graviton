// Utility helper functions
import { MessageId } from '../../../../shared/types'

/**
 * Parse ID based on environment mode
 * - Local mode (SQLite): Converts to integer
 * - UUID strings are kept as strings
 *
 * @param id - The ID to parse (string or number)
 * @returns Parsed ID appropriate for the current environment
 */
export const parseId = (id: string | number): MessageId => {
  // After UUID migration, all IDs are strings
  // Convert numbers to strings for backward compatibility
  return typeof id === 'string' ? id : String(id)
}
