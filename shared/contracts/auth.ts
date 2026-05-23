/**
 * Auth contracts — identity primitives.
 *
 * Canonical prefix: /auth
 * See /app/shared/contracts/DOCTRINE.md §2.
 */
export const AUTH = {
  login:          '/auth/login',
  register:       '/auth/register',
  me:             '/auth/me',
  forgotPassword: '/auth/forgot-password',
  resetPassword:  '/auth/reset-password',
} as const;
