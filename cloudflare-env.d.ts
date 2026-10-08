declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ASSETS: Fetcher;
    APP_SECRET?: string;
    OWNER_EMAIL?: string;
    ADMIN_SETUP_TOKEN?: string;
    ADMIN_SETUP_PASSWORD?: string;
    ADMIN_RECOVERY_TOKEN?: string;
    RESEND_API_KEY?: string;
    EMAIL_FROM?: string;
  }
}
