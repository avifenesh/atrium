/**
 * In-process revuto scheduler: runs the review/learn/decay cron loops inside
 * the Atrium server using the vendored engine's startDaemon. Replaces the
 * standalone Revuto daemon — revuto is now one process with Atrium.
 */
import { loadConfig } from '@atrium/revuto-engine/config';
import { listReviewers } from '@atrium/revuto-engine/reviewers';
import { startDaemon, planSchedule } from '@atrium/revuto-engine/scheduler';

interface CronTask { stop?: () => void; destroy?: () => void; }
type RevutoSchedulePlan = { repo: string; schedules: { review: string; learn: string; decay: string } };
interface RevutoSchedulerStatus {
  active: boolean;
  tasks: number;
  repos: number;
  plan: RevutoSchedulePlan[];
}

let started = false;
let tasks: CronTask[] = [];
let repos = 0;
let plan: RevutoSchedulePlan[] = [];

function stopTasks(): void {
  for (const t of tasks) {
    try { t.stop?.(); } catch { /* ignore */ }
    try { t.destroy?.(); } catch { /* ignore */ }
  }
  tasks = [];
}

function status(): RevutoSchedulerStatus {
  return { active: started, tasks: tasks.length, repos, plan };
}

/** (Re)build the cron tasks from the current reviewer set. Safe to call anytime;
 * stops the previous tasks first so a pause/resume/schedule edit takes effect
 * immediately without restarting Atrium or any external daemon. */
export function reloadRevutoScheduler(): RevutoSchedulerStatus {
  stopTasks();
  const config = loadConfig();
  const reviewers = listReviewers(config);
  repos = reviewers.length;
  plan = planSchedule(config, reviewers) as RevutoSchedulePlan[];
  tasks = (startDaemon(config) as unknown as CronTask[]) ?? [];
  started = true;
  console.log(`[revuto] in-process scheduler reloaded: ${reviewers.length} reviewer(s), ${tasks.length} cron task(s)`);
  return status();
}

/** Idempotent boot entry: start once per process. */
export function startRevutoScheduler(): RevutoSchedulerStatus {
  if (started) return status();
  return reloadRevutoScheduler();
}

/** Stop all cron tasks (whole-agent pause). `started` stays true so status still
 * reports the scheduler exists; reload/start rebuilds the tasks. */
export function stopRevutoScheduler(): RevutoSchedulerStatus {
  stopTasks();
  console.log('[revuto] in-process scheduler stopped (0 cron tasks)');
  return status();
}

export function revutoSchedulerStatus(): RevutoSchedulerStatus {
  return status();
}
