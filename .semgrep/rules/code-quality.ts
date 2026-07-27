// fallow-ignore-file unused-file
// Exercises deterministic TypeScript simplifications enforced by the local Semgrep rules.

declare function buildCourse(): { id: string };
declare function recordCourse(course: { id: string }): void;

function booleanBranch(condition: unknown) {
  // ruleid: ts-simplify-boolean-return
  if (condition) {
    return true;
  } else {
    return false;
  }
}

function inverseBooleanBranch(condition: unknown) {
  // ruleid: ts-simplify-boolean-return
  if (condition) {
    return false;
  } else {
    return true;
  }
}

function branchWithWork(condition: unknown) {
  // ok: ts-simplify-boolean-return
  if (condition) {
    recordCourse(buildCourse());
    return true;
  } else {
    return false;
  }
}

function meaningfulTernary(condition: unknown) {
  return condition ? 'ready' : 'pending';
}

export { booleanBranch, branchWithWork, inverseBooleanBranch, meaningfulTernary };
