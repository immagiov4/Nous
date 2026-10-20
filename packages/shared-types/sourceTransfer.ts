/** One effective proxy model, shared by the HTTP adapter and #26's real loopback proxy. */
export interface SourceTransferLimitModel {
  maxRequestBytes: number;
  maxPartBytes: number;
  firstByteTimeoutMs: number;
  originWriteTimeoutMs: number;
  requestTimeoutMs: number;
}

export const SOURCE_TRANSFER_LIMITS: Readonly<SourceTransferLimitModel> = {
  maxRequestBytes: 100_000_000,
  maxPartBytes: 16_000_000,
  firstByteTimeoutMs: 100_000,
  originWriteTimeoutMs: 30_000,
  requestTimeoutMs: 90_000,
};
