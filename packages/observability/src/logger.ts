import pino, { type DestinationStream, type Logger } from 'pino';
import pinoPretty from 'pino-pretty';
import { currentTrace } from '@knowledge/observability/trace';

/** Which process emitted the record. Every entrypoint sets one. */
export type ServiceName = 'api' | 'worker' | 'mcp' | 'cli' | 'web-ssr';

/** Re-exported so consumers can type a logger without depending on pino directly. */
export type AppLogger = Logger;

/**
 * Which process this is, remembered from the last createRootLogger call.
 *
 * The backtest stream needs it for its filename, but the Nest provider that
 * configures that stream is shared by all three entrypoints and cannot tell
 * which one it is running in. The entrypoint always builds its logger first, so
 * reading it from here is both correct and one less thing to thread through.
 */
let activeService: ServiceName = 'cli';

export function currentService(): ServiceName {
  return activeService;
}

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
  activeService = opts.service;
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
    opts.stream ?? destinationFor(1, false),
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
  return destinationFor(2, true);
}

function destinationFor(fd: number, sync: boolean): DestinationStream {
  return envLogPretty() ? prettyStream(fd) : pino.destination({ dest: fd, sync });
}

/**
 * Human-readable, coloured output for development.
 *
 * JSON is the right format for something that greps, aggregates and survives a
 * container; it is the wrong format for a person watching a terminal. So the
 * record shape never changes — only the rendering at the very last step.
 *
 * pino-pretty is imported directly and used as a stream rather than through
 * pino's `transport` option: that spawns a worker thread which resolves the
 * module by name, and name resolution from a worker is exactly what pnpm's
 * strict, non-hoisted node_modules layout makes unreliable.
 */
function prettyStream(fd: number): DestinationStream {
  return pinoPretty({
    destination: fd,
    // Forced rather than auto-detected. `make dev` pipes every process through
    // turbo, so stdout is not a TTY and pino-pretty would disable colour on its
    // own — precisely where it is wanted.
    colorize: true,
    colorizeObjects: true,
    translateTime: 'SYS:HH:MM:ss.l',
    // What gets hidden, and why each one:
    //   pid/service/source — constant for the whole process you are watching.
    //   ctx               — messageFormat already prints it as the [prefix];
    //                       leaving it on renders every line's context twice.
    //   method/route      — the request line already said them.
    //   workspaceId/userId— ambient, and in development effectively constant:
    //                       the demo workspace and the dev principal, on every
    //                       single line.
    // traceId deliberately stays. It is the one ambient field whose value
    // actually varies, and it is what you grep for when something breaks.
    ignore: 'pid,service,source,ctx,method,route,workspaceId,userId',
    messageFormat: '{if ctx}[{ctx}] {end}{msg}',
  });
}

/** Read before DI exists — entrypoints build their logger at bootstrap. */
export function envLogLevel(): string {
  return process.env.LOG_LEVEL ?? 'info';
}

/** Pretty by default everywhere except production, where output is consumed by machines. */
export function envLogPretty(): boolean {
  const raw = process.env.LOG_PRETTY;
  if (raw === undefined || raw === '') return process.env.NODE_ENV !== 'production';
  return !['false', '0', 'no', 'off'].includes(raw.toLowerCase());
}
