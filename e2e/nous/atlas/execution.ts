/** The supervisor clock and owned-process termination stay outside untrusted page scripts. */
export async function boundedRender<T>(
  operation: () => Promise<T>,
  options: { milliseconds: number; terminate: () => Promise<void> }
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let termination: Promise<void> | undefined;
  const expired = new Error(`Renderer exceeded ${options.milliseconds} ms and was terminated.`);
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      termination = options.terminate();
      void termination.then(() => reject(expired), reject);
    }, options.milliseconds);
  });
  const outcome = await Promise.race([Promise.resolve().then(operation), deadline]).then(
    value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error })
  );
  clearTimeout(timer);
  if (termination) {
    await termination;
    // Closing a renderer can settle its pending call before kill() finishes.
    throw expired;
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
