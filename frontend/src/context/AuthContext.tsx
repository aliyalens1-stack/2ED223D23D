import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api, setLogoutHandler } from '../services/api';

interface User {
  id: string;
  _id?: string;
  email: string;
  role: string;
  firstName: string;
  lastName: string;
}

// Sprint 1E: identity layer — accounts + activeAccount come from /auth/me
// envelope (and login/switch responses). Single shape across all surfaces.
export interface AccountView {
  id: string;
  userId: string;
  kind: 'customer' | 'inspector' | 'admin' | 'service_provider' | 'dealer' | 'transport';
  status: string;
  displayName: string;
  isPrimary: boolean;
  isLegacyShim?: boolean;
  isLegacy?: boolean;
  capabilities: string[];
}

// Sprint: Mobile Welcome + Auth Role Flow
export type UserMode = 'guest' | 'customer' | 'provider' | 'admin';
export type AuthIntent = 'find_master' | 'provider_work' | 'login' | 'guest' | null;

// Sprint Auth-2: pendingIntent — string-tag действия, прерванного гостем.
// После login роутер читает его и редиректит обратно (вместо дефолтного /(tabs)).
// Примеры: 'booking_confirm', 'favorites', 'garage', 'review_create'.
export type PendingIntent =
  | 'booking_confirm'
  | 'favorites'
  | 'garage'
  | 'review_create'
  | 'provider_dashboard'
  | string
  | null;

interface AuthContextType {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  // Sprint 1E: identity envelope
  accounts: AccountView[];
  activeAccount: AccountView | null;
  switchAccount: (accountId: string) => Promise<AccountView | null>;
  // Sprint: role-based welcome flow
  mode: UserMode;
  intent: AuthIntent;
  isGuest: boolean;
  // Sprint Auth-2: pendingIntent restore
  pendingIntent: PendingIntent;
  pendingIntentParams: Record<string, string> | null;
  setPendingIntent: (intent: PendingIntent, params?: Record<string, string> | null) => Promise<void>;
  consumePendingIntent: () => Promise<{ intent: PendingIntent; params: Record<string, string> | null }>;
  // Real auth
  login: (email: string, password: string) => Promise<void>;
  loginWith2FA: (challengeToken: string, code?: string, recoveryCode?: string) => Promise<any>;
  register: (data: RegisterData) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  // Welcome flow choices (no real auth, just persistence)
  chooseCustomer: () => Promise<void>;
  chooseProvider: () => Promise<void>;
  continueAsGuest: () => Promise<void>;
}

interface RegisterData {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  role?: string;
  referralCode?: string;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const TOKEN_KEY = 'auth_token';
const MODE_KEY = 'auth.mode';
const INTENT_KEY = 'auth.intent';
// Sprint Auth-2: pendingIntent persistence keys
const PENDING_INTENT_KEY = 'auth.pendingIntent';
const PENDING_INTENT_PARAMS_KEY = 'auth.pendingIntentParams';

// Sprint 1E: deriveMode now prefers active account.kind. Legacy `role` is the
// fallback for users who have not yet been touched by the account switcher.
function deriveMode(role?: string, activeKind?: string): UserMode {
  // Active account.kind is the source of truth post-1C/1D.
  if (activeKind === 'admin') return 'admin';
  if (activeKind === 'inspector' || activeKind === 'service_provider' || activeKind === 'transport') return 'provider';
  if (activeKind === 'customer') return 'customer';
  if (activeKind === 'dealer') return 'provider'; // future: dedicated dealer mode
  // Fallback to legacy role
  if (!role) return 'guest';
  if (role === 'admin') return 'admin';
  if (role.startsWith('provider')) return 'provider';
  return 'customer';
}

// Sprint 1E: normalize the three response shapes into one. /auth/login and
// /auth/register return { accessToken, user, accounts, activeAccount }.
// /auth/me returns { user, accounts, activeAccount }. /auth/switch-account
// returns { accessToken, accounts, activeAccount } (no user).
function normalizeIdentity(payload: any) {
  if (!payload || typeof payload !== 'object') return { user: null, accounts: [], activeAccount: null };
  const userObj = payload.user ?? null;
  const accounts: AccountView[] = Array.isArray(payload.accounts) ? payload.accounts : [];
  const activeAccount: AccountView | null = payload.activeAccount ?? null;
  return { user: userObj, accounts, activeAccount };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [activeAccount, setActiveAccount] = useState<AccountView | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [mode, setMode] = useState<UserMode>('guest');
  const [intent, setIntent] = useState<AuthIntent>(null);
  // Sprint Auth-2: pendingIntent — действие, прерванное гостем (booking_confirm и т.д.)
  const [pendingIntent, setPendingIntentState] = useState<PendingIntent>(null);
  const [pendingIntentParams, setPendingIntentParams] = useState<Record<string, string> | null>(null);

  // 🔥 INIT AUTH - завантажуємо токен при старті
  useEffect(() => {
    const initAuth = async () => {
      console.log('[AuthContext] Initializing auth...');
      try {
        const [storedToken, storedMode, storedIntent, storedPendingIntent, storedPendingParams] = await Promise.all([
          AsyncStorage.getItem(TOKEN_KEY),
          AsyncStorage.getItem(MODE_KEY),
          AsyncStorage.getItem(INTENT_KEY),
          AsyncStorage.getItem(PENDING_INTENT_KEY),
          AsyncStorage.getItem(PENDING_INTENT_PARAMS_KEY),
        ]);

        if (storedMode === 'customer' || storedMode === 'provider' || storedMode === 'guest' || storedMode === 'admin') {
          setMode(storedMode);
        }
        if (storedIntent) {
          setIntent(storedIntent as AuthIntent);
        }
        if (storedPendingIntent) {
          setPendingIntentState(storedPendingIntent);
        }
        if (storedPendingParams) {
          try { setPendingIntentParams(JSON.parse(storedPendingParams)); } catch { /* ignore */ }
        }

        if (storedToken) {
          api.defaults.headers.common['Authorization'] = `Bearer ${storedToken}`;
          setToken(storedToken);

          try {
            const response = await api.get('/auth/me');
            const norm = normalizeIdentity(response.data);
            console.log('[AuthContext] User loaded:', norm.user?.email, 'kind:', norm.activeAccount?.kind);
            setUser(norm.user);
            setAccounts(norm.accounts);
            setActiveAccount(norm.activeAccount);
            setMode(deriveMode(norm.user?.role, norm.activeAccount?.kind));
          } catch (error: any) {
            console.log('[AuthContext] Failed to load user, clearing token:', error?.message);
            await AsyncStorage.removeItem(TOKEN_KEY);
            delete api.defaults.headers.common['Authorization'];
            setToken(null);
            setUser(null);
            setAccounts([]);
            setActiveAccount(null);
          }
        }
      } catch (error) {
        console.log('[AuthContext] Init error:', error);
      } finally {
        setIsLoading(false);
        console.log('[AuthContext] Init complete');
      }
    };

    initAuth();
  }, []);

  // 🔥 LOGIN
  const login = useCallback(async (email: string, password: string) => {
    console.log('[AuthContext] Login attempt for:', email);
    const response = await api.post('/auth/login', { email, password });

    // Sprint 2FA — server may demand a TOTP second step. We DON'T persist
    // anything yet; the screen handler throws a typed error so the UI can
    // navigate to the OTP entry view.
    if (response.data?.requires2FA && response.data?.challengeToken) {
      const err: any = new Error('2FA_REQUIRED');
      err.code = '2FA_REQUIRED';
      err.challengeToken = response.data.challengeToken;
      err.expiresAt = response.data.expiresAt;
      err.email = email;
      throw err;
    }

    const { accessToken } = response.data;
    const norm = normalizeIdentity(response.data);

    await AsyncStorage.setItem(TOKEN_KEY, accessToken);
    api.defaults.headers.common['Authorization'] = `Bearer ${accessToken}`;

    setToken(accessToken);
    setUser(norm.user);
    setAccounts(norm.accounts);
    setActiveAccount(norm.activeAccount);
    const nextMode = deriveMode(norm.user?.role, norm.activeAccount?.kind);
    setMode(nextMode);
    await AsyncStorage.setItem(MODE_KEY, nextMode);

    console.log('[AuthContext] Login complete, user:', norm.user?.email, 'mode:', nextMode);
    return norm.user;
  }, []);

  // 🔥 LOGIN — second step (2FA verify) — mirrors `login` after challenge.
  const loginWith2FA = useCallback(async (challengeToken: string, code?: string, recoveryCode?: string) => {
    const response = await api.post('/auth/2fa/verify', { challengeToken, code, recoveryCode });
    const { accessToken } = response.data;
    if (!accessToken) throw new Error('No access token returned');
    const norm = normalizeIdentity(response.data);

    await AsyncStorage.setItem(TOKEN_KEY, accessToken);
    api.defaults.headers.common['Authorization'] = `Bearer ${accessToken}`;
    setToken(accessToken);
    setUser(norm.user);
    setAccounts(norm.accounts);
    setActiveAccount(norm.activeAccount);
    const nextMode = deriveMode(norm.user?.role, norm.activeAccount?.kind);
    setMode(nextMode);
    await AsyncStorage.setItem(MODE_KEY, nextMode);
    return norm.user;
  }, []);

  // 🔥 REGISTER
  const register = useCallback(async (data: RegisterData) => {
    console.log('[AuthContext] Register attempt for:', data.email, 'role:', data.role);
    const response = await api.post('/auth/register', data);
    const { accessToken } = response.data;
    const norm = normalizeIdentity(response.data);

    await AsyncStorage.setItem(TOKEN_KEY, accessToken);
    api.defaults.headers.common['Authorization'] = `Bearer ${accessToken}`;

    setToken(accessToken);
    setUser(norm.user);
    setAccounts(norm.accounts);
    setActiveAccount(norm.activeAccount);
    const nextMode = deriveMode(norm.user?.role, norm.activeAccount?.kind);
    setMode(nextMode);
    await AsyncStorage.setItem(MODE_KEY, nextMode);

    console.log('[AuthContext] Register complete');
  }, []);

  // 🔥 LOGOUT
  const logout = useCallback(async () => {
    console.log('[AuthContext] Logout...');

    await AsyncStorage.multiRemove([TOKEN_KEY, MODE_KEY, INTENT_KEY, PENDING_INTENT_KEY, PENDING_INTENT_PARAMS_KEY]);
    delete api.defaults.headers.common['Authorization'];

    setToken(null);
    setUser(null);
    setAccounts([]);
    setActiveAccount(null);
    setMode('guest');
    setIntent(null);
    setPendingIntentState(null);
    setPendingIntentParams(null);

    console.log('[AuthContext] Logout complete');
  }, []);

  // Sprint 1E: switch active account. Backend mints a new JWT scoped to
  // the requested account; we save the new token and refresh local state.
  // The mode (and therefore navigation) auto-updates because deriveMode()
  // reads activeAccount.kind first.
  const switchAccount = useCallback(async (accountId: string): Promise<AccountView | null> => {
    if (!token) {
      console.warn('[AuthContext] switchAccount called without a token');
      return null;
    }
    console.log('[AuthContext] Switching to account:', accountId);
    const response = await api.post('/auth/switch-account', { accountId });
    const { accessToken } = response.data;
    const norm = normalizeIdentity(response.data);

    if (!accessToken || !norm.activeAccount) {
      console.warn('[AuthContext] switch-account response malformed:', response.data);
      return null;
    }

    await AsyncStorage.setItem(TOKEN_KEY, accessToken);
    api.defaults.headers.common['Authorization'] = `Bearer ${accessToken}`;

    setToken(accessToken);
    setAccounts(norm.accounts);
    setActiveAccount(norm.activeAccount);
    // user object isn't returned by switch-account — keep the prior one;
    // role didn't change, only active persona did.
    const nextMode = deriveMode(user?.role, norm.activeAccount.kind);
    setMode(nextMode);
    await AsyncStorage.setItem(MODE_KEY, nextMode);

    console.log('[AuthContext] Switched to', norm.activeAccount.kind, '— mode:', nextMode);
    return norm.activeAccount;
  }, [token, user?.role]);

  // 🔥 Set logout handler for 401 interceptor
  useEffect(() => {
    setLogoutHandler(logout);
  }, [logout]);

  // 🔥 REFRESH USER
  const refreshUser = useCallback(async () => {
    if (!token) return;

    try {
      const response = await api.get('/auth/me');
      const norm = normalizeIdentity(response.data);
      setUser(norm.user);
      setAccounts(norm.accounts);
      setActiveAccount(norm.activeAccount);
      setMode(deriveMode(norm.user?.role, norm.activeAccount?.kind));
    } catch (error) {
      console.log('[AuthContext] Refresh user failed');
    }
  }, [token]);

  // ─── Welcome flow choices (no real auth) ───────────────────────────
  const persistChoice = useCallback(async (nextMode: UserMode, nextIntent: AuthIntent) => {
    setMode(nextMode);
    setIntent(nextIntent);
    await Promise.all([
      AsyncStorage.setItem(MODE_KEY, nextMode),
      nextIntent
        ? AsyncStorage.setItem(INTENT_KEY, nextIntent)
        : AsyncStorage.removeItem(INTENT_KEY),
    ]);
  }, []);

  const chooseCustomer = useCallback(async () => {
    await persistChoice('customer', 'find_master');
  }, [persistChoice]);

  const chooseProvider = useCallback(async () => {
    await persistChoice('provider', 'provider_work');
  }, [persistChoice]);

  const continueAsGuest = useCallback(async () => {
    await persistChoice('guest', 'guest');
  }, [persistChoice]);

  // ─── Sprint Auth-2: pendingIntent (action restore after login) ─────
  const setPendingIntent = useCallback(
    async (next: PendingIntent, params: Record<string, string> | null = null) => {
      setPendingIntentState(next);
      setPendingIntentParams(params);
      if (next) {
        await AsyncStorage.setItem(PENDING_INTENT_KEY, String(next));
        if (params && Object.keys(params).length > 0) {
          await AsyncStorage.setItem(PENDING_INTENT_PARAMS_KEY, JSON.stringify(params));
        } else {
          await AsyncStorage.removeItem(PENDING_INTENT_PARAMS_KEY);
        }
      } else {
        await AsyncStorage.multiRemove([PENDING_INTENT_KEY, PENDING_INTENT_PARAMS_KEY]);
      }
    },
    []
  );

  const consumePendingIntent = useCallback(async () => {
    const result = { intent: pendingIntent, params: pendingIntentParams };
    setPendingIntentState(null);
    setPendingIntentParams(null);
    await AsyncStorage.multiRemove([PENDING_INTENT_KEY, PENDING_INTENT_PARAMS_KEY]);
    return result;
  }, [pendingIntent, pendingIntentParams]);

  const isAuthenticated = !!token && !!user;
  const isGuest = !isAuthenticated;

  const value: AuthContextType = {
    user,
    token,
    isLoading,
    isAuthenticated,
    accounts,
    activeAccount,
    switchAccount,
    mode,
    intent,
    isGuest,
    pendingIntent,
    pendingIntentParams,
    setPendingIntent,
    consumePendingIntent,
    login,
    loginWith2FA,
    register,
    logout,
    refreshUser,
    chooseCustomer,
    chooseProvider,
    continueAsGuest,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
