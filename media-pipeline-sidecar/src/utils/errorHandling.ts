export interface MediaPipelineErrorOptions {
  code: string;
  message: string;
  retryable?: boolean;
  statusCode?: number;
  cause?: unknown;
}

export class MediaPipelineError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly statusCode?: number;
  public override readonly cause?: unknown;

  public constructor(options: MediaPipelineErrorOptions) {
    super(options.message);
    this.name = 'MediaPipelineError';
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.statusCode = options.statusCode;
    this.cause = options.cause;
  }
}

export class RetryableMediaPipelineError extends MediaPipelineError {
  public constructor(options: Omit<MediaPipelineErrorOptions, 'retryable'>) {
    super({ ...options, retryable: true });
    this.name = 'RetryableMediaPipelineError';
  }
}

export class NonRetryableMediaPipelineError extends MediaPipelineError {
  public constructor(options: Omit<MediaPipelineErrorOptions, 'retryable'>) {
    super({ ...options, retryable: false });
    this.name = 'NonRetryableMediaPipelineError';
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof MediaPipelineError) {
    return error.retryable;
  }

  return false;
}

export function isLikelyTransientError(error: unknown): boolean {
  if (error instanceof MediaPipelineError) {
    return error.retryable;
  }

  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as {
    code?: unknown;
    name?: unknown;
    message?: unknown;
    $retryable?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };

  if (candidate.$retryable === true) {
    return true;
  }

  const statusCode = typeof candidate.$metadata?.httpStatusCode === 'number'
    ? candidate.$metadata.httpStatusCode
    : undefined;
  if (statusCode === 408 || statusCode === 425 || statusCode === 429 || (statusCode !== undefined && statusCode >= 500)) {
    return true;
  }

  const code = typeof candidate.code === 'string' ? candidate.code.toUpperCase() : '';
  if ([
    'ECONNRESET',
    'ECONNREFUSED',
    'EPIPE',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'ECONNABORTED',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET'
  ].includes(code)) {
    return true;
  }

  const name = typeof candidate.name === 'string' ? candidate.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    return true;
  }

  const message = typeof candidate.message === 'string' ? candidate.message.toLowerCase() : '';
  return message.includes('timed out') || message.includes('timeout');
}

export function errorCode(error: unknown): string {
  if (error instanceof MediaPipelineError) {
    return error.code;
  }

  return 'MEDIA_PIPELINE_UNEXPECTED';
}

export function errorStatusCode(error: unknown): number | undefined {
  if (error instanceof MediaPipelineError) {
    return error.statusCode;
  }

  return undefined;
}
