/** Store the HTTP status and stable code for an application error. */
export class HubError extends Error {
  /** Initialize an application error's status, code, and message. */
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HubError";
  }
}
