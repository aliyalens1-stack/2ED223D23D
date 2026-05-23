import { create } from 'zustand';
import { authAPI, api } from '../services/api';

// Sprint 1E — identity layer for web. Mirrors the mobile AuthContext shape.
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

interface User {
  id: string;
  email: string;
  role: string;
  firstName: string;
  lastName: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  accounts: AccountView[];
  activeAccount: AccountView | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<{ user: User | null; activeAccount: AccountView | null; accounts: AccountView[] }>;
  register: (data: any) => Promise<{ user: User | null; activeAccount: AccountView | null; accounts: AccountView[] }>;
  logout: () => void;
  checkAuth: () => Promise<void>;
  switchAccount: (accountId: string) => Promise<AccountView | null>;
}

// Sprint 1E: normalize the three response shapes into one. /auth/login,
// /auth/register, /auth/me and /auth/switch-account each return a slightly
// different envelope; this collapses them into { user, accounts, activeAccount }.
function normalizeIdentity(payload: any) {
  if (!payload || typeof payload !== 'object') {
    return { user: null, accounts: [] as AccountView[], activeAccount: null };
  }
  return {
    user: payload.user ?? null,
    accounts: Array.isArray(payload.accounts) ? (payload.accounts as AccountView[]) : [],
    activeAccount: (payload.activeAccount as AccountView | null) ?? null,
  };
}

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: readStored<User | null>('user', null),
  token: localStorage.getItem('token'),
  accounts: readStored<AccountView[]>('accounts', []),
  activeAccount: readStored<AccountView | null>('activeAccount', null),
  isLoading: false,

  login: async (email, password) => {
    const { data } = await authAPI.login(email, password);
    const norm = normalizeIdentity(data);
    localStorage.setItem('token', data.accessToken);
    if (norm.user) localStorage.setItem('user', JSON.stringify(norm.user));
    localStorage.setItem('accounts', JSON.stringify(norm.accounts));
    if (norm.activeAccount) localStorage.setItem('activeAccount', JSON.stringify(norm.activeAccount));
    set({
      user: norm.user,
      token: data.accessToken,
      accounts: norm.accounts,
      activeAccount: norm.activeAccount,
    });
    return norm;
  },

  register: async (d) => {
    const { data } = await authAPI.register(d);
    const norm = normalizeIdentity(data);
    localStorage.setItem('token', data.accessToken);
    if (norm.user) localStorage.setItem('user', JSON.stringify(norm.user));
    localStorage.setItem('accounts', JSON.stringify(norm.accounts));
    if (norm.activeAccount) localStorage.setItem('activeAccount', JSON.stringify(norm.activeAccount));
    set({
      user: norm.user,
      token: data.accessToken,
      accounts: norm.accounts,
      activeAccount: norm.activeAccount,
    });
    return norm;
  },

  logout: () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    localStorage.removeItem('accounts');
    localStorage.removeItem('activeAccount');
    set({ user: null, token: null, accounts: [], activeAccount: null });
  },

  checkAuth: async () => {
    const t = localStorage.getItem('token');
    if (!t) return;
    set({ isLoading: true });
    try {
      const { data } = await authAPI.me();
      const norm = normalizeIdentity(data);
      if (norm.user) localStorage.setItem('user', JSON.stringify(norm.user));
      localStorage.setItem('accounts', JSON.stringify(norm.accounts));
      if (norm.activeAccount) localStorage.setItem('activeAccount', JSON.stringify(norm.activeAccount));
      set({
        user: norm.user,
        token: t,
        accounts: norm.accounts,
        activeAccount: norm.activeAccount,
      });
    } catch {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      localStorage.removeItem('accounts');
      localStorage.removeItem('activeAccount');
      set({ user: null, token: null, accounts: [], activeAccount: null });
    } finally {
      set({ isLoading: false });
    }
  },

  switchAccount: async (accountId) => {
    const token = get().token;
    if (!token) return null;
    const { data } = await api.post('/auth/switch-account', { accountId });
    const norm = normalizeIdentity(data);
    if (!data.accessToken || !norm.activeAccount) return null;
    localStorage.setItem('token', data.accessToken);
    localStorage.setItem('accounts', JSON.stringify(norm.accounts));
    localStorage.setItem('activeAccount', JSON.stringify(norm.activeAccount));
    set({
      token: data.accessToken,
      accounts: norm.accounts,
      activeAccount: norm.activeAccount,
    });
    return norm.activeAccount;
  },
}));
