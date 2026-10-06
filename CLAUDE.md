# Working agreement

- **Production is `main`.** Cloudflare (Worker `delivery-note`) deploys `main` to https://modycustomer.com.
- **Never merge or push to `main` without the owner's explicit approval** ("מאשר למזג").
- Work happens on a feature branch. Every push there gets a Cloudflare preview URL;
  send that link with what to check, wait for approval, and only then merge to `main`.
- Database changes (Supabase project `lpqbdvoknexpomhcopbz`) are shared by production and previews:
  keep them additive and backwards-compatible so the live site keeps working until the merge.
  Save every applied migration under `supabase/migrations/` with the version Supabase assigned.
- The repository is public: never commit real business data. Tests use synthetic values only.
- Before pushing: `npm run build`, `npx vitest run`, and the Playwright E2E suite (`npm run e2e`).
