-- Migration 0020: Persist chat message history per generation session
--
-- Adds chat_messages JSONB to generation_sessions so the full UI chat
-- history survives page reloads and can be restored when a merchant
-- navigates back to an app they previously worked on.
--
-- Shape: JSON array of ChatMessage objects with the `actions` field
-- omitted (onClick closures are non-serializable and re-bound on mount).
-- All other fields (id, role, text, type, deployBundle, liveAppId,
-- clarifyingData) are stored as-is.
--
-- Written by: the platform API via PATCH /generation/:jobId/chat,
-- called from the frontend after a debounced 1.5 s delay whenever messages change.

ALTER TABLE generation_sessions
  ADD COLUMN IF NOT EXISTS chat_messages JSONB;

COMMENT ON COLUMN generation_sessions.chat_messages IS
  'Serialized frontend chat history for this generation session. '
  'Array of ChatMessage objects; actions (onClick closures) are stripped before storage. '
  'Written by PATCH /generation/:jobId/chat. Used to restore full chat history '
  'when a merchant navigates back to the generation page after a page reload.';
