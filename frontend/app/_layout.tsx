import React, { useEffect } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import * as Linking from 'expo-linking';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useTranslation } from 'react-i18next';
import { AuthProvider } from '../src/context/AuthContext';
import { ToastProvider } from '../src/context/ToastContext';
import { ThemeProvider, useThemeContext } from '../src/context/ThemeContext';
import { LocationProvider } from '../src/context/LocationContext';
import { CityProvider, useCity } from '../src/context/CityContext';
import { SafeAreaProvider } from 'react-native-safe-area-context';
// P0.b.C.e — asearch:// deep-link resolver. Listens to Linking events,
// resolves via /api/deeplink/resolve, pushes to the chronology surface.
// Does NOT enforce auth — that lives on the target screen / REST/WS endpoint.
import { navigateDeeplink } from '../src/deeplink';
// init i18next (sets up resources, language, persistence)
import '../src/i18n';
import { theme } from '../src/context/ThemeContext';
const colors = theme.colors;

function LoadingScreen() {
  const { colors } = useThemeContext();
  const { t } = useTranslation();
  return (
    <View style={[styles.loadingContainer, { backgroundColor: colors.background }]}>
      <ActivityIndicator size="large" color={colors.primary} />
      <Text style={[styles.loadingText, { color: colors.textSecondary }]}>
        {t('app.loading')}
      </Text>
    </View>
  );
}

/**
 * Stage 2 — Onboarding gate.
 * If city has never been selected → redirect to /city-select before showing the app.
 * Skipped on welcome (/) and city-select itself to avoid loops.
 */
function CityOnboardingGate({ children }: { children: React.ReactNode }) {
  const { loading, hasSelected } = useCity();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (hasSelected) return;
    const path = '/' + segments.join('/');
    // Allow welcome, login, register, city-select, forgot-password, invite,
    // and the auto-request choose screen (Phase 3.0a — pre-form scenario picker)
    // without forcing city pick. The form itself collects city.
    const passThrough = [
      '/', '/login', '/register', '/city-select', '/forgot-password', '/invite',
      '/auto-request/choose', '/auto-request/create',
      // Phase 3.0b P0-1 — payment funnel reachable for guests without city onboarding
      '/payment-success', '/payment-cancelled',
      // P1.5 — free risk preview reachable from link paste before city pick
      '/inspection-preview',
      // Phase C.3 — Provider Workspace + Customer Comparison reachable for guests
      '/provider/workspace',
      // Phase 3.1 — Provider Mobile Parity (Workbench + Earnings Clarity).
      // Both screens have their own auth-rehydration gate; city-select pre-redirect
      // would block the provider operational/money perception surfaces.
      '/provider/workbench',
      '/provider/earnings-clarity',
      // 2026-05-17 — Earnings tab (the wallet/Доходы centre tab) routes here.
      // It owns its own role+auth gate (see provider-intelligence.tsx). The
      // city-onboarding redirect would lock the inspector out of money-truth.
      '/provider-intelligence',
      '/dashboard/requests',
      // Step 4 — Customer Request Creation V1 + Pass C continuity bridge.
      // The intake surface collects its own location substrate; the
      // establishment / continuity / cognition surfaces are restrained
      // read models that must not be gated by the city onboarding flow.
      '/customer/request',
      '/customer/inspection',
      // UX-4B — customer-facing inspection report viewer must be reachable
      // via deep link (e.g. from email / share sheet) before city onboarding.
      '/inspection-report',
      // Partner self-registration owns its own city selector (3. Where you
      // operate). Forcing city onboarding before partner-register would
      // double-pick city and lose deep-link entry from marketing pages.
      '/partner-register',
      // Admin partner-verification queue (approve/reject). Admins log in
      // from any device — city onboarding is a customer concept.
      '/admin/partner-verifications',
      '/admin/coverage',
      // Sprint 5 — Trust & Retention surfaces. Trust profile + post-escrow
      // review + pending list must be reachable via deep-link from
      // notifications and marketplace cards without re-asking city.
      '/trust',
      '/review',
      // Sprint 6 — Disputes. Open/detail screens must be reachable via
      // deep-link from notifications and request detail without re-asking city.
      '/disputes',
      // Sprint 7 — Stripe Connect onboarding (provider payouts).
      '/provider/stripe-connect',
      // Sprint 8 — Provider Urgent Match deep-link from push notification.
      '/provider/urgent-match',
      // P6.2 — Provider payout chronology (governance-grade evidence
      // trail mirror of customer/payment/[id]/chronology). Reachable via
      // asearch://link?ref=payout-activity.provider:<paymentId> deeplink
      // and from inside provider/earnings flows. Provider may receive
      // this push BEFORE having picked a city (cross-zone payouts).
      '/provider/payout',
    ];
    if (passThrough.some((p) => path === p || path.startsWith(p + '/'))) return;
    router.replace('/city-select?redirect=/(tabs)' as any);
  }, [loading, hasSelected, segments, router]);

  return <>{children}</>;
}

function RootLayoutNav() {
  const { colors, isDark } = useThemeContext();
  const router = useRouter();

  // P0.b.C.e — asearch:// deep-link listener. Mounted once at root.
  // Handles cold-start URL + hot URL events. Authorisation lives downstream.
  useEffect(() => {
    let mounted = true;
    Linking.getInitialURL().then((url) => {
      if (mounted && url) {
        navigateDeeplink(url, router);
      }
    });
    const sub = Linking.addEventListener('url', ({ url }) => {
      if (url) navigateDeeplink(url, router);
    });
    return () => {
      mounted = false;
      sub.remove();
    };
  }, [router]);

  return (
    <>
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <CityOnboardingGate>
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.background },
            animation: 'slide_from_right',
          }}
        />
      </CityOnboardingGate>
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AuthProvider>
          <LocationProvider>
            <CityProvider>
              <ToastProvider>
                <RootLayoutNav />
              </ToastProvider>
            </CityProvider>
          </LocationProvider>
        </AuthProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  loadingText: {
    fontSize: 16,
    fontWeight: '500',
  },
});
