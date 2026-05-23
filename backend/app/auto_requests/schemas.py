"""Request / response schemas for Auto Requests API."""
from __future__ import annotations
from typing import List, Optional
from pydantic import BaseModel, Field, field_validator, model_validator


class CreateCarRequest(BaseModel):
    # Phase 2 — Requests Engine: two flows
    # type='inspection' → link-based check of a specific car
    # type='selection'  → selection under budget/filters
    type: str = Field(default="selection", pattern=r"^(inspection|selection)$")

    # Core (required for 'selection'; optional/empty for 'inspection' where only link matters)
    brand: Optional[str] = Field(default=None, max_length=60)
    model: Optional[str] = Field(default=None, max_length=60)
    budget: Optional[int] = Field(default=None, ge=500, le=500_000)

    # Shared
    links: List[str] = Field(default_factory=list)
    cities: List[str] = Field(default_factory=list)
    country: Optional[str] = Field(default=None, max_length=5)
    comment: Optional[str] = Field(default=None, max_length=2000)

    # P4.1 — Vehicle linkage. Optional on the wire (anonymous flow may
    # have no saved vehicle yet) but, when provided, the request becomes
    # an explicit edge in the per-vehicle memory graph. NOT validated
    # against /api/customer/vehicles existence on this layer — service
    # layer trusts the caller (consistent with existing 'links' field
    # which is also opaque). Belongs to the customer who owns the vehicle.
    vehicleId: Optional[str] = Field(default=None, max_length=64)

    # Phase 2 — selection filters
    yearFrom: Optional[int] = Field(default=None, ge=1950, le=2100)
    yearTo: Optional[int] = Field(default=None, ge=1950, le=2100)
    fuel: Optional[str] = Field(default=None, max_length=30)          # petrol/diesel/hybrid/electric
    transmission: Optional[str] = Field(default=None, max_length=30)  # manual/auto
    mileageMax: Optional[int] = Field(default=None, ge=0, le=2_000_000)

    # Phase 2 — inspection specifics
    urgency: Optional[str] = Field(default=None, max_length=20)  # asap / 24h / week

    # ── Customer Request Creation V1 — guided intake substrate
    #
    # Doctrine: capture interpretation-relevant context, NOT operational telemetry.
    # Both fields are optional on the wire (V1 supports honest incompleteness —
    # the customer can establish a request with partial substrate, additional
    # context may be recorded later).
    #
    # `uncertainty` — free-text customer-provided context: what makes them
    # want this inspection, what they're worried about, prior knowledge of the
    # vehicle history, etc. This is substrate, not analysis. Mappers (continuity,
    # cognition) MAY read structural signals (length, presence) but MUST NOT
    # render this text verbatim into customer-facing copy.
    uncertainty: Optional[str] = Field(default=None, max_length=2000)

    # `schedulingWindow` — calm continuity vocabulary for timing preference.
    # Replaces the operationally-noisy `urgency` framing on the intake surface.
    # Closed set, deterministic (no AI). When provided, mapped internally to
    # the existing `urgency` field for back-compat with downstream code:
    #   soon       → 'asap'    (within ~2 days)
    #   this_week  → '24h'     (within the working week)
    #   flexible   → 'week'    (no fixed window)
    schedulingWindow: Optional[str] = Field(
        default=None,
        pattern=r"^(soon|this_week|flexible)$",
    )

    # Phase 3 — per-request feature-flag override for soft-marketplace.
    # None = use global `feature_flags.use_exposures`. True/False = force behavior for this request.
    useExposures: Optional[bool] = Field(default=None)

    @field_validator("cities")
    @classmethod
    def _clean_cities(cls, v: List[str]) -> List[str]:
        out: List[str] = []
        seen: set[str] = set()
        for c in v:
            s = (c or "").strip()
            if not s:
                continue
            key = s.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(s)
        if len(out) > 10:
            raise ValueError("too many cities (max 10)")
        return out

    @field_validator("links")
    @classmethod
    def _clean_links(cls, v: List[str]) -> List[str]:
        out = [l.strip() for l in v if l and l.strip()]
        if len(out) > 10:
            raise ValueError("too many links (max 10)")
        return out

    @model_validator(mode="after")
    def _enforce_flow(self):
        if self.type == "inspection":
            if not self.links:
                raise ValueError("links required for inspection type")
            if not self.cities:
                raise ValueError("at least one city required")
        else:  # selection
            if not self.brand or not self.model:
                raise ValueError("brand and model required for selection type")
            if self.budget is None:
                raise ValueError("budget required for selection type")
            if not self.cities:
                raise ValueError("at least one city required")
            if self.yearFrom and self.yearTo and self.yearFrom > self.yearTo:
                raise ValueError("yearFrom must be <= yearTo")
        return self


class CarRequestOut(BaseModel):
    id: str
    userId: Optional[str] = None
    vehicleId: Optional[str] = None  # P4.1 — explicit vehicle linkage (None for legacy/anonymous flows)
    type: str = "selection"
    brand: str = ""
    model: str = ""
    budget: int = 0
    links: List[str] = []
    cities: List[str] = []
    country: Optional[str] = None
    urgency: Optional[str] = None
    yearFrom: Optional[int] = None
    yearTo: Optional[int] = None
    fuel: Optional[str] = None
    transmission: Optional[str] = None
    mileageMax: Optional[int] = None
    comment: Optional[str] = None
    # V1 intake substrate (additive, optional on legacy docs)
    uncertainty: Optional[str] = None
    schedulingWindow: Optional[str] = None
    status: str
    jobsTotal: int
    jobsClaimed: int
    jobsDone: int
    createdAt: str
    updatedAt: str


class InspectionJobOut(BaseModel):
    id: str
    requestId: str
    city: str
    inspectorId: Optional[str] = None
    status: str
    brand: str
    model: str
    budget: int
    createdAt: str


class AssignJob(BaseModel):
    jobId: str
    inspectorId: str


# ─────────────────────────────────────────────────────────────────────
# Sprint 4 — Inspection Reports
# ─────────────────────────────────────────────────────────────────────

class ChecklistItemIn(BaseModel):
    """One inspection checklist item submitted by inspector."""
    key: str = Field(min_length=1, max_length=40)
    status: str = Field(default="not_checked")  # ok | warning | problem | not_checked
    comment: Optional[str] = Field(default=None, max_length=1000)


class IssueIn(BaseModel):
    severity: str = Field(default="medium")  # low | medium | high
    title: str = Field(min_length=1, max_length=200)
    description: Optional[str] = Field(default=None, max_length=2000)


class SubmitReportRequest(BaseModel):
    score: float = Field(ge=1.0, le=10.0)
    verdict: str  # recommended | risky | not_recommended
    checklist: List[ChecklistItemIn] = Field(default_factory=list)
    issues: List[IssueIn] = Field(default_factory=list)
    summary: str = Field(min_length=10, max_length=4000)
    repairEstimateMin: Optional[int] = Field(default=None, ge=0, le=1_000_000)
    repairEstimateMax: Optional[int] = Field(default=None, ge=0, le=1_000_000)
    # Sprint 2 Step 4 — link to the AI draft that the inspector started from.
    # If present, submit_report compares fields vs the draft and writes a
    # delta into `ai_overrides_log` for future model calibration.
    aiDraftId: Optional[str] = Field(default=None, max_length=64)

    @field_validator("verdict")
    @classmethod
    def _verdict_ok(cls, v: str) -> str:
        from app.auto_requests.checklist import VERDICTS
        if v not in VERDICTS:
            raise ValueError(f"verdict must be one of {VERDICTS}")
        return v

    @field_validator("checklist")
    @classmethod
    def _checklist_keys_ok(cls, v: List[ChecklistItemIn]) -> List[ChecklistItemIn]:
        # D3: accept BOTH atomic checklist keys AND legacy group-level summary
        # keys (engine, brakes, …). See checklist.LEGACY_GROUP_ALIAS_KEYS.
        from app.auto_requests.checklist import ACCEPTED_CHECKLIST_KEYS, ITEM_STATUSES
        for it in v:
            if it.key not in ACCEPTED_CHECKLIST_KEYS:
                raise ValueError(f"unknown checklist key: {it.key}")
            if it.status not in ITEM_STATUSES:
                raise ValueError(f"invalid status for {it.key}: {it.status}")
        return v


class ReportOut(BaseModel):
    id: str
    jobId: str
    requestId: str
    inspectorId: str
    city: str
    brand: str
    model: str
    score: float
    verdict: str
    checklist: List[dict]
    issues: List[dict]
    summary: str
    repairEstimateMin: Optional[int] = None
    repairEstimateMax: Optional[int] = None
    status: str  # submitted | approved | rejected
    rejectReason: Optional[str] = None
    createdAt: str
    approvedAt: Optional[str] = None


class CancelJobRequest(BaseModel):
    reason: Optional[str] = Field(default=None, max_length=500)


class RejectReportRequest(BaseModel):
    reason: str = Field(min_length=3, max_length=1000)
