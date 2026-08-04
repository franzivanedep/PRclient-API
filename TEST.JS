const express = require('express');
const cors = require('cors');

const knex = require('knex')({
  client: 'mysql2',
  connection: {
    host: 'localhost',      // or 'localhost'
    port: 3306,
    user: 'zombie',
    password: 'andrei',           // Default XAMPP password is empty
    database: 'fitnessdb',
  },
});

const WEEKLY_WORKOUT_GOAL = 4;
const PORT = Number(7072);

const app = express();

// Behind a hosting proxy (Render/Railway/etc.) so req.secure and
// req.headers['x-forwarded-proto'] reflect the real client protocol.
app.set('trust proxy', 1);

// --- 1. CORS CONFIGURATION ---
// This allows your frontend to send the 'x-api-key' and 'x-user-id' headers
app.use(cors({
  origin: [
    "https://g-fitness-mauve.vercel.app"
  ],
  methods: [
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'OPTIONS'
  ],
  allowedHeaders: [
    'Content-Type',
    'x-api-key',
    'x-user-id',
    'Authorization'
  ],
}));

// Prevent Safari from caching responses
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use(express.json());

// --- 2. API KEY SECURITY LOGIC ---
const SAFE_API_KEY = "kP9x!V4mQz7@L2sT8#nR6wY1uH5dJ0bC#";

function requireApiKey(req, res, next) {
  if (req.method === 'OPTIONS' || (req.method === 'POST' && req.path === '/auth/login')) {
    return next();
  }
  const apiKey = req.get('x-api-key');
  if (!apiKey || apiKey !== SAFE_API_KEY) {
    return res.status(401).json({ success: false, message: 'Invalid API key.' });
  }
  next();
}

// Stateless auth: valid requests must present the shared API key together with
// a userId (from body, query string, or the x-user-id header — the same key
// the frontend already stores in localStorage).
function requireAuth(req, res, next) {
  const apiKey = req.get('x-api-key');
  const userId = req.body?.userId || req.query?.userId || req.get('x-user-id');

  if (apiKey === SAFE_API_KEY && userId) {
    return next();
  }

  res.status(401).json({ success: false, message: 'Authentication required.' });
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ---------- date helpers ----------
function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function fromDateKey(dateKey) {
  if (dateKey instanceof Date) {
    return dateKey;
  }

  if (typeof dateKey !== "string") {
    throw new Error(`Invalid dateKey: ${JSON.stringify(dateKey)}`);
  }

  // Handle ISO dates like 2026-07-26T16:00:00.000Z
  if (dateKey.includes("T")) {
    dateKey = dateKey.split("T")[0];
  }

  const [y, m, d] = dateKey.split('-').map(Number);

  if (!y || !m || !d) {
    throw new Error(`Invalid date format: ${dateKey}`);
  }

  return new Date(y, m - 1, d);
}

function getWeekStart(date) {
  const weekStart = new Date(date);
  weekStart.setHours(0, 0, 0, 0);
  const dayIndex = weekStart.getDay();
  const shift = dayIndex === 0 ? -6 : 1 - dayIndex;
  weekStart.setDate(weekStart.getDate() + shift);
  return weekStart;
}

function getWeekEnd(date) {
  const end = getWeekStart(date);
  end.setDate(end.getDate() + 6);
  return end;
}

function getWeekDates(weekStartKey) {
  const weekStart = fromDateKey(weekStartKey);
  return Array.from({ length: 7 }, (_, i) => {
    const next = new Date(weekStart);
    next.setDate(weekStart.getDate() + i);
    return toDateKey(next);
  });
}

// Resolve which profile userId a request is acting on. Priority: request
// body -> query string -> x-user-id header. There is no session fallback —
// the frontend is expected to always send the userId it has in localStorage.
function getEffectiveUserId(req) {
  return req.body?.userId || req.query?.userId || req.get('x-user-id');
}

function getReminderMessage(workoutDays) {
  if (workoutDays >= WEEKLY_WORKOUT_GOAL) return 'You have reached your weekly fitness goal. Great job!';
  const remaining = Math.max(0, WEEKLY_WORKOUT_GOAL - workoutDays);
  if (remaining === 1) return 'Only one workout remaining this week!';
  const words = ['zero', 'one', 'two', 'three', 'four'];
  return `You still need ${words[remaining] || remaining} workouts to reach your weekly goal.`;
}

// ---------- data access helpers ----------
async function getActivitiesById(userId = null) {
  let query = knex('activities').where({ is_active: 1 });
  // If userId is provided, only return global activities OR user's custom activities
  if (userId) {
    query = query.andWhere(function() {
      this.whereNull('user_id').orWhere('user_id', userId);
    });
  }
  const rows = await query;
  return new Map(rows.map((row) => [row.id, row]));
}

async function getProfileUserById(userId) {
  if (!userId) {
    return null;
  }
  return knex('app_users').where({ id: userId, is_active: 1 }).first();
}

async function ensureCurrentWeek(userId, referenceDate = new Date()) {
  const weekStart = toDateKey(getWeekStart(referenceDate));
  const weekEnd = toDateKey(getWeekEnd(referenceDate));

  let week = await knex("tracker_weeks")
    .where({
      user_id: userId,
      week_start: weekStart,
    })
    .first();

  if (week) {
    if (week.status !== "current") {
      await knex("tracker_weeks")
        .where({ id: week.id })
        .update({
          status: "current",
          archived_at: null,
          week_end: weekEnd,
        });

      week.status = "current";
      week.archived_at = null;
      week.week_end = weekEnd;
    }

    return week;
  }

  await knex("tracker_weeks")
    .where({
      user_id: userId,
      status: "current",
    })
    .update({
      status: "archived",
      archived_at: knex.fn.now(),
    });

  const [id] = await knex("tracker_weeks").insert({
    user_id: userId,
    week_start: weekStart,
    week_end: weekEnd,
    status: "current",
  });

  return knex("tracker_weeks")
    .where({ id })
    .first();
}

async function getOrCreateWeekForDate(userId, dateKey) {
  const weekStart = toDateKey(getWeekStart(fromDateKey(dateKey)));
  const weekEnd = toDateKey(getWeekEnd(fromDateKey(dateKey)));
  const currentWeekStart = toDateKey(getWeekStart(new Date()));

  const existing = await knex('tracker_weeks').where({ user_id: userId, week_start: weekStart }).first();
  if (existing) return existing;

  if (weekStart === currentWeekStart) return ensureCurrentWeek(userId, fromDateKey(dateKey));

  const [id] = await knex('tracker_weeks').insert({ user_id: userId, week_start: weekStart, week_end: weekEnd, status: 'archived', archived_at: knex.fn.now() });
  return { id, user_id: userId, week_start: weekStart, week_end: weekEnd, status: 'archived' };
}

async function getOrCreateDay(weekId, dateKey) {
  let day = await knex('tracker_days').where({ week_id: weekId, date_key: dateKey }).first();
  if (day) return day;
  const [id] = await knex('tracker_days').insert({ week_id: weekId, date_key: dateKey });
  return { id, week_id: weekId, date_key: dateKey };
}

async function loadWeekWithDays(week) {
  const dateKeys = getWeekDates(week.week_start);
  const days = await knex('tracker_days').where({ week_id: week.id });

  // Normalize database date keys to simple format (remove time component)
  const dayByDate = new Map();
  for (const day of days) {
    let dateKey = day.date_key;
    // Handle both string and Date objects
    if (typeof dateKey === 'string') {
      dateKey = dateKey.includes('T') ? dateKey.split('T')[0] : dateKey;
    } else if (dateKey instanceof Date) {
      dateKey = toDateKey(dateKey);
    }
    dayByDate.set(dateKey, day);
  }

  const dayIds = days.map((d) => d.id);
  const activityLinks = dayIds.length ? await knex('tracker_day_activities').whereIn('day_id', dayIds) : [];
  const linksByDay = new Map();
  for (const link of activityLinks) {
    if (!linksByDay.has(link.day_id)) linksByDay.set(link.day_id, []);
    linksByDay.get(link.day_id).push(link.activity_id);
  }

  const result = { weekStart: week.week_start, weekEnd: week.week_end, status: week.status, days: {} };
  for (const dateKey of dateKeys) {
    const day = dayByDate.get(dateKey);
    result.days[dateKey] = { date: dateKey, activityIds: day ? linksByDay.get(day.id) || [] : [] };
  }
  return result;
}

async function createWeekSummary(week, userId = null) {
  const activitiesById = await getActivitiesById(userId);
  const days = Object.values(week.days).sort((a, b) => a.date.localeCompare(b.date));

  const dailyBreakdown = days.map((day) => {
    const workoutCount = day.activityIds.filter((id) => activitiesById.get(id)?.category === 'workout').length;
    const healthyHabitCount = day.activityIds.filter((id) => activitiesById.get(id)?.category === 'habit').length;
    return {
      dateKey: day.date,
      activityIds: day.activityIds,
      workoutCount,
      healthyHabitCount,
      trackedCount: day.activityIds.length,
      workoutDay: workoutCount > 0,
    };
  });

  const workoutsCompleted = dailyBreakdown.filter((d) => d.workoutDay).length;
  const healthyHabitsCompleted = dailyBreakdown.reduce((sum, d) => sum + d.healthyHabitCount, 0);
  const activityCount = dailyBreakdown.reduce((sum, d) => sum + d.trackedCount, 0);
  const workoutActivityCount = dailyBreakdown.reduce((sum, d) => sum + d.workoutCount, 0);
  const remainingWorkouts = Math.max(0, WEEKLY_WORKOUT_GOAL - workoutsCompleted);
  const completionRatio = WEEKLY_WORKOUT_GOAL === 0 ? 0 : workoutsCompleted / WEEKLY_WORKOUT_GOAL;
  const summaryText =
    workoutsCompleted >= WEEKLY_WORKOUT_GOAL
      ? 'Weekly goal completed!'
      : `You have completed ${workoutsCompleted} of your ${WEEKLY_WORKOUT_GOAL} workouts this week. ${remainingWorkouts === 1 ? 'One workout remaining.' : `${remainingWorkouts} workouts remaining.`}`;

  return { workoutsCompleted, healthyHabitsCompleted, activityCount, workoutActivityCount, remainingWorkouts, completionRatio, summaryText, dailyBreakdown };
}

async function assembleTrackerState(activeUserId) {
  const users = await knex('app_users').where({ is_active: 1 }).orderBy('sort_order');
  const activeId = activeUserId || users[0]?.id;
  const state = { version: 1, activeUserId: activeId, users: {} };

  for (const user of users) {
    const currentWeekRow = await ensureCurrentWeek(user.id);
    const currentWeek = await loadWeekWithDays(currentWeekRow);
    const otherWeeks = await knex('tracker_weeks').where({ user_id: user.id }).andWhereNot({ id: currentWeekRow.id }).orderBy('week_start', 'desc');
    const history = [];
    for (const w of otherWeeks) history.push(await loadWeekWithDays(w));

    state.users[user.id] = {
      id: user.id,
      name: user.name,
      accent: user.accent,
      ring: user.ring,
      currentWeek,
      history,
    };
  }

  return state;
}

async function upsertUserSettings(userId, partial) {
  // Validate user exists
  const profileUser = await getProfileUserById(userId);
  if (!profileUser) {
    throw Object.assign(new Error('Profile user not found.'), { statusCode: 404 });
  }

  const current = await knex('user_settings').where({ user_id: userId }).first();
  const next = {
    weekly_workout_goal: partial.weeklyWorkoutGoal ?? current?.weekly_workout_goal ?? WEEKLY_WORKOUT_GOAL,
    reminders_enabled: partial.remindersEnabled ?? current?.reminders_enabled ?? 1,
    notification_permission: partial.notificationPermission ?? current?.notification_permission ?? 'default',
    active_theme: partial.activeTheme ?? current?.active_theme ?? 'light',
  };

  if (current) {
    await knex('user_settings').where({ user_id: userId }).update(next);
  } else {
    await knex('user_settings').insert({ user_id: userId, ...next });
  }

  return {
    userId,
    weeklyWorkoutGoal: next.weekly_workout_goal,
    remindersEnabled: Boolean(next.reminders_enabled),
    notificationPermission: next.notification_permission,
    activeTheme: next.active_theme,
  };
}

async function toggleActivityForDay(userId, dateKey, activityId) {
  if (!userId) {
    throw Object.assign(new Error('userId is required'), { statusCode: 400 });
  }

  // Validate user exists
  const profileUser = await getProfileUserById(userId);
  if (!profileUser) {
    throw Object.assign(new Error('Profile user not found.'), { statusCode: 404 });
  }

  const activity = await knex('activities').where({ id: activityId, is_active: 1 }).first();
  if (!activity) throw Object.assign(new Error('Activity not found.'), { statusCode: 404 });

  const week = await getOrCreateWeekForDate(userId, dateKey);
  const day = await getOrCreateDay(week.id, dateKey);

  const existing = await knex('tracker_day_activities').where({ day_id: day.id, activity_id: activityId }).first();
  if (existing) {
    await knex('tracker_day_activities').where({ id: existing.id }).del();
    return { toggledOn: false };
  }

  await knex('tracker_day_activities').insert({ day_id: day.id, activity_id: activityId });
  return { toggledOn: true };
}

async function setDayActivities(userId, dateKey, activityIds) {
  // Validate user exists
  const profileUser = await getProfileUserById(userId);
  if (!profileUser) {
    throw Object.assign(new Error('Profile user not found.'), { statusCode: 404 });
  }

  const week = await getOrCreateWeekForDate(userId, dateKey);
  const day = await getOrCreateDay(week.id, dateKey);

  await knex('tracker_day_activities').where({ day_id: day.id }).del();
  for (const activityId of activityIds) {
    await knex('tracker_day_activities').insert({ day_id: day.id, activity_id: activityId }).onConflict(['day_id', 'activity_id']).ignore();
  }
}

async function ensureWeightLogsTable() {
  const exists = await knex.schema.hasTable('weight_logs');
  if (exists) return;

  await knex.schema.createTable('weight_logs', (table) => {
    table.increments('id').primary();
    table.string('user_id', 64).notNullable();
    table.date('week_start').notNullable();
    table.decimal('weight_value', 6, 2).notNullable();
    table.decimal('body_fat', 5, 2).nullable();
    table.enu('unit', ['kg', 'lb']).notNullable().defaultTo('kg');
    table.string('notes', 255).nullable();
    table.dateTime('measured_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['user_id', 'week_start'], 'uq_weight_logs_user_week');
    table.index(['user_id', 'week_start'], 'idx_weight_logs_user_week');
    table.foreign('user_id').references('app_users.id').onDelete('CASCADE').onUpdate('CASCADE');
  });
}

// Adds the body_fat column to an existing weight_logs table (idempotent).
// Body fat is stored per user per week, in the same row as the weight entry.
async function ensureWeightLogsBodyFatColumn() {
  const exists = await knex.schema.hasColumn('weight_logs', 'body_fat');
  if (!exists) {
    await knex.schema.alterTable('weight_logs', (table) => {
      table.decimal('body_fat', 5, 2).nullable();
    });
  }
}

async function ensureActivitiesUserIdColumn() {
  const hasUserIdColumn = await knex.schema.hasColumn('activities', 'user_id');
  if (!hasUserIdColumn) {
    await knex.schema.table('activities', (table) => {
      table.string('user_id', 64).nullable().after('group_id');
      table.index(['user_id'], 'idx_activities_user_id');
      table.foreign('user_id').references('app_users.id').onDelete('CASCADE').onUpdate('CASCADE');
    });
  }
}

function mapWeightRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    userId: row.user_id,
    weekStart: row.week_start,
    weightValue: Number(row.weight_value),
    bodyFat: row.body_fat === null || row.body_fat === undefined ? null : Number(row.body_fat),
    unit: row.unit,
    notes: row.notes,
    measuredAt: row.measured_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseBodyFat(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw Object.assign(new Error('bodyFat must be a number between 0 and 100.'), { statusCode: 400 });
  }
  return Math.round(parsed * 10) / 10;
}

async function upsertWeightLog(userId, weightInput) {
  // Validate user exists
  const profileUser = await getProfileUserById(userId);
  if (!profileUser) {
    throw Object.assign(new Error('Profile user not found.'), { statusCode: 404 });
  }

  const weekStart = weightInput.weekStart ? toDateKey(getWeekStart(fromDateKey(weightInput.weekStart))) : toDateKey(getWeekStart(new Date()));
  const weightValue = Number(weightInput.weightValue ?? weightInput.weight);
  const unit = weightInput.unit === 'lb' ? 'lb' : 'kg';
  const notes = typeof weightInput.notes === 'string' ? weightInput.notes.trim() : null;
  const bodyFat = parseBodyFat(weightInput.bodyFat);
  const measuredAt = weightInput.measuredAt ? new Date(weightInput.measuredAt) : knex.fn.now();

  if (!Number.isFinite(weightValue) || weightValue <= 0) {
    throw Object.assign(new Error('weightValue is required and must be a positive number.'), { statusCode: 400 });
  }

  await knex('weight_logs')
    .insert({
      user_id: userId,
      week_start: weekStart,
      weight_value: weightValue,
      body_fat: bodyFat,
      unit,
      notes,
      measured_at: measuredAt,
      created_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    })
    .onConflict(['user_id', 'week_start'])
    .merge({
      weight_value: weightValue,
      body_fat: bodyFat,
      unit,
      notes,
      measured_at: measuredAt,
      updated_at: knex.fn.now(),
    });

  return getWeightProgress(userId);
}

async function getWeightProgress(userId) {
  const rows = await knex('weight_logs').where({ user_id: userId }).orderBy('week_start', 'desc').orderBy('updated_at', 'desc');
  const currentWeekStart = toDateKey(getWeekStart(new Date()));

  // Normalize database week_start to string format for comparison
  const normalizedRows = rows.map(row => ({
    ...row,
    week_start_normalized: typeof row.week_start === 'string'
      ? row.week_start.includes('T') ? row.week_start.split('T')[0] : row.week_start
      : toDateKey(new Date(row.week_start))
  }));

  const current = normalizedRows.find((row) => row.week_start_normalized === currentWeekStart) || null;
  const previous = normalizedRows.find((row) => row.week_start_normalized < currentWeekStart) || null;

  const delta = current && previous ? Number((Number(current.weight_value) - Number(previous.weight_value)).toFixed(2)) : null;
  const percentChange = current && previous && Number(previous.weight_value) !== 0 ? Number((((Number(current.weight_value) - Number(previous.weight_value)) / Number(previous.weight_value)) * 100).toFixed(2)) : null;

  const currentBodyFat = current && current.body_fat !== null && current.body_fat !== undefined ? Number(current.body_fat) : null;
  const previousBodyFat = previous && previous.body_fat !== null && previous.body_fat !== undefined ? Number(previous.body_fat) : null;
  const bodyFatDelta = currentBodyFat !== null && previousBodyFat !== null ? Number((currentBodyFat - previousBodyFat).toFixed(2)) : null;

  return {
    currentWeekStart,
    currentWeight: current ? Number(current.weight_value) : null,
    previousWeight: previous ? Number(previous.weight_value) : null,
    delta,
    percentChange,
    trend: delta === null ? 'unknown' : delta === 0 ? 'flat' : delta < 0 ? 'down' : 'up',
    unit: current?.unit || previous?.unit || 'kg',
    currentBodyFat,
    previousBodyFat,
    bodyFatDelta,
    entries: rows.map(mapWeightRow),
  };
}

// ---------- workout data access helpers ----------
// Default exercise library mirrors the frontend data/exercises.json. The
// videoUrl values are already converted to YouTube embed URLs.
const GLOBAL_EXERCISES = [
  {
    id: 'bench-press',
    name: 'Bench Press',
    videoUrl: 'https://www.youtube-nocookie.com/embed/L29tpTiWFjk',
    targetMuscles: ['Chest', 'Triceps', 'Front Delts'],
    instructions: 'Lie on a flat bench, grip the bar slightly wider than shoulder width, lower it to mid-chest, then press back up.',
  },
  {
    id: 'back-squat',
    name: 'Barbell Back Squat',
    videoUrl: 'https://www.youtube-nocookie.com/embed/DnXwPiYJReQ',
    targetMuscles: ['Quads', 'Glutes', 'Hamstrings'],
    instructions: 'Set the bar across your upper back, brace your core, sit down to at least parallel, then drive up through your heels.',
  },
  {
    id: 'deadlift',
    name: 'Deadlift',
    videoUrl: 'https://www.youtube-nocookie.com/embed/zubVfCkc3cc',
    targetMuscles: ['Hamstrings', 'Glutes', 'Lower Back', 'Traps'],
    instructions: 'Stand with the bar over mid-foot, hinge at the hips, keep a flat back, and stand up by driving the floor away.',
  },
  {
    id: 'overhead-press',
    name: 'Overhead Press',
    videoUrl: 'https://www.youtube-nocookie.com/embed/a81SaIpjGlA',
    targetMuscles: ['Shoulders', 'Triceps'],
    instructions: 'Press the bar from your shoulders straight overhead, keeping your core braced and ribs down.',
  },
  {
    id: 'pull-up',
    name: 'Pull-Up',
    videoUrl: 'https://www.youtube-nocookie.com/embed/tNV6-iUDHO4',
    targetMuscles: ['Lats', 'Biceps', 'Upper Back'],
    instructions: 'Hang from the bar, pull your chin above it by driving elbows down and back, then lower under control.',
  },
  {
    id: 'barbell-bicep-curl',
    name: 'Barbell Bicep Curl',
    videoUrl: 'https://www.youtube-nocookie.com/embed/eFNf_ZXqlzI',
    targetMuscles: ['Biceps', 'Forearms'],
    instructions: 'Hold the bar at hip height, curl it toward your shoulders without swinging, and lower slowly.',
  },
  {
    id: 'bent-over-row',
    name: 'Bent-Over Barbell Row',
    videoUrl: 'https://www.youtube-nocookie.com/embed/_o9uE-oeOjE',
    targetMuscles: ['Upper Back', 'Lats', 'Rear Delts'],
    instructions: 'Hinge forward with a flat back, row the bar to your lower ribs, then lower with control.',
  },
];

function parseTargetMuscles(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) { /* not JSON, fall through to comma split */ }
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

// Converts any supported YouTube URL (watch, Shorts, v/, embed) into the
// https://www.youtube-nocookie.com/embed/<videoId> format the frontend uses.
function toEmbedVideoUrl(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;
  const patterns = [
    /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|v\/|shorts\/))([\w-]{11})/i,
    /youtu\.be\/([\w-]{11})/i,
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match) return `https://www.youtube-nocookie.com/embed/${match[1]}`;
  }
  return null;
}

function mapExercise(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    videoUrl: row.video_url,
    targetMuscles: parseTargetMuscles(row.target_muscles),
    instructions: row.instructions,
  };
}

function normalizeDateKey(value) {
  if (value instanceof Date) return toDateKey(value);
  if (!value) return toDateKey(new Date());
  const s = String(value);
  return s.includes('T') ? s.split('T')[0] : s;
}

function toEpochMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? Date.now() : parsed;
  }
  return Date.now();
}

function mapWorkoutSet(row) {
  return { id: row.set_ref, reps: Number(row.reps), weight: Number(row.weight) };
}

// Returns workout logs in the same shape the frontend stores in localStorage:
// [{ exerciseId, sets: [{ id, reps, weight }], updatedAt }]
async function loadSessionLogs(session) {
  const rows = await knex('workout_sets').where({ session_id: session.id }).orderBy('sort_order');
  const byExercise = new Map();
  for (const row of rows) {
    const entry = byExercise.get(row.exercise_id) || { sets: [], updatedAt: 0 };
    entry.sets.push(mapWorkoutSet(row));
    entry.updatedAt = Math.max(entry.updatedAt, toEpochMs(row.updated_at));
    byExercise.set(row.exercise_id, entry);
  }
  const logs = [];
  for (const [exerciseId, entry] of byExercise) {
    logs.push({ exerciseId, sets: entry.sets, updatedAt: entry.updatedAt });
  }
  return logs;
}

async function getSessionSummary(sessionId) {
  const rows = await knex('workout_sets').where({ session_id: sessionId });
  const exerciseIds = new Set();
  let totalReps = 0;
  let totalVolume = 0;
  for (const row of rows) {
    exerciseIds.add(row.exercise_id);
    totalReps += Number(row.reps) || 0;
    totalVolume += (Number(row.reps) || 0) * (Number(row.weight) || 0);
  }
  return {
    exerciseCount: exerciseIds.size,
    setCount: rows.length,
    totalReps,
    totalVolume: Number(totalVolume.toFixed(2)),
  };
}

async function mapSession(row) {
  return {
    id: row.id,
    userId: row.user_id,
    sessionDate: normalizeDateKey(row.session_date),
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(await getSessionSummary(row.id)),
  };
}

// One session per user per calendar day. Idempotent - returns the existing
// session for that date if one already exists.
async function getOrCreateSession(userId, dateKey) {
  let session = await knex('workout_sessions').where({ user_id: userId, session_date: dateKey }).first();
  if (session) return session;
  const [id] = await knex('workout_sessions').insert({ user_id: userId, session_date: dateKey });
  return knex('workout_sessions').where({ id }).first();
}

async function ensureWorkoutTables() {
  const hasExercises = await knex.schema.hasTable('exercises');
  if (!hasExercises) {
    await knex.schema.createTable('exercises', (table) => {
      table.string('id', 191).primary();
      table.string('user_id', 64).nullable();
      table.string('name', 255).notNullable();
      table.string('video_url', 500).notNullable();
      table.json('target_muscles').notNullable();
      table.text('instructions').nullable();
      table.integer('sort_order').notNullable().defaultTo(0);
      table.boolean('is_active').notNullable().defaultTo(true);
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      table.index(['user_id'], 'idx_exercises_user_id');
      table.index(['name'], 'idx_exercises_name');
      table.foreign('user_id').references('app_users.id').onDelete('CASCADE').onUpdate('CASCADE');
    });
  }

  const hasSessions = await knex.schema.hasTable('workout_sessions');
  if (!hasSessions) {
    await knex.schema.createTable('workout_sessions', (table) => {
      table.increments('id').primary();
      table.string('user_id', 64).notNullable();
      table.date('session_date').notNullable();
      table.string('notes', 500).nullable();
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      table.unique(['user_id', 'session_date'], 'uq_workout_sessions_user_date');
      table.index(['session_date'], 'idx_workout_sessions_date');
      table.foreign('user_id').references('app_users.id').onDelete('CASCADE').onUpdate('CASCADE');
    });
  }

  const hasSets = await knex.schema.hasTable('workout_sets');
  if (!hasSets) {
    await knex.schema.createTable('workout_sets', (table) => {
      table.increments('id').primary();
      table.integer('session_id').unsigned().notNullable();
      table.string('exercise_id', 191).notNullable();
      table.string('set_ref', 64).notNullable();
      table.integer('reps').unsigned().notNullable().defaultTo(0);
      table.decimal('weight', 8, 2).notNullable().defaultTo(0);
      table.integer('sort_order').notNullable().defaultTo(0);
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      table.unique(['session_id', 'exercise_id', 'set_ref'], 'uq_workout_sets_session_exercise_ref');
      table.index(['session_id'], 'idx_workout_sets_session_id');
      table.index(['exercise_id'], 'idx_workout_sets_exercise_id');
      table.foreign('session_id').references('workout_sessions.id').onDelete('CASCADE').onUpdate('CASCADE');
      table.foreign('exercise_id').references('exercises.id').onDelete('CASCADE').onUpdate('CASCADE');
    });
  }
}

// Seeds the default exercise library (global exercises, user_id IS NULL).
// Idempotent - existing rows are left untouched.
async function seedGlobalExercises() {
  if (!(await knex.schema.hasTable('exercises'))) return;
  await knex('exercises')
    .insert(
      GLOBAL_EXERCISES.map((exercise, index) => ({
        id: exercise.id,
        user_id: null,
        name: exercise.name,
        video_url: exercise.videoUrl,
        target_muscles: JSON.stringify(exercise.targetMuscles),
        instructions: exercise.instructions,
        sort_order: index,
        is_active: 1,
      })),
    )
    .onConflict('id')
    .ignore();
}

app.get('/health', (req, res) => res.json({ success: true, data: { status: 'healthy' } }));

app.use('/api', requireApiKey);

// ---------- auth ----------
// Stateless login: validates credentials and hands back the auth + profile
// user. The frontend is responsible for storing the returned userId (in
// localStorage) and sending it with every subsequent request.
app.post(
  '/api/auth/login',
  asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ success: false, message: 'Username and password are required.' });

    const authUser = await knex('auth_users').where({ username, is_active: 1 }).first();
    if (!authUser || authUser.password !== password) {
      return res.status(401).json({ success: false, message: 'Incorrect username or password.' });
    }

    const profileUser = await getProfileUserById(authUser.default_profile_user_id);

    res.json({ success: true, data: { authenticated: true, user: authUser, profileUser } });
  }),
);

// ---------- users ----------
app.get(
  '/api/users',
  requireAuth,
  asyncHandler(async (req, res) => {
    const users = await knex('app_users').where({ is_active: 1 }).orderBy('sort_order');
    res.json({ success: true, data: { users, activeUserId: getEffectiveUserId(req) } });
  }),
);

app.post(
  '/api/users',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id, name, accent, ring, sortOrder = 0, isActive = true } = req.body || {};
    if (!id || !name || !accent || !ring) return res.status(400).json({ success: false, message: 'id, name, accent, and ring are required.' });

    await knex('app_users')
      .insert({ id, name, accent, ring, sort_order: sortOrder, is_active: isActive ? 1 : 0 })
      .onConflict('id')
      .merge();

    res.status(201).json({ success: true, data: await getProfileUserById(id) });
  }),
);

app.patch(
  '/api/users/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const existing = await getProfileUserById(req.params.userId);
    if (!existing) return res.status(404).json({ success: false, message: 'User not found.' });

    await knex('app_users').where({ id: req.params.userId }).update({
      name: req.body.name ?? existing.name,
      accent: req.body.accent ?? existing.accent,
      ring: req.body.ring ?? existing.ring,
      sort_order: req.body.sortOrder ?? existing.sort_order,
      is_active: req.body.isActive === undefined ? existing.is_active : req.body.isActive ? 1 : 0,
    });

    res.json({ success: true, data: await getProfileUserById(req.params.userId) });
  }),
);

app.delete(
  '/api/users/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    await knex('app_users').where({ id: req.params.userId }).update({ is_active: 0 });
    res.json({ success: true, data: { userId: req.params.userId } });
  }),
);

// ---------- activity groups ----------
app.get(
  '/api/activity-groups',
  requireAuth,
  asyncHandler(async (req, res) => {
    const groups = await knex('activity_groups').where({ is_active: 1 }).orderBy('sort_order');
    res.json({ success: true, data: { activityGroups: groups } });
  }),
);

app.post(
  '/api/activity-groups',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id, name, description, category, sortOrder = 0, isActive = true } = req.body || {};
    if (!id || !name || !description || !category) return res.status(400).json({ success: false, message: 'id, name, description, and category are required.' });

    await knex('activity_groups')
      .insert({ id, name, description, category, sort_order: sortOrder, is_active: isActive ? 1 : 0 })
      .onConflict('id')
      .merge();

    res.status(201).json({ success: true, data: await knex('activity_groups').where({ id }).first() });
  }),
);

app.patch(
  '/api/activity-groups/:groupId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const existing = await knex('activity_groups').where({ id: req.params.groupId }).first();
    if (!existing) return res.status(404).json({ success: false, message: 'Activity group not found.' });

    await knex('activity_groups').where({ id: req.params.groupId }).update({
      name: req.body.name ?? existing.name,
      description: req.body.description ?? existing.description,
      category: req.body.category ?? existing.category,
      sort_order: req.body.sortOrder ?? existing.sort_order,
      is_active: req.body.isActive === undefined ? existing.is_active : req.body.isActive ? 1 : 0,
    });

    res.json({ success: true, data: await knex('activity_groups').where({ id: req.params.groupId }).first() });
  }),
);

app.delete(
  '/api/activity-groups/:groupId',
  requireAuth,
  asyncHandler(async (req, res) => {
    await knex('activity_groups').where({ id: req.params.groupId }).update({ is_active: 0 });
    res.json({ success: true, data: { groupId: req.params.groupId } });
  }),
);

// ---------- activities ----------
app.get(
  '/api/activities',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    const activities = await knex('activities')
      .where({ is_active: 1 })
      .andWhere(function() {
        // Get global activities (user_id is null) OR user-specific activities for this user
        this.whereNull('user_id').orWhere('user_id', userId);
      })
      .orderBy('sort_order');
    res.json({ success: true, data: { activities } });
  }),
);

app.post(
  '/api/activities',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    const { id, groupId, label, category, sortOrder = 0, countsTowardGoal = false, isHealthyHabit = false, isActive = true, isCustom = false } = req.body || {};

    // Validate user exists
    const profileUser = await getProfileUserById(userId);
    if (!profileUser) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    // For custom activities, only require id, label, and category
    if (isCustom) {
      if (!label || !category) {
        return res.status(400).json({ success: false, message: 'label and category are required for custom activities.' });
      }

      // Trim whitespace from label
      const trimmedLabel = label.trim();
      if (!trimmedLabel) {
        return res.status(400).json({ success: false, message: 'Activity name cannot be empty.' });
      }

      // Check for duplicate activity names for the same user (case-insensitive)
      const existingActivity = await knex('activities')
        .where({ user_id: userId, is_active: 1 })
        .andWhereRaw('LOWER(label) = ?', [trimmedLabel.toLowerCase()])
        .first();

      if (existingActivity) {
        return res.status(409).json({ success: false, message: 'An activity with this name already exists.' });
      }

      // Generate a unique ID if not provided
      const activityId = id || `custom_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      await knex('activities').insert({
        id: activityId,
        user_id: userId,
        group_id: null,
        label: trimmedLabel,
        category,
        sort_order: sortOrder,
        counts_toward_goal: category === 'workout' ? 1 : 0,
        is_healthy_habit: category === 'habit' ? 1 : 0,
        is_active: isActive ? 1 : 0,
      });

      res.status(201).json({ success: true, data: await knex('activities').where({ id: activityId }).first() });
    } else {
      // Original behavior for global activities
      if (!id || !groupId || !label || !category) {
        return res.status(400).json({ success: false, message: 'id, groupId, label, and category are required.' });
      }

      await knex('activities')
        .insert({
          id,
          group_id: groupId,
          label,
          category,
          sort_order: sortOrder,
          counts_toward_goal: countsTowardGoal ? 1 : 0,
          is_healthy_habit: isHealthyHabit ? 1 : 0,
          is_active: isActive ? 1 : 0,
        })
        .onConflict('id')
        .merge();

      res.status(201).json({ success: true, data: await knex('activities').where({ id }).first() });
    }
  }),
);

app.patch(
  '/api/activities/:activityId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const existing = await knex('activities').where({ id: req.params.activityId }).first();
    if (!existing) return res.status(404).json({ success: false, message: 'Activity not found.' });

    await knex('activities').where({ id: req.params.activityId }).update({
      group_id: req.body.groupId ?? existing.group_id,
      label: req.body.label ?? existing.label,
      category: req.body.category ?? existing.category,
      sort_order: req.body.sortOrder ?? existing.sort_order,
      counts_toward_goal: req.body.countsTowardGoal === undefined ? existing.counts_toward_goal : req.body.countsTowardGoal ? 1 : 0,
      is_healthy_habit: req.body.isHealthyHabit === undefined ? existing.is_healthy_habit : req.body.isHealthyHabit ? 1 : 0,
      is_active: req.body.isActive === undefined ? existing.is_active : req.body.isActive ? 1 : 0,
    });

    res.json({ success: true, data: await knex('activities').where({ id: req.params.activityId }).first() });
  }),
);

app.delete(
  '/api/activities/:activityId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    const activity = await knex('activities').where({ id: req.params.activityId }).first();

    if (!activity) {
      return res.status(404).json({ success: false, message: 'Activity not found.' });
    }

    // Only allow deletion of custom activities (user_id is not null)
    if (!activity.user_id) {
      return res.status(403).json({ success: false, message: 'Cannot delete global activities.' });
    }

    // Only allow the owner to delete their custom activity
    if (activity.user_id !== userId) {
      return res.status(403).json({ success: false, message: 'You can only delete your own custom activities.' });
    }

    await knex('activities').where({ id: req.params.activityId }).update({ is_active: 0 });
    res.json({ success: true, data: { activityId: req.params.activityId } });
  }),
);

// ---------- tracker state ----------
app.get(
  '/api/tracker/state',
  requireAuth,
  asyncHandler(async (req, res) => {
    const trackerState = await assembleTrackerState(getEffectiveUserId(req));
    res.json({ success: true, data: { trackerState } });
  }),
);

app.put(
  '/api/tracker/state',
  requireAuth,
  asyncHandler(async (req, res) => {
    const state = req.body.state || req.body;
    const activeUserId = getEffectiveUserId(req) || state.activeUserId;

    if (!activeUserId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }

    // Verify the user exists
    const profileUser = await getProfileUserById(activeUserId);
    if (!profileUser) {
      return res.status(404).json({ success: false, message: 'Profile user not found.' });
    }

    // Only update the selected user, not all users in state.users
    const userState = state.users?.[activeUserId];
    if (userState?.currentWeek) {
      for (const day of Object.values(userState.currentWeek.days || {})) {
        if (!day?.date) continue;
        await setDayActivities(activeUserId, day.date, Array.isArray(day.activityIds) ? day.activityIds : []);
      }
    }

    res.json({ success: true, data: { trackerState: await assembleTrackerState(activeUserId) } });
  }),
);

app.patch(
  '/api/tracker/active-user',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req) || req.body.activeUserId;
    const profileUser = await getProfileUserById(userId);
    if (!profileUser) return res.status(404).json({ success: false, message: 'Profile user not found.' });

    res.json({ success: true, data: { activeUserId: profileUser.id } });
  }),
);

// ---------- weekly progress ----------
app.get(
  '/api/weekly-progress',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const profileUser = await getProfileUserById(userId);
    if (!profileUser) return res.status(404).json({ success: false, message: 'Profile user not found.' });

    const weekRow = await ensureCurrentWeek(userId);
    const currentWeek = await loadWeekWithDays(weekRow);
    const summary = await createWeekSummary(currentWeek);

    res.json({ success: true, data: { user: profileUser, currentWeek, summary, remainingWorkouts: summary.remainingWorkouts, reminderMessage: getReminderMessage(summary.workoutsCompleted) } });
  }),
);

app.get(
  '/api/weekly-progress/current',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const profileUser = await getProfileUserById(userId);
    if (!profileUser) return res.status(404).json({ success: false, message: 'Profile user not found.' });

    const weekRow = await ensureCurrentWeek(profileUser.id);
    const currentWeek = await loadWeekWithDays(weekRow);
    const summary = await createWeekSummary(currentWeek, profileUser.id);

    res.json({ success: true, data: { user: profileUser, currentWeek, summary } });
  }),
);

// ---------- dashboard ----------
app.get(
  '/api/dashboard',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const profileUser = await getProfileUserById(userId);
    if (!profileUser) return res.status(404).json({ success: false, message: 'Active profile user not found.' });

    const trackerState = await assembleTrackerState(userId);
    const activeUser = trackerState.users[trackerState.activeUserId];
    const activeSummary = await createWeekSummary(activeUser.currentWeek, activeUser.id);
    const activityGroups = await knex('activity_groups').where({ is_active: 1 }).orderBy('sort_order');
    // Only return global activities (user_id IS NULL) OR user's custom activities
    const activities = await knex('activities')
      .where({ is_active: 1 })
      .andWhere(function() {
        this.whereNull('user_id').orWhere('user_id', profileUser.id);
      })
      .orderBy('sort_order');
    const settings = await upsertUserSettings(profileUser.id, {});
    const weightProgress = await getWeightProgress(profileUser.id);
    const notifications = await knex('notifications').where({ user_id: profileUser.id }).orderBy('created_at', 'desc');
    const reminders = await knex('reminder_logs').where({ user_id: profileUser.id }).orderBy('sent_at', 'desc');
    const historyWeeks = [activeUser.currentWeek, ...activeUser.history].sort((a, b) => b.weekStart.localeCompare(a.weekStart));

    res.json({
      success: true,
      data: {
        currentUser: profileUser,
        activeProfileUserId: profileUser.id,
        weeklyWorkoutGoal: settings.weeklyWorkoutGoal,
        trackerState,
        activeUser,
        activeSummary,
        activityGroups,
        activities,
        historyWeeks,
        reminders,
        notifications,
        settings,
        weightProgress,
        dashboardStats: {
          workoutsCompleted: activeSummary.workoutsCompleted,
          healthyHabitsCompleted: activeSummary.healthyHabitsCompleted,
          activityCount: activeSummary.activityCount,
          workoutActivityCount: activeSummary.workoutActivityCount,
          remainingWorkouts: activeSummary.remainingWorkouts,
          completionRatio: activeSummary.completionRatio,
          summaryText: activeSummary.summaryText,
          weightDelta: weightProgress.delta,
          weightPercentChange: weightProgress.percentChange,
          currentWeight: weightProgress.currentWeight,
          weightUnit: weightProgress.unit,
        },
      },
    });
  }),
);

app.get(
  '/api/dashboard/stats',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const weekRow = await ensureCurrentWeek(userId);
    const currentWeek = await loadWeekWithDays(weekRow);
    const summary = await createWeekSummary(currentWeek, userId);
    const weightProgress = await getWeightProgress(userId);
    res.json({
      success: true,
      data: {
        workoutsCompleted: summary.workoutsCompleted,
        healthyHabitsCompleted: summary.healthyHabitsCompleted,
        activityCount: summary.activityCount,
        workoutActivityCount: summary.workoutActivityCount,
        remainingWorkouts: summary.remainingWorkouts,
        completionRatio: summary.completionRatio,
        summaryText: summary.summaryText,
        weightDelta: weightProgress.delta,
        weightPercentChange: weightProgress.percentChange,
        currentWeight: weightProgress.currentWeight,
        weightUnit: weightProgress.unit,
      },
    });
  }),
);

// ---------- weight ----------
app.get(
  '/api/weight',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const profileUser = await getProfileUserById(userId);
    if (!profileUser) return res.status(404).json({ success: false, message: 'Profile user not found.' });

    res.json({ success: true, data: { user: profileUser, weightProgress: await getWeightProgress(userId) } });
  }),
);

app.get('/api/weight/progress', requireAuth, asyncHandler(async (req, res) => {
  const userId = getEffectiveUserId(req);
  if (!userId) {
    return res.status(400).json({ success: false, message: 'Missing userId' });
  }

  const progress = await getWeightProgress(userId);
  res.json({ success: true, data: { weightProgress: progress } });
}));

app.post(
  '/api/weight',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const profileUser = await getProfileUserById(userId);
    if (!profileUser) return res.status(404).json({ success: false, message: 'Profile user not found.' });

    // Ensure weight logs table exists
    await ensureWeightLogsTable();

    const weightProgress = await upsertWeightLog(userId, req.body || {});
    res.status(201).json({ success: true, data: { user: profileUser, weightProgress } });
  }),
);

app.patch(
  '/api/weight/:weightId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const existing = await knex('weight_logs').where({ id: req.params.weightId, user_id: userId }).first();
    if (!existing) return res.status(404).json({ success: false, message: 'Weight entry not found.' });

    const nextWeightValue = req.body.weightValue ?? req.body.weight ?? existing.weight_value;
    const nextUnit = req.body.unit || existing.unit;
    const nextNotes = req.body.notes ?? existing.notes;
    let nextBodyFat = existing.body_fat ?? null;
    if (req.body.bodyFat !== undefined) {
      nextBodyFat = parseBodyFat(req.body.bodyFat);
    }

    if (!Number.isFinite(Number(nextWeightValue)) || Number(nextWeightValue) <= 0) {
      return res.status(400).json({ success: false, message: 'weightValue must be a positive number.' });
    }

    await knex('weight_logs').where({ id: existing.id }).update({
      weight_value: Number(nextWeightValue),
      body_fat: nextBodyFat,
      unit: nextUnit === 'lb' ? 'lb' : 'kg',
      notes: nextNotes,
      updated_at: knex.fn.now(),
    });

    res.json({ success: true, data: { userId: existing.user_id, weightProgress: await getWeightProgress(existing.user_id) } });
  }),
);

app.delete(
  '/api/weight/:weightId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const existing = await knex('weight_logs').where({ id: req.params.weightId, user_id: userId }).first();
    if (!existing) return res.status(404).json({ success: false, message: 'Weight entry not found.' });

    await knex('weight_logs').where({ id: existing.id }).del();
    res.json({ success: true, data: { userId: existing.user_id, deleted: true, weightProgress: await getWeightProgress(existing.user_id) } });
  }),
);

// Deletes the entire weight entry (weight + body fat) for a specific user and
// week. Filters by BOTH user_id and week_start so one user can never delete
// another user's entry.
app.delete(
  '/api/weight/week/:weekStart',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }

    const weekStart = toDateKey(getWeekStart(fromDateKey(req.params.weekStart)));

    const deleted = await knex('weight_logs')
      .where({ user_id: userId, week_start: weekStart })
      .del();

    res.json({ success: true, data: { userId, weekStart, deleted: deleted > 0, weightProgress: await getWeightProgress(userId) } });
  }),
);

// ---------- reminders ----------
app.get(
  '/api/reminders',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const profileUser = await getProfileUserById(userId);
    if (!profileUser) return res.status(404).json({ success: false, message: 'Profile user not found.' });

    const reminders = await knex('reminder_logs').where({ user_id: userId }).orderBy('sent_at', 'desc');
    res.json({ success: true, data: { user: profileUser, reminders } });
  }),
);

app.post(
  '/api/reminders',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, message } = req.body || {};
    const reminderKey = req.body.reminderKey || toDateKey(new Date());
    if (!userId || !message) return res.status(400).json({ success: false, message: 'userId and message are required.' });

    const profileUser = await getProfileUserById(userId);
    if (!profileUser) return res.status(404).json({ success: false, message: 'Profile user not found.' });

    await knex('reminder_logs')
      .insert({ user_id: userId, reminder_key: reminderKey, message, sent_at: knex.fn.now() })
      .onConflict(['user_id', 'reminder_key'])
      .merge();

    await knex('notifications').insert({ user_id: userId, type: 'reminder', title: 'Fitness reminder', body: message, metadata: JSON.stringify({ reminderKey }) });

    res.status(201).json({ success: true, data: { userId, reminderKey } });
  }),
);

app.post(
  '/api/reminders/evaluate',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const profileUser = await getProfileUserById(userId);
    if (!profileUser) return res.status(404).json({ success: false, message: 'Profile user not found.' });

    const weekRow = await ensureCurrentWeek(userId);
    const currentWeek = await loadWeekWithDays(weekRow);
    const summary = await createWeekSummary(currentWeek, userId);
    const reminderMessage = getReminderMessage(summary.workoutsCompleted);

    if (!reminderMessage) return res.json({ success: true, message: 'No reminder needed.', data: { sent: false } });

    const reminderKey = `${currentWeek.weekStart}-${toDateKey(new Date())}`;
    await knex('reminder_logs')
      .insert({ user_id: userId, reminder_key: reminderKey, message: reminderMessage, sent_at: knex.fn.now() })
      .onConflict(['user_id', 'reminder_key'])
      .merge();
    await knex('notifications').insert({ user_id: userId, type: 'reminder', title: 'Fitness reminder', body: reminderMessage, metadata: JSON.stringify({ reminderKey }) });

    res.status(201).json({ success: true, data: { sent: true, reminderKey, reminderMessage } });
  }),
);

// ---------- notifications ----------
app.get(
  '/api/notifications',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const profileUser = await getProfileUserById(userId);
    if (!profileUser) return res.status(404).json({ success: false, message: 'Profile user not found.' });

    const notifications = await knex('notifications').where({ user_id: userId }).orderBy('created_at', 'desc');
    res.json({ success: true, data: { user: profileUser, notifications } });
  }),
);

app.post(
  '/api/notifications/:notificationId/read',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    await knex('notifications')
      .where({ id: req.params.notificationId, user_id: userId })
      .whereNull('read_at')
      .update({ read_at: knex.fn.now() });
    res.json({ success: true, data: { notificationId: req.params.notificationId } });
  }),
);

app.post(
  '/api/notifications/read-all',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    await knex('notifications').where({ user_id: userId }).whereNull('read_at').update({ read_at: knex.fn.now() });
    res.json({ success: true, data: { userId } });
  }),
);

// ---------- settings ----------
app.get(
  '/api/settings',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const profileUser = await getProfileUserById(userId);
    if (!profileUser) return res.status(404).json({ success: false, message: 'Profile user not found.' });

    res.json({ success: true, data: { user: profileUser, settings: await upsertUserSettings(userId, {}) } });
  }),
);

async function handleSettingsUpdate(req, res) {
  const userId = getEffectiveUserId(req);
  const profileUser = await getProfileUserById(userId);
  if (!profileUser) return res.status(404).json({ success: false, message: 'Profile user not found.' });

  const settings = await upsertUserSettings(userId, req.body || {});
  res.json({ success: true, data: { user: profileUser, settings } });
}

app.put('/api/settings', requireAuth, asyncHandler(handleSettingsUpdate));
app.patch('/api/settings', requireAuth, asyncHandler(handleSettingsUpdate));

// ---------- tracker days ----------
app.get(
  '/api/tracker/days/:dateKey',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const profileUser = await getProfileUserById(userId);
    if (!profileUser) return res.status(404).json({ success: false, message: 'Profile user not found.' });

    const week = await getOrCreateWeekForDate(userId, req.params.dateKey);
    const day = await getOrCreateDay(week.id, req.params.dateKey);
    const links = await knex('tracker_day_activities').where({ day_id: day.id });

    res.json({ success: true, data: { user: profileUser, dateKey: req.params.dateKey, activityIds: links.map((l) => l.activity_id) } });
  }),
);

app.post('/api/tracker/days/:dateKey/activities', requireAuth, asyncHandler(async (req, res) => {
  const userId = getEffectiveUserId(req);
  if (!userId) {
    return res.status(400).json({ success: false, message: 'Missing userId' });
  }

  const { activityId } = req.body;
  const result = await toggleActivityForDay(userId, req.params.dateKey, activityId);
  res.json({ success: true, data: result });
}));

app.put(
  '/api/tracker/days/:dateKey/activities',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }

    const activityIds = Array.isArray(req.body.activityIds) ? req.body.activityIds : [];
    await setDayActivities(userId, req.params.dateKey, activityIds);
    res.json({ success: true, data: { userId, dateKey: req.params.dateKey, activityIds } });
  }),
);

app.delete(
  '/api/tracker/days/:dateKey/activities',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }

    const week = await getOrCreateWeekForDate(userId, req.params.dateKey);
    const day = await getOrCreateDay(week.id, req.params.dateKey);
    const deleted = await knex('tracker_day_activities').where({ day_id: day.id }).del();

    res.json({ success: true, data: { userId, dateKey: req.params.dateKey, cleared: deleted > 0 } });
  }),
);

app.post(
  '/api/tracker/days/:dateKey/activities/:activityId/toggle',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    const profileUser = await getProfileUserById(userId);
    if (!profileUser) return res.status(404).json({ success: false, message: 'Profile user not found.' });

    const result = await toggleActivityForDay(userId, req.params.dateKey, req.params.activityId);
    res.json({ success: true, data: { userId, dateKey: req.params.dateKey, activityId: req.params.activityId, toggledOn: result.toggledOn } });
  }),
);

// ---------- completion confirmation endpoints ----------
app.put(
  '/api/tracker/days/:dateKey/activities/:activityId/complete',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    const profileUser = await getProfileUserById(userId);
    if (!profileUser) return res.status(404).json({ success: false, message: 'Profile user not found.' });

    const activity = await knex('activities').where({ id: req.params.activityId, is_active: 1 }).first();
    if (!activity) return res.status(404).json({ success: false, message: 'Activity not found.' });

    const week = await getOrCreateWeekForDate(userId, req.params.dateKey);
    const day = await getOrCreateDay(week.id, req.params.dateKey);

    const existing = await knex('tracker_day_activities').where({ day_id: day.id, activity_id: req.params.activityId }).first();
    if (existing) {
      return res.json({ success: true, data: { userId, dateKey: req.params.dateKey, activityId: req.params.activityId, alreadyCompleted: true } });
    }

    await knex('tracker_day_activities').insert({ day_id: day.id, activity_id: req.params.activityId });
    res.json({ success: true, data: { userId, dateKey: req.params.dateKey, activityId: req.params.activityId, completed: true } });
  }),
);

app.put(
  '/api/tracker/days/:dateKey/activities/:activityId/incomplete',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    const profileUser = await getProfileUserById(userId);
    if (!profileUser) return res.status(404).json({ success: false, message: 'Profile user not found.' });

    const activity = await knex('activities').where({ id: req.params.activityId, is_active: 1 }).first();
    if (!activity) return res.status(404).json({ success: false, message: 'Activity not found.' });

    const week = await getOrCreateWeekForDate(userId, req.params.dateKey);
    const day = await getOrCreateDay(week.id, req.params.dateKey);

    const existing = await knex('tracker_day_activities').where({ day_id: day.id, activity_id: req.params.activityId }).first();
    if (!existing) {
      return res.json({ success: true, data: { userId, dateKey: req.params.dateKey, activityId: req.params.activityId, alreadyIncomplete: true } });
    }

    await knex('tracker_day_activities').where({ id: existing.id }).del();
    res.json({ success: true, data: { userId, dateKey: req.params.dateKey, activityId: req.params.activityId, completed: false } });
  }),
);

// ---------- workout exercises ----------
app.get(
  '/api/exercises',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    const exercises = await knex('exercises')
      .where({ is_active: 1 })
      .andWhere(function () {
        this.whereNull('user_id').orWhere('user_id', userId);
      })
      .orderBy('sort_order')
      .orderBy('name');
    res.json({ success: true, data: { exercises: exercises.map(mapExercise) } });
  }),
);

app.post(
  '/api/exercises',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    const { id, name, videoUrl, targetMuscles, instructions, sortOrder = 0 } = req.body || {};

    const profileUser = await getProfileUserById(userId);
    if (!profileUser) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedName) {
      return res.status(400).json({ success: false, message: 'Exercise name is required.' });
    }

    const embedUrl = toEmbedVideoUrl(videoUrl);
    if (!embedUrl) {
      return res.status(400).json({ success: false, message: 'A valid YouTube video URL is required.' });
    }

    const duplicate = await knex('exercises')
      .where({ is_active: 1 })
      .andWhere(function () {
        this.whereNull('user_id').orWhere('user_id', userId);
      })
      .andWhereRaw('LOWER(name) = ?', [trimmedName.toLowerCase()])
      .first();

    if (duplicate) {
      return res.status(409).json({ success: false, message: 'An exercise with this name already exists.' });
    }

    const exerciseId = id || `exercise-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    await knex('exercises').insert({
      id: exerciseId,
      user_id: userId,
      name: trimmedName,
      video_url: embedUrl,
      target_muscles: JSON.stringify(Array.isArray(targetMuscles) ? targetMuscles : []),
      instructions: typeof instructions === 'string' ? instructions.trim() : '',
      sort_order: sortOrder,
      is_active: 1,
    });

    res.status(201).json({ success: true, data: mapExercise(await knex('exercises').where({ id: exerciseId }).first()) });
  }),
);

app.patch(
  '/api/exercises/:exerciseId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const existing = await knex('exercises').where({ id: req.params.exerciseId }).first();
    if (!existing) return res.status(404).json({ success: false, message: 'Exercise not found.' });

    let videoUrl = existing.video_url;
    if (req.body.videoUrl !== undefined) {
      videoUrl = toEmbedVideoUrl(req.body.videoUrl);
      if (!videoUrl) {
        return res.status(400).json({ success: false, message: 'A valid YouTube video URL is required.' });
      }
    }

    await knex('exercises').where({ id: existing.id }).update({
      name: req.body.name ?? existing.name,
      video_url: videoUrl,
      target_muscles: req.body.targetMuscles !== undefined
        ? JSON.stringify(req.body.targetMuscles || [])
        : JSON.stringify(parseTargetMuscles(existing.target_muscles)),
      instructions: req.body.instructions ?? existing.instructions,
      sort_order: req.body.sortOrder ?? existing.sort_order,
      is_active: req.body.isActive === undefined ? existing.is_active : req.body.isActive ? 1 : 0,
    });

    res.json({ success: true, data: mapExercise(await knex('exercises').where({ id: existing.id }).first()) });
  }),
);

app.put(
  '/api/exercises/:exerciseId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const existing = await knex('exercises').where({ id: req.params.exerciseId }).first();
    if (!existing) return res.status(404).json({ success: false, message: 'Exercise not found.' });

    const embedUrl = toEmbedVideoUrl(req.body.videoUrl);
    if (!embedUrl) {
      return res.status(400).json({ success: false, message: 'A valid YouTube video URL is required.' });
    }

    await knex('exercises').where({ id: existing.id }).update({
      name: req.body.name ?? existing.name,
      video_url: embedUrl,
      target_muscles: req.body.targetMuscles !== undefined
        ? JSON.stringify(req.body.targetMuscles || [])
        : JSON.stringify(parseTargetMuscles(existing.target_muscles)),
      instructions: req.body.instructions ?? existing.instructions,
      sort_order: req.body.sortOrder ?? existing.sort_order,
      is_active: req.body.isActive === undefined ? existing.is_active : req.body.isActive ? 1 : 0,
    });

    res.json({ success: true, data: mapExercise(await knex('exercises').where({ id: existing.id }).first()) });
  }),
);

app.delete(
  '/api/exercises/:exerciseId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    const exercise = await knex('exercises').where({ id: req.params.exerciseId }).first();

    if (!exercise) {
      return res.status(404).json({ success: false, message: 'Exercise not found.' });
    }

    if (!exercise.user_id) {
      return res.status(403).json({ success: false, message: 'Cannot delete global exercises.' });
    }

    if (exercise.user_id !== userId) {
      return res.status(403).json({ success: false, message: 'You can only delete your own custom exercises.' });
    }

    // Remove workout sets logged for this exercise across the user's sessions
    await knex('workout_sets')
      .whereIn('session_id', knex('workout_sessions').select('id').where({ user_id: userId }))
      .andWhere({ exercise_id: exercise.id })
      .del();

    await knex('exercises').where({ id: exercise.id }).update({ is_active: 0 });
    res.json({ success: true, data: { exerciseId: exercise.id } });
  }),
);

// ---------- workout sessions & sets ----------
app.get(
  '/api/workouts',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const profileUser = await getProfileUserById(userId);
    if (!profileUser) return res.status(404).json({ success: false, message: 'Profile user not found.' });

    const dateKey = normalizeDateKey(req.query.date);
    const session = await getOrCreateSession(userId, dateKey);
    const logs = await loadSessionLogs(session);

    res.json({ success: true, data: { user: profileUser, session: await mapSession(session), logs } });
  }),
);

app.get(
  '/api/workouts/sessions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const profileUser = await getProfileUserById(userId);
    if (!profileUser) return res.status(404).json({ success: false, message: 'Profile user not found.' });

    const rows = await knex('workout_sessions').where({ user_id: userId }).orderBy('session_date', 'desc');
    const sessions = [];
    for (const row of rows) sessions.push(await mapSession(row));

    res.json({ success: true, data: { user: profileUser, sessions } });
  }),
);

app.post(
  '/api/workouts/sessions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const profileUser = await getProfileUserById(userId);
    if (!profileUser) return res.status(404).json({ success: false, message: 'Profile user not found.' });

    const dateKey = normalizeDateKey(req.body.date);
    const session = await getOrCreateSession(userId, dateKey);

    if (req.body.notes !== undefined) {
      await knex('workout_sessions').where({ id: session.id }).update({ notes: req.body.notes });
    }

    res.status(201).json({ success: true, data: { user: profileUser, session: await mapSession(session), logs: await loadSessionLogs(session) } });
  }),
);

app.get(
  '/api/workouts/sessions/:sessionId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const session = await knex('workout_sessions').where({ id: req.params.sessionId, user_id: userId }).first();
    if (!session) return res.status(404).json({ success: false, message: 'Workout session not found.' });

    res.json({ success: true, data: { session: await mapSession(session), logs: await loadSessionLogs(session) } });
  }),
);

app.patch(
  '/api/workouts/sessions/:sessionId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const session = await knex('workout_sessions').where({ id: req.params.sessionId, user_id: userId }).first();
    if (!session) return res.status(404).json({ success: false, message: 'Workout session not found.' });

    const next = {};
    if (req.body.sessionDate !== undefined) next.session_date = normalizeDateKey(req.body.sessionDate);
    if (req.body.notes !== undefined) next.notes = req.body.notes;

    if (Object.keys(next).length) {
      await knex('workout_sessions').where({ id: session.id }).update(next);
    }

    res.json({ success: true, data: { session: await mapSession(session), logs: await loadSessionLogs(session) } });
  }),
);

app.delete(
  '/api/workouts/sessions/:sessionId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const session = await knex('workout_sessions').where({ id: req.params.sessionId, user_id: userId }).first();
    if (!session) return res.status(404).json({ success: false, message: 'Workout session not found.' });

    await knex('workout_sets').where({ session_id: session.id }).del();
    await knex('workout_sessions').where({ id: session.id }).del();

    res.json({ success: true, data: { sessionId: session.id, deleted: true } });
  }),
);

// Replaces the full set list for one exercise inside a session. Mirrors how
// the frontend persists a workout log for a single exercise.
app.put(
  '/api/workouts/sessions/:sessionId/exercises/:exerciseId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const session = await knex('workout_sessions').where({ id: req.params.sessionId, user_id: userId }).first();
    if (!session) return res.status(404).json({ success: false, message: 'Workout session not found.' });

    const exercise = await knex('exercises').where({ id: req.params.exerciseId, is_active: 1 }).first();
    if (!exercise) return res.status(404).json({ success: false, message: 'Exercise not found.' });

    const now = Date.now();
    const sets = Array.isArray(req.body.sets) ? req.body.sets : [];

    const insertRows = sets.map((set, index) => ({
      session_id: session.id,
      exercise_id: exercise.id,
      set_ref: typeof set.id === 'string' && set.id ? set.id : `set-${now}-${Math.random().toString(36).slice(2, 9)}-${index}`,
      reps: Math.max(0, Math.round(Number(set.reps) || 0)),
      weight: Math.max(0, Number(set.weight) || 0),
      sort_order: index,
    }));

    // Drop duplicate set_ref values inside a single request
    const seen = new Set();
    const deduped = [];
    for (const row of insertRows) {
      if (seen.has(row.set_ref)) continue;
      seen.add(row.set_ref);
      deduped.push(row);
    }

    await knex('workout_sets').where({ session_id: session.id, exercise_id: exercise.id }).del();
    if (deduped.length) {
      await knex('workout_sets').insert(deduped);
    }

    res.json({
      success: true,
      data: {
        sessionId: session.id,
        log: {
          exerciseId: exercise.id,
          sets: deduped.map((row) => ({ id: row.set_ref, reps: row.reps, weight: Number(row.weight) })),
          updatedAt: now,
        },
      },
    });
  }),
);

app.delete(
  '/api/workouts/sessions/:sessionId/exercises/:exerciseId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const session = await knex('workout_sessions').where({ id: req.params.sessionId, user_id: userId }).first();
    if (!session) return res.status(404).json({ success: false, message: 'Workout session not found.' });

    const deleted = await knex('workout_sets').where({ session_id: session.id, exercise_id: req.params.exerciseId }).del();

    res.json({ success: true, data: { sessionId: session.id, exerciseId: req.params.exerciseId, cleared: deleted > 0 } });
  }),
);

app.delete(
  '/api/workouts/sessions/:sessionId/sets/:setRef',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const session = await knex('workout_sessions').where({ id: req.params.sessionId, user_id: userId }).first();
    if (!session) return res.status(404).json({ success: false, message: 'Workout session not found.' });

    const deleted = await knex('workout_sets').where({ session_id: session.id, set_ref: req.params.setRef }).del();

    res.json({ success: true, data: { sessionId: session.id, setRef: req.params.setRef, deleted: deleted > 0 } });
  }),
);

// ---------- food tracker ----------
const FOOD_CATEGORIES = ['breakfast', 'lunch', 'dinner', 'snack', 'other'];

async function ensureFoodTables() {
  const hasFoods = await knex.schema.hasTable('foods');
  if (!hasFoods) {
    await knex.schema.createTable('foods', (table) => {
      table.increments('id').primary();
      table.string('user_id', 64).notNullable();
      table.string('name', 191).notNullable();
      table.enu('category', FOOD_CATEGORIES).notNullable().defaultTo('other');
      table.string('quantity', 255).nullable();
      table.string('notes', 500).nullable();
      table.integer('sort_order').notNullable().defaultTo(0);
      table.boolean('is_active').notNullable().defaultTo(true);
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      table.unique(['user_id', 'name'], 'uq_foods_user_name');
      table.index(['user_id'], 'idx_foods_user_id');
      table.foreign('user_id').references('app_users.id').onDelete('CASCADE').onUpdate('CASCADE');
    });
  }

  const hasLogs = await knex.schema.hasTable('food_logs');
  if (!hasLogs) {
    await knex.schema.createTable('food_logs', (table) => {
      table.increments('id').primary();
      table.string('user_id', 64).notNullable();
      table.integer('food_id').unsigned().nullable();
      table.date('log_date').notNullable();
      table.enu('category', FOOD_CATEGORIES).notNullable().defaultTo('other');
      table.string('quantity', 255).nullable();
      table.string('notes', 500).nullable();
      table.string('food_name', 255).notNullable();
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      table.index(['user_id', 'log_date'], 'idx_food_logs_user_date');
      table.index(['food_id'], 'idx_food_logs_food_id');
      table.foreign('user_id').references('app_users.id').onDelete('CASCADE').onUpdate('CASCADE');
      table.foreign('food_id').references('foods.id').onDelete('SET NULL').onUpdate('CASCADE');
    });
  }
}

function mapFoodRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    category: row.category,
    quantity: row.quantity,
    notes: row.notes,
    sortOrder: row.sort_order,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapFoodLogRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    userId: row.user_id,
    foodId: row.food_id,
    date: normalizeDateKey(row.log_date),
    category: row.category,
    quantity: row.quantity,
    notes: row.notes,
    foodName: row.food_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeFoodCategory(value, fallback = 'other') {
  return FOOD_CATEGORIES.includes(value) ? value : fallback;
}

app.get(
  '/api/foods',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const profileUser = await getProfileUserById(userId);
    if (!profileUser) return res.status(404).json({ success: false, message: 'Profile user not found.' });

    const rows = await knex('foods').where({ user_id: userId, is_active: 1 }).orderBy('sort_order').orderBy('name');
    res.json({ success: true, data: { user: profileUser, foods: rows.map(mapFoodRow) } });
  }),
);

app.post(
  '/api/foods',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const profileUser = await getProfileUserById(userId);
    if (!profileUser) return res.status(404).json({ success: false, message: 'Profile user not found.' });

    const { name, category, quantity, notes, sortOrder = 0 } = req.body || {};
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedName) {
      return res.status(400).json({ success: false, message: 'Food name is required.' });
    }

    const normalizedCategory = normalizeFoodCategory(category);

    const duplicate = await knex('foods')
      .where({ user_id: userId, is_active: 1 })
      .andWhereRaw('LOWER(name) = ?', [trimmedName.toLowerCase()])
      .first();
    if (duplicate) {
      return res.status(409).json({ success: false, message: 'A food with this name already exists.' });
    }

    const [id] = await knex('foods').insert({
      user_id: userId,
      name: trimmedName,
      category: normalizedCategory,
      quantity: typeof quantity === 'string' ? quantity.trim() : null,
      notes: typeof notes === 'string' ? notes.trim() : null,
      sort_order: sortOrder,
      is_active: 1,
    });

    res.status(201).json({ success: true, data: mapFoodRow(await knex('foods').where({ id }).first()) });
  }),
);

app.put(
  '/api/foods/:foodId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const existing = await knex('foods').where({ id: req.params.foodId, user_id: userId }).first();
    if (!existing) return res.status(404).json({ success: false, message: 'Food not found.' });

    const trimmedName = req.body.name !== undefined ? String(req.body.name).trim() : existing.name;
    if (!trimmedName) {
      return res.status(400).json({ success: false, message: 'Food name is required.' });
    }

    if (trimmedName.toLowerCase() !== existing.name.toLowerCase()) {
      const duplicate = await knex('foods')
        .where({ user_id: userId, is_active: 1 })
        .andWhereRaw('LOWER(name) = ?', [trimmedName.toLowerCase()])
        .whereNot({ id: existing.id })
        .first();
      if (duplicate) {
        return res.status(409).json({ success: false, message: 'A food with this name already exists.' });
      }
    }

    await knex('foods').where({ id: existing.id }).update({
      name: trimmedName,
      category: req.body.category !== undefined ? normalizeFoodCategory(req.body.category) : existing.category,
      quantity: req.body.quantity !== undefined ? (typeof req.body.quantity === 'string' ? req.body.quantity.trim() : null) : existing.quantity,
      notes: req.body.notes !== undefined ? (typeof req.body.notes === 'string' ? req.body.notes.trim() : null) : existing.notes,
      sort_order: req.body.sortOrder ?? existing.sort_order,
      updated_at: knex.fn.now(),
    });

    res.json({ success: true, data: mapFoodRow(await knex('foods').where({ id: existing.id }).first()) });
  }),
);

app.delete(
  '/api/foods/:foodId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const existing = await knex('foods').where({ id: req.params.foodId, user_id: userId }).first();
    if (!existing) return res.status(404).json({ success: false, message: 'Food not found.' });

    // Soft delete so existing food logs keep a reference to the food row.
    await knex('foods').where({ id: existing.id }).update({ is_active: 0, updated_at: knex.fn.now() });
    res.json({ success: true, data: { foodId: existing.id, deleted: true } });
  }),
);

app.get(
  '/api/food-logs',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const profileUser = await getProfileUserById(userId);
    if (!profileUser) return res.status(404).json({ success: false, message: 'Profile user not found.' });

    const query = knex('food_logs').where({ user_id: userId });
    if (req.query.date) {
      query.andWhere({ log_date: normalizeDateKey(req.query.date) });
    }
    const rows = await query.orderBy('log_date', 'desc').orderBy('updated_at', 'desc');

    res.json({ success: true, data: { user: profileUser, foodLogs: rows.map(mapFoodLogRow) } });
  }),
);

app.post(
  '/api/food-logs',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const profileUser = await getProfileUserById(userId);
    if (!profileUser) return res.status(404).json({ success: false, message: 'Profile user not found.' });

    const { foodId, date, category, quantity, notes } = req.body || {};
    if (!foodId) {
      return res.status(400).json({ success: false, message: 'foodId is required.' });
    }
    const logDate = normalizeDateKey(date);
    if (!logDate) {
      return res.status(400).json({ success: false, message: 'A valid date is required.' });
    }

    const food = await knex('foods').where({ id: foodId, user_id: userId, is_active: 1 }).first();
    if (!food) return res.status(404).json({ success: false, message: 'Food not found.' });

    const normalizedCategory = normalizeFoodCategory(category, food.category);

    const [id] = await knex('food_logs').insert({
      user_id: userId,
      food_id: food.id,
      log_date: logDate,
      category: normalizedCategory,
      quantity: typeof quantity === 'string' ? quantity.trim() : (food.quantity ?? null),
      notes: typeof notes === 'string' ? notes.trim() : null,
      food_name: food.name,
    });

    res.status(201).json({ success: true, data: mapFoodLogRow(await knex('food_logs').where({ id }).first()) });
  }),
);

app.put(
  '/api/food-logs/:logId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const existing = await knex('food_logs').where({ id: req.params.logId, user_id: userId }).first();
    if (!existing) return res.status(404).json({ success: false, message: 'Food log not found.' });

    let food = null;
    let foodId = existing.food_id;
    if (req.body.foodId !== undefined) {
      if (!req.body.foodId) {
        return res.status(400).json({ success: false, message: 'foodId is required.' });
      }
      food = await knex('foods').where({ id: req.body.foodId, user_id: userId, is_active: 1 }).first();
      if (!food) return res.status(404).json({ success: false, message: 'Food not found.' });
      foodId = food.id;
    }

    await knex('food_logs').where({ id: existing.id }).update({
      food_id: foodId,
      food_name: food ? food.name : existing.food_name,
      log_date: req.body.date !== undefined ? normalizeDateKey(req.body.date) : existing.log_date,
      category: req.body.category !== undefined ? normalizeFoodCategory(req.body.category) : existing.category,
      quantity: req.body.quantity !== undefined ? (typeof req.body.quantity === 'string' ? req.body.quantity.trim() : null) : existing.quantity,
      notes: req.body.notes !== undefined ? (typeof req.body.notes === 'string' ? req.body.notes.trim() : null) : existing.notes,
      updated_at: knex.fn.now(),
    });

    res.json({ success: true, data: mapFoodLogRow(await knex('food_logs').where({ id: existing.id }).first()) });
  }),
);

app.delete(
  '/api/food-logs/:logId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = getEffectiveUserId(req);
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Missing userId' });
    }
    const existing = await knex('food_logs').where({ id: req.params.logId, user_id: userId }).first();
    if (!existing) return res.status(404).json({ success: false, message: 'Food log not found.' });

    await knex('food_logs').where({ id: existing.id }).del();
    res.json({ success: true, data: { foodLogId: existing.id, deleted: true } });
  }),
);

// ---------- root ----------
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'API is running'
  });
});

// ---------- error handling ----------
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
});

app.use((err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({ success: false, message: err.message || 'Internal server error.' });
});

async function startServer() {
  await ensureWeightLogsTable();
  await ensureWeightLogsBodyFatColumn();
  await ensureActivitiesUserIdColumn();
  await ensureWorkoutTables();
  await seedGlobalExercises();
  await ensureFoodTables();

  app.listen(PORT, () => {
    console.log(`G Fitness API running on port ${PORT} | API key header: x-api-key`);
  });
}

startServer().catch((error) => {
  console.error('Failed to start G Fitness API:', error);
  process.exitCode = 1;
});

module.exports = { app, knex };
