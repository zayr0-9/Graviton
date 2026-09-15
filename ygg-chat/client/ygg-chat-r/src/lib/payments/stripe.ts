import type {
  PaymentProvider,
  SubscriptionStatus,
  TierInfo,
  CreditHistoryEntry,
} from './types'
import { isCommunityMode } from '../../config/runtimeMode'
import { buildLocalApiUrl } from '../../utils/api'
import { TIER_INFOS } from '../../constants/pricingData'

const assertPaymentsEnabled = () => {
  if (isCommunityMode) {
    throw new Error('Payments are disabled in community mode.')
  }
}

/**
 * Stripe Payment Provider
 *
 * Used in web mode for subscription payments and credit management.
 */
export class StripePaymentProvider implements PaymentProvider {
  isSupported(): boolean {
    return !isCommunityMode
  }

  async createCheckoutSession(
    userId: string,
    tier: 'high' | 'mid' | 'low',
    email?: string,
  ): Promise<{ sessionId: string; url: string }> {
    assertPaymentsEnabled()
    const response = await fetch(await buildLocalApiUrl('/cloud/stripe/create-checkout-session'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId, tier, email }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({
        error: 'Failed to create checkout session',
      }))
      throw new Error(errorData.error || 'Failed to create checkout session')
    }

    return response.json()
  }

  async getSubscriptionStatus(userId: string): Promise<SubscriptionStatus> {
    assertPaymentsEnabled()
    const response = await fetch(await buildLocalApiUrl(`/cloud/stripe/subscription-status?userId=${userId}`))

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({
        error: 'Failed to get subscription status',
      }))
      throw new Error(errorData.error || 'Failed to get subscription status')
    }

    return response.json()
  }

  async cancelSubscription(userId: string): Promise<void> {
    assertPaymentsEnabled()
    const response = await fetch(await buildLocalApiUrl('/cloud/stripe/cancel-subscription'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({
        error: 'Failed to cancel subscription',
      }))
      throw new Error(errorData.error || 'Failed to cancel subscription')
    }
  }

  async getCreditHistory(userId: string, limit: number = 100): Promise<CreditHistoryEntry[]> {
    assertPaymentsEnabled()
    const response = await fetch(
      await buildLocalApiUrl(`/cloud/stripe/credit-history?userId=${userId}&limit=${limit}`),
    )

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({
        error: 'Failed to get credit history',
      }))
      throw new Error(errorData.error || 'Failed to get credit history')
    }

    const data = await response.json()
    return data.history || []
  }

  async getPricingInfo(): Promise<TierInfo[]> {
    // Return client-side enforced pricing info to ensure UI consistency
    return TIER_INFOS
  }
}
