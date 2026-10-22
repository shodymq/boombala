export function findFreePort(): Promise<number>;
export function initCluster(dir: string): void;
export function startCluster(dir: string, port: number, opts?: { fast?: boolean }): string;
export function stopCluster(dir: string, socketDir?: string): void;
export function isRunning(dir: string): boolean;
