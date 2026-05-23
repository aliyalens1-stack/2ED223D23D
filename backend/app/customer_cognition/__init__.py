"""Customer Report Cognition — restrained interpretive read layer.

Pass A doctrine (chat contract, Step 2):
  • Customer never "reads the report". Customer receives a structured
    interpretation of inspection continuity.
  • Substrate is REUSED, not regenerated: inspection_drafts (contradictions,
    missingEvidence, topProblems, recommendedActions, severityDistribution),
    inspection_jobs (status), users.reputation (hard_floor).
  • All wording is produced HERE. Operational copy (draft.summary,
    draft.reasoning, problem.note, action strings) is NEVER proxied.
  • Forbidden lexicon (AI / confidence / probability / score / rating /
    accuracy / expert / guaranteed / percentages / traffic-light /
    "vehicle passed" / "safe to buy" / "recommended purchase" / "safe
    investment") is structurally impossible.
  • Gating: cognition surface exists ONLY for delivered reports. Before
    delivery the response is `{ ok:false, reason:'forming' }` with the
    interpretation line "Interpretation continuity is still forming."
  • Same pattern as Observatory: deterministic restrained interpreter.

Public endpoint:
  GET /api/customer/inspection/{job_id}/report-cognition
"""
from .router import router

__all__ = ["router"]
