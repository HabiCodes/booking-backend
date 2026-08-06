"use strict";
/**
 * Domain types — single source of truth for every row shape the app reads
 * from PostgreSQL.  Keep this file in sync with migrations/versions/*.sql.
 *
 * Conventions:
 *  - Row interfaces  → exactly match DB columns (snake_case)
 *  - DTO interfaces  → what the API returns to the client (camelCase)
 *  - Input interfaces → what the client sends to us (camelCase)
 */
Object.defineProperty(exports, "__esModule", { value: true });
