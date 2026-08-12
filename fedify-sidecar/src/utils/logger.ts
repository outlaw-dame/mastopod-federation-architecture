/**
 * Logger utility for Fedify Sidecar
 *
 * Provides structured logging with configurable levels and formats.
 */

import { pino, type LoggerOptions } from "pino";

const level = process.env["LOG_LEVEL"] ?? "info";
const format = process.env["LOG_FORMAT"] ?? "json";

const pinoOptions: LoggerOptions = {
  level,
  base: {
    service: "fedify-sidecar",
    version: process.env["VERSION"] ?? "1.0.0",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

const baseLogger = pino(
  format === "pretty"
    ? {
        ...pinoOptions,
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        },
      }
    : pinoOptions,
);

/**
 * Historical call sites use both Pino's native `(fields, message)` form and a
 * legacy `(message, fields)` form. Normalize only the latter so structured
 * diagnostic fields are never silently discarded while callers are migrated.
 */
for (const method of ["debug", "info", "warn", "error"] as const) {
  const original = baseLogger[method].bind(baseLogger) as (...args: unknown[]) => void;
  (baseLogger[method] as unknown as (...args: unknown[]) => void) = (
    first: unknown,
    second?: unknown,
    ...rest: unknown[]
  ) => {
    if (
      typeof first === "string"
      && second !== null
      && typeof second === "object"
      && !Array.isArray(second)
    ) {
      original(second, first, ...rest);
      return;
    }
    original(first, second, ...rest);
  };
}

export const logger = baseLogger;

export const LogLevel = {
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
} as const;

export type LogLevel = typeof LogLevel[keyof typeof LogLevel];
