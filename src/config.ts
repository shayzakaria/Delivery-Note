// Public client configuration. The publishable key is designed to be shipped to
// browsers; all data access is enforced server-side by Row Level Security.
export const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL || 'https://lpqbdvoknexpomhcopbz.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY: string =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_bPB-1f_O9TAla3h7kCNRsQ_y7et_DTI';
export const DATA_MODE: 'supabase' | 'mock' = import.meta.env.VITE_DATA_MODE === 'mock' ? 'mock' : 'supabase';
export const APP_VERSION = '2026-09-30';
