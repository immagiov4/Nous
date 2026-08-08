type ShutdownAction = () => void | Promise<void>;

interface BackendShutdownResources {
  closeCodex: ShutdownAction;
  closeHttpServer: ShutdownAction;
  closeWorkflow: ShutdownAction;
  stopFeedback: ShutdownAction;
}

export const closeBackendResources = async ({
  closeCodex,
  closeHttpServer,
  closeWorkflow,
  stopFeedback,
}: BackendShutdownResources): Promise<void> => {
  const failures: unknown[] = [];
  const attempt = async (action: ShutdownAction): Promise<void> => {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  };

  await attempt(stopFeedback);
  await attempt(closeCodex);
  await attempt(closeWorkflow);
  await attempt(closeHttpServer);

  if (failures.length > 0) {
    throw new AggregateError(failures, 'Backend shutdown did not close every resource cleanly.');
  }
};
