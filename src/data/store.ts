import { DATA_MODE } from '../config';
import { MockStore } from './mockStore';
import { SupabaseStore } from './supabaseStore';
import type { DataStore } from './types';

export const store: DataStore = DATA_MODE === 'mock' ? new MockStore() : new SupabaseStore();
