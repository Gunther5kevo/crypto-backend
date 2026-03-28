import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

// This maps exactly to your existing posts table — DO NOT change field names
export interface Post {
  id?: string;                    // uuid, auto-generated
  title: string;                  // required
  slug: string;                   // required, unique
  content?: string;
  excerpt?: string;
  created_at?: string;
  updated_at?: string;
  author?: string;
  tags?: string[];
  views?: number;                 // default 0
  category?: string;
  referral_links?: ReferralLink[];
  is_published?: boolean;         // default false
  meta_title?: string;
  meta_description?: string;
  focus_keyword?: string;
}

export interface ReferralLink {
  url: string;
  type: 'airdrop' | 'external' | 'referral' | 'unknown';
}

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY!; // service role — bypasses RLS

if (!supabaseUrl || !supabaseKey) {
  throw new Error('[supabase] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
}

export const supabase = createClient(supabaseUrl, supabaseKey);