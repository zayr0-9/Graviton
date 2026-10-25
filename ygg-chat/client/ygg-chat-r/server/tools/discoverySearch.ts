/** Literal, case-insensitive AND search with bounded, deterministic pagination. */
export interface DiscoverySearchArgs {
  query?: string
  limit?: number
  offset?: number
}

export function validateDiscoverySearch(args: DiscoverySearchArgs): string | undefined {
  if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 500) {
    return 'Search requires a non-empty "query" string (maximum 500 characters)'
  }
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) {
    return 'Search "limit" must be an integer from 1 to 100'
  }
  if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0)) {
    return 'Search "offset" must be a non-negative safe integer'
  }
  return undefined
}

export function searchDiscovery<T>(items: T[], args: DiscoverySearchArgs, text: (item: T) => string) {
  const terms = args.query!.trim().toLowerCase().split(/\s+/)
  const matches = items.filter(item => {
    const haystack = text(item).toLowerCase()
    return terms.every(term => haystack.includes(term))
  }).sort((a, b) => text(a).localeCompare(text(b)))
  const offset = args.offset ?? 0
  const limit = args.limit ?? 20
  return {
    items: matches.slice(offset, offset + limit),
    totalCount: matches.length,
    nextOffset: offset + limit < matches.length ? offset + limit : undefined,
  }
}
