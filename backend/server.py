from fastapi import FastAPI, Request, Response, HTTPException, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os, logging, httpx, uuid, bcrypt, asyncio, subprocess, random, jwt, time
from prod_readiness import (
    check_rate_limit,
    idempotency_lookup,
    idempotency_commit,
    ensure_idempotency_indexes,
    ensure_alert_indexes,
    ensure_ttl_indexes,
    dispatch_alert,
    write_audit,
    nest_breaker,
)
from pathlib import Path
from typing import Optional
from datetime import datetime, timezone, timedelta

# Sprint 21 PRE-COMMIT 0: shared AppContext.
# Контейнер заполняется ниже (после db) и в конце секции realtime emitters.
from app.core.context import ctx, RealtimeEmitters

# Sprint 21 C1: core modules (config / utils / security).
# ВСЕ константы и JWT/bcrypt-хелперы теперь живут в app/core/*.
# server.py читает их через re-export, никаких поведенческих изменений.
# load_dotenv() выполняется внутри app/core/config.py — до любого os.environ.get.
from app.core.config import (
    MONGO_URL, DB_NAME, NESTJS_URL, NESTJS_ENABLED,
    ADMIN_BUILD_DIR, WEBAPP_BUILD_DIR,
    JWT_SECRET, JWT_ALGO,
    ADMIN_EMAIL, ADMIN_PASSWORD,
)
from app.core.utils import now_utc, uid
from app.core.security import hash_pw, verify_pw, verify_admin_token
from app.core.db import get_db
from app.core.realtime import emit_realtime_event
from app.core.metrics import metrics
# Phase 1B Tier 2 — pure sync cluster enrichment for admin governance writers.
from app.core.cluster_writer import enrich_with_cluster, DEFAULT_ADMIN_ACTION_CLUSTER

ROOT_DIR = Path(__file__).parent

# Shim: старый код использует lowercase mongo_url/db_name — оставляем для
# обратной совместимости. Будет удалено после миграции всех вызовов (C22).
mongo_url = MONGO_URL
db_name = DB_NAME
client = AsyncIOMotorClient(mongo_url)
db = client[db_name]

app = FastAPI()
# Sprint 21 C15: lifespan подключён параллельно с существующими @app.on_event
# хендлерами. FastAPI 0.93+ корректно отрабатывает оба: сначала lifespan enter,
# потом on_event("startup"), при выключении — on_event("shutdown") и lifespan exit.
# На этом этапе lifespan делает только DB ping + ML hydration (idempotent).
# Loops/seed/NestJS остаются в startup_with_feedback до C15.1.
from app.core.lifespan import lifespan as _c15_lifespan  # noqa: E402
app.router.lifespan_context = _c15_lifespan

# Sprint 21 C5: первый APIRouter разрез — /api/auth/* перенесён в app/system/auth.py.
# include_router должен идти ПЕРЕД определением старых @app.post("/api/auth/...")
# чтобы при reload старые definitions либо были первыми-встреченными (резерв), либо
# вообще удалены — в любом случае новый модуль первый в route-list.
from app.system.auth import router as auth_router
app.include_router(auth_router)

# Sprint 2FA — TOTP-based two-factor auth (/api/auth/2fa/*).
# Must be registered AFTER /api/auth/* so the prefix routes resolve in order.
from app.two_factor.router import router as two_factor_router, ensure_indexes as _2fa_indexes
app.include_router(two_factor_router)


@app.on_event("startup")
async def _startup_two_factor_indexes():  # pragma: no cover — idempotent
    try:
        await _2fa_indexes()
    except Exception:
        pass

# Sprint 21 C6: health + system endpoints вынесены в app/system/health.py и
# app/system/system.py. include_router'ы идут перед определениями старых
# endpoints (FastAPI first-match resolve).
from app.system.health import router as health_router
from app.system.system import router as system_router
from app.system.telemetry import router as telemetry_router
# Sprint P0.b.C.e: stateless deep-link resolver (asearch:// scheme support).
# Intentionally NOT a permission engine — returns target metadata only.
from app.system.deeplink import router as deeplink_router
# Sprint P0.b.C.f: payment chronology — REST + WS for 3 actor projections.
from app.payments.chronology.router import router as payment_chronology_router
app.include_router(health_router)
app.include_router(system_router)
app.include_router(telemetry_router)
app.include_router(deeplink_router)
app.include_router(payment_chronology_router)

# Hygiene-pass 404 cleanup: NestJS-наследники, которые отвалились вместе с
# `NESTJS_ENABLED=0` и оставили Dashboard / Live Feed пустыми в админке.
# Подключаем ДО любого catch-all proxy.
from app.system.realtime import router as realtime_router
from app.admin.control_tower import router as control_tower_router
app.include_router(realtime_router)
app.include_router(control_tower_router)

# Sprint 21 C7: /api/admin-panel/* и /api/web-app/* (SPA static) вынесены
# в app/static/router.py. include_router ДО proxy_to_nestjs catch-all
# (в конце server.py), чтобы specific static routes выигрывали first-match.
from app.static.router import router as static_router
app.include_router(static_router)

# Sprint 21 C8: simple-proxy compat endpoints (6 штук: /api/disputes,
# /notifications/my, /favorites/my, /organizations/search, /garage/{id},
# /payments/list) вынесены в app/system/compat.py. Admin-compat остаётся
# в server.py — у него mixed native+proxy логика.
from app.system.compat import router as compat_router
app.include_router(compat_router)

# Sprint 21 FINAL — Governance domain (37 endpoints extracted from server.py).
# Includes demand-push, provider behavior, flow control, demand action chains,
# revenue A/B experiments, monetization promote/priority, distribution config,
# billing revenue, zone admin controls, push-device legacy, simulation/analytics.
# Server.py теперь содержит только bootstrap + middleware + lifecycle + catch-all proxy.
from app.governance import router as governance_router  # noqa: E402
app.include_router(governance_router)

# Sprint 21 C8: shared proxy helper переехал в app/core/proxy.py. Оставшиеся
# admin-compat endpoints (live-feed, alerts, automation/replay, config/features,
# config/commission-tiers) используют его через thin-wrapper _proxy_to ниже.
from app.core.proxy import proxy_to_nest

# Sprint 21 C9: Quick Request CORE (resolve/accept/reject/inbox/status +
# admin/ranking/* + ranking optimizer loop + auto-expire) вынесен в
# app/marketplace/quick_request.py. 8 endpoints регистрируются здесь, фоновый
# provider_ranking_optimizer_loop запускается в startup_with_feedback().
from app.marketplace.quick_request import (
    router as qr_router,
    provider_ranking_optimizer_loop,
)
app.include_router(qr_router)

# Sprint 21 C10: Marketplace + Matching + Zones + Demand + Distribution domain
# (35 endpoints) вынесены в app/marketplace/{providers,matching,zones}.py и
# агрегированы через app/marketplace/router.py. include_router идёт ДО
# catch-all NestJS proxy в конце server.py.
from app.marketplace.router import router as marketplace_router
app.include_router(marketplace_router)

# Stage 2 — Geo + Search: cities catalogue
from app.marketplace.cities import router as cities_router  # noqa: E402
app.include_router(cities_router)
from app.marketplace.partner_register import router as partner_register_router  # noqa: E402
app.include_router(partner_register_router)
from app.admin.partner_verifications import router as partner_verifications_router  # noqa: E402
app.include_router(partner_verifications_router)

# Geo-1 sprint — canonical geo namespace (countries + cities + inspector topology)
from app.geo import router as geo_router  # noqa: E402
app.include_router(geo_router)

# Geo-2 sprint — provider topology (baseCountry, baseCityId, travelRadiusKm)
from app.geo.topology import router as topology_router  # noqa: E402
app.include_router(topology_router)

# Geo-3 sprint — operational coverage projection (read-only marketplace density)
from app.geo.coverage_projection import router as coverage_router  # noqa: E402
app.include_router(coverage_router)

# Sprint UX-1 — Support tickets (real backend endpoint, replaces mailto fallback)
from app.system.support_tickets import router as support_tickets_router  # noqa: E402
app.include_router(support_tickets_router)

# UX-3A — Inspection Report v2 (section-based with per-item media)
from app.inspections.v2 import router as inspections_v2_router  # noqa: E402
from app.inspections.timeline import router as inspections_timeline_router  # noqa: E402
app.include_router(inspections_v2_router)
app.include_router(inspections_timeline_router)

# Stage 3 — Services + Booking (requests / quotes / accept)
from app.marketplace.requests import router as requests_router  # noqa: E402
app.include_router(requests_router)

# Stage 4 — Payments (Stripe Checkout) + Revenue
from app.payments.router import router as payments_router  # noqa: E402
app.include_router(payments_router)

# Phase 3.0b P0-1 — Inline payment for auto-requests (one-shot Stripe Checkout)
from app.payments.checkout_simple import (  # noqa: E402
    router as ar_checkout_router,
    webhook_router as ar_webhook_router,
)
app.include_router(ar_checkout_router)
app.include_router(ar_webhook_router)

# ═══════════════════════════════════════════════════════════════════════
# AUTO 2.0 · Auto Requests Core (Sprint 2) — car_requests + inspection_jobs.
# ЕСТЬ 1:N: 1 request → N jobs (по городам). НЕ смешивать с legacy repair.
# ═══════════════════════════════════════════════════════════════════════
from app.auto_requests.router_customer import router as ar_customer_router, reports_router as ar_customer_reports_router  # noqa: E402
from app.auto_requests.router_inspector import router as ar_inspector_router, checklist_router as ar_inspector_checklist_router  # noqa: E402
from app.auto_requests.router_admin import router as ar_admin_router  # noqa: E402
from app.auto_requests.router_marketplace import (  # noqa: E402
    inspector_router as ar_mkt_inspector_router,
    customer_router as ar_mkt_customer_router,
)
from app.auto_requests.router_media import (  # noqa: E402
    inspector_media_router,
    customer_media_router,
    public_media_router,
)
app.include_router(ar_customer_router)
app.include_router(ar_customer_reports_router)
app.include_router(ar_inspector_checklist_router)
app.include_router(ar_inspector_router)
app.include_router(ar_admin_router)
app.include_router(ar_mkt_inspector_router)
app.include_router(ar_mkt_customer_router)
app.include_router(inspector_media_router)
app.include_router(customer_media_router)
app.include_router(public_media_router)

# Phase C.3 — Provider Workspace: candidate cars on selection requests.
from app.auto_requests.router_candidates import (  # noqa: E402
    provider_router as ar_provider_candidates_router,
    customer_router as ar_customer_candidates_router,
)
app.include_router(ar_provider_candidates_router)
app.include_router(ar_customer_candidates_router)

# AUTO 2.0 — Job-scoped media (P0 inspector execution flow): photos/videos
# tied to inspection_job + category (exterior/interior/engine/...). Separate
# from report-scoped media — uploadable BEFORE report submission.
from app.auto_requests.job_media import (  # noqa: E402
    router as job_media_router,
    public_router as job_media_public_router,
)
app.include_router(job_media_router)
app.include_router(job_media_public_router)

# AUTO 3.0 — Inspector personal stats (P1 trust loop): rating, completed, earnings.
from app.auto_requests.router_inspector_stats import router as inspector_stats_router  # noqa: E402
app.include_router(inspector_stats_router)

# Inspector operating profile — identity + trust + capability snapshot.
from app.auto_requests.router_inspector_profile import router as inspector_profile_router  # noqa: E402
app.include_router(inspector_profile_router)

# Inspector Cabinet — full /inspector/* surface (dashboard, profile PATCH,
# inspections archive, availability, payouts, performance, verification,
# security, settings, change-password).
from app.inspector.cabinet import router as inspector_cabinet_router  # noqa: E402
app.include_router(inspector_cabinet_router)

# Sprint 2 Step 1 — Timeline Engine: durable event spine for inspector ops.
# Public endpoints: POST /api/inspector/timeline/append + GET /api/inspector/timeline.
from app.inspector.timeline import router as inspector_timeline_router  # noqa: E402
app.include_router(inspector_timeline_router)

# Sprint 2 Step 2 — Customer Contact Unlock (read-only visibility resolver).
# GET /api/inspector/jobs/{job_id}/contact + deprecated POST /contact/reveal
from app.inspector.contact import router as inspector_contact_router  # noqa: E402
app.include_router(inspector_contact_router)

# Sprint 2 Step 2 — Contact Reveal Audit (admin-only).
# GET /api/admin/contact-reveals
from app.admin.contact_audit import router as admin_contact_audit_router  # noqa: E402
app.include_router(admin_contact_audit_router)

# Sprint 2 Step 4 — Draft Intelligence Engine.
# POST /api/inspector/jobs/{id}/draft  +  GET .../drafts
from app.intelligence.router import router as intelligence_router  # noqa: E402
app.include_router(intelligence_router)

# Sprint 2 Step 5 — Offline Queue (R2) audit log.
# POST /api/inspector/offline-replay/log + GET /api/admin/offline-replay/recent
from app.inspector.offline_replay import router as inspector_offline_replay_router  # noqa: E402
app.include_router(inspector_offline_replay_router)

# Sprint 3 Step 1 — Verification Admin Queue.
# GET/POST /api/admin/verification-queue/*
from app.admin.verification_queue import router as admin_verification_queue_router  # noqa: E402
app.include_router(admin_verification_queue_router)

# P3.3 — Reconciliation router (cross-truth divergence detector).
# READ-ONLY surface over app.payments.reconciliation. Admin-only.
# GET /api/admin/reconciliation/report
# GET /api/admin/reconciliation/taxonomy
from app.payments.router_reconciliation import router as reconciliation_router  # noqa: E402
app.include_router(reconciliation_router)

# P3.4 — Forensic navigation graph (READ-ONLY).
# GET /api/admin/forensic-graph/
# GET /api/admin/forensic-graph/{entity_type}/{entity_id}
from app.admin.forensic_graph import router as forensic_graph_router  # noqa: E402
app.include_router(forensic_graph_router)

# P5.1 — Attribution read router (READ-ONLY admin_audit_log queries).
# GET /api/admin/attribution/by-actor/{actor_id}
# GET /api/admin/attribution/by-entity/{entity_id}
# GET /api/admin/attribution/recent
from app.admin.attribution_router import router as attribution_router  # noqa: E402
app.include_router(attribution_router)


# Sprint 3 Step 2 — Notification projector + polling endpoints.
# GET /api/notifications/unread-count
# GET /api/notifications/since
# POST /api/admin/notifications/backfill
from app.notifications.projector import router as notifications_projector_router  # noqa: E402
app.include_router(notifications_projector_router)

# Sprint Customer-Notify-2 — dry-run audit pipeline:
# GET  /api/admin/customer-notify/audit
# POST /api/admin/customer-notify/preview
# POST /api/admin/customer-notify/project
from app.notifications.customer_pipeline import router as customer_notify_router  # noqa: E402
app.include_router(customer_notify_router)

# Sprint Bounce-1 (2026-05-15) — Postmark webhook ingress for
# suppression namespace. URL: /api/notifications/webhooks/postmark/<secret>.
# Always returns 200 (never feed provider retry queue).
from app.notifications.webhooks.postmark import router as postmark_webhook_router  # noqa: E402
app.include_router(postmark_webhook_router)

# Sprint 3 Step 3 — Reputation Engine
# GET  /api/inspector/reputation
# GET  /api/inspector/reputation/history
# GET  /api/admin/reputation
# POST /api/admin/reputation/recompute/{userId}
from app.reputation.router import router as reputation_router  # noqa: E402
app.include_router(reputation_router)

# Sprint 5 — Trust & Retention Layer (provider reputation, blind-reveal reviews)
# POST /api/trust/reviews                          — submit review
# GET  /api/trust/reviews/pending                  — my outstanding reviews
# GET  /api/trust/reviews/by-request/{rid}         — pair state
# GET  /api/trust/providers/{id}                   — trust card
# GET  /api/trust/providers/{id}/reviews           — revealed reviews
# GET  /api/admin/trust/reviews                    — admin viewer
# POST /api/admin/trust/recompute/{provider_id}    — admin recompute
from app.provider_trust.router import router as provider_trust_router  # noqa: E402
app.include_router(provider_trust_router)

# Sprint 6 — Disputes & Resolution Layer
# POST /api/disputes                               — open
# GET  /api/disputes/my                            — user list
# GET  /api/disputes/{id}                          — detail (party or admin)
# GET  /api/admin/disputes                         — admin queue + stats
# GET  /api/admin/disputes/{id}                    — admin detail w/ timeline+chat+reputation
# POST /api/admin/disputes/{id}/resolve            — release | partial | refund
from app.disputes.router import router as disputes_router  # noqa: E402
app.include_router(disputes_router)

# Sprint 7 — Stripe Connect Express (real money escrow + payouts)
# POST /api/connect/onboarding/start               — provider: create account + onboarding link
# POST /api/connect/onboarding/refresh             — provider: refresh expired link
# GET  /api/connect/onboarding/status              — provider: capabilities snapshot
# POST /api/payments/stripe/escrow/intent          — customer: PaymentIntent for service_request
# POST /api/payments/stripe/escrow/release/{pid}   — release escrow via Transfer (12h delay + freeze gates)
# POST /api/payments/stripe/escrow/refund          — admin: real Stripe Refund (used by dispute resolution)
# GET  /api/admin/payments/platform-status         — admin: freeze + onboarding stats
# POST /api/admin/payments/freeze                  — admin: emergency freeze ALL payouts
# POST /api/admin/payments/unfreeze                — admin: lift platform freeze
# POST /api/admin/payments/freeze-provider/{id}    — admin: per-provider freeze
# POST /api/billing/webhook/connect                — Stripe webhook (signature + idempotency)
from app.integrations.router_connect import router as stripe_connect_router  # noqa: E402
app.include_router(stripe_connect_router)

# Sprint 8 — Operational Alerts
# GET  /api/admin/ops/alerts                       — high-dispute/frozen/stuck/webhooks/queue snapshot
from app.admin.ops_alerts import router as ops_alerts_router  # noqa: E402
app.include_router(ops_alerts_router)

# Sprint P0.d — Admin money + moderation surface (payouts / payments / reviews)
# - /api/admin/payouts/*           approve / hold / process (FSM with `failed` terminal)
# - /api/admin/payments/*          refund / retry (escrow)
# - /api/admin/reviews-mod/*       flag / restore / exclude-rating
# All actions append-only into `money_audit`. Released/paid/refunded immutable.
from app.admin.p0d import router as p0d_router, ensure_indexes as _p0d_ensure_indexes  # noqa: E402
app.include_router(p0d_router)

# Sprint P0.b.A — Booking lifecycle freeze (sidecar; existing flows untouched)
# - /api/admin/booking-lifecycle/states                  frozen FSM
# - /api/admin/booking-lifecycle/{id}                    state + projection + timeline
# - /api/admin/booking-lifecycle/{id}/transition         admin transition (FSM + audit)
# Backed by append-only `booking_timeline` collection.
from app.booking import router as booking_lifecycle_router, customer_router as booking_customer_router, provider_router as booking_provider_router, inspector_router as booking_inspector_router, ensure_indexes as _booking_ensure_indexes  # noqa: E402
app.include_router(booking_lifecycle_router)
app.include_router(booking_customer_router)
app.include_router(booking_provider_router)
app.include_router(booking_inspector_router)


@app.on_event("startup")
async def _p0d_startup() -> None:
    try:
        await _p0d_ensure_indexes(db)
    except Exception as e:
        logging.getLogger(__name__).warning(f"[p0d] index ensure failed: {e}")


@app.on_event("startup")
async def _booking_lifecycle_startup() -> None:
    try:
        await _booking_ensure_indexes(db)
    except Exception as e:
        logging.getLogger(__name__).warning(f"[booking_lifecycle] index ensure failed: {e}")

# Sprint 3 Step 4 — Live Assignments
# Inspector: GET /live, POST /{id}/accept, POST /{id}/decline
# Admin: POST /create, GET /assignments, POST /{id}/cancel
from app.assignments.router import router as assignments_router  # noqa: E402
app.include_router(assignments_router)

# Sprint 3 Step 5 — Ops Map (read-only projection)
# GET /api/admin/ops-map/snapshot
from app.ops_map.router import router as ops_map_router  # noqa: E402
app.include_router(ops_map_router)

# Operator Cognition Observatory — interpretive read of live substrate.
# GET /api/operator/observatory (admin-gated, manual refresh only).
from app.observatory import router as observatory_router  # noqa: E402
app.include_router(observatory_router)

# Customer Inspection Continuity — restrained cognition surface.
# GET /api/customer/inspection/{jobId}/continuity (customer-gated, per-inspection).
from app.customer_continuity import router as customer_continuity_router  # noqa: E402
app.include_router(customer_continuity_router)

# Step 2 — Customer Report Cognition (Pass A): deterministic restrained
# interpreter built atop inspection_drafts + inspection_jobs. Same
# customer-only auth gate as continuity, same per-jobId scope.
from app.customer_cognition import router as customer_cognition_router  # noqa: E402
app.include_router(customer_cognition_router)


# AUTO 3.0 — Dynamic pricing (P1 monetization): public + admin endpoints,
# Mongo-backed, no hardcoded prices in frontend.
from app.pricing.router import (  # noqa: E402
    public_router as pricing_public_router,
    admin_router as pricing_admin_router,
)
app.include_router(pricing_public_router)
app.include_router(pricing_admin_router)

# Pricing projection — distance surcharge calculator (city + 100 km included,
# tiered remote compensation beyond that). See app/pricing/tiers.py.
from app.pricing.projection_router import (  # noqa: E402
    projection_router as pricing_projection_router,
    inspector_pricing_router,
    admin_pricing_router,
)
app.include_router(pricing_projection_router)
app.include_router(inspector_pricing_router)
app.include_router(admin_pricing_router)

# Pricing-3 — customer-facing request-level quote endpoints (live preview +
# freeze on confirm + snapshot back onto the request doc).
from app.pricing.customer_quote_router import quote_router as pricing_quote_router  # noqa: E402
app.include_router(pricing_quote_router)

# Pricing-v2 — density-aware preview + modifier table + version registry.
# Read-only. Lives ALONGSIDE v1; v1 routes & confirmed quotes are untouched.
from app.pricing.projection_v2_router import router as pricing_v2_router  # noqa: E402
app.include_router(pricing_v2_router)

# Matching-v2 — density-aware dispatch policy projection (Sprint 1).
# Reads frozen `pricingSnapshot.densitySnapshot.effectiveDensity` and
# returns the locked dispatch policy (radius / batch / TTL / policy).
# NEVER recalculates density. NO broadcast in Sprint 1 — projection only.
from app.matching_v2.router import router as matching_v2_router  # noqa: E402
app.include_router(matching_v2_router)

# Car Selection — advisory workflow (Sprint 1).
# Separate namespace from inspection / marketplace. Customer-facing
# "Подбор авто" form persists into `car_selection_requests` collection;
# admin sees queue and assigns workers; lifecycle is strict.
from app.car_selection.router_customer import router as car_selection_customer_router  # noqa: E402
from app.car_selection.router_admin import router as car_selection_admin_router  # noqa: E402
from app.car_selection.router_provider import router as car_selection_provider_router  # noqa: E402
app.include_router(car_selection_customer_router)
app.include_router(car_selection_admin_router)
app.include_router(car_selection_provider_router)

# Car-Selection-4 — append-only thread + notifications projection.
from app.car_selection_thread.router_customer import router as cst_customer_router  # noqa: E402
from app.car_selection_thread.router_provider import router as cst_provider_router  # noqa: E402
from app.car_selection_thread.router_admin import router as cst_admin_router  # noqa: E402
from app.car_selection_thread.router_inbox import router as cst_inbox_router  # noqa: E402
app.include_router(cst_customer_router)
app.include_router(cst_provider_router)
app.include_router(cst_admin_router)
app.include_router(cst_inbox_router)

# Car-Selection-6 — Offer Packages (immutable commercial deliverables).
# Lives in a SEPARATE bounded context from the thread:
#   thread        → append-only conversation
#   artifacts     → immutable evidence (shared)
#   offer_package → frozen-on-deliver commercial commitment
# Lifecycle: draft → delivered → accepted | declined | revoked.
# See /app/backend/app/offer_packages/__init__.py for the discipline.
from app.offer_packages.router_provider import router as op_provider_router  # noqa: E402
from app.offer_packages.router_customer import router as op_customer_router  # noqa: E402
from app.offer_packages.router_admin import router as op_admin_router  # noqa: E402
app.include_router(op_provider_router)
app.include_router(op_customer_router)
app.include_router(op_admin_router)

# Payments-1 — snapshot-bound checkout. Reads `car_requests.pricing`
# ONLY; never recomputes. Refuses to charge if snapshot is missing or
# unconfirmed. Self-contained payment record with full snapshot copy.
from app.payments.snapshot_checkout import router as snapshot_checkout_router  # noqa: E402
app.include_router(snapshot_checkout_router)

# Sprint 5 Block 3 — PayPal credit purchases
from app.payments.router_paypal import router as paypal_router  # noqa: E402
app.include_router(paypal_router)

# ═══════════════════════════════════════════════════════════════════════
# AUTO 2.0 · Packages + Payments (Sprint 3) — credits-based economy.
# Packages catalog: 1 / 3 / 5 inspections · Stripe real + PayPal mock.
# ═══════════════════════════════════════════════════════════════════════
from app.packages.router_packages import router as pkg_router  # noqa: E402
from app.packages.router_admin import router as pkg_admin_router  # noqa: E402
app.include_router(pkg_router)
app.include_router(pkg_admin_router)

# Sprint 21 C11: Orchestrator domain router (admin/governance/*, orchestrator/*,
# feedback/*). Регистрируем ДО catch-all NestJS proxy в конце server.py.
from app.orchestrator.router import router as orchestrator_router  # noqa: E402
app.include_router(orchestrator_router)

# Sprint 21 C12A: Admin domain router — dashboard (live-feed/alerts/alerts-enhanced)
# + forecast (status/retrain). Ranking остался в app.marketplace.quick_request.
# Регистрируем ДО catch-all NestJS proxy, иначе FastAPI first-match проксирует в NestJS.
from app.admin.router import router as admin_router  # noqa: E402
app.include_router(admin_router)

# Stripe runtime settings — admin-managed (keys, currency, payment methods)
from app.admin.stripe_settings import router as stripe_settings_router  # noqa: E402
app.include_router(stripe_settings_router)

# Chat + Notifications (Sprint 34 D8) — user↔provider, user↔support
from app.chat.router import router as chat_router  # noqa: E402
app.include_router(chat_router)
from app.chat.canonical import router as chat_v1_router  # noqa: E402
app.include_router(chat_v1_router)

# Sprint 21 C16: provider/customer/billing domain routers extracted from server.py.
# 40 endpoints total (23 provider + 10 customer + 7 billing/experiments).
# Регистрируем ДО catch-all NestJS proxy.
from app.provider.router import router as provider_router  # noqa: E402
from app.customer.router import router as customer_router  # noqa: E402
from app.vehicles import router as vehicles_router  # noqa: E402  Sprint 2B — Vehicle Memory MVP
from app.vehicles.public_memory import (  # noqa: E402  Vehicle as Memory System (public)
    router as vehicle_public_memory_router,
    seed_demo_vehicle as _seed_demo_vehicle,
)
from app.vehicles.ingest import router as vehicle_ingest_router  # noqa: E402  Listing → Vehicle pipeline
from app.vehicles.refresh import router as vehicle_refresh_router  # noqa: E402  Temporal evolution layer
from app.vehicles.watchlist import router as vehicle_watchlist_router  # noqa: E402  Subscriptions/feed layer
from app.vehicles.market_searches import router as market_searches_router  # noqa: E402  Saved searches / market subscriptions
from app.billing.router import router as billing_router  # noqa: E402
from app.billing.stripe_payments import router as stripe_router  # noqa: E402  Sprint 22
from app.performance import router as performance_router, init as performance_init  # noqa: E402  Sprint 26
from app.revenue import router as revenue_router, init as revenue_init  # noqa: E402  Sprint 28
from app.marketplace.auction import router as auction_router  # noqa: E402  Sprint 27
from app.referrals import router as referrals_router  # noqa: E402  Sprint 29
from app.retention import router as retention_router  # noqa: E402  Sprint 30
from app.push import router as push_router  # noqa: E402  Sprint 31
from app.market_playbooks import router as domination_router  # noqa: E402  Sprint 32
from app.marketplace.clusters import router as clusters_router  # noqa: E402  Sprint 33
from app.growth.reactivation import router as growth_reactivation_router  # noqa: E402  Sprint 33 C8.1
from app.growth.nudges import router as growth_nudges_router  # noqa: E402  Sprint 33 C8.2
from app.growth.auto_money import router as growth_auto_money_router  # noqa: E402  Sprint 33 C8.4
from app.parsers.router import router as parsers_router  # noqa: E402  Berlin Launch B2 — mobile.de parser
from app.inspection.router import router as inspection_router  # noqa: E402  Berlin Launch B1 — Inspection Report
from app.provider.onboarding import router as provider_onboarding_router  # noqa: E402  Berlin Launch B-PO — Provider Onboarding v1
app.include_router(provider_router)
app.include_router(provider_onboarding_router)
app.include_router(customer_router)
app.include_router(vehicles_router)  # Sprint 2B — Vehicle Memory MVP
app.include_router(vehicle_public_memory_router)  # Vehicle as Memory System (public /vehicle/:id)
app.include_router(vehicle_ingest_router)  # Listing → Vehicle pipeline (POST /api/vehicles/ingest, /decode-vin)
app.include_router(vehicle_refresh_router)  # Temporal evolution (POST /:id/refresh, /simulate-change, GET /:id/snapshots)
app.include_router(vehicle_watchlist_router)  # Subscriptions/feed (POST /:id/watch, /api/watchlist/:wid/feed)
app.include_router(market_searches_router)  # Saved searches (POST /api/searches, /preview, list/delete)
app.include_router(billing_router)
app.include_router(stripe_router)
app.include_router(performance_router)
app.include_router(revenue_router, dependencies=[Depends(verify_admin_token)])
app.include_router(auction_router)
app.include_router(referrals_router)
app.include_router(retention_router)
app.include_router(push_router)
app.include_router(domination_router)
app.include_router(clusters_router)
app.include_router(growth_reactivation_router)
app.include_router(growth_nudges_router)  # Sprint 33 C8.2 — Smart Nudge Engine
app.include_router(growth_auto_money_router)  # Sprint 33 C8.4 — Auto-money mode
app.include_router(parsers_router)  # Berlin Launch B2 — POST /api/parse/car-link (mobile.de)
app.include_router(inspection_router)  # Berlin Launch B1 — POST /api/inspection/report/generate

# Phase D Pass 1 — Runtime Continuity Ledger.
# Append-only continuity-topology trace. NOT analytics. See
# /app/backend/app/runtime_ledger/__init__.py for the full doctrine.
from app.runtime_ledger import router as runtime_ledger_router  # noqa: E402
from app.runtime_ledger import ensure_indexes as _runtime_ledger_ensure_indexes  # noqa: E402
app.include_router(runtime_ledger_router)

# Phase 4 Sprint A — Real-Production layer.
# Admin-editable integration credentials + credentials-backed Stripe surface
# + supervisor visibility (Q2 trigger fired).
from app.integrations.router_admin_integrations import router as integrations_admin_router  # noqa: E402
from app.integrations.router_stripe import (  # noqa: E402
    router_payments as stripe_payments_router,
    router_webhook as stripe_webhook_router,
)
from app.admin.router_workers import router as admin_workers_router  # noqa: E402
app.include_router(integrations_admin_router)
app.include_router(stripe_payments_router)
app.include_router(stripe_webhook_router)
app.include_router(admin_workers_router)

# ── Service Marketplace v1 (unified exchange for 9 service categories) ─
from app.service_marketplace import (  # noqa: E402
    customer_router as service_marketplace_customer_router,
    provider_router as service_marketplace_provider_router,
    admin_router as service_marketplace_admin_router,
    public_router as service_marketplace_public_router,
    provider_geo_router as service_marketplace_geo_router,
    admin_dispatch_router as service_marketplace_dispatch_router,
    notifications_router as service_marketplace_notifications_router,
)
app.include_router(service_marketplace_customer_router)
app.include_router(service_marketplace_provider_router)
app.include_router(service_marketplace_admin_router)
# Public open marketplace (no-auth feed + provider-auth bid). Under
# `/api/marketplace/*` namespace — see router_public.py for rationale.
app.include_router(service_marketplace_public_router)
# Sprint 2 — Geo Matching & Live Dispatch
app.include_router(service_marketplace_geo_router)
app.include_router(service_marketplace_dispatch_router)
app.include_router(service_marketplace_notifications_router)

# ── Sprint 3A — Escrow & Monetization Core ──────────────────────────────
# service_payments + provider_subscriptions + revenue dashboard.
# accept-bid (выше) импортирует create_payment_for_bid через runtime-import,
# поэтому порядок include здесь после service_marketplace не критичен.
from app.escrow import (  # noqa: E402
    customer_payments_router as escrow_customer_payments_router,
    webhook_router as escrow_webhook_router,
    subscriptions_router as escrow_subscriptions_router,
    admin_revenue_router as escrow_admin_revenue_router,
)
app.include_router(escrow_customer_payments_router)
app.include_router(escrow_webhook_router)
app.include_router(escrow_subscriptions_router)
app.include_router(escrow_admin_revenue_router)

# ── Sprint 4 — Service Chat + Timeline (Real-Time Communication Layer) ───
# Polling-based (5–10s). Anti-bypass scanner. Admin moderation.
# Зависит от service_marketplace + escrow.
from app.service_chat import (  # noqa: E402
    service_chat_router,
    admin_chats_router,
    timeline_router as service_timeline_router,
)
app.include_router(service_chat_router)
app.include_router(admin_chats_router)
app.include_router(service_timeline_router)




@app.on_event("startup")
async def _runtime_ledger_startup() -> None:
    await _runtime_ledger_ensure_indexes()


@app.on_event("startup")
async def _provider_trust_startup() -> None:
    """Sprint 5 — ensure indexes for provider_reviews + provider_reputation."""
    try:
        from app.provider_trust.engine import ensure_indexes as _trust_indexes
        await _trust_indexes(db)
    except Exception as e:
        logging.getLogger(__name__).warning(f"[trust] index ensure failed: {e}")


@app.on_event("startup")
async def _disputes_startup() -> None:
    """Sprint 6 — ensure indexes for disputes."""
    try:
        from app.disputes.router import ensure_indexes as _disputes_indexes
        await _disputes_indexes(db)
    except Exception as e:
        logging.getLogger(__name__).warning(f"[disputes] index ensure failed: {e}")


@app.on_event("startup")
async def _stripe_connect_startup() -> None:
    """Sprint 7 — ensure indexes for stripe_webhook_events + platform_settings."""
    try:
        from app.integrations.stripe_connect_service import ensure_indexes as _connect_indexes
        await _connect_indexes(db)
    except Exception as e:
        logging.getLogger(__name__).warning(f"[connect] index ensure failed: {e}")


@app.on_event("startup")
async def _payment_chronology_startup() -> None:
    """Sprint P0.b.C.f — ensure indexes for payment_events.

    Independent of stripe_webhook_events (provider evidence) and money_audit
    (admin governance). payment_events is a new chronology species.
    """
    try:
        from app.payments.chronology.writer import ensure_indexes as _payment_chron_indexes
        await _payment_chron_indexes(db)
    except Exception as e:
        logging.getLogger(__name__).warning(
            f"[payment-chronology] index ensure failed: {e}"
        )



@app.on_event("startup")
async def _hot_indexes_startup() -> None:
    """Sprint 9 — compound indexes for hot collections (escrow, disputes,
    notifications, marketplace). Idempotent. Adds only, never drops.

    Runs as a background task so a slow first-run (creating many indexes)
    never blocks app startup. Safe to retry: create_index is idempotent.
    """
    import asyncio as _aio
    async def _run():
        try:
            await _aio.sleep(2)  # let other startup hooks complete
            from app.core.hot_indexes import ensure_hot_indexes
            await ensure_hot_indexes(db)
        except Exception as e:
            logging.getLogger(__name__).warning(f"[hot-indexes] startup failed: {e}")
    _aio.create_task(_run())

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── Sprint 21 PRE-COMMIT 0 — shared context (part 1/2: db + logger).
# Модули из app/* читают эти ссылки вместо глобалов. ctx.emit
# привязывается ниже, после определения emit_* функций. ctx.ready
# НЕ выставляется здесь — только в startup_event после полной инициализации.
ctx.mongo = client
ctx.db = db
ctx.logger = logger

# Sprint 26: init Performance module (gives it db handle for hooks).
performance_init(db, verify_admin_token)
# Sprint 28: init Revenue module.
revenue_init(db, verify_admin_token)




http_client = httpx.AsyncClient(timeout=30.0)

# Sprint 21 C4: привязываем shared httpx client к ctx — app/core/realtime.py
# использует ctx.http_client, это избавляет от circular import.
ctx.http_client = http_client


# ═══════════════════════════════════════════════
# 🔔 REALTIME EVENT EMISSION
# ═══════════════════════════════════════════════
# Sprint 21 C4: emit_realtime_event вынесен в app/core/realtime.py.
# Импортируется выше (наверху файла). Тело функции не меняется — только адрес.


async def emit_booking_status_changed(booking_id: str, old_status: str, new_status: str, extra: dict = None):
    """Emit booking:status_changed event"""
    payload = {"bookingId": booking_id, "oldStatus": old_status, "newStatus": new_status, **(extra or {})}
    # Sprint 21 C3: через ctx.emit.event вместо глобального emit_realtime_event.
    # Runtime-поведение идентично (ctx.emit.event == emit_realtime_event), но
    # теперь shell-функция не зависит от module-level глобала — готова к
    # выносу в app/core/realtime.py в C4.
    await ctx.emit.event("booking:status_changed", payload)


async def emit_provider_new_request(booking: dict):
    """Emit provider:new_request event"""
    # Sprint 21 C3 — через ctx.emit.event (см. коммент выше).
    await ctx.emit.event("provider:new_request", {
        "requestId": booking.get("id"), "serviceName": booking.get("serviceName"),
        "priceEstimate": booking.get("priceEstimate"), "source": booking.get("source"),
    })


async def emit_provider_location(booking_id: str, lat: float, lng: float, heading: float = 0, speed: float = 0, eta: int = 0):
    """Emit booking:provider_location event"""
    # Sprint 21 C3 — через ctx.emit.event (см. коммент выше).
    await ctx.emit.event("booking:provider_location", {
        "bookingId": booking_id, "lat": lat, "lng": lng, "heading": heading, "speed": speed, "etaMinutes": eta,
    })


# ── Sprint 21 PRE-COMMIT 0 — shared context (part 2/2: realtime emitters).
# Атомарная привязка: никакого partially-filled состояния. Прямые вызовы
# emit_realtime_event / emit_booking_status_changed / emit_provider_new_request /
# emit_provider_location в остальном коде пока НЕ трогаем — они будут заменены
# на ctx.emit.* в C3+ по мере выноса соответствующих модулей.
ctx.emit = RealtimeEmitters(
    event=emit_realtime_event,
    booking_status=emit_booking_status_changed,
    provider_new_request=emit_provider_new_request,
    provider_location=emit_provider_location,
)


zone_engine_task = None

# Sprint 21 C11: moved to app/orchestrator/* (cycle/pre_engagement/feedback/router)


# @app.on_event("startup") is REMOVED (C15.1) — lifecycle handled by app.core.lifespan.
# bootstrap_side_effects() — публичный helper, вызывается из lifespan.
# Содержит: seed_data → NestJS subprocess spawn → geo indexes → provider locations seed
# → production-readiness indexes. Loops НЕ стартуют здесь — за это отвечает
# app.orchestrator.runner.start_all_loops, вызываемый lifespan'ом после этой функции.
# ═══════════════════════════════════════════════════════════════
# 🔍 SPRINT 6 — OBSERVABILITY & ERROR SYSTEM
# ═══════════════════════════════════════════════════════════════

# Sprint 21 C6: counters вынесены в app/core/metrics.py (singleton `metrics`).
# Middleware пишет через metrics.request_counter / metrics.error_counters, читает
# /api/system/health в app/system/health.py. Один источник — один процесс.

ERROR_CODE_MAP = {
    400: "VALIDATION_ERROR",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    409: "CONFLICT",
    422: "VALIDATION_ERROR",
    429: "RATE_LIMITED",
    500: "INTERNAL_ERROR",
    502: "UPSTREAM_ERROR",
    503: "SERVICE_UNAVAILABLE",
}


def _normalize_error(status_code: int, message: str, code: Optional[str] = None, details: Optional[dict] = None) -> dict:
    """Produce the unified error envelope {error, code, message, details}."""
    return {
        "error": True,
        "code": code or ERROR_CODE_MAP.get(status_code, "INTERNAL_ERROR"),
        "message": message or "Unknown error",
        "details": details or {},
    }


async def _log_system_event(level: str, route: str, method: str, status: int,
                            message: str, code: str, duration_ms: int,
                            user_id: Optional[str] = None, meta: Optional[dict] = None):
    """Write an entry to system_logs (fire-and-forget; never raises)."""
    try:
        await db.system_logs.insert_one({
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": level,
            "service": "fastapi",
            "route": route,
            "method": method,
            "status": status,
            "errorCode": code,
            "message": message[:500],
            "userId": user_id,
            "durationMs": duration_ms,
            "meta": meta or {},
        })
    except Exception:
        pass


@app.middleware("http")
async def observability_middleware(request: Request, call_next):
    """
    Logs every request + time + status. Writes to system_logs ONLY for non-2xx
    or long-running requests (>2000ms). This keeps the collection tight.
    """
    start = time.time()
    metrics.request_counter += 1
    path = request.url.path
    method = request.method
    # Cheap skip for noisy endpoints
    skip_log = path.startswith("/api/socket.io/") or path.startswith("/api/realtime/events")

    try:
        response = await call_next(request)
        duration_ms = int((time.time() - start) * 1000)
        status = response.status_code

        # Count + log non-2xx
        if status >= 400:
            code = ERROR_CODE_MAP.get(status, "INTERNAL_ERROR")
            metrics.error_counters["total"] += 1
            metrics.error_counters["by_status"][str(status)] = metrics.error_counters["by_status"].get(str(status), 0) + 1
            metrics.error_counters["by_code"][code] = metrics.error_counters["by_code"].get(code, 0) + 1
            metrics.error_counters["by_route"][path] = metrics.error_counters["by_route"].get(path, 0) + 1
            if not skip_log:
                await _log_system_event(
                    level="error" if status >= 500 else "warn",
                    route=path, method=method, status=status,
                    message=f"{method} {path} → {status}",
                    code=code, duration_ms=duration_ms,
                )
        elif duration_ms > 2000 and not skip_log:
            await _log_system_event(
                level="warn", route=path, method=method, status=status,
                message=f"slow {method} {path} ({duration_ms}ms)",
                code="SLOW_REQUEST", duration_ms=duration_ms,
            )

        # Annotate response header for clients (admin UI badge)
        response.headers["x-request-duration-ms"] = str(duration_ms)
        return response
    except HTTPException:
        # Let FastAPI's default handler format it → our exception_handler below catches.
        raise
    except (RequestValidationError, ValueError) as exc:
        # Pydantic field_validator raises ValueError → wrapped into RequestValidationError
        # by FastAPI body parser. Re-raise so the dedicated handler returns proper 422
        # (not a generic 500).
        raise
    except Exception as exc:
        duration_ms = int((time.time() - start) * 1000)
        logger.exception(f"Unhandled error on {method} {path}")
        metrics.error_counters["total"] += 1
        metrics.error_counters["by_status"]["500"] = metrics.error_counters["by_status"].get("500", 0) + 1
        metrics.error_counters["by_code"]["INTERNAL_ERROR"] = metrics.error_counters["by_code"].get("INTERNAL_ERROR", 0) + 1
        metrics.error_counters["by_route"][path] = metrics.error_counters["by_route"].get(path, 0) + 1
        await _log_system_event(
            level="error", route=path, method=method, status=500,
            message=str(exc)[:500], code="INTERNAL_ERROR", duration_ms=duration_ms,
        )
        return JSONResponse(status_code=500, content=_normalize_error(500, str(exc)))


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    """Convert FastAPI HTTPException → unified error envelope."""
    body = exc.detail if isinstance(exc.detail, dict) else {"message": str(exc.detail)}
    if isinstance(body, dict) and body.get("error") is True:
        payload = body  # already normalized
    else:
        msg = body.get("message") if isinstance(body, dict) else str(exc.detail)
        payload = _normalize_error(exc.status_code, msg or "")
    return JSONResponse(status_code=exc.status_code, content=payload, headers=exc.headers or None)


@app.exception_handler(StarletteHTTPException)
async def starlette_http_exception_handler(request: Request, exc: StarletteHTTPException):
    return JSONResponse(status_code=exc.status_code,
                        content=_normalize_error(exc.status_code, str(exc.detail) if exc.detail else ""))


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    # Pydantic v2 puts raw exception instances under errors()[*]["ctx"]["error"] —
    # those are not JSON-serializable. Stringify everything that isn't trivially safe.
    safe_errors = []
    for err in exc.errors():
        clean = dict(err)
        ctx = clean.get("ctx")
        if isinstance(ctx, dict):
            clean["ctx"] = {k: (str(v) if not isinstance(v, (str, int, float, bool, type(None))) else v) for k, v in ctx.items()}
        # Also stringify any non-serializable input value (e.g. bytes)
        if "input" in clean and not isinstance(clean["input"], (str, int, float, bool, list, dict, type(None))):
            clean["input"] = str(clean["input"])
        safe_errors.append(clean)
    return JSONResponse(status_code=422, content=_normalize_error(
        422, "Validation failed", code="VALIDATION_ERROR", details={"errors": safe_errors}
    ))


# ═══════════════════════════════════════════════════════════════
# 🛡 SPRINT 12 — Rate limit + Idempotency middleware
# Registered AFTER observability so it runs OUTER (i.e. before obs).
# ═══════════════════════════════════════════════════════════════

# Sprint 12: paths that must require admin JWT but are handled by upstream
# (NestJS) that forgot to guard them.
UNGUARDED_ADMIN_PATHS = (
    "/api/admin/automation/",
)


@app.middleware("http")
async def prod_readiness_middleware(request: Request, call_next):
    # 0. Hard-gate paths that NestJS forgot to protect
    p = request.url.path
    if any(p.startswith(pref) for pref in UNGUARDED_ADMIN_PATHS):
        auth = request.headers.get("authorization", "")
        if not auth.startswith("Bearer "):
            return JSONResponse(status_code=401, content=_normalize_error(
                401, "Unauthorized", code="UNAUTHORIZED"))
        try:
            payload = jwt.decode(auth[7:], JWT_SECRET, algorithms=["HS256"])
            if payload.get("role") != "admin":
                return JSONResponse(status_code=403, content=_normalize_error(
                    403, "Admin role required", code="FORBIDDEN"))
        except jwt.ExpiredSignatureError:
            return JSONResponse(status_code=401, content=_normalize_error(
                401, "Token expired", code="UNAUTHORIZED"))
        except jwt.InvalidTokenError:
            return JSONResponse(status_code=401, content=_normalize_error(
                401, "Invalid token", code="UNAUTHORIZED"))

    # 1. Rate limit (fast path)
    rl = check_rate_limit(request)
    if rl is not None:
        return rl
    # 2. Idempotency lookup (may short-circuit with cached response)
    idem_early = await idempotency_lookup(db, request)
    if idem_early is not None:
        return idem_early
    # 3. Execute handler
    response = await call_next(request)
    # 4. Commit idempotency record (status-class-aware policy lives inside
    #    `idempotency_commit`):
    #      2xx → cache 24h (durable de-duplication)
    #      4xx → cache 90s  (rapid re-tap dedup; allows legitimate retry)
    #      5xx → purge placeholder (immediate retry, never blocked by server hiccup)
    if (request.headers.get("idempotency-key")
            and request.method == "POST"):
        try:
            body_iter = [chunk async for chunk in response.body_iterator]  # type: ignore[attr-defined]
            content = b"".join(body_iter)
            await idempotency_commit(db, request, response.status_code, content)
            # Return a new plain Response so body is properly re-sent
            from starlette.responses import Response as _Resp
            headers = {k: v for k, v in response.headers.items()
                       if k.lower() not in ("content-length",
                                            "content-encoding",
                                            "transfer-encoding")}
            return _Resp(
                content=content,
                status_code=response.status_code,
                headers=headers,
                media_type=response.media_type,
            )
        except Exception:
            logger.exception("idempotency commit failed")
            return response
    return response


# ─── System observability endpoints ─────────────────────────────

# Sprint 21 C6: /api/system/health, /api/system/errors и /api/system/errors/stats
# вынесены в app/system/health.py и app/system/system.py.


# ═══════════════════════════════════════════════
# 🔐 AUTH ENDPOINTS (FastAPI native — NestJS fallback)
# ═══════════════════════════════════════════════

# Sprint 21 C5: /api/auth/login, /register, /me вынесены в app/system/auth.py.


# Sprint 21 C6: /api/health вынесен в app/system/health.py.


# Serve admin panel static files BEFORE the catch-all proxy
# Sprint 21 C7: все /api/web-app/* и /api/admin-panel/* (8 endpoints) вынесены
# в app/static/router.py.


# ═══════════════════════════════════════════════
# 🧠 GOVERNANCE: Demand Push + Provider Behavior + Flow Control
# ═══════════════════════════════════════════════

# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# Sprint 21 C11: moved to app/orchestrator/* (cycle/pre_engagement/feedback/router)


# ═══════════════════════════════════════════════
# 🧠 GOVERNANCE SCORE — единая метрика здоровья рынка
# ═══════════════════════════════════════════════

# Sprint 21 C11: moved to app/orchestrator/* (cycle/pre_engagement/feedback/router)


# Sprint 21 C11: moved to app/orchestrator/* (cycle/pre_engagement/feedback/router)


# Sprint 21 C11: moved to app/orchestrator/* (cycle/pre_engagement/feedback/router)


# ═══════════════════════════════════════════════
# 🔥 DEMAND → ACTION CHAINS (Auto-Reaction Engine)
# ═══════════════════════════════════════════════

# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# ═══════════════════════════════════════════════
# 🧪 REVENUE / SURGE A/B EXPERIMENTS
# ═══════════════════════════════════════════════

# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# ═══════════════════════════════════════════════
# 🔔 PUSH DEVICE REGISTRATION
# ═══════════════════════════════════════════════
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# ═══════════════════════════════════════════════
# 🌐 WEB MARKETPLACE API (Real Data)
# ═══════════════════════════════════════════════

import math

# Sprint 21 C9: haversine + resolve_zone вынесены в app/core/geo.py (pure utils,
# без side-effects). Реимпорт в namespace модуля, чтобы остальные 15+ usages
# в server.py продолжали работать без массового редактирования.
from app.core.geo import haversine, resolve_zone  # noqa: F401  (re-export)

# Sprint 21 C10: moved to app/marketplace/* (see router.py)

# Sprint 21 C10: moved to app/marketplace/* (see router.py)

# Sprint 21 C10: moved to app/marketplace/* (see router.py)

# Sprint 21 C10: moved to app/marketplace/* (see router.py)


# ═══════════════════════════════════════════════════════════════════
# 🔥 SPRINT 14.5–17 — QUICK REQUEST CORE + RANKING OPTIMIZER
# Sprint 21 C9: весь модуль (classifier, surge formatting, ranking
# optimizer loop + 8 endpoints) вынесен в app/marketplace/quick_request.py.
# include_router(qr_router) + запуск provider_ranking_optimizer_loop в
# startup делается рядом с другими routers вверху server.py.
# ═══════════════════════════════════════════════════════════════════

# ═══════════════════════════════════════════════════════════════════
# Marketplace quick-request (legacy, kept for backward compatibility)
# ═══════════════════════════════════════════════════════════════════
# Sprint 21 C10: moved to app/marketplace/* (see router.py)

# Sprint 21 C10: moved to app/marketplace/* (see router.py)

# Sprint 21 C10: moved to app/marketplace/* (see router.py)

# ═══════════════════════════════════════════════
# 📍 PROVIDER LOCATION TRACKING (WebSocket)
# ═══════════════════════════════════════════════
# Sprint 21 C10: moved to app/marketplace/* (see router.py)

# Sprint 21 C10: moved to app/marketplace/* (see router.py)

# Sprint 21 C10: moved to app/marketplace/* (see router.py)

# Sprint 21 C10: moved to app/marketplace/* (see router.py)

# Sprint 21 C10: moved to app/marketplace/* (see router.py)

# Sprint 21 C10: moved to app/marketplace/* (see router.py)


# ═══════════════════════════════════════════════
# 🔧 PROVIDER EXECUTION LAYER
# ═══════════════════════════════════════════════

# Sprint 21 C10: moved to app/marketplace/* (see router.py)

# Sprint 21 C10: moved to app/marketplace/* (see router.py)

# Sprint 21 C10: moved to app/marketplace/* (see router.py)

# Sprint 21 C10: moved to app/marketplace/* (see router.py)

# Sprint 21 C10: moved to app/marketplace/* (see router.py)

# Sprint 21 C10: moved to app/marketplace/* (see router.py)

# Sprint 21 C10: moved to app/marketplace/* (see router.py)


# ═══════════════════════════════════════════════
# 💰 MONETIZATION: Promoted Providers + Priority Requests
# ═══════════════════════════════════════════════

# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# ═══════════════════════════════════════════════
# 🚀 GROWTH ENGINE: Billing + Pressure + A/B + Retention
# ═══════════════════════════════════════════════

# ── BILLING CATALOG ──
# Sprint 21 C16: BILLING_PRODUCTS + TIER_THRESHOLDS перенесены в
# app/billing/router.py и app/provider/router.py соответственно.
# ── ADMIN BILLING REVENUE ──
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# ═══════════════════════════════════════════════
# 📊 PHASE B: BOOKING DEMAND EVENTS
# ═══════════════════════════════════════════════

# Sprint 21 C10: moved to app/marketplace/* (see router.py)


# Sprint 21 C10: moved to app/marketplace/* (see router.py)


# Sprint 21 C10: moved to app/marketplace/* (see router.py)


# ═══════════════════════════════════════════════
# 🧠 PHASE B: ZONE-AWARE MATCHING (Enhanced)
# ═══════════════════════════════════════════════

# Sprint 21 C10: moved to app/marketplace/* (see router.py)


# ═══════════════════════════════════════════════
# 🚀 PHASE B: ZONE-AWARE DISTRIBUTION
# ═══════════════════════════════════════════════

# Sprint 21 C10: moved to app/marketplace/* (see router.py)


# Sprint 21 C10: moved to app/marketplace/* (see router.py)


# ═══════════════════════════════════════════════
# 📊 PHASE B: ZONE DASHBOARD (COMPREHENSIVE)
# ═══════════════════════════════════════════════

# Sprint 21 C10: moved to app/marketplace/* (see router.py)


# Sprint 21 C10: moved to app/marketplace/* (see router.py)


# ═══════════════════════════════════════════════
# 🗺️ GEO + ZONE ENGINE (Phase B)
# ═══════════════════════════════════════════════

# Sprint 21 C9: resolve_zone вынесен в app/core/geo.py. Импорт сделан
# рядом с haversine вверху файла. Все 7 usages в server.py работают
# через module-level re-export.

# ── ZONE RESOLVE (must be before /{zone_id}) ──
# Sprint 21 C10: moved to app/marketplace/* (see router.py)
# Sprint 21 C10: moved to app/marketplace/* (see router.py)

# Sprint 21 C10: moved to app/marketplace/* (see router.py)

# Sprint 21 C10: moved to app/marketplace/* (see router.py)

# Sprint 21 C10: moved to app/marketplace/* (see router.py)
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# ── ZONE HISTORY / ANALYTICS ──
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# ── ADMIN ZONE CONTROLS ──
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# ── ZONE-AWARE DISTRIBUTION CONFIG ──
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# ── ZONE DASHBOARD ──
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# ═══════════════════════════════════════════════════════════════
# 🧠 PHASE C: CUSTOMER INTELLIGENCE ENGINE
# ═══════════════════════════════════════════════════════════════

# ── C.1: Customer Profile Intelligence ──

# ═══════════════════════════════════════════════════════════════
# 🧠 PHASE E: MARKET ORCHESTRATION LAYER
# ═══════════════════════════════════════════════════════════════
#
# Zone/Market state -> Decision -> Actions -> Logs -> Override
#
# System automatically:
#   - reads live zone state
#   - decides actions based on rules config
#   - executes (surge, push, fanout, priority bias, zone boost)
#   - logs everything
#   - respects admin overrides
# ═══════════════════════════════════════════════════════════════

# ── DEFAULT RULES CONFIG ──
# Sprint 21 C11: ORCHESTRATOR_DEFAULT_RULES moved to app/orchestrator/cycle.py

# Sprint 21 C13: cooldown helpers вынесены в app/orchestrator/cooldown.py.
# Re-export для backcompat.
from app.orchestrator.cooldown import (  # noqa: E402, F401
    orchestrator_cooldowns,
    is_in_cooldown,
    set_cooldown,
)

orchestrator_engine_task = None
# Sprint 21 C11: orchestrator_enabled/cycle_count/last_cycle_at/last_actions_count
# вынесены в app/orchestrator/cycle.py (mutable globals, общие с router.py).
from app.orchestrator import cycle as _cycle  # noqa: E402


def _get_orchestrator_state():
    return _cycle.orchestrator_enabled, _cycle.orchestrator_cycle_count, _cycle.orchestrator_last_cycle_at, _cycle.orchestrator_last_actions_count


# Sprint 21 C13: build_actions + execute_action вынесены в
# app/orchestrator/actions.py. Re-export для backcompat.
from app.orchestrator.actions import build_actions, execute_action  # noqa: E402, F401


# ═══════════════════════════════════════════════════════════════════════
# 🔥 SPRINT 18: PROVIDER PRE-ENGAGEMENT ENGINE
#
# Цель: переходим от реактивной системы (клиент → ищем мастера) к проактивной
# (predicted demand → поднимаем мастеров заранее).
#
# 1. predict_demand(zone_id) — простая short-window прогнозная метрика на базе
#    последних zone_snapshots и текущего demandScore. Не ML — это базовая линия,
#    Sprint 20 заменит на полноценный TS-forecast.
# 2. trigger_pre_engagement(zone, pressure) — создаёт событие в коллекции
#    pre_engagement_events (TTL = 15 мин), эмиттит realtime в комнату zone:<id>.
# 3. preEngageBoost (1.1x) применяется в /matching/nearby ranking, если у
#    провайдера preEngagedAt свежее 15 минут.
# ═══════════════════════════════════════════════════════════════════════
# Sprint 21 C11: pre-engagement consts + cooldowns + pressure threshold
# вынесены в app/orchestrator/pre_engagement.py. PRE_ENGAGEMENT_TTL_MIN и
# PRE_ENGAGEMENT_BOOST — в app/core/constants.py (shared с matching.py).
# Они ещё нужны endpoint'у /api/provider/pre-engage (строки 2184, 2217).
from app.core.constants import PRE_ENGAGEMENT_TTL_MIN, PRE_ENGAGEMENT_BOOST  # noqa: E402, F401


# Sprint 21 C13: ML domain (SKLEARN_OK / _compute_behavioral_signals /
# DemandPredictor / predict_demand / _predict_demand_ewma) вынесен в
# app/ml/predictor.py. Re-export для backcompat.
from app.ml.predictor import (  # noqa: E402, F401
    SKLEARN_OK,
    DemandPredictor,
    _compute_behavioral_signals,
    _predict_demand_ewma,
    predict_demand,
)


# Sprint 21 C13: ML body physically moved to app/ml/predictor.py
# (re-export на строке ~3443 выше). Всего удалено ~360 строк ML-кода.


# Sprint 21 C11: moved to app/orchestrator/* (cycle/pre_engagement/feedback/router)


# Sprint 21 C11: startup_with_orchestrator (v1) был полностью замещён
# startup_with_feedback (v2) — он ниже в файле. Оставляем только v2.

# ═══════════════════════════════════════════════
# 📡 ORCHESTRATOR API ENDPOINTS
# ═══════════════════════════════════════════════

# Sprint 21 C11: все /api/orchestrator/* endpoints вынесены в
# app/orchestrator/router.py.


# ═══════════════════════════════════════════════════════════════
# 🧠 PHASE G+H: ACTION FEEDBACK LOOP + STRATEGY OPTIMIZER
# ═══════════════════════════════════════════════════════════════
#
# Every orchestrator action → capture BEFORE snapshot
# After 3 min → capture AFTER snapshot → calculate effectiveness
# Strategy Optimizer → adjusts weights per zone+action_type
# Orchestrator → uses weights when deciding actions
# ═══════════════════════════════════════════════════════════════

# Sprint 21 C11: DEFAULT_STRATEGY_WEIGHTS + FEEDBACK_DELAY_SECONDS +
# STRATEGY_RECALC_INTERVAL + MIN_SAMPLES_FOR_LEARNING + ZONE_WEIGHT_BLEND
# вынесены в app/orchestrator/feedback.py.
feedback_engine_task = None
strategy_optimizer_task = None

# ── FIX 1: Zone Locks (Race Condition Prevention) ──
zone_locks: dict = {}  # { zoneId: { lockedBy: str, expiresAt: str } }

# Sprint 21 C11: feedback helpers (acquire/release/capture/calculate/track/
# feedback_processor_loop/strategy_optimizer_loop/recalculate_strategy_weights/
# get_strategy_weight) — в app/orchestrator/feedback.py.
#
# Cycle helpers (zone_state_engine/orchestrator_run_cycle/
# orchestrator_run_cycle_with_feedback/orchestrator_engine_loop_v2/
# seed_orchestrator_rules) — в app/orchestrator/cycle.py.
#
# trigger_pre_engagement — в app/orchestrator/pre_engagement.py.

# ── Imports used by startup_with_feedback ──
from app.orchestrator.cycle import (  # noqa: E402
    orchestrator_engine_loop_v2,
    orchestrator_run_cycle,
    orchestrator_run_cycle_with_feedback,
    seed_orchestrator_rules as _new_seed_orchestrator_rules,
    zone_state_engine as _new_zone_state_engine,
)
from app.orchestrator.feedback import (  # noqa: E402
    feedback_processor_loop,
    strategy_optimizer_loop,
)


# Sprint 21 C15.1: startup_with_feedback / _demand_prediction_loop / on_startup.clear
# УДАЛЕНЫ. Весь lifecycle теперь в app.core.lifespan (init_db → load_ml_models →
# bootstrap_side_effects → start_all_loops). См. app/orchestrator/runner.py.


# ═══════════════════════════════════════════════
# 📡 FEEDBACK & STRATEGY API ENDPOINTS
# ═══════════════════════════════════════════════

# Sprint 21 C11: moved to app/orchestrator/* (cycle/pre_engagement/feedback/router)


# Sprint 21 C11: moved to app/orchestrator/* (cycle/pre_engagement/feedback/router)


# Sprint 21 C11: moved to app/orchestrator/* (cycle/pre_engagement/feedback/router)


# Sprint 21 C11: moved to app/orchestrator/* (cycle/pre_engagement/feedback/router)


# Sprint 21 C11: moved to app/orchestrator/* (cycle/pre_engagement/feedback/router)


# Sprint 21 C11: moved to app/orchestrator/* (cycle/pre_engagement/feedback/router)


# Sprint 21 C11: moved to app/orchestrator/* (cycle/pre_engagement/feedback/router)


# Sprint 21 C11: moved to app/orchestrator/* (cycle/pre_engagement/feedback/router)


# ═══════════════════════════════════════════════════════════════
# 📊 SIMULATION & ANALYTICS API
# ═══════════════════════════════════════════════════════════════

# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# ═══════════════════════════════════════════════════════════════
# 🔧 CONTRACT COMPAT LAYER — Sprint 1 API alignment
# Registered BEFORE the catch-all proxy so these paths never fall through.
# ═══════════════════════════════════════════════════════════════

async def _proxy_to(request: Request, target_path: str, method: Optional[str] = None,
                    query_override: Optional[dict] = None) -> Response:
    """Sprint 21 C8: реализация переехала в app/core/proxy.py (proxy_to_nest).
    Этот thin-wrapper оставлен, чтобы оставшиеся admin-compat endpoints ниже
    продолжали работать без массовых переименований. Новый код должен
    импортировать proxy_to_nest напрямую.
    """
    return await proxy_to_nest(request, target_path, method=method, query_override=query_override)


# --- Notifications / Favorites / Organizations search / Garage / Payments ---
# Sprint 21 C8: 5 simple-proxy compat endpoints вынесены в app/system/compat.py.
# (compat_notifications_my, compat_favorites_my, compat_orgs_search,
#  compat_garage_get, compat_payments_list)


# --- Auth forgot-password (mock-safe) ---
# Sprint 21 C5: /api/auth/forgot-password и /reset-password вынесены в app/system/auth.py.


# --- Admin live-feed (aggregate recent events) ---
# --- Admin live-feed + alerts: Sprint 21 C12A — вынесено в app/admin/dashboard.py ---


# --- Admin automation replay alias ---
# Sprint 21 FINAL: handler relocated to app/governance/router.py.
# --- Admin feature flags alias ---
# Sprint 21 C12B: /api/admin/config/features + /api/admin/config/commission-tiers
# вынесены в app/admin/controls.py


# ═══════════════════════════════════════════════════════════════
# 🔀 NESTJS PROXY (catch-all — MUST BE LAST)
# ═══════════════════════════════════════════════════════════════


# ══════════════════════════════════════════════════════════════════════════════
# Sprint 9 — ADMIN CONTROL SYSTEM
#   Block 1: Zone Override (manual market control)
#   Block 2: Orchestrator Timeline (visibility w/ before/after)
#   Block 3: Strategy Control (AI on/off + weight bounds)
#   Block 4: Alerts with impact (lost revenue / recommended action)
# ══════════════════════════════════════════════════════════════════════════════

# Sprint 21 C13: OVERRIDE_MODE_MAP + get_active_override вынесены в
# app/core/overrides.py. Re-export для обратной совместимости (любое место,
# где был `from server import OVERRIDE_MODE_MAP, get_active_override`,
# продолжает работать без изменений).
from app.core.overrides import OVERRIDE_MODE_MAP, get_active_override  # noqa: E402, F401


# Sprint 21 C12B: Override/Timeline/Strategy endpoints вынесены в
# app/admin/controls.py. Константа OVERRIDE_MODE_MAP и функция
# get_active_override живут в app/core/overrides.py (C13).


# ═══════════════════════════════════════════════════════════════
# 🛡 SPRINT 12 — Production-readiness endpoints
# ═══════════════════════════════════════════════════════════════

# Sprint 21 C6: /api/system/breaker, /alert-dispatches, /test-alert,
# /idempotency/{key}, /audit — все вынесены в app/system/system.py.


# Sprint 21 C12B: /api/admin/zones/{id}/timeline + /api/admin/strategy/{id} +
# /api/admin/strategies вынесены в app/admin/controls.py.


# ── BLOCK 4 — Alerts with impact ─────────────────────────────────────────────
_AVG_ORDER_VALUE = 800  # ₴ mean booking value used for impact math


def _recommend_action(zone: dict) -> str:
    status = zone.get("status")
    ratio = zone.get("ratio", 1.0)
    if status == "CRITICAL":
        return "FORCE_SURGE + raise fanout to 6"
    if status == "SURGE" and ratio > 2.5:
        return "ENABLE_SURGE"
    if status == "BUSY":
        return "INCREASE_FANOUT"
    return "MONITOR"


# Sprint 21 C12A: /api/admin/alerts/enhanced вынесено в app/admin/dashboard.py
# --- Catch-all NestJS proxy ---
@app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
async def proxy_to_nestjs(request: Request, path: str):
    # NestJS officially disabled: возвращаем чистую 404 без circuit-breaker,
    # без relaunch попыток, без alerts. FastAPI native перекрывает все
    # основные роуты через include_router выше — этот catch-all срабатывает
    # только на неизвестные пути.
    if not NESTJS_ENABLED:
        return JSONResponse(
            status_code=404,
            content=_normalize_error(404, f"Endpoint not found: /api/{path}", code="NOT_FOUND"),
        )

    # Circuit breaker check
    if not nest_breaker.allow():
        st = nest_breaker.state()
        return JSONResponse(
            status_code=503,
            content={
                "error": True,
                "code": "NESTJS_UNAVAILABLE",
                "message": "Backend service temporarily unavailable (circuit open)",
                "details": {"retryIn": st["retryIn"], "breaker": st},
            },
            headers={"Retry-After": str(st["retryIn"] or 30)},
        )

    target = f"{NESTJS_URL}/api/{path}"
    if request.query_params:
        target += f"?{request.query_params}"
    headers = dict(request.headers)
    headers.pop('host', None)
    headers.pop('content-length', None)
    body = await request.body()

    last_err: Optional[str] = None
    for attempt in range(3):  # 1 try + 2 retries
        try:
            resp = await http_client.request(method=request.method, url=target,
                                              headers=headers, content=body,
                                              timeout=15.0)
            # success (even 4xx is NestJS reachable)
            nest_breaker.record_success()
            rh = dict(resp.headers)
            for k in ['content-length', 'content-encoding', 'transfer-encoding']:
                rh.pop(k, None)
            return Response(content=resp.content, status_code=resp.status_code, headers=rh,
                            media_type=resp.headers.get('content-type', 'application/json'))
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout, httpx.WriteTimeout) as e:
            last_err = f"{type(e).__name__}: {e}"
            nest_breaker.record_failure()
            # relaunch NestJS on connect error
            if isinstance(e, httpx.ConnectError):
                from app.core.bootstrap import start_nestjs
                asyncio.create_task(start_nestjs())
            if attempt < 2:
                await asyncio.sleep(0.5 * (attempt + 1))
                continue
            # fire alert (mocked dispatch) when breaker trips
            if nest_breaker.state()["state"] == "open":
                asyncio.create_task(dispatch_alert(
                    db, level="critical", code="NESTJS_CIRCUIT_OPEN",
                    message="FastAPI↔NestJS circuit opened after consecutive failures",
                    meta={"lastError": last_err, "breaker": nest_breaker.state()},
                ))
            return JSONResponse(
                status_code=503,
                content={
                    "error": True,
                    "code": "NESTJS_UNAVAILABLE",
                    "message": "Backend service temporarily unavailable",
                    "details": {"lastError": last_err, "breaker": nest_breaker.state()},
                },
                headers={"Retry-After": "5"},
            )
        except Exception as e:
            nest_breaker.record_failure()
            return JSONResponse(
                status_code=502,
                content=_normalize_error(502, str(e), code="UPSTREAM_ERROR"),
            )
    # should not reach here
    return JSONResponse(status_code=502,
                        content=_normalize_error(502, last_err or "Unknown upstream error",
                                                 code="UPSTREAM_ERROR"))

