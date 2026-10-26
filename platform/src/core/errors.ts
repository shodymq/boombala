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

/** A required server secret for intake is missing or too weak: the request is refused, nothing is stored. */
export class IntakeMisconfiguredError extends Error {
  constructor(message = "intake_misconfigured") {
    super(message);
    this.name = "IntakeMisconfiguredError";
  }
}

/** The documents a visitor must accept are not published yet, so no personal data may be collected. */
export class ConsentUnavailableError extends Error {
  constructor() {
    super("consent_unavailable");
    this.name = "ConsentUnavailableError";
  }
}

export class NotFoundError extends Error {
  constructor(message = "not_found") {
    super(message);
    this.name = "NotFoundError";
  }
}

/** Automatic processing was requested but is switched off (or not legally confirmed). Nothing was changed. */
export class RetentionDisabledError extends Error {
  constructor() {
    super("retention_disabled");
    this.name = "RetentionDisabledError";
  }
}

/** The visitor consented to editions of the documents that are no longer the published ones: nothing is recorded. */
export class DocumentsChangedError extends Error {
  constructor() {
    super("documents_changed");
    this.name = "DocumentsChangedError";
  }
}
