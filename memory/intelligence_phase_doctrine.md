# Foundation Phase Closed · Intelligence Phase Doctrine

**Status:** locked. This document is institutional memory for the
architectural transition between phases. It is NOT a roadmap. It does
NOT list features. It records:

1. What changed about the system between phases.
2. Which doors are now open that were not open before.
3. The rules we follow during intelligence-phase work.
4. The order in which we approach the obvious next sprints — and why.

Update only when the meaning of the transition itself changes — not
when individual sprints ship.

---

## What was achieved (the "before / after")

### Before (P4.0 and earlier)

The platform was **request-centric**.

```
request
├─ quote
├─ inspection
├─ payment
└─ booking
```

Each entity lived next to the others. After a request closed, the
memory of what happened around it functionally died — the customer's
relationship with the *vehicle* was not modeled.

### After (P4.1 + P4.2 + P4.3)

The anchor moved from **transient transaction** to **durable real-world
object**.

```
vehicle
├─ requests[]
├─ quotes[]
├─ inspections[]
├─ payments[]
├─ bookings[]
├─ ownership state
├─ customer intent
├─ lifecycle memory
└─ future intelligence
```

Three concrete deliverables made this real:

| Sprint | Capability gained                                                          |
|--------|----------------------------------------------------------------------------|
| P4.1   | Durable object graph anchored on `vehicleId` — explicit linkage + indexes. |
| P4.2   | Single semantic kernel proven across surfaces — web ≡ mobile, no fork.     |
| P4.3   | Optimistic memory state layer with shared reconciliation invariants.       |

This is not "marketplace for requests" anymore. It is the start of:
- an **ownership platform**,
- an **automotive memory layer**,
- a **lifecycle operating system**.

---

## What this unlocks (architecturally — not as a TODO list)

These products were not buildable cleanly before. They are now.
**Architectural possibility ≠ product priority.** Listed here so the
team understands the door is open, not because they should be built
in sequence.

- **Warranty intelligence** — "11 months ago this vehicle showed brake
  wear. Re-check before winter?"
- **Resale intelligence** — "This vehicle is resale-ready: 2
  inspections, clean history, service continuity, ownership timeline."
- **Trade-in intelligence** — dealer-specific trade-in valuations
  conditioned on lifecycle.
- **Provider intelligence** — customer-side behavioral memory
  (decision speed, mobile-vs-shop preference, cancellation rate).
- **AI assistant** — context isn't a flat car list anymore; it is the
  history of `user × vehicle`.
- **Lifecycle products** — warranty, maintenance, resale, financing,
  trade-in. Each becomes a *projection*, not a new subsystem.

---

## The trap of the intelligence phase

The risk now is no longer "we under-built foundation."

The risk now is **architectural over-confidence**:

> "We have such a clean substrate — let's build a universal something
>  on top of it."

This is how good architectures die in month 6 of fast growth.
Specifically the temptations the team will face:

- ❌ Universal event bus.
- ❌ Generic entity framework.
- ❌ Plugin / extension architecture.
- ❌ Universal projection engine.
- ❌ AI abstraction layer ("our own LLM router").
- ❌ Runtime registries / dynamic dispatch.
- ❌ "Mobile-only" status / "web-only" projection.
- ❌ Cross-domain orchestration runtime.

**The current asset is `clarity of domains`. Defend it at all costs.**

When in doubt:
- Copy and project. Do not generalise.
- Add an explicit field. Do not add a runtime registry.
- Add a typed projection. Do not add a polymorphic stream.
- Add a per-surface adapter. Do not branch shared by `Platform.OS`.

---

## Recommended sprint order (strict, with rationale)

This sequence is not arbitrary. Each step assumes the prior step's
operational semantics are in place. **Do not reorder without revisiting
this document.**

### 1. Provider Workbench

Operational intelligence comes before financial maturity, and both
come before AI.

**Why first:** the marketplace's most semantically-fragile area is
provider-side. Dispatch, permissions, and earnings semantics are
operational and need to be *grounded* before money flows on top of
them and *long* before AI reasons about them.

**Scope guardrails (when this sprint runs):**
- Provider workspace, dispatch ergonomics, permission boundaries,
  earnings *semantics* (not yet payouts).
- Continues the `vehicleId`-anchored graph — provider-side projections
  read from the same shared kernel.
- NO new event bus. NO orchestration runtime.

### 2. Payment 0C

**Why second:** payouts, reconciliation, refund lifecycle, and webhook
maturity require provider semantics already to be stable. If providers
are still drifting on dispatch / permissions, payouts will encode
those bugs into accounting truth — which is the worst place for them.

**Scope guardrails:**
- Payouts, reconciliation, refunds, webhook idempotency.
- `vehicleId` propagated end-to-end (already true post-P4.1 — preserve).
- NO finance ledger framework. NO universal accounting engine.

### 3. AI assistant memory feed

**Why last (and only after 1 + 2):** AI on top of unstable operational
semantics produces a *demo*, not a product. Any "smart" recommendation
that depends on unreliable provider state or unreliable payout state
will look magical for two weeks and indefensible thereafter.

**Scope guardrails (when this sprint runs):**
- Vehicle Memory + Provider Workbench + Payment lifecycle as the LLM
  context substrate — read-only projections, not a new domain.
- NO AI orchestration framework, NO model router, NO prompt registry.
  One model, one prompt path, one explicit consumer at a time.
- AI is a *surface*, not a *domain*. It consumes shared projections
  the same way web-app and mobile do.

---

## The rule of the next phase

> **Clean semantics first. Intelligence second.**
>
> Most teams reach foundation maturity and immediately start
> "applying" intelligence. The result is brittle magic. The
> opportunity here is the inverse: stabilise the operational meaning
> of every interaction (provider workflows, payment lifecycle,
> ownership state) — *then* let intelligence read from a substrate
> that is already true.

---

## How to know we are still on track

Self-check questions for any future sprint proposal:

1. Does this sprint build a product on top of the substrate, or does
   it build *more substrate*? (After P4.3, the answer should be the
   former. If a proposal needs new substrate, that needs explicit
   architectural justification.)
2. Does it touch `/app/shared/`? (If yes, why? Shared changes during
   intelligence phase should be additive type exports or new
   projections — not new abstractions.)
3. Does it introduce a runtime registry, plugin point, or polymorphic
   stream? (If yes — stop, see the trap section.)
4. Does mobile or web-app start owning domain logic locally? (If yes
   — the surface is forking. Push the logic into shared.)
5. Is there an explicit projection consumer per surface? (If no — we
   are building generic infra again.)

If a sprint plan answers these correctly, it is on track. If not,
re-read this document before writing any code.
