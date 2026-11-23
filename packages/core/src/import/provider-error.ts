export class ImportProviderError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_URL'
      | 'INVALID_CREDENTIAL'
      | 'AUTH_REQUIRED'
      | 'FORBIDDEN'
      | 'NOT_FOUND'
      | 'RATE_LIMITED'
      | 'UNAVAILABLE'
      | 'INVALID_RESPONSE',
    message: string,
  ) {
    super(message)
    this.name = 'ImportProviderError'
  }
}
