declare module '@atrium/revuto-engine/config' {
  export function loadConfig(): any;
}
declare module '@atrium/revuto-engine/jobs' {
  export function reviewRepo(config: any, settings: any, opts?: { force?: boolean }): Promise<any>;
  export function learnRepo(config: any, settings: any): Promise<any>;
  export function learnOnce(config: any, settings: any): Promise<any>;
  export function decayRepo(config: any, repo: string): Promise<any>;
  export function reviewOnePr(config: any, repo: string, pr: number): Promise<any>;
}
declare module '@atrium/revuto-engine/reviewers' {
  export function listReviewers(config: any): any[];
  export function readReviewer(config: any, repo: string): any | null;
  export function writeReviewer(config: any, settings: any): void;
  export function removeReviewer(config: any, repo: string, opts?: { purge?: boolean }): boolean;
  export function setPaused(config: any, repo: string, paused: boolean): boolean;
  export function setSchedule(config: any, repo: string, job: string, expr: string | null): boolean;
  export function effectiveSchedules(config: any, settings: any): { review: string; learn: string; decay: string };
  export function updateIndex(config: any): void;
}
declare module '@atrium/revuto-engine/scheduler' {
  export function planSchedule(config: any, reviewers: any[]): any[];
  export function runQueuedForRepo(config: any, repo: string, fn: () => Promise<any>): Promise<any>;
  export function startDaemon(config: any): void;
}
declare module '@atrium/revuto-engine/doctor' {
  export function runDoctor(config: any): Promise<any>;
  export function doctorOk(report: any): boolean;
  export function runModelProbes(...args: any[]): Promise<any>;
}
declare module '@atrium/revuto-engine/init' {
  export function runInit(opts: any): Promise<any>;
}
