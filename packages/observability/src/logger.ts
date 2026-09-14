import pino, { type DestinationStream, type Logger } from 'pino';
import { currentTrace } from '@knowledge/observability/trace';

/** Which process emitted the record. Every entrypoint sets one. */
export type ServiceName = 'api' | 'worker' | 'mcp' | 'cli' | 'web-ssr';

/** Re-exported so consumers can type a logger without depending on pino directly. */
export type AppLogger = Logger;

/**
 * The root logger.
 *
 * `mixin` is the whole correlation mechanism: pino calls it on every record, so
 * the active trace context is merged in without any call site passing it. That
 * is what lets apps/api's 54 existing `new Logger(X.name)` declarations become
 * correlated without being touched.
 */
export function createRootLogger(opts: {
  service: ServiceName;
  level?: string;
  stream?: DestinationStream;
}): AppLogger {
  return pino(
    {
      level: opts.level ?? envLogLevel(),
      base: { service: opts.service, pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
      // Serializes an Error to { type, message, stack }. Without this, the ~60
      // sites that log `(e as Error).message` lose the stack entirely — passing
      // the Error itself as `err` is what recovers it.
      serializers: { err: pino.stdSerializers.err },
      mixin: () => ({ ...currentTrace() }),
    },
    opts.stream ?? pino.destination({ dest: 1, sync: false }),
  );
}

/**
 * stderr, for a process whose stdout is a protocol.
 *
 * The MCP entrypoint speaks JSON-RPC frames on stdout; one stray byte corrupts
 * the transport, which is why that process used to run with logging disabled
 * entirely. sync so records flush before an exit path can drop them.
 */
export function stderrStream(): DestinationStream {
  return pino.destination({ dest: 2, sync: true });
}

/** Read before DI exists — entrypoints build their logger at bootstrap. */
export function envLogLevel(): string {
  return process.env.LOG_LEVEL ?? 'info';
}
