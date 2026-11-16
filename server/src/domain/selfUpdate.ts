/** Exit code that tells docker/supervise.sh "I'm idle: swap in the staged release". */
export const EXIT_UPDATE = 75;

/**
 * Should the server hand over to a staged release now? Only when one is staged,
 * it isn't the commit already running, and nobody is watching anything.
 */
export function shouldHandOver(f: { running: string | null; staged: string | null; playing: boolean }): boolean {
  if (!f.staged || f.staged === f.running) return false;
  return !f.playing;
}
