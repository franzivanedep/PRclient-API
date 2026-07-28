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
const PORT = Number(process.env.PORT || 4000);

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
async function getActivitiesById() {
  const rows = await knex('activities').where({ is_active: 1 });
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

async function createWeekSummary(week) {
  const activitiesById = await getActivitiesById();
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

function mapWeightRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    userId: row.user_id,
    weekStart: row.week_start,
    weightValue: Number(row.weight_value),
    unit: row.unit,
    notes: row.notes,
    measuredAt: row.measured_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
  const measuredAt = weightInput.measuredAt ? new Date(weightInput.measuredAt) : knex.fn.now();

  if (!Number.isFinite(weightValue) || weightValue <= 0) {
    throw Object.assign(new Error('weightValue is required and must be a positive number.'), { statusCode: 400 });
  }

  await knex('weight_logs')
    .insert({
      user_id: userId,
      week_start: weekStart,
      weight_value: weightValue,
      unit,
      notes,
      measured_at: measuredAt,
      created_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    })
    .onConflict(['user_id', 'week_start'])
    .merge({
      weight_value: weightValue,
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

  return {
    currentWeekStart,
    currentWeight: current ? Number(current.weight_value) : null,
    previousWeight: previous ? Number(previous.weight_value) : null,
    delta,
    percentChange,
    trend: delta === null ? 'unknown' : delta === 0 ? 'flat' : delta < 0 ? 'down' : 'up',
    unit: current?.unit || previous?.unit || 'kg',
    entries: rows.map(mapWeightRow),
  };
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
    const activities = await knex('activities').where({ is_active: 1 }).orderBy('sort_order');
    res.json({ success: true, data: { activities } });
  }),
);

app.post(
  '/api/activities',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { id, groupId, label, category, sortOrder = 0, countsTowardGoal = false, isHealthyHabit = false, isActive = true } = req.body || {};
    if (!id || !groupId || !label || !category) return res.status(400).json({ success: false, message: 'id, groupId, label, and category are required.' });

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
    const summary = await createWeekSummary(currentWeek);

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
    const activeSummary = await createWeekSummary(activeUser.currentWeek);
    const activityGroups = await knex('activity_groups').where({ is_active: 1 }).orderBy('sort_order');
    const activities = await knex('activities').where({ is_active: 1 }).orderBy('sort_order');
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
    const summary = await createWeekSummary(currentWeek);
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

    if (!Number.isFinite(Number(nextWeightValue)) || Number(nextWeightValue) <= 0) {
      return res.status(400).json({ success: false, message: 'weightValue must be a positive number.' });
    }

    await knex('weight_logs').where({ id: existing.id }).update({
      weight_value: Number(nextWeightValue),
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
    const summary = await createWeekSummary(currentWeek);
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

  app.listen(PORT, () => {
    console.log(`G Fitness API running on port ${PORT} | API key header: x-api-key`);
  });
}

startServer().catch((error) => {
  console.error('Failed to start G Fitness API:', error);
  process.exitCode = 1;
});

module.exports = { app, knex };