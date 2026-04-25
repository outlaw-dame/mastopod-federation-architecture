import { pino } from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';
const format = process.env.LOG_FORMAT ?? 'json';

const pinoOptions = {
  level,
  base: {
    service: 'fedify-sidecar',
    version: process.env.VERSION ?? '1.0.0',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
};

export const logger = pino(
  format === 'pretty'
    ? {
        ...pinoOptions,
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        },
      }
    : pinoOptions,
);

export default logger;
