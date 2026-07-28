-- G Fitness API schema
-- MySQL / mysql2 compatible
-- Ordered to satisfy foreign key dependencies

-- ---------- app_users ----------
-- used by: /api/users*, session.activeProfileUserId, tracker/weight/settings/notifications everywhere
CREATE TABLE app_users (
  id          VARCHAR(64) PRIMARY KEY,
  name        VARCHAR(120) NOT NULL,
  accent      VARCHAR(32)  NOT NULL,
  ring        VARCHAR(32)  NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ---------- auth_users ----------
-- used by: POST /api/auth/login, GET /api/auth/me
CREATE TABLE auth_users (
  id                       INT AUTO_INCREMENT PRIMARY KEY,
  username                 VARCHAR(120) NOT NULL UNIQUE,
  password                 VARCHAR(255) NOT NULL,
  default_profile_user_id  VARCHAR(64) NULL,
  is_active                TINYINT(1) NOT NULL DEFAULT 1,
  created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_auth_users_profile
    FOREIGN KEY (default_profile_user_id) REFERENCES app_users(id)
    ON DELETE SET NULL ON UPDATE CASCADE
);

-- ---------- activity_groups ----------
-- used by: /api/activity-groups*
CREATE TABLE activity_groups (
  id           VARCHAR(64) PRIMARY KEY,
  name         VARCHAR(120) NOT NULL,
  description  VARCHAR(255) NOT NULL,
  category     VARCHAR(64) NOT NULL,
  sort_order   INT NOT NULL DEFAULT 0,
  is_active    TINYINT(1) NOT NULL DEFAULT 1,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ---------- activities ----------
-- used by: /api/activities*, createWeekSummary (category = 'workout' | 'habit')
CREATE TABLE activities (
  id                  VARCHAR(64) PRIMARY KEY,
  group_id            VARCHAR(64) NOT NULL,
  label               VARCHAR(120) NOT NULL,
  category            VARCHAR(64) NOT NULL,
  sort_order          INT NOT NULL DEFAULT 0,
  counts_toward_goal  TINYINT(1) NOT NULL DEFAULT 0,
  is_healthy_habit    TINYINT(1) NOT NULL DEFAULT 0,
  is_active           TINYINT(1) NOT NULL DEFAULT 1,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_activities_group
    FOREIGN KEY (group_id) REFERENCES activity_groups(id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- ---------- tracker_weeks ----------
-- used by: ensureCurrentWeek, getOrCreateWeekForDate, loadWeekWithDays, assembleTrackerState
CREATE TABLE tracker_weeks (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  user_id      VARCHAR(64) NOT NULL,
  week_start   DATE NOT NULL,
  week_end     DATE NOT NULL,
  status       ENUM('current', 'archived') NOT NULL DEFAULT 'current',
  archived_at  DATETIME NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tracker_weeks_user_week (user_id, week_start),
  KEY idx_tracker_weeks_user_status (user_id, status, updated_at),
  CONSTRAINT fk_tracker_weeks_user
    FOREIGN KEY (user_id) REFERENCES app_users(id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- ---------- tracker_days ----------
-- used by: getOrCreateDay, loadWeekWithDays
CREATE TABLE tracker_days (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  week_id     INT NOT NULL,
  date_key    DATE NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tracker_days_week_date (week_id, date_key),
  CONSTRAINT fk_tracker_days_week
    FOREIGN KEY (week_id) REFERENCES tracker_weeks(id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- ---------- tracker_day_activities ----------
-- used by: toggleActivityForDay, setDayActivities, loadWeekWithDays
CREATE TABLE tracker_day_activities (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  day_id       INT NOT NULL,
  activity_id  VARCHAR(64) NOT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_day_activities_day_activity (day_id, activity_id),
  CONSTRAINT fk_day_activities_day
    FOREIGN KEY (day_id) REFERENCES tracker_days(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_day_activities_activity
    FOREIGN KEY (activity_id) REFERENCES activities(id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- ---------- user_settings ----------
-- used by: /api/settings (GET/PUT/PATCH), upsertUserSettings
CREATE TABLE user_settings (
  user_id                  VARCHAR(64) PRIMARY KEY,
  weekly_workout_goal      INT NOT NULL DEFAULT 4,
  reminders_enabled        TINYINT(1) NOT NULL DEFAULT 1,
  notification_permission  VARCHAR(32) NOT NULL DEFAULT 'default',
  active_theme             VARCHAR(32) NOT NULL DEFAULT 'light',
  created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_settings_user
    FOREIGN KEY (user_id) REFERENCES app_users(id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- ---------- weight_logs ----------
-- matches ensureWeightLogsTable() exactly, used by /api/weight*
CREATE TABLE weight_logs (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       VARCHAR(64) NOT NULL,
  week_start    DATE NOT NULL,
  weight_value  DECIMAL(6, 2) NOT NULL,
  unit          ENUM('kg', 'lb') NOT NULL DEFAULT 'kg',
  notes         VARCHAR(255) NULL,
  measured_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_weight_logs_user_week (user_id, week_start),
  KEY idx_weight_logs_user_week (user_id, week_start),
  CONSTRAINT fk_weight_logs_user
    FOREIGN KEY (user_id) REFERENCES app_users(id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- ---------- notifications ----------
-- used by: /api/notifications*, /api/dashboard
CREATE TABLE notifications (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     VARCHAR(64) NOT NULL,
  type        VARCHAR(32) NOT NULL,
  title       VARCHAR(120) NOT NULL,
  body        TEXT NOT NULL,
  metadata    JSON NULL,
  read_at     DATETIME NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_notifications_user_created (user_id, created_at),
  CONSTRAINT fk_notifications_user
    FOREIGN KEY (user_id) REFERENCES app_users(id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- ---------- reminder_logs ----------
-- used by: /api/reminders*, reminders/evaluate
CREATE TABLE reminder_logs (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       VARCHAR(64) NOT NULL,
  reminder_key  VARCHAR(64) NOT NULL,
  message       TEXT NOT NULL,
  sent_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_reminder_logs_user_key (user_id, reminder_key),
  KEY idx_reminder_logs_user_sent (user_id, sent_at),
  CONSTRAINT fk_reminder_logs_user
    FOREIGN KEY (user_id) REFERENCES app_users(id)
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- ---------- seed data: two profile users + two login accounts ----------
-- Each app_users row is a "profile" (name/accent/ring shown in the UI).
-- Each auth_users row is a login (username/password) tied to one default profile.
-- POST /api/auth/login checks auth_users.username + auth_users.password (plaintext, matches current code).

INSERT INTO app_users (id, name, accent, ring, sort_order, is_active) VALUES
  ('user_guus',  'Guus',  '#ff6b6b', '#ff6b6b', 0, 1),
  ('user_ladyv', 'LadyV', '#4dabf7', '#4dabf7', 1, 1);
 
INSERT INTO auth_users (username, password, default_profile_user_id, is_active) VALUES
  ('guus',  'passwordfitness@123', 'user_guus', 1),
  ('ladyv', 'passwordfitness@123', 'user_ladyv', 1);


UPDATE activities SET id='incline-1h' WHERE id='incline_walk_1h';

UPDATE activities SET id='incline-90m' WHERE id='incline_walk_15h';

UPDATE activities SET id='after-dinner-walk' WHERE id='walk_after_dinner';

UPDATE activities SET id='walk-5km' WHERE id='walk_5km';

UPDATE activities SET id='walk-7km' WHERE id='walk_7km';

UPDATE activities SET id='walk-10km' WHERE id='walk_10km';

UPDATE activities SET id='squats-100' WHERE id='daily_squats';

UPDATE activities SET id='chia-protein-shake' WHERE id='chia_protein';

UPDATE activities SET id='sauna-session' WHERE id='sauna_session';


INSERT INTO activities
(id, label, category, counts_toward_goal, is_healthy_habit, sort_order)
VALUES

('incline-1h', '1-hour incline walk', 'workout', 1, 0, 1),

('incline-90m', '1.5-hour incline walk', 'workout', 1, 0, 2),

('after-dinner-walk', '20-minute walk after dinner', 'neutral', 0, 0, 3),

('walk-5km', '5 km walk', 'workout', 1, 0, 4),

('walk-7km', '7 km walk', 'workout', 1, 0, 5),

('walk-10km', '10 km walk', 'workout', 1, 0, 6),

('squats-100', '100 daily squats', 'habit', 0, 1, 7),

('lemon-water', 'Drink lemon water in the morning', 'habit', 0, 1, 8),

('chia-protein-shake', 'Add chia seeds to a protein shake', 'habit', 0, 1, 9),

('fitness-workout', 'Fitness workout', 'workout', 1, 0, 10),

('hiit-workout', 'HIIT workout', 'workout', 1, 0, 11),

('sauna-session', 'Sauna session', 'habit', 0, 1, 12);

UPDATE activities
SET id='fitness-workout'
WHERE id='fitness_workout';

UPDATE activities
SET id='hiit-workout'
WHERE id='hiit_workout';

UPDATE activities
SET id='lemon-water'
WHERE id='lemon_water';

UPDATE activities
SET id='fitness-workout'
WHERE id='fitness_workout';

UPDATE activities
SET id='hiit-workout'
WHERE id='hiit_workout';

UPDATE activities
SET id='lemon-water'
WHERE id='lemon_water';