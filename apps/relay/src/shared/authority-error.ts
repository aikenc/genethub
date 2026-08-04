/** A Control response which cannot become valid through transport retry. */
export class AuthorityHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AuthorityHttpError";
  }
}

export function isDefinitiveAuthorityError(error: unknown): boolean {
  return (
    error instanceof AuthorityHttpError &&
    (error.status === 401 ||
      error.status === 403 ||
      error.status === 404 ||
      error.status === 409)
  );
}
