"""app.two_factor — TOTP-based 2FA module (Google Authenticator compatible).

Per the integration playbook (2FA TOTP):
  - pyotp generates / verifies RFC 6238 codes
  - qrcode + Pillow renders the otpauth:// URI as a PNG QR
  - Fernet encrypts the Base32 secret at rest (key: TOTP_FERNET_KEY env)
  - 10 single-use recovery codes (bcrypt-hashed) generated at enrollment
  - Short-lived `totp_challenges` collection with TTL index gates the
    second login step

Endpoints (all under /api/auth/2fa):
  POST /setup/start    → returns secret + QR (base64 PNG) + otpauth URI
  POST /setup/confirm  → confirm enrollment (verifies first TOTP code),
                          returns 10 recovery codes (only this once)
  POST /disable        → disable 2FA (requires password + TOTP/recovery)
  POST /verify         → second-step login: challenge_token + code → JWT
  GET  /status         → { enabled, hasRecoveryCodes, lastVerifiedAt }
  POST /recovery/regenerate → regenerate recovery codes (auth'd)

Existing /api/auth/login is amended to return `requires2FA: true` and a
`challengeToken` when the user has 2FA enabled (instead of issuing a JWT
immediately). Clients call /verify with the code to complete login.
"""
