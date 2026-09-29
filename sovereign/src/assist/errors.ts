export class AssistError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 403 | 404 | 409 | 413 | 422) {
    super(message); this.name = "AssistError";
  }
}
