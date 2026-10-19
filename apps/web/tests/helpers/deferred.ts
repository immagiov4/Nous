/** A test-controlled completion point using the project's ES2022 promise API. */
export const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => {
    resolve = complete;
  });
  return { promise, resolve };
};
