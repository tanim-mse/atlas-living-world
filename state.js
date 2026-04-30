/**
 * state.js — Global world state
 * Atlas: The Living World
 *
 * Single shared mutable object that every module reads and writes.
 * No getters, no setters, no Proxy — intentionally simple.
 * The renderer reads it every frame; auth.js hydrates it on login.
 *
 * Keys are grouped by domain. Do not add keys outside their group.
 * Derived metrics (moodAvg7, financialHealth, etc.) are computed by
 * auth.js after every data hydration — never set them manually.
 */

export const state = {

  // ── Authentication ─────────────────────────────────────────────────────────
  // Set by auth.js after successful login / session restore.
  // Cleared to null on logout.
  user: null,


  // ── World ──────────────────────────────────────────────────────────────────
  currentZone: 'center',          // 'center' | 'garden' | 'grove' | 'crystals'
                                  // | 'library' | 'treasury' | 'gaming'
  season:      'summer',          // 'spring' | 'summer' | 'autumn' | 'winter'
  weather:     'scattered',       // 'clear' | 'scattered' | 'overcast' | 'rain' | 'storm'


  // ── Camera ─────────────────────────────────────────────────────────────────
  // All positions in world units.  y = eye height (1.72 at standing).
  camera: {
    x:              0,
    y:              1.72,
    z:              0,
    targetX:        0,
    targetY:        1.72,
    targetZ:        0,
    yaw:            0,            // radians — horizontal look angle
    pitch:          0,            // radians — vertical look angle, clamped ±10°
    isTransitioning: false,       // true during zone-to-zone CatmullRom spline travel
  },


  // ── Wind ───────────────────────────────────────────────────────────────────
  // Read every frame by grass, flower, tree, and vine shaders.
  wind: {
    strength:        0.20,        // 0 (still) → 1 (gale)
    direction:       { x: 0.82, z: 0.28 },   // normalised XZ vector
    gustStrength:    0.0,         // instantaneous gust on top of base strength
    gustPhase:       0.0,         // internal phase accumulator
    targetStrength:  0.20,        // lerp target — weather system writes this
    targetDirection: { x: 0.82, z: 0.28 },
  },


  // ── Time ───────────────────────────────────────────────────────────────────
  // localHour drives sun position, light temperature, and zone atmospherics.
  localHour:   12.0,              // 0.0 – 23.999, real wall-clock time of day
  dayOfYear:   1,                 // 1 – 365, drives seasonal sun declination
  latitude:    23.8,              // Dhaka, Bangladesh — fixed


  // ── Sun & moon ─────────────────────────────────────────────────────────────
  sunDirection:  { x: 0, y: 1, z: 0 },     // normalised world-space direction toward sun
  sunColor:      { r: 1.0, g: 0.95, b: 0.88 },
  sunElevation:  0,               // degrees above horizon, negative = below
  moonPhase:     0,               // 0 (new) → 0.5 (full) → 1 (new again)
  isNight:       false,           // true when sunElevation < −6°


  // ── Environment ────────────────────────────────────────────────────────────
  wetness:          0.0,          // 0 (dry) → 1 (soaked). All shaders read uWetness.
  fogDensity:       0.0004,       // exponential fog density coefficient
  lightTemperature: 6500,         // Kelvin — 2800 sunset, 6500 noon, 7500 overcast


  // ── Performance ────────────────────────────────────────────────────────────
  fps:       60,
  gpuTier:   'high',              // 'high' | 'medium' | 'low' — set by scene.js on init
  deltaTime: 0.016,               // seconds since last frame, updated by render loop


  // ── Data cache — raw Supabase rows ─────────────────────────────────────────
  // Populated by auth.js → _hydrateState() after login.
  // Zone modules read these arrays — they never fetch directly.

  habits:             [],         // rows from habits table
  habitLogs:          [],         // rows from habit_logs (last 365 days)

  journalEntries:     [],         // rows from journal_entries (last 200)
  moodLogs:           [],         // rows from mood_logs (last 365 days)

  goals:              [],         // rows from goals table

  books:              [],         // rows from books table
  readingSessions:    [],         // rows from reading_sessions

  gamingSessions:     [],         // rows from gaming_sessions (last 500)
  games:              [],         // rows from games aggregate table

  incomeEntries:      [],         // rows from income_entries
  expenseEntries:     [],         // rows from expense_entries
  expenseCategories:  [],         // rows from expense_categories
  savingsGoals:       [],         // rows from savings_goals
  savingsEntries:     [],         // rows from savings_entries
  debtEntries:        [],         // rows from debt_entries (active only)


  // ── Derived metrics ────────────────────────────────────────────────────────
  // Computed by auth.js → _computeDerivedMetrics() after every hydration.
  // Read by zone modules for visual decisions. Never set manually.

  // Mood
  moodAvg7:    0.5,               // 7-day valence average,  0–1
  moodAvg30:   0.5,               // 30-day valence average, 0–1
  moodTrend:   0.0,               // moodAvg7 − moodAvg30. positive = improving

  // Financial
  monthlyIncome:    0,            // BDT, current calendar month
  monthlyExpenses:  0,            // BDT, current calendar month
  monthlyNet:       0,            // income − expenses
  savingsBalance:   0,            // sum of all savings_entries
  totalDebt:        0,            // sum of outstanding debt balances
  financialHealth:  0.5,          // 0 (dire) → 1 (excellent), drives Treasury visuals

  // Books
  booksFinished:        0,        // count of status = 'finished'
  currentReadingStreak: 0,        // days — from reading_streak view


  // ── UI ─────────────────────────────────────────────────────────────────────
  activePanel:       null,        // string key of the open panel, or null
  activePanelTarget: null,        // Three.js object that triggered the panel

};