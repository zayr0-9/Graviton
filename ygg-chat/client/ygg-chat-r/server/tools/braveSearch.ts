import { getBraveApiKey } from '../keytarSecrets.js'

interface BraveSearchResult {
  title: string
  url: string
  description: string
  age?: string
  language?: string
}

interface BraveSearchResponse {
  web?: {
    results: Array<{
      title: string
      url: string
      description: string
      age?: string
      language?: string
    }>
  }
  news?: {
    results: Array<{
      title: string
      url: string
      description: string
      age?: string
    }>
  }
}

interface BraveSearchOptions {
  count?: number
  offset?: number
  safesearch?: 'strict' | 'moderate' | 'off'
  country?: string
  search_lang?: string
  ui_lang?: string
  spellcheck?: boolean
  result_filter?: string
  goggles_id?: string
  units?: 'metric' | 'imperial'
  extra_snippets?: boolean
  summary?: boolean
}

/**
 * Search the web using Brave Search API
 * @param query The search query
 * @param options Optional search parameters
 * @returns Promise with search results
 */
export async function braveSearch(
  query: string,
  options: BraveSearchOptions = {}
): Promise<{
  success: boolean
  results?: BraveSearchResult[]
  error?: string
  query: string
  total_results?: number
}> {
  const apiKey = (await getBraveApiKey()) || process.env.BRAVE_API_KEY

  if (!apiKey) {
    return {
      success: false,
      error: 'Brave Search API key is not configured. Add one in Settings → API Keys or set BRAVE_API_KEY for development.',
      query,
    }
  }

  if (!query || query.trim().length === 0) {
    return {
      success: false,
      error: 'Search query cannot be empty',
      query,
    }
  }

  try {
    // Add 2 second delay to avoid rate limits
    await new Promise(resolve => setTimeout(resolve, 2000))

    const baseUrl = 'https://api.search.brave.com/res/v1/web/search'
    const searchParams = new URLSearchParams({
      q: query.trim(),
      count: (options.count || 10).toString(),
      offset: (options.offset || 0).toString(),
      safesearch: options.safesearch || 'moderate',
      ...(options.country && { country: options.country }),
      ...(options.search_lang && { search_lang: options.search_lang }),
      ...(options.ui_lang && { ui_lang: options.ui_lang }),
      ...(options.spellcheck !== undefined && { spellcheck: options.spellcheck.toString() }),
      ...(options.result_filter && { result_filter: options.result_filter }),
      ...(options.goggles_id && { goggles_id: options.goggles_id }),
      ...(options.units && { units: options.units }),
      ...(options.extra_snippets !== undefined && { extra_snippets: options.extra_snippets.toString() }),
      ...(options.summary !== undefined && { summary: options.summary.toString() }),
    })

    const response = await fetch(`${baseUrl}?${searchParams}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      return {
        success: false,
        error: `Brave API error: ${response.status} ${response.statusText} - ${errorText}`,
        query,
      }
    }

    const data = (await response.json()) as BraveSearchResponse

    // Extract web results
    const webResults = data.web?.results || []
    const newsResults = data.news?.results || []

    // Combine and format results
    const allResults: BraveSearchResult[] = [
      ...webResults.map(result => ({
        title: result.title,
        url: result.url,
        description: result.description,
        age: result.age,
        language: result.language,
      })),
      ...newsResults.map(result => ({
        title: result.title,
        url: result.url,
        description: result.description,
        age: result.age,
      })),
    ]

    return {
      success: true,
      results: allResults,
      query,
      total_results: allResults.length,
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred during search',
      query,
    }
  }
}
