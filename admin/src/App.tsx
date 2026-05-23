import { useEffect, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { useAuthStore } from './stores/authStore';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';

// ─────────────────────────────────────────────────────────────────────
// Phase 1.2 — topology correction.
//
// Visible == operational. Routes here all map to a working FastAPI
// endpoint OR to a strategic surface tracked by P3 governance.
//
// Pages on disk but NOT routed below remain in `/src/pages/` so a future
// backend port is a one-line route add. They are intentionally
// unreachable from the running shell.
//
// Hard rule for any new entry:
//   1. Backend endpoint must exist (verify with curl).
//   2. Add Layout.tsx nav entry in the matching group.
//   3. Add the lazy import + Route below.
//   Three changes, one PR. No exceptions.
// ─────────────────────────────────────────────────────────────────────

// Eager pages
// (Login + Layout always rendered on first paint)

// Lazy pages — ONLY visible/operational routes.

// CORE
const DashboardPage         = lazy(() => import('./pages/DashboardPage'));
const VerificationQueuePage = lazy(() => import('./pages/VerificationQueuePage'));
const AdminInboxPage        = lazy(() => import('./pages/AdminInboxPage'));
const AdminAssignmentsPage  = lazy(() => import('./pages/AdminAssignmentsPage'));
const AdminOpsMapPage       = lazy(() => import('./pages/AdminOpsMapPage'));
const NotificationsPage     = lazy(() => import('./pages/NotificationsPage'));

// GOVERNANCE
const GovernanceScorePage   = lazy(() => import('./pages/GovernanceScorePage'));
const ForecastDashboardPage = lazy(() => import('./pages/ForecastDashboardPage'));
const AdminReputationPage   = lazy(() => import('./pages/AdminReputationPage'));
const ZoneControlPage       = lazy(() => import('./pages/ZoneControlPage'));
const IntegrationsPage      = lazy(() => import('./pages/IntegrationsPage'));
const SystemErrorsPage      = lazy(() => import('./pages/SystemErrorsPage'));
// P4 — Operational UX closure
const ForensicGraphPage     = lazy(() => import('./pages/ForensicGraphPage'));
const ReconciliationPage    = lazy(() => import('./pages/ReconciliationPage'));

// MARKETPLACE (B-bucket — visible, P3-tracked gaps)
const AutoRequestsPage           = lazy(() => import('./pages/AutoRequestsPage'));
const ServiceMarketplaceExchange = lazy(() => import('./pages/ServiceMarketplaceExchange'));
const ServiceMarketplaceMap      = lazy(() => import('./pages/ServiceMarketplaceMap'));
const CarSelectionPage           = lazy(() => import('./pages/CarSelectionPage'));
const PaymentsAndCreditsPage     = lazy(() => import('./pages/PaymentsAndCreditsPage'));

// NOTIFY
const CustomerNotifyPreviewPage   = lazy(() => import('./pages/CustomerNotifyPreviewPage'));
const CustomerNotifyLifecyclePage = lazy(() => import('./pages/CustomerNotifyLifecyclePage'));

// FINANCE
const PaymentsPage         = lazy(() => import('./pages/PaymentsPage'));
const DisputesPage         = lazy(() => import('./pages/DisputesPage'));
const StripePaymentsPage   = lazy(() => import('./pages/StripePaymentsPage'));
const StripeSettingsPage   = lazy(() => import('./pages/StripeSettingsPage'));
const SupportChatPage      = lazy(() => import('./pages/SupportChatPage'));
const RevenueDashboardPage = lazy(() => import('./pages/RevenueDashboardPage'));

function PageFallback() {
  return (
    <div
      data-testid="admin-page-loading"
      className="min-h-[60vh] flex items-center justify-center"
    >
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
    </div>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading, token } = useAuthStore();

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!token || !user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function RouteOutlet() {
  return <Outlet />;
}

export default function App() {
  const { checkAuth } = useAuthStore();

  useEffect(() => {
    checkAuth();
  }, []);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route
          element={
            <Suspense fallback={<PageFallback />}>
              <RouteOutlet />
            </Suspense>
          }
        >
          {/* CORE */}
          <Route index                          element={<DashboardPage />} />
          <Route path="verification-queue"      element={<VerificationQueuePage />} />
          <Route path="inbox"                   element={<AdminInboxPage />} />
          <Route path="assignments"             element={<AdminAssignmentsPage />} />
          <Route path="ops-map"                 element={<AdminOpsMapPage />} />
          <Route path="notifications"           element={<NotificationsPage />} />

          {/* GOVERNANCE */}
          <Route path="governance-score"        element={<GovernanceScorePage />} />
          <Route path="forecast"                element={<ForecastDashboardPage />} />
          <Route path="reputation"              element={<AdminReputationPage />} />
          <Route path="zone-control"            element={<ZoneControlPage />} />
          <Route path="integrations"            element={<IntegrationsPage />} />
          <Route path="system/errors"           element={<SystemErrorsPage />} />
          {/* P4 — Operational UX closure */}
          <Route path="reconciliation"          element={<ReconciliationPage />} />
          <Route path="forensic/:entityType/:entityId" element={<ForensicGraphPage />} />

          {/* MARKETPLACE */}
          <Route path="auto-requests"           element={<AutoRequestsPage />} />
          <Route path="service-marketplace"     element={<ServiceMarketplaceExchange />} />
          <Route path="service-marketplace/map" element={<ServiceMarketplaceMap />} />
          <Route path="car-selection"           element={<CarSelectionPage />} />
          <Route path="auto-payments"           element={<PaymentsAndCreditsPage />} />

          {/* NOTIFY */}
          <Route path="customer-notify"             element={<CustomerNotifyPreviewPage />} />
          <Route path="customer-notify/lifecycle"   element={<CustomerNotifyLifecyclePage />} />

          {/* FINANCE */}
          <Route path="payments"                element={<PaymentsPage />} />
          <Route path="disputes"                element={<DisputesPage />} />
          <Route path="billing/stripe"          element={<StripePaymentsPage />} />
          <Route path="billing/stripe-settings" element={<StripeSettingsPage />} />
          <Route path="billing/support-chat"    element={<SupportChatPage />} />
          <Route path="revenue"                 element={<RevenueDashboardPage />} />
        </Route>
      </Route>
      {/* Frozen routes (Users / Providers / Bookings / Quotes / Reviews / Map
          / GeoOps / FeatureFlags / Audit Log / Inspection Forensics /
          Live Monitor / System Health / Incidents / Request Flow /
          Settings / Services / Organizations / Customers / Provider* /
          Provider Inbox) — direct URL → soft-redirect to Dashboard. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
