# JVIDEO — GUI Design Brief, Addendum 3 (System Settings Pane + Reserve Fund)
# Paste this into the SAME Claude design conversation as the previous briefs.
# Same design system, tokens, and badge language.
# ─────────────────────────────────────────────────────────────────────────────

Two refinements to what you've already designed.

## A. Withdraw flow refinement (if Addendum 2 was already processed)

The owner withdraw flow (Addendum 2, screen 9) is now precisely: **amount →
payout phone number → reason for withdrawal (required) → Submit**, and
submit dispatches to the payout gateway. Accounting rule the UI must make
visible: every owner has a **reserve fund (minimum balance)** that can never
be withdrawn. Show the three numbers together — Balance, Reserve,
**Withdrawable** — and validate/cap against Withdrawable everywhere
(including the "withdraw all" shortcut). Exceeding it explains the reserve
("UGX 10,000 stays in your account as a reserve"), it doesn't just reject.

## B. Admin Console — System Settings pane (new screen)

A dedicated **Settings** area in the admin console (super_admin only), the
home for platform-wide defaults. Grouped, form-per-group with explicit save,
each setting showing: label, plain-language description of what it affects,
current value, and its default. Design these groups now and make the pattern
obviously extensible (more settings will land here over time):

1. **Revenue & payouts**
   - *Default revenue share (%)* — applied to newly created nodes; existing
     nodes keep their own value (per-node override lives on the node form).
   - *Default minimum balance / reserve fund* — the reserve applied to any
     owner who doesn't have their own; per-site override lives on the site/
     owner form. Money input with currency.
   - Copy note the design should carry: "Changing a default never changes
     existing sites/nodes or past records — it applies where nothing more
     specific is set."
2. **Distribution** (placeholder group, values exist in the platform):
   off-peak window start/end hours.
3. **Extensibility pattern** — how a future group/setting slots in without
   redesign (consistent row anatomy: label, description, control, default
   hint, per-entity-override note where applicable).

Also add the per-entity override fields where they belong:
- **Site/owner form**: "Minimum balance (reserve)" — optional; empty means
  "use system default (currently UGX X)".
- **Node form** already has revenue share % — add the "system default is
  X%" hint when creating.

## C. Design-system additions

- **Setting row anatomy** (label / description / control / default hint /
  override note) as a reusable pattern.
- **Balance triplet display** (Balance · Reserve · Withdrawable) used on the
  owner dashboard, the withdraw flow, and the admin withdrawal queue
  (the queue's available-balance-at-request column becomes
  withdrawable-at-request).

Everything else from the previous briefs stands.
