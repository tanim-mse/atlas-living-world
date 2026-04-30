/**
 * supabase.js — Supabase client & data access layer
 * Atlas: The Living World
 *
 * Initialises the single shared Supabase client and exposes typed query
 * helpers for every table Atlas reads or writes.  All functions return
 * { data, error } so callers can handle failures without try/catch boilerplate.
 *
 * Import order dependency: config.js must be loaded first.
 */

import { CONFIG } from './config.js';

// ── Client initialisation ─────────────────────────────────────────────────────
// One client for the entire application lifetime.  Imported by every module
// that needs database or auth access.

const { createClient } = window.supabase;   // UMD global set by CDN script tag

export const db = createClient(
  CONFIG.SUPABASE_URL,
  CONFIG.SUPABASE_ANON_KEY,
  {
    auth: {
      persistSession:    true,
      autoRefreshToken:  true,
      detectSessionInUrl: false,   // Atlas never uses OAuth redirect flows
    },
    realtime: {
      params: { eventsPerSecond: 2 },   // conservative — Atlas doesn't need sub-second sync
    },
  }
);


// =============================================================================
// WORLD STATE
// =============================================================================

export async function loadWorldState(userId) {
  const { data, error } = await db
    .from('world_state')
    .select('*')
    .eq('user_id', userId)
    .single();
  return { data, error };
}

export async function saveWorldState(userId, patch) {
  const { data, error } = await db
    .from('world_state')
    .upsert({ user_id: userId, ...patch, updated_at: new Date().toISOString() })
    .select()
    .single();
  return { data, error };
}


// =============================================================================
// HABITS
// =============================================================================

export async function loadHabits(userId) {
  const { data, error } = await db
    .from('habits')
    .select('*')
    .eq('user_id', userId)
    .is('archived_at', null)
    .order('sort_order', { ascending: true });
  return { data, error };
}

export async function loadHabitLogs(userId, daysBack = 365) {
  const since = new Date();
  since.setDate(since.getDate() - daysBack);

  const { data, error } = await db
    .from('habit_logs')
    .select('*')
    .eq('user_id', userId)
    .gte('logged_date', since.toISOString().slice(0, 10))
    .order('logged_date', { ascending: false });
  return { data, error };
}

export async function logHabit(userId, habitId, note = null) {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await db
    .from('habit_logs')
    .upsert(
      { user_id: userId, habit_id: habitId, logged_date: today, note },
      { onConflict: 'habit_id,logged_date' }
    )
    .select()
    .single();
  return { data, error };
}

export async function unlogHabit(userId, habitId) {
  const today = new Date().toISOString().slice(0, 10);
  const { error } = await db
    .from('habit_logs')
    .delete()
    .eq('user_id', userId)
    .eq('habit_id', habitId)
    .eq('logged_date', today);
  return { error };
}

export async function createHabit(userId, fields) {
  const { data, error } = await db
    .from('habits')
    .insert({ user_id: userId, ...fields })
    .select()
    .single();
  return { data, error };
}

export async function updateHabit(userId, habitId, patch) {
  const { data, error } = await db
    .from('habits')
    .update(patch)
    .eq('user_id', userId)
    .eq('id', habitId)
    .select()
    .single();
  return { data, error };
}

export async function archiveHabit(userId, habitId) {
  return updateHabit(userId, habitId, { archived_at: new Date().toISOString() });
}


// =============================================================================
// JOURNAL
// =============================================================================

export async function loadJournalEntries(userId, limit = 200) {
  const { data, error } = await db
    .from('journal_entries')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return { data, error };
}

export async function searchJournal(userId, query) {
  // Full-text search via the GIN index on content + title
  const { data, error } = await db
    .from('journal_entries')
    .select('*')
    .eq('user_id', userId)
    .textSearch('content', query, { type: 'websearch', config: 'english' })
    .order('created_at', { ascending: false })
    .limit(50);
  return { data, error };
}

export async function createJournalEntry(userId, fields) {
  const { data, error } = await db
    .from('journal_entries')
    .insert({ user_id: userId, ...fields })
    .select()
    .single();
  return { data, error };
}

export async function updateJournalEntry(userId, entryId, patch) {
  const { data, error } = await db
    .from('journal_entries')
    .update(patch)
    .eq('user_id', userId)
    .eq('id', entryId)
    .select()
    .single();
  return { data, error };
}

export async function deleteJournalEntry(userId, entryId) {
  const { error } = await db
    .from('journal_entries')
    .delete()
    .eq('user_id', userId)
    .eq('id', entryId);
  return { error };
}


// =============================================================================
// MOOD
// =============================================================================

export async function loadMoodLogs(userId, daysBack = 365) {
  const since = new Date();
  since.setDate(since.getDate() - daysBack);

  const { data, error } = await db
    .from('mood_logs')
    .select('*')
    .eq('user_id', userId)
    .gte('logged_at', since.toISOString())
    .order('logged_at', { ascending: false });
  return { data, error };
}

export async function logMood(userId, valence, energy, note = null) {
  const { data, error } = await db
    .from('mood_logs')
    .insert({ user_id: userId, valence, energy, note })
    .select()
    .single();
  return { data, error };
}


// =============================================================================
// GOALS
// =============================================================================

export async function loadGoals(userId) {
  const { data, error } = await db
    .from('goals')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  return { data, error };
}

export async function createGoal(userId, fields) {
  const { data, error } = await db
    .from('goals')
    .insert({ user_id: userId, ...fields })
    .select()
    .single();
  return { data, error };
}

export async function updateGoalProgress(userId, goalId, currentValue) {
  const { data, error } = await db
    .from('goals')
    .update({ current_value: currentValue })
    .eq('user_id', userId)
    .eq('id', goalId)
    .select()
    .single();
  return { data, error };
}

export async function abandonGoal(userId, goalId) {
  const { data, error } = await db
    .from('goals')
    .update({ status: 'abandoned', abandoned_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('id', goalId)
    .select()
    .single();
  return { data, error };
}


// =============================================================================
// BOOKS
// =============================================================================

export async function loadBooks(userId) {
  const { data, error } = await db
    .from('books')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  return { data, error };
}

export async function createBook(userId, fields) {
  const { data, error } = await db
    .from('books')
    .insert({ user_id: userId, ...fields })
    .select()
    .single();
  return { data, error };
}

export async function updateBook(userId, bookId, patch) {
  const { data, error } = await db
    .from('books')
    .update(patch)
    .eq('user_id', userId)
    .eq('id', bookId)
    .select()
    .single();
  return { data, error };
}

export async function markBookStarted(userId, bookId) {
  return updateBook(userId, bookId, {
    status:     'reading',
    start_date: new Date().toISOString().slice(0, 10),
  });
}

export async function markBookFinished(userId, bookId, fields) {
  // fields: { overall_feeling, final_note, remembered_sentence, would_reread }
  return updateBook(userId, bookId, {
    status:      'finished',
    finish_date: new Date().toISOString().slice(0, 10),
    ...fields,
  });
}

export async function markBookAbandoned(userId, bookId) {
  return updateBook(userId, bookId, { status: 'abandoned' });
}


// =============================================================================
// READING SESSIONS
// =============================================================================

export async function loadReadingSessions(userId) {
  const { data, error } = await db
    .from('reading_sessions')
    .select('*')
    .eq('user_id', userId)
    .order('date', { ascending: false });
  return { data, error };
}

export async function loadReadingSessionsForBook(userId, bookId) {
  const { data, error } = await db
    .from('reading_sessions')
    .select('*')
    .eq('user_id', userId)
    .eq('book_id', bookId)
    .order('date', { ascending: false });
  return { data, error };
}

export async function logReadingSession(userId, bookId, fields) {
  // fields: { pages_read, current_page_after, mood, note, date? }
  const { data, error } = await db
    .from('reading_sessions')
    .insert({ user_id: userId, book_id: bookId, ...fields })
    .select()
    .single();
  return { data, error };
}

export async function loadReadingStreak(userId) {
  const { data, error } = await db
    .from('reading_streak')
    .select('current_streak, streak_start, streak_end')
    .eq('user_id', userId)
    .maybeSingle();
  return { data, error };
}


// =============================================================================
// GAMING
// =============================================================================

export async function loadGamingSessions(userId, limit = 500) {
  const { data, error } = await db
    .from('gaming_sessions')
    .select('*')
    .eq('user_id', userId)
    .order('played_at', { ascending: false })
    .limit(limit);
  return { data, error };
}

export async function loadGames(userId) {
  const { data, error } = await db
    .from('games')
    .select('*')
    .eq('user_id', userId)
    .order('last_played', { ascending: false });
  return { data, error };
}

export async function logGamingSession(userId, fields) {
  // fields: { game_title, duration_minutes, energy_level, valence,
  //           emotional_quadrant, mode, note?, is_highlight?, played_at? }
  const { data, error } = await db
    .from('gaming_sessions')
    .insert({ user_id: userId, ...fields })
    .select()
    .single();
  return { data, error };
}

export async function toggleSessionHighlight(userId, sessionId, current) {
  const { data, error } = await db
    .from('gaming_sessions')
    .update({ is_highlight: !current })
    .eq('user_id', userId)
    .eq('id', sessionId)
    .select()
    .single();
  return { data, error };
}


// =============================================================================
// FINANCIAL — INCOME
// =============================================================================

export async function loadIncomeEntries(userId) {
  const { data, error } = await db
    .from('income_entries')
    .select('*')
    .eq('user_id', userId)
    .order('date', { ascending: false });
  return { data, error };
}

export async function createIncomeEntry(userId, fields) {
  const { data, error } = await db
    .from('income_entries')
    .insert({ user_id: userId, ...fields })
    .select()
    .single();
  return { data, error };
}

export async function deleteIncomeEntry(userId, entryId) {
  const { error } = await db
    .from('income_entries')
    .delete()
    .eq('user_id', userId)
    .eq('id', entryId);
  return { error };
}


// =============================================================================
// FINANCIAL — EXPENSES
// =============================================================================

export async function loadExpenseEntries(userId) {
  const { data, error } = await db
    .from('expense_entries')
    .select('*')
    .eq('user_id', userId)
    .order('date', { ascending: false });
  return { data, error };
}

export async function createExpenseEntry(userId, fields) {
  const { data, error } = await db
    .from('expense_entries')
    .insert({ user_id: userId, ...fields })
    .select()
    .single();
  return { data, error };
}

export async function deleteExpenseEntry(userId, entryId) {
  const { error } = await db
    .from('expense_entries')
    .delete()
    .eq('user_id', userId)
    .eq('id', entryId);
  return { error };
}

export async function loadExpenseCategories(userId) {
  const { data, error } = await db
    .from('expense_categories')
    .select('*')
    .eq('user_id', userId)
    .order('name', { ascending: true });
  return { data, error };
}

export async function createExpenseCategory(userId, name, color = '#c8a96e', icon = null) {
  const { data, error } = await db
    .from('expense_categories')
    .upsert(
      { user_id: userId, name, color, icon },
      { onConflict: 'user_id,name' }
    )
    .select()
    .single();
  return { data, error };
}

export async function seedDefaultCategories(userId) {
  // Seeded once after first login. Bengali category names for cultural accuracy.
  const defaults = [
    { name: 'Food',          color: '#b8860b', icon: '🍚' },
    { name: 'Transport',     color: '#4a6a8a', icon: '🚌' },
    { name: 'Education',     color: '#2a5a3a', icon: '📚' },
    { name: 'Health',        color: '#6a2a2a', icon: '🌿' },
    { name: 'Entertainment', color: '#4a2a6b', icon: '🎮' },
    { name: 'Clothing',      color: '#5a3a2a', icon: '👕' },
    { name: 'Gifts',         color: '#6b4a5a', icon: '🎁' },
    { name: 'Other',         color: '#5a5a4a', icon: '•'  },
  ];

  const rows = defaults.map(c => ({ user_id: userId, ...c }));
  const { error } = await db
    .from('expense_categories')
    .upsert(rows, { onConflict: 'user_id,name', ignoreDuplicates: true });
  return { error };
}


// =============================================================================
// FINANCIAL — SAVINGS
// =============================================================================

export async function loadSavingsGoals(userId) {
  const { data, error } = await db
    .from('savings_goals')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  return { data, error };
}

export async function createSavingsGoal(userId, name, targetAmount) {
  const { data, error } = await db
    .from('savings_goals')
    .insert({ user_id: userId, name, target_amount: targetAmount })
    .select()
    .single();
  return { data, error };
}

export async function loadSavingsEntries(userId) {
  const { data, error } = await db
    .from('savings_entries')
    .select('*')
    .eq('user_id', userId)
    .order('date', { ascending: false });
  return { data, error };
}

export async function createSavingsEntry(userId, fields) {
  // fields: { amount, date, linked_goal_id?, note? }
  const { data, error } = await db
    .from('savings_entries')
    .insert({ user_id: userId, ...fields })
    .select()
    .single();
  return { data, error };
}


// =============================================================================
// FINANCIAL — DEBT
// =============================================================================

export async function loadDebtEntries(userId) {
  const { data, error } = await db
    .from('debt_entries')
    .select('*')
    .eq('user_id', userId)
    .is('cleared_at', null)            // only active debts by default
    .order('created_at', { ascending: true });
  return { data, error };
}

export async function createDebtEntry(userId, fields) {
  const { data, error } = await db
    .from('debt_entries')
    .insert({ user_id: userId, ...fields })
    .select()
    .single();
  return { data, error };
}

export async function updateDebtEntry(userId, debtId, patch) {
  const { data, error } = await db
    .from('debt_entries')
    .update(patch)
    .eq('user_id', userId)
    .eq('id', debtId)
    .select()
    .single();
  return { data, error };
}

export async function clearDebt(userId, debtId) {
  return updateDebtEntry(userId, debtId, {
    cleared_at: new Date().toISOString(),
  });
}


// =============================================================================
// AGGREGATE VIEWS
// =============================================================================

export async function loadMonthlyFinancialSummary(userId, months = 12) {
  const since = new Date();
  since.setMonth(since.getMonth() - months);

  const { data, error } = await db
    .from('monthly_financial_summary')
    .select('*')
    .eq('user_id', userId)
    .gte('month', since.toISOString())
    .order('month', { ascending: true });
  return { data, error };
}

export async function loadHabitCompletion30d(userId) {
  const { data, error } = await db
    .from('habit_completion_30d')
    .select('*')
    .eq('user_id', userId);
  return { data, error };
}

export async function loadBookStats(userId) {
  const { data, error } = await db
    .from('book_stats')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  return { data, error };
}


// =============================================================================
// BULK LOADER
// Fetches all personal data in parallel on initial world load.
// Returns a structured object the state.js hydration step consumes directly.
// =============================================================================

export async function loadAllUserData(userId) {
  const [
    habits,
    habitLogs,
    journal,
    mood,
    goals,
    books,
    readingSessions,
    readingStreak,
    gamingSessions,
    games,
    income,
    expenses,
    categories,
    savingsGoals,
    savings,
    debt,
    worldState,
  ] = await Promise.all([
    loadHabits(userId),
    loadHabitLogs(userId, 365),
    loadJournalEntries(userId, 200),
    loadMoodLogs(userId, 365),
    loadGoals(userId),
    loadBooks(userId),
    loadReadingSessions(userId),
    loadReadingStreak(userId),
    loadGamingSessions(userId, 500),
    loadGames(userId),
    loadIncomeEntries(userId),
    loadExpenseEntries(userId),
    loadExpenseCategories(userId),
    loadSavingsGoals(userId),
    loadSavingsEntries(userId),
    loadDebtEntries(userId),
    loadWorldState(userId),
  ]);

  // Surface the first error encountered — caller logs and decides how to handle
  const firstError = [
    habits, habitLogs, journal, mood, goals,
    books, readingSessions, readingStreak,
    gamingSessions, games,
    income, expenses, categories, savingsGoals, savings, debt,
    worldState,
  ].find(r => r.error)?.error ?? null;

  return {
    error: firstError,
    habits:           habits.data           ?? [],
    habitLogs:        habitLogs.data        ?? [],
    journalEntries:   journal.data          ?? [],
    moodLogs:         mood.data             ?? [],
    goals:            goals.data            ?? [],
    books:            books.data            ?? [],
    readingSessions:  readingSessions.data  ?? [],
    readingStreak:    readingStreak.data?.current_streak ?? 0,
    gamingSessions:   gamingSessions.data   ?? [],
    games:            games.data            ?? [],
    incomeEntries:    income.data           ?? [],
    expenseEntries:   expenses.data         ?? [],
    expenseCategories: categories.data      ?? [],
    savingsGoals:     savingsGoals.data     ?? [],
    savingsEntries:   savings.data          ?? [],
    debtEntries:      debt.data             ?? [],
    worldState:       worldState.data       ?? null,
  };
}


// =============================================================================
// REALTIME SUBSCRIPTIONS
// Used by world.js to keep the 3D scene in sync with fresh data without a
// full reload.  Returns the channel so the caller can unsubscribe on cleanup.
// =============================================================================

export function subscribeToHabits(userId, onChange) {
  return db
    .channel(`habits:${userId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'habit_logs', filter: `user_id=eq.${userId}` },
      onChange
    )
    .subscribe();
}

export function subscribeToBooks(userId, onChange) {
  return db
    .channel(`books:${userId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'books', filter: `user_id=eq.${userId}` },
      onChange
    )
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'reading_sessions', filter: `user_id=eq.${userId}` },
      onChange
    )
    .subscribe();
}

export function subscribeToGoals(userId, onChange) {
  return db
    .channel(`goals:${userId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'goals', filter: `user_id=eq.${userId}` },
      onChange
    )
    .subscribe();
}

export function unsubscribe(channel) {
  if (channel) db.removeChannel(channel);
}