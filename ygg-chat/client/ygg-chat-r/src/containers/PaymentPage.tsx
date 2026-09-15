import React, { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Button } from '../components'
import { isCommunityMode } from '../config/runtimeMode'
import { useAuth } from '../hooks/useAuth'
import { getPaymentProvider, type SubscriptionStatus, type TierInfo } from '../lib/payments'
import { apiCall } from '../utils/api'

import { TIER_INFOS } from '../constants/pricingData'

interface PricingInfo {
  tiers: {
    Ultra: TierInfo
    Pro: TierInfo
    Basic: TierInfo
  }
}

// Default tiers derived from shared data
const DEFAULT_TIERS: TierInfo[] = TIER_INFOS

const PaymentPage: React.FC = () => {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { userId } = useAuth()

  const [subscriptionStatus, setSubscriptionStatus] = useState<SubscriptionStatus | null>(null)
  const [pricingInfo, setPricingInfo] = useState<PricingInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [deleting, setDeleting] = useState(false)
  // const [paymentsSupported, setPaymentsSupported] = useState(true)

  // Check for success/cancel query params from Stripe redirect
  const success = searchParams.get('success')
  const canceled = searchParams.get('canceled')

  // Check if we're in Electron or local mode (payments not supported directly)
  const isElectronOrLocal =
    isCommunityMode ||
    (typeof __IS_ELECTRON__ !== 'undefined' && __IS_ELECTRON__) ||
    (typeof __IS_LOCAL__ !== 'undefined' && __IS_LOCAL__) ||
    import.meta.env.VITE_ENVIRONMENT === 'electron' ||
    import.meta.env.VITE_ENVIRONMENT === 'local'

  useEffect(() => {
    fetchData()
  }, [userId])

  // Refetch data when returning from successful checkout
  useEffect(() => {
    if (success && userId) {
      // Small delay to ensure webhook has processed
      const timer = setTimeout(() => {
        fetchData()
      }, 1000)
      return () => clearTimeout(timer)
    }
  }, [success, userId])

  const fetchData = async () => {
    setLoading(true)

    if (isCommunityMode) {
      const pricingData: PricingInfo = {
        tiers: {
          Basic: DEFAULT_TIERS.find(t => t.name === 'Basic') || DEFAULT_TIERS[0],
          Pro: DEFAULT_TIERS.find(t => t.name === 'Pro') || DEFAULT_TIERS[1],
          Ultra: DEFAULT_TIERS.find(t => t.name === 'Ultra') || DEFAULT_TIERS[2],
        },
      }
      setSubscriptionStatus(null)
      setPricingInfo(pricingData)
      setLoading(false)
      return
    }

    try {
      const provider = await getPaymentProvider()

      // In Electron/Local, provider.isSupported() returns false,
      // but we still want to show the pricing UI (just with external links).
      // So we only check this for setting the state variable which might be used elsewhere.
      // const supported = provider.isSupported()
      // setPaymentsSupported(supported)

      if (userId) {
        // Fetch subscription status only if user is logged in
        try {
          const statusData = await provider.getSubscriptionStatus(userId)
          setSubscriptionStatus(statusData)
        } catch (err) {
          console.warn('[PaymentPage] Failed to fetch subscription status:', err)
          // Don't block UI rendering if status fetch fails
        }
      }

      // Fetch pricing info
      let tiersData = await provider.getPricingInfo()

      // If no tiers returned (e.g. Electron no-op provider), use defaults
      if (!tiersData || tiersData.length === 0) {
        tiersData = DEFAULT_TIERS
      }

      // Convert array to object format for backward compatibility
      const pricingData: PricingInfo = {
        tiers: {
          Basic: tiersData.find(t => t.name === 'Basic') || tiersData[0],
          Pro: tiersData.find(t => t.name === 'Pro') || tiersData[1],
          Ultra: tiersData.find(t => t.name === 'Ultra') || tiersData[2],
        },
      }
      setPricingInfo(pricingData)
    } catch (err: any) {
      console.error('[PaymentPage] Error fetching payment data:', err)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const openPaymentUrl = async () => {
    const url = 'https://yggchat.com/payment'
    if (window.electronAPI?.auth?.openExternal) {
      await window.electronAPI.auth.openExternal(url)
    } else {
      window.open(url, '_blank')
    }
  }

  const handleSubscribe = async (tier: 'high' | 'mid' | 'low') => {
    // If in Electron/Local mode, open external payment page
    if (isElectronOrLocal) {
      await openPaymentUrl()
      return
    }

    if (!userId) {
      setError('You must be logged in to subscribe')
      return
    }

    setCheckoutLoading(tier)
    setError(null)

    try {
      const provider = await getPaymentProvider()

      const { url } = await provider.createCheckoutSession(userId, tier)

      if (url) {
        // Redirect to Stripe Checkout
        window.location.href = url
      }
    } catch (err: any) {
      console.error('Error creating checkout session:', err)
      setError(err.message)
      setCheckoutLoading(null)
    }
  }

  const handleCancelSubscription = async () => {
    if (
      !userId ||
      !window.confirm(
        'Are you sure you want to cancel your subscription? You will have access until the end of your billing period.'
      )
    ) {
      return
    }

    try {
      const provider = await getPaymentProvider()

      await provider.cancelSubscription(userId)

      alert('Subscription canceled. You will have access until the end of your billing period.')
      fetchData() // Refresh data
    } catch (err: any) {
      console.error('Error canceling subscription:', err)

      // Show user-friendly error messages
      let errorMessage = 'Failed to cancel subscription. Please try again or contact support.'

      if (err.message?.includes('already canceled')) {
        errorMessage = 'Your subscription is already canceled.'
      } else if (err.message?.includes('already scheduled to cancel')) {
        errorMessage = 'Your subscription is already scheduled to cancel at the end of the billing period.'
      } else if (err.message?.includes('No active subscription')) {
        errorMessage = 'No active subscription found.'
      } else if (err.message) {
        errorMessage = err.message
      }

      setError(errorMessage)
    }
  }

  const handleDeleteAccount = async () => {
    if (isCommunityMode) {
      setError('Account deletion via cloud backend is disabled in community mode.')
      return
    }

    if (!userId || deleteConfirmText !== 'DELETE') {
      return
    }

    setDeleting(true)
    setError(null)

    try {
      const accessToken = null

      const response = await apiCall<{ success: boolean; message: string }>('/user/account', accessToken, {
        method: 'DELETE',
        body: JSON.stringify({ confirmDeletion: true }),
      })

      if (response.success) {
        // Clear local storage
        localStorage.clear()
        sessionStorage.clear()

        // Show success message and redirect to landing page
        alert('Your account has been successfully deleted. You will be redirected to the home page.')
        window.location.href = '/'
      } else {
        throw new Error('Account deletion failed')
      }
    } catch (err: any) {
      console.error('Error deleting account:', err)
      setError(err.message || 'Failed to delete account. Please try again or contact support.')
      setDeleting(false)
    }
  }

  const formatDate = (dateString: string | null) => {
    if (!dateString) return 'N/A'
    return new Date(dateString).toLocaleDateString()
  }

  const getTierColor = (tier: string) => {
    switch (tier) {
      case 'high':
        return 'from-purple-500 to-pink-600'
      case 'mid':
        return 'from-blue-500 to-cyan-600'
      case 'low':
        return 'from-green-500 to-teal-600'
      default:
        return 'from-gray-500 to-gray-600'
    }
  }

  const hasActiveAccess = () => {
    if (!subscriptionStatus || !subscriptionStatus.tier) return false

    const status = subscriptionStatus.status

    // Active subscription
    if (status === 'active') return true

    // Past due or canceled but still within access period
    if ((status === 'past_due' || status === 'canceled') && subscriptionStatus.currentPeriodEnd) {
      const periodEnd = new Date(subscriptionStatus.currentPeriodEnd)
      const now = new Date()
      return now < periodEnd
    }

    return false
  }

  if (loading) {
    return (
      <div className='min-h-full bg-zinc-50 dark:bg-yBlack-500 flex items-center justify-center'>
        <p className='text-xl dark:text-neutral-100'>Loading...</p>
      </div>
    )
  }

  // Show alternative UI for Electron/local modes (no payments) -> REMOVED to show pricing
  /* 
  if (!paymentsSupported || isElectronOrLocal) {
    return (...)
  }
  */

  return (
    <div className='h-full overflow-y-auto min-h-full'>
      <div className='max-w-7xl mx-auto px-4 py-8'>
        {/* Header */}
        <div className='flex items-center justify-between mb-8'>
          <h1 className='relative z-10 text-4xl font-bold video-light:text-neutral-100 video-dark:text-neutral-900'>
            Subscription & Credits
          </h1>
          <div className='flex items-center gap-4'>
            {isElectronOrLocal && (
              <Button variant='outline' onClick={openPaymentUrl}>
                <i className='bx bx-link-external mr-2'></i>
                Manage Subscription on Web
              </Button>
            )}
            {hasActiveAccess() ? (
              <Button variant='acrylic' onClick={() => navigate('/homepage')}>
                <i className='bx bx-arrow-back mr-2'></i>
                Home
              </Button>
            ) : (
              <Button variant='acrylic' onClick={() => navigate('/homepage')}>
                <i className='bx bx-home-alt mr-2'></i>
                Home
              </Button>
            )}
          </div>
        </div>

        {/* Success/Cancel Messages */}
        {success && (
          <div className='mb-6 p-4 bg-green-100 dark:bg-green-900 border border-green-400 dark:border-green-600 rounded-lg'>
            <p className='text-green-800 dark:text-green-200'>
              <i className='bx bx-check-circle mr-2'></i>
              Subscription activated successfully! Welcome aboard!
            </p>
          </div>
        )}
        {canceled && (
          <div className='mb-6 p-4 bg-yellow-100 dark:bg-yellow-900 border border-yellow-400 dark:border-yellow-600 rounded-lg'>
            <p className='text-yellow-800 dark:text-yellow-200'>
              <i className='bx bx-info-circle mr-2'></i>
              Checkout canceled. You can subscribe anytime!
            </p>
          </div>
        )}

        {error && (
          <div className='mb-6 p-4 bg-red-100 dark:bg-red-900 border border-red-400 dark:border-red-600 rounded-lg'>
            <p className='text-red-800 dark:text-red-200'>
              <i className='bx bx-error mr-2'></i>
              {error}
            </p>
          </div>
        )}

        {/* Current Subscription Status */}
        {subscriptionStatus && subscriptionStatus.tier && (
          <div className='mb-8 p-6 bg-white dark:bg-yBlack-900 rounded-lg shadow-md border mica border-indigo-100 dark:border-neutral-700'>
            <h2 className='text-2xl font-bold mb-4 dark:text-neutral-100'>Current Subscription</h2>
            <div className='grid grid-cols-1 md:grid-cols-3 gap-4'>
              <div>
                <p className='text-sm text-gray-600 dark:text-gray-400'>Tier</p>
                <p className='text-lg font-semibold dark:text-neutral-100 capitalize'>
                  {subscriptionStatus.tier === 'high' ? 'Ultra' : subscriptionStatus.tier === 'mid' ? 'Pro' : 'Basic'}
                </p>
              </div>
              <div>
                <p className='text-sm text-gray-600 dark:text-gray-400'>Status</p>
                <p className='text-lg font-semibold dark:text-neutral-100 capitalize'>{subscriptionStatus.status}</p>
              </div>
              <div>
                <p className='text-sm text-gray-600 dark:text-gray-400'>Credits Balance</p>
                <p className='text-lg font-semibold dark:text-neutral-100'>
                  {(subscriptionStatus.creditsBalance * 100).toLocaleString()}
                </p>
              </div>
            </div>
            {subscriptionStatus.currentPeriodEnd && (
              <div className='mt-4'>
                <p className='text-sm text-gray-600 dark:text-gray-400'>
                  {subscriptionStatus.status === 'canceled'
                    ? 'Access until'
                    : subscriptionStatus.cancelAtPeriodEnd
                      ? 'Cancels on'
                      : 'Renews on'}
                  : {formatDate(subscriptionStatus.currentPeriodEnd)}
                </p>
                {subscriptionStatus.cancelAtPeriodEnd && subscriptionStatus.status === 'active' && (
                  <p className='text-sm text-yellow-600 dark:text-yellow-400 mt-2'>
                    <i className='bx bx-info-circle mr-1'></i>
                    Your subscription is scheduled to cancel at the end of the billing period.
                  </p>
                )}
              </div>
            )}
            {subscriptionStatus.status === 'active' && !subscriptionStatus.cancelAtPeriodEnd && (
              <div className='mt-4'>
                <Button variant='outline2' size='medium' onClick={handleCancelSubscription}>
                  Cancel Subscription
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Pricing Tiers - Only show if user doesn't have active subscription */}
        {!hasActiveAccess() ? (
          <>
            <h2 className='relative z-10 text-3xl font-bold mb-6 video-light:text-neutral-100 video-dark:text-neutral-900'>
              Choose Your Plan
            </h2>

            <div className='grid grid-cols-1 lg:grid-cols-3 gap-6'>
              {pricingInfo &&
                Object.entries(pricingInfo.tiers).map(([key, tier]) => {
                  const getTierKey = (k: string): 'high' | 'mid' | 'low' => {
                    switch (k) {
                      case 'Ultra':
                        return 'high'
                      case 'Pro':
                        return 'mid'
                      case 'Basic':
                      default:
                        return 'low'
                    }
                  }
                  const tierKey = getTierKey(key)
                  const isLoading = checkoutLoading === tierKey

                  return (
                    <div
                      key={key}
                      className='relative acrylic p-6 rounded-lg shadow-lg border-2 border-gray-200 dark:border-neutral-700 bg-white dark:bg-yBlack-900 hover:shadow-xl transition-shadow flex flex-col'
                    >
                      <div
                        className={`w-16 h-16 rounded-full bg-gradient-to-br ${getTierColor(tierKey)} mb-4 flex items-center justify-center`}
                      >
                        <i className='bx bx-crown text-white text-3xl'></i>
                      </div>

                      <h3 className='text-2xl font-bold mb-2 dark:text-neutral-100'>{tier.name}</h3>
                      <div className='mb-4'>
                        <span className='text-4xl font-bold dark:text-neutral-100'>${tier.price}</span>
                        <span className='text-gray-600 dark:text-gray-400'>/month</span>
                      </div>

                      <div className='mb-6'>
                        <p className='text-sm text-gray-600 dark:text-gray-400 mb-2'>Monthly Credits</p>
                        <p className='text-xl font-semibold dark:text-neutral-100'>{tier.credits.toLocaleString()}</p>
                      </div>

                      <ul className='space-y-2 mb-6 flex-grow'>
                        {tier.features.map((feature, idx) => (
                          <li key={idx} className='flex items-start text-sm dark:text-neutral-200'>
                            <i className='bx bx-check text-green-500 mr-2 mt-0.5'></i>
                            {feature}
                          </li>
                        ))}
                      </ul>

                      <Button
                        variant='outline'
                        size='large'
                        className='w-full'
                        onClick={() => handleSubscribe(tierKey)}
                        disabled={isLoading}
                      >
                        {isLoading ? (
                          <>
                            <i className='bx bx-loader-alt animate-spin mr-2'></i>
                            Processing...
                          </>
                        ) : isElectronOrLocal ? (
                          <>
                            <i className='bx bx-link-external mr-2'></i>
                            Subscribe on Website
                          </>
                        ) : (
                          'Subscribe Now'
                        )}
                      </Button>
                    </div>
                  )
                })}
            </div>
          </>
        ) : (
          /* Already subscribed message */
          <div className='mb-8 p-6 bg-white dark:bg-yBlack-900 rounded-lg shadow-md border mica border-gray-200 dark:border-neutral-700'>
            <h2 className='text-2xl font-bold mb-4 dark:text-neutral-100'>You&apos;re All Set! 🎉</h2>
            <p className='text-gray-700 dark:text-neutral-300 mb-4'>
              You currently have an active subscription. Your credits will automatically replenish each month on your
              renewal date.
            </p>
            {subscriptionStatus?.status === 'canceled' && (
              <p className='text-yellow-700 dark:text-yellow-400 mb-4'>
                <i className='bx bx-info-circle mr-2'></i>
                Your subscription is set to cancel, but you&apos;ll have access until{' '}
                {formatDate(subscriptionStatus.currentPeriodEnd)}.
              </p>
            )}
            {subscriptionStatus?.status === 'past_due' && (
              <p className='text-red-700 dark:text-red-400 mb-4'>
                <i className='bx bx-error mr-2'></i>
                Your payment is past due. Please update your payment method to continue service after{' '}
                {formatDate(subscriptionStatus.currentPeriodEnd)}.
              </p>
            )}
            <p className='text-sm text-gray-600 dark:text-gray-400'>
              Need to change your plan or payment method? Please contact support or cancel your current subscription
              first.
            </p>
          </div>
        )}

        {/* How Credits Work */}
        <div className='mt-12 p-6 bg-white dark:bg-yBlack-900 rounded-lg shadow-md border mica border-gray-200 dark:border-neutral-700'>
          <h2 className='text-2xl font-bold mb-4 dark:text-neutral-100'>How Credits Work</h2>
          <ul className='space-y-2 dark:text-neutral-200'>
            <li className='flex items-start'>
              <i className='bx bx-info-circle mr-2 mt-0.5 text-indigo-600 dark:text-indigo-200'></i>
              Credits are consumed with each AI generation based on the model and token usage
            </li>
            <li className='flex items-start'>
              <i className='bx bx-info-circle mr-2 mt-0.5 text-indigo-600 dark:text-indigo-200'></i>
              Your credits replenish automatically each month on your subscription renewal date
            </li>
            <li className='flex items-start'>
              <i className='bx bx-info-circle mr-2 mt-0.5 text-indigo-600 dark:text-indigo-200'></i>
              If payment fails, you can continue using the service until your current period ends
            </li>
            <li className='flex items-start'>
              <i className='bx bx-info-circle mr-2 mt-0.5 text-indigo-600 dark:text-indigo-200'></i>
              More expensive models (like GPT-5, Claude Sonnet 4.5) use more credits per generation
            </li>
          </ul>
        </div>

        {/* Delete Account Section - Only show in web mode */}
        {!isElectronOrLocal && userId && (
          <div className='mt-12 p-6 mica bg-red-50 dark:bg-red-950 rounded-lg shadow-md border border-red-200 dark:border-red-800'>
            <h2 className='text-2xl font-bold mb-4 text-red-800 dark:text-red-200'>Delete Account</h2>
            <p className='text-red-700 dark:text-red-300 mb-4'>
              <i className='bx bx-error-circle mr-2'></i>
              <strong>Warning:</strong> This action is permanent and cannot be undone. All your conversations, messages,
              and files will be permanently deleted.
            </p>
            <div className='mb-4'>
              <p className='text-sm text-red-700 dark:text-red-300 mb-2'>
                The following data will be <strong>deleted</strong>:
              </p>
              <ul className='text-sm text-red-700 dark:text-red-300 ml-6 list-disc space-y-1'>
                <li>All conversations and messages</li>
                <li>All projects and workspaces</li>
                <li>All file attachments</li>
                <li>Your profile and preferences</li>
              </ul>
            </div>
            <div className='mb-4'>
              <p className='text-sm text-red-700 dark:text-red-300 mb-2'>
                The following data will be <strong>preserved</strong> for legal/accounting purposes:
              </p>
              <ul className='text-sm text-red-700 dark:text-red-300 ml-6 list-disc space-y-1'>
                <li>Billing history and credit transactions</li>
                <li>Subscription records</li>
              </ul>
            </div>
            <Button
              variant='outline2'
              size='medium'
              onClick={() => setShowDeleteModal(true)}
              className='bg-red-600 hover:bg-red-700 text-white border-red-600'
            >
              <i className='bx bx-trash mr-2'></i>
              Delete My Account
            </Button>
          </div>
        )}

        {/* Delete Account Confirmation Modal */}
        {showDeleteModal && (
          <div className='fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50'>
            <div className='bg-white dark:bg-yBlack-900 rounded-lg shadow-xl p-6 max-w-md w-full mx-4 border border-red-200 dark:border-red-800'>
              <h3 className='text-2xl font-bold mb-4 text-red-800 dark:text-red-200'>
                <i className='bx bx-error-circle mr-2'></i>
                Confirm Account Deletion
              </h3>
              <p className='text-gray-700 dark:text-neutral-300 mb-4'>
                This action is <strong>permanent and irreversible</strong>. All your data will be deleted immediately.
              </p>
              {subscriptionStatus?.status === 'active' && (
                <p className='text-yellow-700 dark:text-yellow-400 mb-4 p-3 bg-yellow-50 dark:bg-yellow-950 rounded border border-yellow-200 dark:border-yellow-800'>
                  <i className='bx bx-info-circle mr-2'></i>
                  You have an active subscription. It will be canceled immediately.
                </p>
              )}
              <div className='mb-4'>
                <label className='block text-sm font-medium text-gray-700 dark:text-neutral-300 mb-2'>
                  Type <strong>DELETE</strong> to confirm:
                </label>
                <input
                  type='text'
                  value={deleteConfirmText}
                  onChange={e => setDeleteConfirmText(e.target.value)}
                  className='w-full px-3 py-2 border border-gray-300 dark:border-neutral-600 rounded-md bg-white dark:bg-yBlack-800 text-gray-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-red-500'
                  placeholder='Type DELETE'
                  disabled={deleting}
                />
              </div>
              <div className='flex gap-3'>
                <Button
                  variant='outline2'
                  size='medium'
                  onClick={() => {
                    setShowDeleteModal(false)
                    setDeleteConfirmText('')
                  }}
                  disabled={deleting}
                  className='flex-1'
                >
                  Cancel
                </Button>
                <Button
                  variant='outline2'
                  size='medium'
                  onClick={handleDeleteAccount}
                  disabled={deleteConfirmText !== 'DELETE' || deleting}
                  className='flex-1 bg-red-600 hover:bg-red-700 text-white border-red-600 disabled:opacity-50 disabled:cursor-not-allowed'
                >
                  {deleting ? (
                    <>
                      <i className='bx bx-loader-alt animate-spin mr-2'></i>
                      Deleting...
                    </>
                  ) : (
                    <>
                      <i className='bx bx-trash mr-2'></i>
                      Delete Forever
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default PaymentPage
