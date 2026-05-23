import React from 'react';
import { Tabs } from 'expo-router';
import { View, TouchableOpacity, StyleSheet, Platform, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '../../src/context/ThemeContext';
import { useAuth } from '../../src/context/AuthContext';
import i18n from '../../src/i18n';

// STRICT role-split tab bar:
//   Customer:  Home / Requests / + (create) / Reports   / Profile
//   Inspector: Home / Jobs     / + (none)   / Earnings  / Profile
function CustomTabBar({ state, navigation }: any) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { colors, isDark } = useThemeContext();
  const { t } = useTranslation();
  const { user } = useAuth();
  const isInspector = !!user && (user.role === 'provider' || (user.role || '').startsWith('provider'));

  const tabs = isInspector
    ? [
        { name: 'index', icon: 'home', label: i18n.t('tabs.home'), testID: 'tab-home' },
        { name: 'requests', icon: 'briefcase', label: i18n.t('tabs.jobs'), testID: 'tab-jobs', overrideHref: '/inspector/exposures' },
        { name: 'create', icon: 'wallet', label: i18n.t('tabs.earnings'), isCenter: true, testID: 'tab-earnings', overrideHref: '/provider-intelligence' },
        { name: 'reports', icon: 'list', label: i18n.t('tabs.history'), testID: 'tab-history', overrideHref: '/inspector/jobs' },
        { name: 'profile', icon: 'person', label: i18n.t('tabs.profile'), testID: 'tab-profile' },
      ]
    : [
        { name: 'index', icon: 'home', label: i18n.t('tabs.home'), testID: 'tab-home' },
        { name: 'requests', icon: 'document-text', label: i18n.t('tabs.requests'), testID: 'tab-requests' },
        { name: 'create', icon: 'add', label: '', isCenter: true, testID: 'tab-create-fab' },
        { name: 'reports', icon: 'clipboard', label: i18n.t('tabs.reports'), testID: 'tab-reports' },
        { name: 'profile', icon: 'person', label: i18n.t('tabs.profile'), testID: 'tab-profile' },
      ];

  return (
    <View
      style={[
        styles.tabBarContainer,
        { backgroundColor: colors.tabBar, borderTopColor: colors.tabBarBorder, paddingBottom: Math.max(insets.bottom, 8) },
      ]}
    >
      <View style={styles.tabBarInner}>
        {tabs.map((tab: any) => {
          const routeIndex = state.routes.findIndex((r: any) => r.name === tab.name);
          const isFocused = state.index === routeIndex;

          if (tab.isCenter && !isInspector) {
            const fabShadow = Platform.select({
              ios: { shadowColor: colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: isDark ? 0.35 : 0.18, shadowRadius: 8 },
              android: { elevation: 8 },
            });
            return (
              <TouchableOpacity
                key={tab.name}
                testID={tab.testID}
                style={styles.fabContainer}
                onPress={() => router.push('/auto-request/create')}
                activeOpacity={0.85}
              >
                <View style={[styles.fabButton, { backgroundColor: colors.primary }, fabShadow]}>
                  <Ionicons name="add" size={26} color={colors.onPrimary ?? '#FFF'} />
                </View>
              </TouchableOpacity>
            );
          }

          const iconName = isFocused ? tab.icon : `${tab.icon}-outline`;

          return (
            <TouchableOpacity
              key={tab.name}
              testID={tab.testID}
              onPress={() => {
                if (tab.overrideHref) {
                  router.push(tab.overrideHref);
                  return;
                }
                if (!isFocused && routeIndex !== -1) navigation.navigate(tab.name);
              }}
              style={styles.tabItem}
              activeOpacity={0.7}
            >
              <View style={styles.tabItemInner}>
                <View style={[styles.iconContainer, isFocused && !tab.overrideHref && { backgroundColor: colors.infoBg }]}>
                  <Ionicons name={iconName as any} size={22} color={isFocused && !tab.overrideHref ? colors.primary : colors.tabInactive} />
                </View>
                <Text
                  style={[styles.tabLabel, { color: isFocused && !tab.overrideHref ? colors.primary : colors.tabInactive }]}
                  numberOfLines={1}
                >
                  {tab.label}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

export default function TabLayout() {
  const { colors } = useThemeContext();
  return (
    <Tabs
      tabBar={(props) => <CustomTabBar {...props} />}
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="requests" />
      <Tabs.Screen name="create" options={{ href: null }} />
      <Tabs.Screen name="reports" />
      <Tabs.Screen name="profile" />
      <Tabs.Screen name="services" options={{ href: null }} />
      <Tabs.Screen name="quotes" options={{ href: null }} />
      <Tabs.Screen name="garage" options={{ href: null }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBarContainer: {
    borderTopWidth: 1,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.08, shadowRadius: 12 },
      android: { elevation: 12 },
    }),
  },
  tabBarInner: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-around', height: 64, paddingHorizontal: 8 },
  tabItem: { flex: 1, alignItems: 'center', justifyContent: 'center', height: 60 },
  tabItemInner: { alignItems: 'center', justifyContent: 'center', gap: 4 },
  iconContainer: { width: 40, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  tabLabel: { fontSize: 11, fontWeight: '500', letterSpacing: 0.1 },
  fabContainer: { alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  fabButton: { width: 52, height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
});
