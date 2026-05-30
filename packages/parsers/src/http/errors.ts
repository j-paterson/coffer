export interface ParserHttpErrorInfo {
  url: string;
  method: string;
  attempts: number;
}

export abstract class ParserHttpError extends Error {
  abstract readonly kind: "status" | "network";
  readonly url: string;
  readonly method: string;
  readonly attempts: number;
  constructor(message: string, info: ParserHttpErrorInfo) {
    super(message);
    this.name = this.constructor.name;
    this.url = info.url;
    this.method = info.method;
    this.attempts = info.attempts;
  }
}

export interface HttpStatusErrorInfo extends ParserHttpErrorInfo {
  status: number;
  bodyExcerpt: string;
}

export class HttpStatusError extends ParserHttpError {
  readonly kind = "status" as const;
  readonly status: number;
  readonly bodyExcerpt: string;
  constructor(message: string, info: HttpStatusErrorInfo) {
    super(message, info);
    this.status = info.status;
    this.bodyExcerpt = info.bodyExcerpt;
  }
}

export interface HttpNetworkErrorInfo extends ParserHttpErrorInfo {
  cause: unknown;
}

export class HttpNetworkError extends ParserHttpError {
  readonly kind = "network" as const;
  readonly cause: unknown;
  constructor(message: string, info: HttpNetworkErrorInfo) {
    super(message, info);
    this.cause = info.cause;
  }
}
