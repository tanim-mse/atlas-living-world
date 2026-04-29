/**
 * config.js — Central configuration
 * Atlas: The Living World
 *
 * Single source of truth for all environment values.
 * The anon key is intentionally public — it is safe in client-side code.
 * The service role key is NEVER stored here or anywhere in the codebase.
 */

export const CONFIG = {

  // ── Supabase ──────────────────────────────────────────────────────────────
  SUPABASE_URL:      'https://aeubcbcmafpazswkkyex.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFldWJjYmNtYWZwYXpzd2treWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0MzczNDQsImV4cCI6MjA5MzAxMzM0NH0.hAH8zEaxg-nUqeYru2CQnnTPhc-QfILi-naQ2rEPtZk',

  // ── Cloudinary ────────────────────────────────────────────────────────────
  CLOUDINARY_CLOUD:  'dr2b6pzux',
  CLOUDINARY_PRESET: 'portfolio_uploads',

  // ── Auth ──────────────────────────────────────────────────────────────────
  ALLOWED_EMAIL:       'tanim97@proton.me',
  INACTIVITY_TIMEOUT:  30 * 60 * 1000,   // 30 minutes → lock screen
  MAX_LOGIN_ATTEMPTS:  5,
  LOCKOUT_DURATION:    15 * 60 * 1000,   // 15 minutes
  MAX_UNLOCK_ATTEMPTS: 3,                 // then full logout

  // ── World ─────────────────────────────────────────────────────────────────
  WORLD_SIZE:          10_000,            // units (10 km × 10 km)
  CAMERA_FOV:          58,
  CAMERA_NEAR:         0.05,
  CAMERA_FAR:          15_000,
  CAMERA_EYE_HEIGHT:   1.72,             // metres
  LATITUDE:            23.8,             // Dhaka, Bangladesh

  // ── Renderer ──────────────────────────────────────────────────────────────
  TARGET_FPS:          60,
  PIXEL_RATIO:         Math.min(window.devicePixelRatio, 2),

  // ── Zone positions (world-space centre coordinates) ───────────────────────
  ZONES: {
    center:  { x:     0, z:     0 },
    garden:  { x: -1600, z:  1400 },
    grove:   { x: -1400, z: -2200 },
    crystals:{ x:  2200, z: -2400 },
    library: { x:  2260, z: -2430 },   // inside cliff face of crystal field
    treasury:{ x: -3500, z: -1000 },
    gaming:  { x:  2600, z:  1600 },
  },

  // ── Hosting ───────────────────────────────────────────────────────────────
  BASE_URL: 'https://github.com/tanim-mse/Atlas-living-world',   // update to real Pages URL

};