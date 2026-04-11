/**
 * Logger utility for Fedify Sidecar
 * 
 * Provides structured logging with configurable levels and formats.
 */

import { pino, type LoggerOptions } from "pino";

// Get log level from environment
const level = process.env["LOG_LEVEL"] ?? "info";
const format = process.env["LOG_FORMAT"] ?? "json";

// Create pino logger
const pinoOptions: LoggerOptions = {
  level,
  base: {
    service: "fedify-sidecar",
    version: process.env["VERSION"] ?? "1.0.0",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

// Use pretty printing in development
export const logger = pino(
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

// Export log levels for convenience
export const LogLevel = {
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
} as const;

export type LogLevel = typeof LogLevel[keyof typeof LogLevel];
