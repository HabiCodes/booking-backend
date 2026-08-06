/**
 * Global test setup / teardown.
 * Sets NODE_ENV to 'test' so the app loads test-safe config.
 */

process.env.NODE_ENV = 'test';

// Suppress noisy file transports during tests
process.env.LOG_FILE_ENABLED = 'false';
