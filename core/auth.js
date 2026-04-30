/**
 * auth.js — Authentication & session security
 * Atlas: The Living World
 *
 * Handles login, logout, session restoration, inactivity locking,
 * and the lock-screen unlock flow.  Enforces all client-side auth
 * layers defined in the security architecture (Layers 3–5).
 *
 * Security model:
 *   - Only tanim97@proton.me is permitted — checked before any network call
 *   - Max 5 login attempts → 15-minute lockout
 *   - 30 minutes idle → lock screen (state cleared, world dimmed)
 *   - Max 3 unlock failures → full logout
 *   - Session token validated on every restoration
 */

import { CONFIG }  from './config.js';
import { db }      from './supabase.js';
import { state }   from './state.js';
import {
  loadAllUserData,
  saveWorldState,
  seedDefaultCategories,
} from './supabase.js';


// =============================================================================
// PRIVATE STATE
// =============================================================================

let inactivityTimer   = null;
let loginAttempts     = 0;
let lockoutUntil      = null;    // Date.now() timestamp
let unlockAttempts    = 0;
let isFirstLogin      = false;   // triggers category seeding once


// =============================================================================
// LOGIN
// =============================================================================

/**
 * Attempt to sign in with email + password.
 * Returns { data } on success or { error: string } on failure.
 * All error strings are safe to display directly in the UI.
 */
export async function login(email, password) {
  const normalised = email.toLowerCase().trim();

  // Layer 3 — email whitelist checked before any network call
  if (normalised !== CONFIG.ALLOWED_EMAIL) {
    return { error: 'Unauthorized.' };
  }

  // Lockout check
  if (lockoutUntil && Date.now() < lockoutUntil) {
    const mins = Math.ceil((lockoutUntil - Date.now()) / 60_000);
    return { error: `Too many attempts. Try again in ${mins} minute${mins !== 1 ? 's' : ''}.` };
  }

  const { data, error } = await db.auth.signInWithPassword({ email: normalised, password });

  if (error) {
    loginAttempts += 1;

    if (loginAttempts >= CONFIG.MAX_LOGIN_ATTEMPTS) {
      lockoutUntil  = Date.now() + CONFIG.LOCKOUT_DURATION;
      loginAttempts = 0;
      return { error: 'Too many attempts. Locked for 15 minutes.' };
    }

    const remaining = CONFIG.MAX_LOGIN_ATTEMPTS - loginAttempts;
    return {
      error: `Invalid credentials. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`,
    };
  }

  // Successful login
  loginAttempts = 0;
  lockoutUntil  = null;
  state.user    = data.user;

  await _onSessionEstablished(data.user);

  return { data };
}


// =============================================================================
// SESSION RESTORATION
// =============================================================================

/**
 * Called on world.html load.  Reads the persisted Supabase session from
 * localStorage and validates it.  Returns true if a valid Tanim session
 * exists, false otherwise (caller should redirect to index.html).
 */
export async function restoreSession() {
  const { data: { session }, error } = await db.auth.getSession();

  if (error || !session) return false;

  // Double-check email even on a valid JWT — belt and suspenders
  if (session.user.email !== CONFIG.ALLOWED_EMAIL) {
    await logout();
    return false;
  }

  state.user = session.user;
  await _onSessionEstablished(session.user);

  return true;
}


// =============================================================================
// LOGOUT
// =============================================================================

/**
 * Full sign-out: clears timers, wipes in-memory state, signs out from
 * Supabase, and redirects to the login page.
 */
export async function logout() {
  _clearInactivityTimer();
  _clearStateData();

  await db.auth.signOut();

  window.location.href = '/index.html';
}


// =============================================================================
// INACTIVITY TIMER
// =============================================================================

/**
 * Reset the inactivity countdown.  Called by world.js on every user
 * interaction (mousemove, keydown, click, wheel).
 */
export function resetInactivityTimer() {
  _startInactivityTimer();
}

function _startInactivityTimer() {
  _clearInactivityTimer();
  inactivityTimer = setTimeout(_lockScreen, CONFIG.INACTIVITY_TIMEOUT);
}

function _clearInactivityTimer() {
  if (inactivityTimer !== null) {
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
  }
}


// =============================================================================
// LOCK SCREEN
// =============================================================================

/**
 * Triggered after INACTIVITY_TIMEOUT milliseconds of no interaction.
 * Clears sensitive in-memory data, dims the world, and shows the lock overlay.
 */
function _lockScreen() {
  _clearStateData();

  // Notify the world renderer to dim
  window.dispatchEvent(new CustomEvent('atlas:lock'));

  const overlay  = document.getElementById('lock-screen');
  const input    = document.getElementById('lock-password');

  if (overlay) overlay.style.display = 'flex';
  if (input)   { input.value = ''; input.focus(); }
}

/**
 * Attempt to unlock from the lock screen.
 * Returns { data } on success or { error: string } on failure.
 * After MAX_UNLOCK_ATTEMPTS failures → full logout.
 */
export async function unlockScreen(password) {
  const { data, error } = await db.auth.signInWithPassword({
    email: CONFIG.ALLOWED_EMAIL,
    password,
  });

  if (error) {
    unlockAttempts += 1;

    if (unlockAttempts >= CONFIG.MAX_UNLOCK_ATTEMPTS) {
      await logout();
      return { error: 'Too many unlock attempts. Signed out.' };
    }

    const remaining = CONFIG.MAX_UNLOCK_ATTEMPTS - unlockAttempts;
    return {
      error: `Incorrect password. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`,
    };
  }

  // Successful unlock — restore state and restart timer
  unlockAttempts = 0;
  state.user     = data.session.user;

  const overlay = document.getElementById('lock-screen');
  if (overlay) overlay.style.display = 'none';

  // Notify the world renderer to un-dim
  window.dispatchEvent(new CustomEvent('atlas:unlock'));

  // Reload data so the world reflects any changes made elsewhere
  await _hydrateState(data.session.user.id);

  _startInactivityTimer();

  return { data };
}


// =============================================================================
// AUTH GUARD
// =============================================================================

/**
 * Call at the top of world.html's init script.
 * Redirects to the login page if no valid session exists.
 * Returns false so the caller can bail out immediately.
 */
export function requireAuth() {
  if (!state.user) {
    window.location.href = '/index.html';
    return false;
  }
  return true;
}


// =============================================================================
// SUPABASE AUTH STATE LISTENER
// =============================================================================

/**
 * Keeps state.user in sync with Supabase token refreshes.
 * Registered once — the SDK fires this on every token change.
 */
db.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') {
    _clearStateData();
    state.user = null;
    return;
  }

  if (event === 'TOKEN_REFRESHED' && session) {
    // Token silently refreshed — just update the user reference
    state.user = session.user;
  }
});


// =============================================================================
// PRIVATE HELPERS
// =============================================================================

/**
 * Shared setup run after every successful sign-in or session restoration.
 */
async function _onSessionEstablished(user) {
  // Seed default expense categories on first-ever login
  const { data: existing } = await db
    .from('expense_categories')
    .select('id')
    .eq('user_id', user.id)
    .limit(1);

  if (!existing || existing.length === 0) {
    isFirstLogin = true;
    await seedDefaultCategories(user.id);
  }

  await _hydrateState(user.id);
  _startInactivityTimer();
}

/**
 * Load all personal data from Supabase into state in one parallel fetch.
 */
async function _hydrateState(userId) {
  const payload = await loadAllUserData(userId);

  if (payload.error) {
    console.error('[Atlas] Data hydration error:', payload.error.message);
    // Non-fatal — the world loads with whatever data arrived
  }

  state.habits            = payload.habits;
  state.habitLogs         = payload.habitLogs;
  state.journalEntries    = payload.journalEntries;
  state.moodLogs          = payload.moodLogs;
  state.goals             = payload.goals;
  state.books             = payload.books;
  state.readingSessions   = payload.readingSessions;
  state.currentReadingStreak = payload.readingStreak;
  state.gamingSessions    = payload.gamingSessions;
  state.games             = payload.games;
  state.incomeEntries     = payload.incomeEntries;
  state.expenseEntries    = payload.expenseEntries;
  state.expenseCategories = payload.expenseCategories;
  state.savingsGoals      = payload.savingsGoals;
  state.savingsEntries    = payload.savingsEntries;
  state.debtEntries       = payload.debtEntries;

  // Restore world camera position from last saved state
  if (payload.worldState) {
    const ws = payload.worldState;
    state.currentZone       = ws.last_zone    ?? 'center';
    state.season            = ws.current_season ?? 'summer';
    state.weather           = ws.weather_state  ?? 'scattered';
    state.camera.x          = ws.camera_x ?? 0;
    state.camera.y          = ws.camera_y ?? CONFIG.CAMERA_EYE_HEIGHT;
    state.camera.z          = ws.camera_z ?? 0;
    state.camera.targetX    = state.camera.x;
    state.camera.targetY    = state.camera.y;
    state.camera.targetZ    = state.camera.z;
  }

  _computeDerivedMetrics();
}

/**
 * Compute summary metrics the world uses for visual decisions
 * (season from mood, financial health, etc.).
 * Called after every hydration.
 */
function _computeDerivedMetrics() {
  // ── Mood averages ─────────────────────────────────────────────────────────
  const now    = Date.now();
  const logs7  = state.moodLogs.filter(m =>
    now - new Date(m.logged_at).getTime() < 7  * 86_400_000
  );
  const logs30 = state.moodLogs.filter(m =>
    now - new Date(m.logged_at).getTime() < 30 * 86_400_000
  );

  state.moodAvg7  = logs7.length
    ? logs7.reduce((s, m) => s + m.valence, 0) / logs7.length
    : 0.5;
  state.moodAvg30 = logs30.length
    ? logs30.reduce((s, m) => s + m.valence, 0) / logs30.length
    : 0.5;
  state.moodTrend = state.moodAvg7 - state.moodAvg30;   // positive = improving

  // ── Financial health ──────────────────────────────────────────────────────
  const thisMonth = new Date().toISOString().slice(0, 7);   // 'YYYY-MM'

  state.monthlyIncome = state.incomeEntries
    .filter(e => e.date.startsWith(thisMonth))
    .reduce((s, e) => s + parseFloat(e.amount), 0);

  state.monthlyExpenses = state.expenseEntries
    .filter(e => e.date.startsWith(thisMonth))
    .reduce((s, e) => s + parseFloat(e.amount), 0);

  state.monthlyNet = state.monthlyIncome - state.monthlyExpenses;

  state.savingsBalance = state.savingsEntries
    .reduce((s, e) => s + parseFloat(e.amount), 0);

  state.totalDebt = state.debtEntries
    .filter(e => !e.cleared_at)
    .reduce((s, e) => s + (parseFloat(e.total_amount) - parseFloat(e.amount_paid)), 0);

  // Financial health: 0 (dire) → 1 (excellent)
  // Simple heuristic: positive net → base 0.6, savings tilt toward 1,
  // debt load tilts toward 0.
  const netRatio     = state.monthlyIncome > 0
    ? Math.min(state.monthlyNet / state.monthlyIncome, 1)
    : 0;
  const debtPenalty  = state.totalDebt > 0 && state.monthlyIncome > 0
    ? Math.min(state.totalDebt / (state.monthlyIncome * 12), 1) * 0.3
    : 0;

  state.financialHealth = Math.max(0, Math.min(1,
    0.5 + netRatio * 0.3 + (state.savingsBalance > 0 ? 0.2 : 0) - debtPenalty
  ));

  // ── Books ─────────────────────────────────────────────────────────────────
  state.booksFinished = state.books.filter(b => b.status === 'finished').length;
}

/**
 * Wipe all personal data from memory.
 * Called on lock and logout — data is re-fetched on unlock/re-login.
 */
function _clearStateData() {
  const CLEARABLE_KEYS = [
    'habits', 'habitLogs', 'journalEntries', 'moodLogs',
    'goals', 'books', 'readingSessions',
    'gamingSessions', 'games',
    'incomeEntries', 'expenseEntries', 'expenseCategories',
    'savingsGoals', 'savingsEntries', 'debtEntries',
  ];

  for (const key of CLEARABLE_KEYS) {
    state[key] = [];
  }

  // Reset derived metrics to neutral
  state.moodAvg7          = 0.5;
  state.moodAvg30         = 0.5;
  state.moodTrend         = 0.0;
  state.monthlyIncome     = 0;
  state.monthlyExpenses   = 0;
  state.monthlyNet        = 0;
  state.savingsBalance    = 0;
  state.totalDebt         = 0;
  state.financialHealth   = 0.5;
  state.booksFinished     = 0;
  state.currentReadingStreak = 0;
}