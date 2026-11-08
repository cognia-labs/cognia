-- ADR-0177 batch 5 / ADR-0252 §6: a shared room's own settings, held where
-- every member reads them. `mention_only` is what a room did before it had a
-- setting: the assistant answered only when somebody asked it to.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS reply_mode TEXT NOT NULL DEFAULT 'mention_only' CHECK (reply_mode IN ('auto','mention_only','asleep'));
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS room_instructions TEXT NOT NULL DEFAULT '' CHECK (char_length(room_instructions) <= 4000);
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS room_settings_revision BIGINT NOT NULL DEFAULT 0;
