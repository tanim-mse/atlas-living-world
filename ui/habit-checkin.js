/**
 * habit-checkin.js — Habit check-in panel UI
 * Atlas: The Living World
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * OVERVIEW
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This module owns the DOM content of the check-in panel that opens when Tanim
 * clicks a flower in the Garden. It renders into a container element provided
 * by garden.js, which positions that container as a CSS3DObject in world space.
 *
 * The panel has one job: make check-in feel as natural and brief as touching
 * a flower. No guilt, no gamification language, no streak pressure. Just:
 * "How did it go today?" — and then the flower responds.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * PANEL LAYOUT  (480 × 340 px content area inside the 480 × 360 outer panel)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   ┌────────────────────────────────────────────────────┐
 *   │  🌻  Habit Name                          ●●● 5d   │  ← header
 *   │      Movement  ·  Checked in yesterday             │
 *   ├────────────────────────────────────────────────────┤
 *   │  How did it go today?                              │  ← feeling dial
 *   │                Engaged                             │
 *   │  ○──────────────●──────────────────────○           │
 *   │  Struggling                         Absorbed       │
 *   ├────────────────────────────────────────────────────┤
 *   │  A thought  (optional)                             │  ← note textarea
 *   │  ┌──────────────────────────────────────────────┐ │
 *   │  │                                              │ │
 *   │  └──────────────────────────────────────────────┘ │
 *   ├────────────────────────────────────────────────────┤
 *   │  Week: ● ● ● ○ ● ● ○                   [ Done ]   │  ← footer
 *   └────────────────────────────────────────────────────┘
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * EXPORTED API — exactly what garden.js calls
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   openCheckin(habit, containerEl, { onSubmit, onClose })
 *     Renders the form into containerEl.
 *     containerEl = the #garden-checkin-content div inside garden.js's panel.
 *     onSubmit(logData) is called with { date, mood, mood_valence, note }
 *       when the Done button is clicked.
 *     onClose() is provided for future use (panel close from within the form).
 *
 *   closeCheckin()
 *     Empties containerEl, removes event listeners, resets state.
 *     Safe to call multiple times. Called by garden.js on any close event.
 *
 *   onCheckinSubmit(habitId, logData)
 *     Async. Persists one row to the Supabase habit_logs table.
 *     Returns the inserted row. Throws on DB error.
 *     Called by garden.js after collecting the form data.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * MOOD MODEL
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The feeling dial is a continuous range slider [0, 1] with three named zones:
 *
 *   0.00–0.33  → 'struggling'   The habit felt forced, difficult, or partial
 *   0.33–0.67  → 'engaged'      Present and doing it — the natural midpoint
 *   0.67–1.00  → 'absorbed'     Flow state; deeply satisfying; time collapsed
 *
 * Both the continuous value (mood_valence) and the zone name (mood) are stored.
 * mood_valence drives flower SSS brightness in the fragment shader when the
 * data is eventually used in future Garden refinements.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * DEPENDENCIES
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *   core/state.js    — state.habitLogs for streak and recent-day computation
 *   core/supabase.js — Supabase client instance for persistence
 *
 * No THREE dependency — this module is pure DOM + data.
 */

import { state }    from '../core/state.js';
import { db as supabase } from '../core/supabase.js';
// ─── Design tokens ────────────────────────────────────────────────────────────
// Mirror Atlas design system exactly — same values as :root in ui.css

const T = {
  textPrimary:  '#e8e0d0',
  textMuted:    '#8a7e6e',
  accent:       '#c8a96e',
  accentDim:    'rgba(200, 169, 110, 0.15)',
  accentBorder: 'rgba(200, 169, 110, 0.35)',
  accentSub:    'rgba(200, 169, 110, 0.18)',
  danger:       '#c87060',
  panelBg:      'rgba(255, 255, 255, 0.03)',
  divider:      'rgba(200, 169, 110, 0.10)',
  serif:        '"Fraunces", "Georgia", serif',
  sans:         '"Inter Tight", "Inter", sans-serif',
  easing:       'cubic-bezier(0.22, 1, 0.36, 1)',
};

// ─── Species display data ─────────────────────────────────────────────────────

const SPECIES_ICONS = {
  sunflower:     '🌻',
  iris:          '🪻',
  lavender:      '💜',
  forget_me_not: '💙',
  anemone:       '🤍',
  cosmos:        '🌸',
  peony:         '🌺',
  ranunculus:    '🧡',
  wisteria:      '🫧',
  foxglove:      '🌷',
  protea:        '🌹',
  poppy:         '❤️',
};

// Human-readable category labels — replaces raw habit.category values
const CATEGORY_LABELS = {
  fitness:   'Movement',     exercise: 'Movement',     gym:      'Strength',
  sport:     'Sport',        study:    'Learning',      learning: 'Learning',
  exam:      'Study',        language: 'Language',      skill:    'Skill-building',
  meditat:   'Mindfulness',  mindful:  'Mindfulness',  breathing:'Breathwork',
  mind:      'Mental wellness', calm:  'Stillness',     reading:  'Reading',
  book:      'Reading',      read:     'Reading',       water:    'Hydration',
  hydrat:    'Hydration',    drink:    'Hydration',     sleep:    'Rest',
  rest:      'Rest',         wake:     'Sleep rhythm',  journal:  'Journalling',
  diary:     'Reflection',   writ:     'Writing',       creat:    'Creativity',
  art:       'Art',          draw:     'Drawing',       design:   'Design',
  music:     'Music',        make:     'Making',        social:   'Connection',
  friend:    'Friendship',   famil:    'Family',        connect:  'Connection',
  call:      'Keeping in touch', talk: 'Conversation',  nutrit:   'Nutrition',
  food:      'Eating well',  eat:      'Eating well',   diet:     'Nutrition',
  cook:      'Cooking',      meal:     'Meal planning', outdoor:  'Outdoors',
  walk:      'Walking',      run:      'Running',       nature:   'Nature',
  hike:      'Hiking',
};

// Note textarea placeholder strings — chosen randomly on open
const PLACEHOLDERS = [
  'What made it feel that way?',
  'Anything you noticed?',
  'A small win, or a friction point…',
  'What would make tomorrow easier?',
  'What kept you going?',
  'Something to remember about today.',
];

// ─── Module state ─────────────────────────────────────────────────────────────

/** Currently open habit row. @type {Object|null} */
let _habit       = null;
/** Container element garden.js writes into. @type {HTMLElement|null} */
let _container   = null;
/** Callback registered by garden.js. @type {Function|null} */
let _onSubmit    = null;
/** Callback for close-from-within. @type {Function|null} */
let _onClose     = null;
/** The feeling dial input. @type {HTMLInputElement|null} */
let _dial        = null;
/** The note textarea. @type {HTMLTextAreaElement|null} */
let _note        = null;
/** Prevents double-submit. */
let _submitting  = false;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Render the check-in form into containerEl for the given habit.
 * Replaces any previous form content cleanly.
 *
 * @param {Object}      habit        Row from state.habits
 * @param {HTMLElement} containerEl  The content div inside garden.js's panel
 * @param {Object}      callbacks    { onSubmit(logData), onClose() }
 */
export function openCheckin(habit, containerEl, { onSubmit, onClose } = {}) {
  closeCheckin();   // clean slate

  _habit      = habit;
  _container  = containerEl;
  _onSubmit   = onSubmit || null;
  _onClose    = onClose  || null;
  _submitting = false;

  if (!_container) {
    console.warn('[habit-checkin] openCheckin called without a container element.');
    return;
  }

  _ensureDialStyles();
  _render();
}

/**
 * Tear down the form: empty the container, remove listeners, reset state.
 * Safe to call when no panel is open.
 */
export function closeCheckin() {
  document.removeEventListener('keydown', _onKeyDown);

  if (_container) _container.innerHTML = '';

  _habit      = null;
  _container  = null;
  _onSubmit   = null;
  _onClose    = null;
  _dial       = null;
  _note       = null;
  _submitting = false;
}

/**
 * Persist one habit_log row to Supabase.
 * Called by garden.js immediately after the form's onSubmit fires.
 *
 * Supabase schema:
 *   habit_logs (id, user_id, habit_id, date, mood, mood_valence, note, created_at)
 *
 * @param {string} habitId
 * @param {Object} logData  { date, mood, mood_valence, note }
 * @returns {Promise<Object>}  The inserted row
 * @throws  {Error}            On Supabase error
 */
export async function onCheckinSubmit(habitId, logData) {
  const { data, error } = await supabase
    .from('habit_logs')
    .insert({
      user_id:      state.user.id,
      habit_id:     habitId,
      date:         logData.date         || _todayISO(),
      mood:         logData.mood         || 'engaged',
      mood_valence: logData.mood_valence ?? 0.5,
      note:         logData.note         || null,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

// ─── Rendering ────────────────────────────────────────────────────────────────

/**
 * Build the full panel DOM and append it into _container.
 */
function _render() {
  const logs    = _habitLogs(_habit.id);
  const streak  = _streak(logs);
  const lastLog = logs.length ? logs[logs.length - 1] : null;
  const recent  = _recentWeek(logs);   // 7 booleans: 6 days ago → yesterday
  const species = _habit.flower_species || 'poppy';

  // Root wrapper — flex column, fills container height
  const root = _div({
    display:        'flex',
    flexDirection:  'column',
    height:         '100%',
    gap:            '0',
    fontFamily:     T.sans,
    color:          T.textPrimary,
    userSelect:     'none',
    boxSizing:      'border-box',
  });

  root.append(
    _renderHeader(species, streak, lastLog),
    _divider(),
    _renderDial(),
    _divider(),
    _renderNote(),
    _divider(),
    _renderFooter(recent),
  );

  _container.appendChild(root);

  // Global Enter key shortcut — submit from anywhere except inside the textarea
  document.addEventListener('keydown', _onKeyDown);
}

// ─── Section: Header ─────────────────────────────────────────────────────────

/**
 * Header section: species icon + habit name + streak counter + category + last log.
 *
 * @param {string}      species   Species key
 * @param {number}      streak    Current streak count
 * @param {Object|null} lastLog   Most recent habit_log row
 * @returns {HTMLElement}
 */
function _renderHeader(species, streak, lastLog) {
  const icon = SPECIES_ICONS[species] || '🌸';
  const cat  = _categoryLabel(_habit);

  const section = _div({
    paddingTop:    '4px',
    paddingBottom: '14px',
    flexShrink:    '0',
  });

  // ── Top row: icon + name + streak ──────────────────────────────────────────
  const topRow = _div({
    display:      'flex',
    alignItems:   'center',
    gap:          '10px',
    marginBottom: '7px',
  });

  // Species icon
  const iconEl = document.createElement('span');
  Object.assign(iconEl.style, { fontSize: '21px', lineHeight: '1', flexShrink: '0' });
  iconEl.textContent = icon;
  iconEl.setAttribute('role', 'img');
  iconEl.setAttribute('aria-label', species.replace(/_/g, ' '));

  // Habit name — Fraunces italic, generous size, truncated on overflow
  const nameEl = document.createElement('span');
  Object.assign(nameEl.style, {
    fontFamily:   T.serif,
    fontStyle:    'italic',
    fontWeight:   '300',
    fontSize:     '19px',
    color:        T.textPrimary,
    flex:         '1',
    overflow:     'hidden',
    textOverflow: 'ellipsis',
    whiteSpace:   'nowrap',
    lineHeight:   '1.2',
  });
  nameEl.textContent = _habit.name || 'Habit';

  topRow.append(iconEl, nameEl, _renderStreak(streak));
  section.appendChild(topRow);

  // ── Bottom row: category + last check-in ───────────────────────────────────
  const metaRow = _div({
    display:    'flex',
    alignItems: 'center',
    gap:        '8px',
    fontSize:   '12px',
    color:      T.textMuted,
    lineHeight: '1',
  });

  if (cat) {
    const catEl = document.createElement('span');
    catEl.textContent = cat;
    metaRow.appendChild(catEl);
  }

  const sep = document.createElement('span');
  sep.textContent = '·';
  sep.style.opacity = '0.38';

  const lastEl = document.createElement('span');
  lastEl.textContent = lastLog ? _lastCheckinLabel(lastLog.date) : 'First check-in';

  metaRow.append(sep, lastEl);
  section.appendChild(metaRow);

  return section;
}

/**
 * Streak indicator — compact dots or a day count for long streaks.
 * Shown right-aligned in the header top row.
 *
 * @param {number} streak
 * @returns {HTMLElement}
 */
function _renderStreak(streak) {
  const wrap = _div({
    display:    'flex',
    alignItems: 'center',
    gap:        '4px',
    flexShrink: '0',
  });

  if (streak === 0) return wrap;

  if (streak >= 8) {
    // Long streaks: compact numeric label
    const label = document.createElement('span');
    Object.assign(label.style, {
      fontSize:      '11px',
      fontWeight:    '500',
      color:         T.accent,
      fontFamily:    T.sans,
      letterSpacing: '0.03em',
    });
    label.textContent = `${streak}d`;
    label.title = `${streak} day streak`;
    wrap.appendChild(label);
    return wrap;
  }

  // Short streaks: filled dots up to 7
  const count = Math.min(streak, 7);
  wrap.title  = `${streak} day streak`;

  for (let i = 0; i < count; i++) {
    const dot = document.createElement('span');
    // Dots fade slightly for older days in the streak — oldest is dimmest
    const opacity = i < count - 3 ? String(0.45 + (i / count) * 0.35) : '1';
    Object.assign(dot.style, {
      display:      'inline-block',
      width:        '5px',
      height:       '5px',
      borderRadius: '50%',
      background:   T.accent,
      opacity,
      flexShrink:   '0',
    });
    wrap.appendChild(dot);
  }

  return wrap;
}

// ─── Section: Feeling dial ────────────────────────────────────────────────────

/**
 * The central interaction element — a styled range input with a live label.
 *
 * The prompt is Fraunces italic: "How did it go today?"
 * The live label updates in real time as the thumb moves.
 * Endpoint labels are small and muted — present as orientation, not instruction.
 *
 * @returns {HTMLElement}
 */
function _renderDial() {
  const section = _div({
    paddingTop:    '14px',
    paddingBottom: '12px',
    flexShrink:    '0',
  });

  // Prompt text
  const prompt = document.createElement('p');
  Object.assign(prompt.style, {
    fontFamily:   T.serif,
    fontStyle:    'italic',
    fontWeight:   '300',
    fontSize:     '15px',
    color:        T.textPrimary,
    margin:       '0 0 10px 0',
    lineHeight:   '1.3',
    letterSpacing:'0.01em',
  });
  prompt.textContent = 'How did it go today?';
  section.appendChild(prompt);

  // Live mood label — updates on input event
  const liveLabel = document.createElement('div');
  Object.assign(liveLabel.style, {
    textAlign:    'center',
    fontSize:     '13px',
    fontWeight:   '500',
    fontFamily:   T.sans,
    letterSpacing:'0.05em',
    color:        T.accent,
    minHeight:    '18px',
    marginBottom: '8px',
    transition:   `color 160ms ease`,
  });
  liveLabel.textContent = 'Engaged';
  section.appendChild(liveLabel);

  // Slider
  const sliderWrap = _div({ position: 'relative', padding: '4px 0' });

  _dial       = document.createElement('input');
  _dial.type  = 'range';
  _dial.min   = '0';
  _dial.max   = '100';
  _dial.value = '50';
  _dial.step  = '1';
  _dial.className   = 'atlas-dial';
  _dial.style.width = '100%';
  _dial.setAttribute('aria-label', 'Feeling dial: Struggling to Absorbed');

  // Update fill gradient and live label on every change
  _dial.addEventListener('input', () => {
    const v = _dialValence();
    liveLabel.textContent = _moodLabel(v);
    liveLabel.style.color = _moodColor(v);
    _applyDialFill(_dial);
  });

  _applyDialFill(_dial);   // set initial fill
  sliderWrap.appendChild(_dial);
  section.appendChild(sliderWrap);

  // Endpoint labels
  const ends = _div({
    display:        'flex',
    justifyContent: 'space-between',
    marginTop:      '5px',
    fontSize:       '11px',
    color:          T.textMuted,
    letterSpacing:  '0.04em',
    fontFamily:     T.sans,
  });

  const lo = document.createElement('span');
  lo.textContent = 'Struggling';
  const hi = document.createElement('span');
  hi.textContent = 'Absorbed';
  ends.append(lo, hi);
  section.appendChild(ends);

  return section;
}

// ─── Section: Note ───────────────────────────────────────────────────────────

/**
 * Optional note textarea.
 *
 * Label uses small uppercase tracking. Textarea is visually minimal —
 * a faint dark fill with only a bottom accent border that brightens on focus.
 * Placeholder is chosen randomly from PLACEHOLDERS for variety across sessions.
 * Maximum 280 characters (matches other note fields in Atlas schema).
 *
 * @returns {HTMLElement}
 */
function _renderNote() {
  const section = _div({
    paddingTop:    '14px',
    paddingBottom: '10px',
    flex:          '1',
    display:       'flex',
    flexDirection: 'column',
    minHeight:     '0',
  });

  const label = document.createElement('label');
  Object.assign(label.style, {
    display:       'block',
    fontSize:      '10px',
    fontFamily:    T.sans,
    color:         T.textMuted,
    letterSpacing: '0.09em',
    textTransform: 'uppercase',
    marginBottom:  '8px',
    userSelect:    'none',
  });
  label.textContent = 'A thought  (optional)';
  label.setAttribute('for', 'atlas-checkin-note');
  section.appendChild(label);

  _note = document.createElement('textarea');
  _note.id          = 'atlas-checkin-note';
  _note.maxLength   = 280;
  _note.spellcheck  = true;
  _note.placeholder = PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)];

  Object.assign(_note.style, {
    width:           '100%',
    flex:            '1',
    minHeight:       '48px',
    maxHeight:       '80px',
    resize:          'none',
    background:      T.panelBg,
    border:          'none',
    borderBottom:    `1px solid ${T.accentSub}`,
    borderRadius:    '2px 2px 0 0',
    color:           T.textPrimary,
    fontFamily:      T.sans,
    fontSize:        '13px',
    lineHeight:      '1.75',
    padding:         '8px 10px',
    outline:         'none',
    boxSizing:       'border-box',
    overflowY:       'auto',
    transition:      `border-color 160ms ease, background 160ms ease`,
    caretColor:      T.accent,
  });

  _note.addEventListener('focus', () => {
    _note.style.borderBottomColor = T.accent;
    _note.style.background        = 'rgba(255,255,255,0.055)';
  });
  _note.addEventListener('blur', () => {
    _note.style.borderBottomColor = T.accentSub;
    _note.style.background        = T.panelBg;
  });

  section.appendChild(_note);

  // Character counter — appears only when the user starts typing
  const counter = document.createElement('div');
  Object.assign(counter.style, {
    fontSize:   '11px',
    color:      T.textMuted,
    fontFamily: T.sans,
    textAlign:  'right',
    marginTop:  '4px',
    minHeight:  '14px',
    transition: 'opacity 160ms ease',
    opacity:    '0',
  });
  section.appendChild(counter);

  _note.addEventListener('input', () => {
    const remaining = 280 - _note.value.length;
    if (_note.value.length > 0) {
      counter.textContent = `${remaining}`;
      counter.style.opacity = remaining < 40 ? '1' : '0.4';
    } else {
      counter.style.opacity = '0';
    }
  });

  return section;
}

// ─── Section: Footer ─────────────────────────────────────────────────────────

/**
 * Footer: recent-week completion dots + Done button + error slot.
 *
 * The 7 dots represent the 7 days ending yesterday (not including today since
 * that's the day being checked in). Filled = logged. Empty = no log.
 * No labels — their meaning is self-evident in context.
 *
 * @param {boolean[]} recent  7 booleans, index 0 = 6 days ago, 6 = yesterday
 * @returns {HTMLElement}
 */
function _renderFooter(recent) {
  const wrapper = _div({
    display:       'flex',
    flexDirection: 'column',
    flexShrink:    '0',
    paddingTop:    '14px',
  });

  // ── Main footer row ───────────────────────────────────────────────────────
  const row = _div({
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
    gap:            '12px',
  });

  // Recent week dots
  const dotsWrap = _div({
    display:    'flex',
    alignItems: 'center',
    gap:        '5px',
  });

  const weekLabel = document.createElement('span');
  Object.assign(weekLabel.style, {
    fontSize:      '11px',
    color:         T.textMuted,
    fontFamily:    T.sans,
    marginRight:   '3px',
    letterSpacing: '0.04em',
  });
  weekLabel.textContent = 'Week:';
  dotsWrap.appendChild(weekLabel);

  for (let i = 0; i < 7; i++) {
    const filled = recent[i];
    const dot = document.createElement('span');
    Object.assign(dot.style, {
      display:      'inline-block',
      width:        '7px',
      height:       '7px',
      borderRadius: '50%',
      background:   filled ? T.accent : 'transparent',
      border:       `1.5px solid ${filled ? T.accent : 'rgba(200,169,110,0.25)'}`,
      flexShrink:   '0',
    });

    // Tooltip: "Monday", "Tuesday", etc.
    const daysBack = 7 - i;
    const d = new Date();
    d.setDate(d.getDate() - daysBack);
    dot.title = d.toLocaleDateString('en-US', { weekday: 'long' });

    dotsWrap.appendChild(dot);
  }

  row.appendChild(dotsWrap);

  // Done button
  const btn = document.createElement('button');
  btn.type          = 'button';
  btn.textContent   = 'Done';
  btn.setAttribute('aria-label', 'Log check-in');

  Object.assign(btn.style, {
    background:    T.accentDim,
    border:        `1px solid ${T.accentBorder}`,
    borderRadius:  '3px',
    color:         T.accent,
    fontFamily:    T.sans,
    fontSize:      '13px',
    fontWeight:    '500',
    letterSpacing: '0.06em',
    padding:       '8px 26px',
    cursor:        'pointer',
    outline:       'none',
    flexShrink:    '0',
    transition:    `background 160ms ease, border-color 160ms ease, opacity 160ms ease`,
    userSelect:    'none',
  });

  btn.addEventListener('mouseover', () => {
    if (_submitting) return;
    btn.style.background  = 'rgba(200,169,110,0.26)';
    btn.style.borderColor = 'rgba(200,169,110,0.65)';
  });
  btn.addEventListener('mouseout', () => {
    if (_submitting) return;
    btn.style.background  = T.accentDim;
    btn.style.borderColor = T.accentBorder;
  });

  btn.addEventListener('click', _handleSubmit);

  row.appendChild(btn);
  wrapper.appendChild(row);

  // ── Error slot — hidden until submission fails ──────────────────────────────
  const errEl = document.createElement('div');
  errEl.id = 'atlas-checkin-error';
  Object.assign(errEl.style, {
    display:    'none',
    marginTop:  '8px',
    fontSize:   '12px',
    color:      T.danger,
    fontFamily: T.sans,
    lineHeight: '1.5',
    textAlign:  'center',
  });
  wrapper.appendChild(errEl);

  return wrapper;
}

// ─── Submit handling ──────────────────────────────────────────────────────────

/**
 * Collect form data and call garden.js's onSubmit callback.
 * Sets submitting state to prevent double-fire.
 * Shows an error message if the callback throws.
 */
async function _handleSubmit() {
  if (_submitting || !_onSubmit) return;

  const valence  = _dialValence();
  const noteText = _note ? _note.value.trim() : '';

  const logData = {
    date:         _todayISO(),
    mood:         _moodName(valence),
    mood_valence: valence,
    note:         noteText || null,
  };

  _setSubmitting(true);

  try {
    await _onSubmit(logData);
    // garden.js holds the panel open 820 ms then calls closeCheckin()
    // — nothing more to do here on success
  } catch (err) {
    _setSubmitting(false);
    _showError('Something went wrong. Please try again.');
    console.error('[habit-checkin] Submission error:', err);
  }
}

/**
 * Global keydown handler — Enter submits the form (unless focus is in textarea).
 * Escape is handled by garden.js; we don't duplicate it here.
 *
 * @param {KeyboardEvent} e
 */
function _onKeyDown(e) {
  if (e.key !== 'Enter') return;
  if (e.shiftKey) return;
  if (!_container) return;                          // panel already closed
  if (document.activeElement === _note) return;    // allow newlines in textarea

  e.preventDefault();
  _handleSubmit();
}

/**
 * Update the Done button to show submitting state.
 * @param {boolean} active
 */
function _setSubmitting(active) {
  _submitting = active;

  const btn = _container && _container.querySelector('button[type="button"]');
  if (!btn) return;

  if (active) {
    btn.textContent         = '…';
    btn.style.opacity       = '0.50';
    btn.style.pointerEvents = 'none';
    btn.style.cursor        = 'default';
  } else {
    btn.textContent         = 'Done';
    btn.style.opacity       = '1';
    btn.style.pointerEvents = 'auto';
    btn.style.cursor        = 'pointer';
  }
}

/**
 * Display an error message below the footer row.
 * Auto-dismisses after 4 seconds.
 *
 * @param {string} message
 */
function _showError(message) {
  if (!_container) return;
  const el = _container.querySelector('#atlas-checkin-error');
  if (!el) return;
  el.textContent  = message;
  el.style.display = 'block';
  setTimeout(() => { if (el) el.style.display = 'none'; }, 4000);
}

// ─── Data helpers ─────────────────────────────────────────────────────────────

/**
 * All habit_log rows for a given habitId from state.habitLogs,
 * sorted ascending by date.
 *
 * @param {string} habitId
 * @returns {Object[]}
 */
function _habitLogs(habitId) {
  if (!Array.isArray(state.habitLogs)) return [];
  return state.habitLogs
    .filter(l => l.habit_id === habitId)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Compute the current consecutive-day check-in streak.
 *
 * Rules:
 *   - A streak is a contiguous sequence of days with at least one check-in each.
 *   - The streak is "alive" if the most recent logged day is today or yesterday.
 *     (Tanim may check in at any point during the day; we don't penalise him
 *      at 00:01 for not having checked in yet.)
 *   - Multiple logs on the same day count as one day.
 *
 * @param {Object[]} logs  Ascending-sorted habit_log rows
 * @returns {number}       Current streak in days
 */
function _streak(logs) {
  if (!logs.length) return 0;

  const today     = _todayISO();
  const yesterday = _dateOffset(-1);

  // Unique dates, descending (most recent first)
  const dates = [...new Set(logs.map(l => l.date))].sort().reverse();

  // Streak is only live if the most recent check-in is today or yesterday
  if (dates[0] !== today && dates[0] !== yesterday) return 0;

  let count = 1;
  let prev  = dates[0];

  for (let i = 1; i < dates.length; i++) {
    const expectedPrev = _dateOffsetFrom(prev, -1);
    if (dates[i] === expectedPrev) {
      count++;
      prev = dates[i];
    } else {
      break;
    }
  }

  return count;
}

/**
 * 7-element boolean array: was there a check-in on each of the 7 days
 * ending yesterday?  Index 0 = 6 days ago, index 6 = yesterday.
 *
 * @param {Object[]} logs
 * @returns {boolean[]}
 */
function _recentWeek(logs) {
  const set = new Set(logs.map(l => l.date));
  const out = [];
  for (let i = 7; i >= 1; i--) {
    out.push(set.has(_dateOffset(-i)));
  }
  return out;
}

// ─── Display helpers ──────────────────────────────────────────────────────────

/**
 * Human-readable relative date label for the last check-in.
 * Never uses absolute dates — always relative (today, yesterday, X days ago).
 *
 * @param {string} dateISO  YYYY-MM-DD
 * @returns {string}
 */
function _lastCheckinLabel(dateISO) {
  if (dateISO === _todayISO())     return 'Checked in today';
  if (dateISO === _dateOffset(-1)) return 'Yesterday';

  const days = _daysAgo(dateISO);
  if (days <= 6)  return `${days} days ago`;
  if (days <= 13) return 'Last week';
  if (days <= 30) return `${Math.round(days / 7)} weeks ago`;
  return 'A while ago';
}

/**
 * Resolve a human-friendly category label from the habit row.
 * Matches the first keyword found in the combined name + category string.
 *
 * @param {Object} habit
 * @returns {string}  May be empty string if no match
 */
function _categoryLabel(habit) {
  const src = `${habit.name || ''} ${habit.category || ''}`.toLowerCase();
  for (const [kw, label] of Object.entries(CATEGORY_LABELS)) {
    if (src.includes(kw)) return label;
  }
  return habit.category || '';
}

/**
 * Named mood zone from a valence float.
 * @param {number} v  [0, 1]
 * @returns {string}
 */
function _moodLabel(v) {
  if (v < 0.33) return 'Struggling';
  if (v < 0.67) return 'Engaged';
  return 'Absorbed';
}

/**
 * Accent colour tint for the live label — dims when struggling, warms when absorbed.
 * @param {number} v  [0, 1]
 * @returns {string}  CSS colour
 */
function _moodColor(v) {
  if (v < 0.33) return 'rgba(200, 169, 110, 0.48)';
  if (v < 0.67) return T.accent;
  return '#e8c46e';
}

/**
 * DB-storable mood string.
 * @param {number} v  [0, 1]
 * @returns {'struggling'|'engaged'|'absorbed'}
 */
function _moodName(v) {
  if (v < 0.33) return 'struggling';
  if (v < 0.67) return 'engaged';
  return 'absorbed';
}

/**
 * Current dial value as a normalised float [0, 1].
 * @returns {number}
 */
function _dialValence() {
  return _dial ? parseInt(_dial.value, 10) / 100 : 0.5;
}

/**
 * Apply the CSS custom property that drives the dial's left-fill gradient.
 * The gradient cannot be animated by the browser without this live update.
 *
 * @param {HTMLInputElement} input
 */
function _applyDialFill(input) {
  const pct = ((parseInt(input.value, 10) - parseInt(input.min, 10)) /
               (parseInt(input.max,  10) - parseInt(input.min, 10))) * 100;
  input.style.setProperty('--atlas-fill', `${pct.toFixed(1)}%`);
}

// ─── Dial stylesheet ──────────────────────────────────────────────────────────

/**
 * Inject the range input stylesheet once per document lifetime.
 *
 * We cannot style ::-webkit-slider-thumb or ::-moz-range-thumb with inline
 * styles; they require a proper stylesheet rule. The gradient fill requires
 * a CSS custom property (--atlas-fill) that we update via style.setProperty()
 * on each input event above.
 *
 * The thumb is the Atlas accent gold with a dark border creating a crisp
 * outline against the translucent panel background. On hover it scales up
 * slightly and brightens its shadow — communicating interactivity clearly
 * without an underline or colour change (which wouldn't read at CSS3D scale).
 */
function _ensureDialStyles() {
  if (document.getElementById('atlas-dial-style')) return;

  const s = document.createElement('style');
  s.id = 'atlas-dial-style';
  s.textContent = `
    .atlas-dial {
      -webkit-appearance: none;
      appearance: none;
      width: 100%;
      height: 3px;
      border-radius: 2px;
      outline: none;
      cursor: pointer;
      background: linear-gradient(
        to right,
        #c8a96e 0%,
        #c8a96e var(--atlas-fill, 50%),
        rgba(200,169,110,0.18) var(--atlas-fill, 50%),
        rgba(200,169,110,0.18) 100%
      );
    }

    .atlas-dial::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width:         14px;
      height:        14px;
      border-radius: 50%;
      background:    #c8a96e;
      border:        2.5px solid rgba(8, 6, 4, 0.55);
      box-shadow:    0 0 6px rgba(200, 169, 110, 0.38);
      cursor:        pointer;
      transition:    transform 120ms ease, box-shadow 120ms ease;
    }

    .atlas-dial::-webkit-slider-thumb:hover {
      transform:  scale(1.22);
      box-shadow: 0 0 12px rgba(200, 169, 110, 0.70);
    }

    .atlas-dial::-moz-range-thumb {
      width:         14px;
      height:        14px;
      border-radius: 50%;
      background:    #c8a96e;
      border:        2.5px solid rgba(8, 6, 4, 0.55);
      box-shadow:    0 0 6px rgba(200, 169, 110, 0.38);
      cursor:        pointer;
    }

    .atlas-dial:focus {
      outline: none;
    }

    #atlas-checkin-note::placeholder {
      color: rgba(138, 126, 110, 0.55);
    }

    #atlas-checkin-note::-webkit-scrollbar {
      width: 4px;
    }
    #atlas-checkin-note::-webkit-scrollbar-track {
      background: transparent;
    }
    #atlas-checkin-note::-webkit-scrollbar-thumb {
      background: rgba(200, 169, 110, 0.25);
      border-radius: 2px;
    }
  `;

  document.head.appendChild(s);
}

// ─── DOM utility ──────────────────────────────────────────────────────────────

/**
 * Create a div with applied inline styles.
 * Shorthand for the common _el('div', { style: {...} }) pattern.
 *
 * @param {Object} styles  CSS properties as camelCase key-value pairs
 * @returns {HTMLDivElement}
 */
function _div(styles = {}) {
  const el = document.createElement('div');
  Object.assign(el.style, styles);
  return el;
}

/**
 * Thin horizontal divider matching Atlas panel design.
 * @returns {HTMLHRElement}
 */
function _divider() {
  const hr = document.createElement('hr');
  Object.assign(hr.style, {
    border:     'none',
    borderTop:  `1px solid ${T.divider}`,
    margin:     '0',
    flexShrink: '0',
  });
  return hr;
}

// ─── Date utilities ───────────────────────────────────────────────────────────

/**
 * Today's date in YYYY-MM-DD (local time, not UTC).
 * Habit check-ins are personal daily events — they should follow Tanim's
 * local clock in Dhaka (UTC+6), not the server's UTC time.
 *
 * @returns {string}
 */
function _todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${_p2(d.getMonth() + 1)}-${_p2(d.getDate())}`;
}

/**
 * A date N days from today as YYYY-MM-DD (local time).
 * @param {number} n  Negative for past days
 * @returns {string}
 */
function _dateOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${_p2(d.getMonth() + 1)}-${_p2(d.getDate())}`;
}

/**
 * A date N days from a given ISO date string.
 * @param {string} fromISO  YYYY-MM-DD
 * @param {number} n
 * @returns {string}
 */
function _dateOffsetFrom(fromISO, n) {
  // Append T00:00:00 to force local-time parsing (bare YYYY-MM-DD parses as UTC in JS)
  const d = new Date(fromISO + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${_p2(d.getMonth() + 1)}-${_p2(d.getDate())}`;
}

/**
 * How many complete calendar days ago a date was (local time).
 * @param {string} dateISO
 * @returns {number}
 */
function _daysAgo(dateISO) {
  const then = new Date(dateISO + 'T00:00:00');
  const now  = new Date(_todayISO() + 'T00:00:00');
  return Math.round((now.getTime() - then.getTime()) / 86_400_000);
}

/**
 * Zero-pad a number to two digits.
 * @param {number} n
 * @returns {string}
 */
function _p2(n) {
  return n < 10 ? '0' + n : String(n);
}
