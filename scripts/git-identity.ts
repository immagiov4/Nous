/** Commit and working-tree state of the checkout that produced a run. */
export const readGitIdentity = (cwd: string): { commitSha: string; dirty: boolean } => {
  const git = (args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd, windowsHide: true });
    if (!result.success) throw new Error(`git ${args[0]} failed.`);
    return result.stdout.toString().trim();
  };
  return { commitSha: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain']) !== '' };
};
