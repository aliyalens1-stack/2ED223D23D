"""Inspection report schemas — v1: 15-point checklist, no real media upload."""
from __future__ import annotations
from typing import List, Literal, Optional
from pydantic import BaseModel, Field


# 15-point minimum viable checklist (grow to 60 later)
CHECKLIST_ITEMS = [
    {"key": "vin", "group": "documents"},
    {"key": "service_history", "group": "documents"},
    {"key": "body_panels", "group": "body"},
    {"key": "paint_thickness", "group": "body"},
    {"key": "accident_signs", "group": "body"},
    {"key": "engine_cold_start", "group": "engine"},
    {"key": "engine_leaks", "group": "engine"},
    {"key": "gearbox", "group": "drivetrain"},
    {"key": "suspension", "group": "chassis"},
    {"key": "brakes", "group": "chassis"},
    {"key": "tires", "group": "chassis"},
    {"key": "electronics", "group": "electronics"},
    {"key": "obd_errors", "group": "electronics"},
    {"key": "interior", "group": "interior"},
    {"key": "test_drive", "group": "drive"},
]

ALLOWED_ITEM_STATUSES = {"ok", "warning", "problem", "not_checked"}
ALLOWED_VERDICTS = {"recommended", "risky", "not_recommended"}
ALLOWED_RISKS = {"low", "medium", "high"}


class ChecklistItem(BaseModel):
    key: str
    status: Literal["ok", "warning", "problem", "not_checked"] = "not_checked"
    comment: Optional[str] = None
    photos: List[str] = Field(default_factory=list)  # URLs / placeholders in v1


class Issue(BaseModel):
    severity: Literal["low", "medium", "high"] = "low"
    title: str
    description: Optional[str] = None


class SubmitReport(BaseModel):
    score: float = Field(ge=0, le=10)
    verdict: Literal["recommended", "risky", "not_recommended"]
    riskLevel: Literal["low", "medium", "high"] = "low"
    checklist: List[ChecklistItem] = Field(default_factory=list)
    issues: List[Issue] = Field(default_factory=list)
    photos: List[str] = Field(default_factory=list)
    videos: List[str] = Field(default_factory=list)
    summary: str = Field(min_length=3, max_length=4000)
    repairEstimateMin: Optional[int] = Field(default=None, ge=0)
    repairEstimateMax: Optional[int] = Field(default=None, ge=0)


class ReportOut(BaseModel):
    id: str
    jobId: str
    requestId: str
    inspectorId: str
    city: str
    score: float
    verdict: str
    riskLevel: str
    checklist: List[ChecklistItem]
    issues: List[Issue]
    photos: List[str]
    videos: List[str]
    summary: str
    repairEstimateMin: Optional[int] = None
    repairEstimateMax: Optional[int] = None
    status: str  # submitted | approved | rejected
    createdAt: str
    approvedAt: Optional[str] = None
    rejectedAt: Optional[str] = None
    rejectReason: Optional[str] = None


class RejectReport(BaseModel):
    reason: str = Field(min_length=3, max_length=1000)
