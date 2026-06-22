export interface Logger {
  debug(msg: string, meta?: object): void;
  info(msg: string, meta?: object): void;
  warn(msg: string, meta?: object): void;
  error(msg: string, meta?: object): void;
}

export type ConsoleSink = Pick<Console, "debug" | "info" | "warn" | "error">;

export class ConsoleLogger implements Logger {
  constructor(private readonly sink: ConsoleSink = console) {}
  debug(msg: string, meta?: object): void {
    if (meta !== undefined) this.sink.debug(msg, meta);
    else this.sink.debug(msg);
  }
  info(msg: string, meta?: object): void {
    if (meta !== undefined) this.sink.info(msg, meta);
    else this.sink.info(msg);
  }
  warn(msg: string, meta?: object): void {
    if (meta !== undefined) this.sink.warn(msg, meta);
    else this.sink.warn(msg);
  }
  error(msg: string, meta?: object): void {
    if (meta !== undefined) this.sink.error(msg, meta);
    else this.sink.error(msg);
  }
}
