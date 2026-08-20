ALTER TABLE `consultation_runs`
  ADD COLUMN `capability` VARCHAR(32) NOT NULL DEFAULT 'general',
  ADD COLUMN `dsh_session_id` VARCHAR(128) NULL,
  ADD COLUMN `research_trace` JSON NULL;

CREATE INDEX `consultation_runs_project_id_capability_completed_at_idx`
  ON `consultation_runs`(`project_id`, `capability`, `completed_at`);
