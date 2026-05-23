"""Pydantic models for car_requests + inspection_jobs."""
from __future__ import annotations
from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel, Field


class CarRequestModel(BaseModel):
    id: str
    userId: Optional[str] = None
    brand: str
    model: str
    budget: int
    links: List[str] = []
    cities: List[str] = []
    status: str = "open"  # open | assigned | in_progress | completed
    jobsTotal: int = 0
    jobsClaimed: int = 0
    jobsDone: int = 0
    createdAt: datetime
    updatedAt: datetime


class InspectionJobModel(BaseModel):
    id: str
    requestId: str
    city: str
    inspectorId: Optional[str] = None
    status: str = "open"  # open | claimed | done
    brand: str  # denormalized for inspector list
    model: str
    budget: int
    createdAt: datetime
