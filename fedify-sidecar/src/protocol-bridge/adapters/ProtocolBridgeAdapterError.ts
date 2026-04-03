export class ProtocolBridgeAdapterError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly transient = false,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProtocolBridgeAdapterError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
