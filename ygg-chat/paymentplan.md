# System Design for Stripe Subscriptions and Credits Ledger

> **Historical — cloud parts removed.** Graviton is now fully local (2026-11): there is no Supabase/Railway
> account or sync, cloud storage mode, hosted OpenRouter provider, Stripe billing or web product. Sections that
> describe those are kept for history only. Current behaviour: `ygg-chat/docs/agent_context/AGENT.md`.

The simplest, non-redundant design is to make Stripe the single source of truth for subscription periods and your own credits ledger the single source of truth for balance. Everything else becomes a thin cache or lookup. Here’s a minimal, clean architecture.

## Guiding Principles

- **One source of truth per concern**:
  - Subscription periods and plan changes: Stripe subscription and invoices.
  - User credit balance: your credits ledger (append-only).
- No duplicate “period” state in your profiles. Don’t store `last/next reset` there; derive from Stripe’s `current_period_start/end` when needed.
- Don’t keep separate “usage_ledger” and “credits_transactions.” One ledger table is enough.
- Optional caching only for read performance (e.g., a cached balance on profiles), not as a second source of truth.

## Minimal Data Model (No Code, Conceptual)

### profiles

- `id` (your auth/user id)
- `stripe_customer_id`
- `active_subscription_id` (nullable; FK to subscriptions) for fast joins
- `cached_current_credits` (optional convenience for UI; recomputed from ledger or updated atomically on each ledger insert)

### subscriptions

- `id` (internal)
- `user_id` (FK to profiles)
- `stripe_subscription_id`
- `stripe_price_id`
- `status` (active/trialing/canceled/past_due)
- `current_period_start`, `current_period_end`, `billing_cycle_anchor`

**Note**: This is the only place you keep period boundaries. Profiles do not copy them.

### plans (mapping table; tiny)

- `plan_code` or `tier_name`
- `stripe_price_id` (unique)
- `included_credits_per_cycle` (e.g., “3 credits” for $5)
- display metadata (price, name)

### credits_ledger (append-only; single source of truth for balance)

- `id`
- `user_id`
- `delta_credits` (positive for allocation/top-up; negative for usage)
- `kind` (monthly_allocation, usage, topup_credit, refund, adjustment)
- `external_ref_type` + `external_ref_id` (nullable; e.g., subscription_id+invoice_id for monthly allocation; payment_intent_id for top-ups) with a uniqueness constraint to enforce idempotency
- `metadata` (json: price_id, period_end, platform_fee_applied, etc.)
- `created_at`

**Optional**: No separate topups table  
**Rationale**: top-ups are just credits_ledger rows with `kind=topup_credit`. The Stripe `payment_intent_id` lives in `external_ref_id`. You can query/report top-ups by kind. If you prefer a dedicated topups table for finance ops, you can add it later without changing the core balance logic.

## How Resets and Different User Dates Are Handled

Stripe subscription cycle is your reset boundary. On `invoice.payment_succeeded`, allocate included credits for the next period by inserting a `credits_ledger` entry with `kind=monthly_allocation`.

You don’t store `last/next reset` in profiles. If you need to show it, read `current_period_end` from the subscriptions row (synced from Stripe webhooks).

## End-to-End Flows

### Subscribe (new user or plan change)

- Create/reuse Stripe customer, set default payment method.
- Create/update Stripe subscription with the desired `billing_cycle_anchor` (the user’s own reset day).
- On `customer.subscription.created/updated`, store subscription fields (status, `stripe_price_id`).
- On `invoice.payment_succeeded`, look up the plan by `stripe_price_id`, insert a `credits_ledger` row:
  - `delta_credits` = `included_credits_per_cycle`
  - `kind` = `monthly_allocation`
  - `external_ref_type` = `'invoice'`, `external_ref_id` = `stripe_invoice_id` (unique for idempotency)
- Optionally update `cached_current_credits` = `cached_current_credits` + `delta`

### Usage

- Each usage event inserts a `credits_ledger` row:
  - `delta_credits` = `-usage_cost`
  - `kind` = `usage`
- If `cached_current_credits` is used, decrement it atomically; otherwise compute balance on read by summing ledger for that user.
- If balance would go below zero, block or prompt top-up (your policy).

### Top-up

- Create a Stripe PaymentIntent or Checkout for the top-up dollar amount.
- On `payment_intent.succeeded` (or `checkout.session.completed`):
  - `credits` = `amount * (1 - platform_cut)` => e.g., 5 \* 0.9 = 4.5
  - Insert ledger row with:
    - `delta_credits` = `credits`
    - `kind` = `topup_credit`
    - `external_ref_type` = `'payment_intent'`, `external_ref_id` = `pi_xxx` (unique for idempotency)
    - `metadata`: `{gross_amount, platform_cut, net_credits}`
- Optionally update `cached_current_credits`.

### Renewal/anchor changes

- Stripe updates subscription period boundaries automatically. Your webhook updates the subscriptions row’s `current_period_start/end` and `billing_cycle_anchor`.
- No extra per-user reset fields needed; the invoice event is your trigger to allocate credits.

### Cancellation, failed payments, refunds

- **Payment failure**: subscription status becomes `past_due/unpaid`; do not allocate monthly credits until a successful invoice event.
- **Refunds**: insert a negative `credits_ledger` adjustment that reverses the original credit (reference the same `external_ref_id` with a different kind, e.g., `refund`).
- **Cancellation at period end**: you’ll get `customer.subscription.updated`; status and `cancel_at_period_end` set. You still allocate credits only when `invoice.payment_succeeded` fires; after cancel, no further allocations.

## Why This Is Simplest

- No duplicated “period” fields: only subscriptions holds them; profiles doesn’t.
- No duplicate ledgers: one `credits_ledger` for all activity.
- No separate topups table: entirely optional, as ledger holds all necessary fields and idempotency via `external_ref_id`.
- Stripe drives the timing; your system only reacts by adding a single `monthly_allocation` entry when an invoice is paid.

## Operational Notes

### Webhooks to Implement (idempotent, verified)

- `invoice.payment_succeeded`: add monthly_allocation credits
- `customer.subscription.created/updated/deleted`: sync subscriptions table fields
- `payment_intent.succeeded`: add topup_credit
- `charge.refunded` or `payment_intent.canceled`: insert negative ledger entries as refunds if needed

### Idempotency

- Unique constraint on `credits_ledger` (`external_ref_type`, `external_ref_id`) prevents double-crediting on webhook retries.

### Balance Reads

- **Simple**: `SUM(delta_credits) WHERE user_id = X`
- **Faster**: keep `cached_current_credits` in profiles and update it atomically on each ledger insert. This is a cache, not a source of truth.

### Pricing Mapping

- `plans` maps `stripe_price_id` to `included_credits_per_cycle`. Avoid storing `included_credits_per_cycle` on profiles; always derive from plans.

## Migration from Your Draft

- Remove `last_credit_reset_at` and `next_credit_reset_at` from profiles.
- Remove `included_credits_per_cycle` from profiles; store it in plans.
- Keep only one ledger (`credits_ledger`). Do not implement `usage_ledger` or a separate topups table unless you find a reporting need later.
- Ensure subscriptions is the only place with `current_period_start/end`.

With this, you have:

- Minimal tables
- Clear ownership of state
- Independent reset dates per user via Stripe’s cycle anchor
- Clean, auditable credit accounting via a single ledger

If you want, I can sketch event-by-event state transitions and the minimal fields each webhook should update, but I’ve kept it design-level as requested.
