import { create } from 'zustand';
import { authAPI } from '../services/api';

interface User {
  _id: string;
  email: string;
  role: string;
  firstName?: string;
  lastName?: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<boolean>;
  logout: () => void;
  checkAuth: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  token: localStorage.getItem('admin_token'),
  isLoading: true,
  error: null,

  login: async (email: string, password: string) => {
    try {
      set({ isLoading: true, error: null });
      const res = await authAPI.login(email, password);
      const token = res.data.accessToken || res.data.access_token;
      const user = res.data.user;
      
      // Check if admin
      if (user.role !== 'admin') {
        set({ error: 'Доступ запрещён. Только для администраторов.', isLoading: false });
        return false;
      }
      
      localStorage.setItem('admin_token', token);
      set({ user, token, isLoading: false });
      return true;
    } catch (err: any) {
      set({ 
        error: err.response?.data?.message || 'Ошибка авторизации', 
        isLoading: false 
      });
      return false;
    }
  },

  logout: () => {
    localStorage.removeItem('admin_token');
    set({ user: null, token: null });
    window.location.href = '/login';
  },

  checkAuth: async () => {
    const token = localStorage.getItem('admin_token');
    if (!token) {
      set({ isLoading: false });
      return;
    }
    try {
      const res = await authAPI.me();
      if (res.data.role !== 'admin') {
        localStorage.removeItem('admin_token');
        set({ user: null, token: null, isLoading: false });
        return;
      }
      set({ user: res.data, isLoading: false });
    } catch {
      localStorage.removeItem('admin_token');
      set({ user: null, token: null, isLoading: false });
    }
  },
}));
