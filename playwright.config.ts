import { defineConfig } from '@playwright/test';

// E2E tests run the real UI against the in-browser demo store (`--mode mock`),
// so they need no Supabase project or network access.
const PORT = 5174;

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    acceptDownloads: true,
    locale: 'he-IL',
    timezoneId: 'Asia/Jerusalem',
    launchOptions: {
      ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
      // Chromium on Linux replaces non-ASCII download names with "download" unless the
      // locale is UTF-8; the exported files have Hebrew names.
      env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    },
  },
  webServer: {
    command: `npx vite --mode mock --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
