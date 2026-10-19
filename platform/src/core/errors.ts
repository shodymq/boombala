/** Domain errors. The UI/API layer maps them to responses; no stack or SQL ever reaches a client. */
export class ForbiddenError extends Error {
  constructor(message = "forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class ValidationError extends Error {
  readonly fields: Record<string, string>;
  constructor(fields: Record<string, string>) {
    super("validation");
    this.name = "ValidationError";
    this.fields = fields;
  }
}

export class ConflictError extends Error {
  constructor(message = "conflict") {
    super(message);
    this.name = "ConflictError";
  }
}
