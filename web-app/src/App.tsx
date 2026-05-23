import { useEffect, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuthStore } from './stores/authStore';

// ──────────────────────────────────────────────────────────────────────
// Shell Split α — three shells own three audiences. MarketplaceLayout is
// kept in the bundle as zombie compatibility surface (single-revert path)
// but is NOT rendered by any route after α. See:
//   /app/memory/canonical_surface_map.md  §1, §8.4
// ──────────────────────────────────────────────────────────────────────
import PublicShell from './shells/PublicShell';
import CustomerShell from './shells/CustomerShell';
import OperatorShell from './shells/OperatorShell';

// Eager: home + login (cold-paint shell). Other pages stay lazy.
import MarketplaceHome from './pages/public/MarketplaceHome';
import LoginPage from './pages/auth/LoginPage';

// Public
const InspectPage = lazy(() => import('./pages/public/InspectPage'));
const SelectionRequestPage = lazy(() => import('./pages/public/SelectionRequestPage'));
const ComparisonPage = lazy(() => import('./pages/public/ComparisonPage'));
const ReportsShowcasePage = lazy(() => import('./pages/public/ReportsShowcasePage'));
const SpecialistsPage = lazy(() => import('./pages/public/SpecialistsPage'));
const CaseDetailPage = lazy(() => import('./pages/public/CaseDetailPage'));
const VehicleMemoryPage = lazy(() => import('./pages/public/VehicleMemoryPage'));
const FeedPage = lazy(() => import('./pages/public/FeedPage'));
const OperatorProfilePage = lazy(() => import('./pages/public/OperatorProfilePage'));
const ProviderPage = lazy(() => import('./pages/public/ProviderPage'));
const BookingDetailPage = lazy(() => import('./pages/public/BookingDetailPage'));
const RegionSelectPage = lazy(() => import('./pages/public/RegionSelectPage'));
const PricingPreviewPage = lazy(() => import('./pages/public/PricingPreviewPage'));

// Customer
const MyRequestsListPage = lazy(() =>
  import('./pages/customer/MyRequestsPage').then(m => ({ default: m.MyRequestsListPage }))
);
const MyRequestDetailPage = lazy(() =>
  import('./pages/customer/MyRequestsPage').then(m => ({ default: m.MyRequestDetailPage }))
);
const PackagesPage = lazy(() => import('./pages/customer/PackagesPage'));
const PaymentSuccessPage = lazy(() => import('./pages/customer/PaymentSuccessPage'));
const CustomerQuotesPage = lazy(() => import('./pages/customer/CustomerQuotesPage'));
const PayPalMockPage = lazy(() => import('./pages/customer/PayPalMockPage'));
const CustomerBookings = lazy(() => import('./pages/customer/CustomerBookings'));
const CustomerHomePage = lazy(() => import('./pages/customer/HomePage'));
const CustomerGarage = lazy(() => import('./pages/customer/CustomerGarage'));
const CustomerVehicleDetail = lazy(() => import('./pages/customer/CustomerVehicleDetail'));
const CustomerProfile = lazy(() => import('./pages/customer/CustomerProfile'));
const CustomerFavorites = lazy(() => import('./pages/customer/CustomerFavorites'));
const InspectionContinuityPage = lazy(() => import('./pages/customer/InspectionContinuityPage'));
const InspectionTimelinePage = lazy(() => import('./pages/customer/InspectionTimelinePage'));
// P0.b.C.d.UI.a — server-projected + live booking timeline (separate
// surface from the older InspectionTimelinePage which uses client-side
// customer-grammar projection. The new lineage uses server projection
// + WS realtime acceleration.)
const CustomerBookingTimelinePage = lazy(() =>
  import('./pages/customer/CustomerBookingTimelinePage')
);
const ReportCognitionPage = lazy(() => import('./pages/customer/ReportCognitionPage'));
const RequestIntakePage = lazy(() => import('./pages/customer/RequestIntakePage'));
const RequestEstablishmentPage = lazy(() => import('./pages/customer/RequestEstablishmentPage'));
const InspectionReportPage = lazy(() => import('./pages/customer/InspectionReportPage'));

// Notifications (Sprint A4) — shared canonical page, two route mounts.
const NotificationsPage = lazy(() => import('./pages/notifications/NotificationsPage'));

// Chat (Sprint B2) — canonical client surfaces over /api/chat/v1.
const ChatListPage = lazy(() => import('./pages/chat/ChatPages').then((m) => ({ default: m.ChatListPage })));
const ChatThreadPage = lazy(() => import('./pages/chat/ChatPages').then((m) => ({ default: m.ChatThreadPage })));

// Provider (operator)
const ProviderDashboard = lazy(() => import('./pages/provider/ProviderDashboard'));
const ProviderWorkbench = lazy(() => import('./pages/provider/ProviderWorkbench'));
const ProviderInbox = lazy(() => import('./pages/provider/ProviderInbox'));
const ProviderEarnings = lazy(() => import('./pages/provider/ProviderEarnings'));
const ProviderEarningsClarity = lazy(() => import('./pages/provider/ProviderEarningsClarity'));
const ProviderProfile = lazy(() => import('./pages/provider/ProviderProfile'));
const ProviderCurrentJob = lazy(() => import('./pages/provider/ProviderCurrentJob'));
const ProviderDemand = lazy(() => import('./pages/provider/ProviderDemand'));
const ProviderOnboarding = lazy(() => import('./pages/provider/ProviderOnboarding'));
const ProviderBillingPage = lazy(() => import('./pages/provider/BillingPage'));

// Inspector — keeps its own self-contained workspace shell. α does not
// migrate inspector workspace into OperatorShell; see canonical_surface_map §4.
const InspectorCabinetShell = lazy(() => import('./layouts/InspectorCabinetShell'));
const InspectorWorkspace = lazy(() => import('./pages/inspector/InspectorWorkspace'));
const InspectorJobsPage = lazy(() => import('./pages/inspector/InspectorJobsPage'));
const JobDetailView = lazy(() => import('./pages/inspector/JobDetailView'));
const InspectorEmptyPanel = lazy(() =>
  import('./pages/inspector/JobDetailView').then(m => ({ default: m.InspectorEmptyPanel }))
);
const ReportWorkspace = lazy(() => import('./pages/inspector/ReportWorkspace'));
const InspectorProfilePage = lazy(() => import('./pages/inspector/InspectorProfilePage'));
const InspectorHomePage = lazy(() => import('./pages/inspector/InspectorHomePage'));
const InspectorInspectionsPage = lazy(() => import('./pages/inspector/InspectorInspectionsPage'));
const InspectorAvailabilityPage = lazy(() => import('./pages/inspector/InspectorAvailabilityPage'));
const InspectorPayoutsPage = lazy(() => import('./pages/inspector/InspectorPayoutsPage'));
const InspectorPerformancePage = lazy(() => import('./pages/inspector/InspectorPerformancePage'));
const InspectorVerificationPage = lazy(() => import('./pages/inspector/InspectorVerificationPage'));
const InspectorSecurityPage = lazy(() => import('./pages/inspector/InspectorSecurityPage'));
const InspectorSettingsPage = lazy(() => import('./pages/inspector/InspectorSettingsPage'));

// Auth
const RegisterPage = lazy(() => import('./pages/auth/RegisterPage'));


function PageFallback() {
  return (
    <div
      data-testid="webapp-page-loading"
      className="min-h-[40vh] flex items-center justify-center"
    >
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-yellow-400"></div>
    </div>
  );
}


// ──────────────────────────────────────────────────────────────────────
// Shell Split α — route guards (transition rules §5).
//
// `principal` collapses both legacy `user.role` and the canonical
// `activeAccount.kind` into one matchable set. We accept either form:
// during the transitional ontology window (pre-quarantine) provider
// accounts may carry `role=provider_*` while operator-kind-only accounts
// carry `kind=inspector`. OperatorShell guard accepts the union.
// ──────────────────────────────────────────────────────────────────────
function principalSet(): string[] {
  const { user, activeAccount } = useAuthStore.getState();
  return [user?.role, activeAccount?.kind].filter(Boolean) as string[];
}

function RequireKind({ kinds }: { kinds: string[] }) {
  const { user, token } = useAuthStore();
  const location = useLocation();
  if (!token || !user) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  const principal = principalSet();
  if (!principal.some(p => kinds.includes(p))) {
    return <Navigate to="/" replace />;
  }
  return <Outlet />;
}

function RoleRedirect() {
  const { user, activeAccount } = useAuthStore();
  if (!user) return <Navigate to="/login" replace />;
  if (activeAccount?.kind === 'inspector' || user.role === 'inspector') return <Navigate to="/inspector/jobs" replace />;
  if (user.role === 'provider_owner' || user.role === 'provider_manager') return <Navigate to="/provider" replace />;
  return <Navigate to="/account/home" replace />;
}

// Operator principal during α — see canonical_surface_map §2.3.
const OPERATOR_KINDS = ['inspector', 'provider_owner', 'provider_manager', 'admin'];
const CUSTOMER_KINDS = ['customer'];
const INSPECTOR_KINDS = ['inspector', 'admin'];


export default function App() {
  const { checkAuth } = useAuthStore();
  useEffect(() => { checkAuth(); }, []);

  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        {/* ── PUBLIC SHELL ─────────────────────────────────────── */}
        <Route element={<PublicShell />}>
          <Route path="/" element={<MarketplaceHome />} />
          <Route path="/inspect" element={<InspectPage />} />
          <Route path="/selection-request" element={<SelectionRequestPage />} />
          <Route path="/comparison" element={<ComparisonPage />} />
          <Route path="/reports" element={<ReportsShowcasePage />} />
          <Route path="/case/:id" element={<CaseDetailPage />} />
          <Route path="/vehicle/:id" element={<VehicleMemoryPage />} />
          <Route path="/feed" element={<FeedPage />} />
          <Route path="/operator/:slug" element={<OperatorProfilePage />} />
          <Route path="/specialists" element={<SpecialistsPage />} />
          <Route path="/region" element={<RegionSelectPage />} />
          <Route path="/pricing-preview" element={<PricingPreviewPage />} />
          <Route path="/packages" element={<PackagesPage />} />
          <Route path="/packages/success" element={<PaymentSuccessPage />} />
          <Route path="/packages/paypal-mock" element={<PayPalMockPage />} />
          <Route path="/provider/:slug" element={<ProviderPage />} />
          <Route path="/booking/:id" element={<BookingDetailPage />} />
          {/* Legacy public dispatch-marketplace routes — redirected to inspection-first IA */}
          <Route path="/search" element={<Navigate to="/specialists" replace />} />
          <Route path="/zones" element={<Navigate to="/" replace />} />
        </Route>

        {/* ── AUTH (full-screen, own composition, NOT inside PublicShell) ── */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />

        {/* ── CUSTOMER SHELL ───────────────────────────────────── */}
        <Route element={<RequireKind kinds={CUSTOMER_KINDS} />}>
          <Route element={<CustomerShell />}>
            <Route path="/dashboard/requests" element={<MyRequestsListPage />} />
            <Route path="/dashboard/request/new" element={<RequestIntakePage />} />
            <Route path="/dashboard/request/:id/establishment" element={<RequestEstablishmentPage />} />
            <Route path="/dashboard/requests/:id" element={<MyRequestDetailPage />} />
            <Route path="/dashboard/requests/:id/quotes" element={<CustomerQuotesPage />} />
            <Route path="/dashboard/inspection/:jobId/continuity" element={<InspectionContinuityPage />} />
            <Route path="/dashboard/inspection/:jobId/timeline" element={<InspectionTimelinePage />} />
            {/* P0.b.C.d.UI.a — new server-projected + live booking timeline. */}
            <Route path="/dashboard/bookings/:bookingId/timeline" element={<CustomerBookingTimelinePage />} />
            <Route path="/dashboard/inspection/:jobId/report-cognition" element={<ReportCognitionPage />} />
            <Route path="/dashboard/inspection/:jobId/report" element={<InspectionReportPage />} />
            <Route path="/account">
              <Route index element={<Navigate to="home" replace />} />
              <Route path="home" element={<CustomerHomePage />} />
              <Route path="bookings" element={<CustomerBookings />} />
              <Route path="garage" element={<CustomerGarage />} />
              <Route path="garage/:vehicleId" element={<CustomerVehicleDetail />} />
              <Route path="favorites" element={<CustomerFavorites />} />
              <Route path="profile" element={<CustomerProfile />} />
              <Route path="notifications" element={<NotificationsPage />} />
              <Route path="messages" element={<ChatListPage />} />
              <Route path="messages/:id" element={<ChatThreadPage />} />
            </Route>
          </Route>
        </Route>

        {/* ── OPERATOR SHELL — union: kind=inspector OR role=provider_* / admin ── */}
        <Route element={<RequireKind kinds={OPERATOR_KINDS} />}>
          <Route element={<OperatorShell />}>
            <Route path="/provider">
              <Route index element={<ProviderDashboard />} />
              <Route path="workbench" element={<ProviderWorkbench />} />
              <Route path="inbox" element={<ProviderInbox />} />
              <Route path="current-job" element={<ProviderCurrentJob />} />
              <Route path="earnings" element={<ProviderEarnings />} />
              <Route path="earnings-clarity" element={<ProviderEarningsClarity />} />
              <Route path="demand" element={<ProviderDemand />} />
              <Route path="profile" element={<ProviderProfile />} />
              <Route path="billing" element={<ProviderBillingPage />} />
              <Route path="notifications" element={<NotificationsPage />} />
            </Route>
          </Route>
        </Route>

        {/* Onboarding — public, full-screen own layout, NOT in PublicShell. */}
        <Route path="/provider/onboarding" element={<ProviderOnboarding />} />
        <Route path="/provider-onboarding" element={<ProviderOnboarding />} />

        {/* Inspector cabinet — unified shell for /inspector/*. */}
        <Route element={<RequireKind kinds={INSPECTOR_KINDS} />}>
          <Route path="/inspector" element={<InspectorCabinetShell />}>
            <Route index element={<Navigate to="/inspector/home" replace />} />
            <Route path="home" element={<InspectorHomePage />} />
            <Route path="jobs" element={<InspectorJobsPage />}>
              <Route index element={<InspectorEmptyPanel />} />
              <Route path=":id" element={<JobDetailView />} />
              <Route path=":id/report" element={<ReportWorkspace />} />
            </Route>
            <Route path="inspections" element={<InspectorInspectionsPage />} />
            <Route path="profile" element={<InspectorProfilePage />} />
            <Route path="availability" element={<InspectorAvailabilityPage />} />
            <Route path="payouts" element={<InspectorPayoutsPage />} />
            <Route path="performance" element={<InspectorPerformancePage />} />
            <Route path="verification" element={<InspectorVerificationPage />} />
            <Route path="security" element={<InspectorSecurityPage />} />
            <Route path="settings" element={<InspectorSettingsPage />} />
          </Route>
        </Route>

        {/* /app — kind-aware redirect to the canonical entry. */}
        <Route path="/app" element={<RoleRedirect />} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
